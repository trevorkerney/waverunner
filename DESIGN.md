# waverunner — Design

This document describes how waverunner is built **today**. For what's planned, see [ROADMAP.md](ROADMAP.md). For the running punch-list of things to fix or add, see [TODO.md](TODO.md).

---

## What it is

A desktop media library manager. Point it at one or more folders of movies and/or TV shows, it scans them into a per-library SQLite database, fetches metadata from TMDB, and lets you browse, organize, and play them. Playback runs in an embedded libmpv-based player with a custom React UI on top.

Single-user, local-first, no server component. Cross-platform target (currently Windows-only in practice — see [Build & distribution](#build--distribution)).

---

## Tech stack

| Layer         | Technology                                            |
|---------------|-------------------------------------------------------|
| Desktop shell | Tauri 2 (Rust backend, system webview frontend)       |
| Frontend      | React 19 + TypeScript + Vite 7                        |
| Styling       | Tailwind CSS 4 + shadcn/ui (Base UI primitives)       |
| Drag & drop   | dnd-kit                                               |
| Notifications | sonner                                                |
| Database      | SQLite via sqlx (Rust async)                          |
| Player        | libmpv (FFI via `libloading`, bundled `libmpv-2.dll`) |
| Metadata      | TMDB v3 API via reqwest                               |
| Updater       | tauri-plugin-updater (GitHub releases)                |
| Package mgr   | pnpm                                                  |

---

## Repository layout

```
src/                       React frontend
  App.tsx                  top-level state, layout, global keybinds
  types.ts                 shared TS types (mirrors Rust structs)
  hooks/usePlayer.ts       player state machine
  components/
    Titlebar.tsx           custom titlebar (window controls, menu, zoom)
    Sidebar.tsx            library list + minimized player dock
    MainContent.tsx        grid, search, detail pages, drag/drop, dialogs
    PlayerView.tsx         full-takeover player chrome
    player/
      ControlsOverlay.tsx  top + bottom bars (seek, volume, tracks, etc.)
      CenterTransport.tsx  prev / play-pause / next cluster
      PlayerDock.tsx       sidebar mini-player + transparent video hole
    CreateLibraryDialog.tsx
    SettingsDialog.tsx
    TmdbMatchDialog.tsx, TmdbShowMatchDialog.tsx, TmdbImageBrowserDialog.tsx
    ui/                    shadcn primitives

src-tauri/
  src/
    lib.rs                 plugin registration, AppState, command handlers list
    commands.rs            all DB-backed commands (scan, CRUD, search, sort)
    db.rs                  SQLite schema for app DB + per-library DBs
    tmdb.rs                TMDB API client
    mpv.rs                 thin libmpv FFI bindings
    player.rs              high-level player commands + event loop thread
  lib/libmpv-2.dll         bundled libmpv (Windows)
  tauri.conf.json          window config, updater endpoint
  Cargo.toml
```

---

## Architecture

```
                         ┌──────────────────────────┐
                         │  React frontend (webview)│
                         │  - state in App.tsx       │
                         │  - per-feature hooks      │
                         │  - tauri @api/core invoke │
                         └─────────────┬─────────────┘
                                       │ invoke / events
                         ┌─────────────▼─────────────┐
                         │  Tauri commands (Rust)    │
                         │  - commands.rs (DB ops)   │
                         │  - player.rs (mpv ops)    │
                         │  - tmdb.rs (HTTP)         │
                         └─────┬─────────────────┬───┘
                               │                 │
                    ┌──────────▼─────┐    ┌──────▼──────────┐
                    │ SQLite (sqlx)  │    │ libmpv (FFI)    │
                    │ - app DB       │    │ embedded via wid│
                    │ - lib DBs      │    │ into our window │
                    └────────────────┘    └─────────────────┘
```

The webview is rendered with `transparent: true` and `decorations: false` (custom titlebar). When the player is active, the root html gets a `player-active` class which makes the takeover region transparent so the libmpv-rendered video shows through from underneath.

---

## Data model

Two distinct SQLite databases:

### App DB

Lives in the OS local-app-data dir (`waverunner.db`, or `waverunner_dev.db` in dev). Tables:

- `libraries` — id (uuid), name, paths (JSON array), format, portable, db_filename, default_sort_mode, managed, creating
- `settings` — flat key/value store (auto-update, release_channel, recycle_bin_max_gb, tmdb_api_token, auto_play_next, …)

### Per-library DB

One SQLite file per library. Lives in app data dir by default, or **inside the media folder** if `portable` is set (so the library travels with an external drive). All metadata, cover paths, and sort orders live here.

**Format = `video`** (movies + shows mixed in the same library):

```
media_entry        (id, parent_id, entry_type_id)   -- generic hierarchy node
  └─ entry_type ∈ { movie | show | collection }

movie              (id, title, folder_path, sort_title, sort_order, release_date,
                    selected_cover, tmdb_id, imdb_id, rotten_tomatoes_id,
                    plot, tagline, runtime, maturity_rating_id)
  └─ junction tables: movie_genre, movie_director, movie_cast, movie_crew,
                      movie_producer, movie_studio, movie_keyword

show               (id, title, folder_path, sort_title, sort_order,
                    selected_cover, tmdb_id, imdb_id, plot, tagline,
                    maturity_rating_id)
  └─ junction tables: show_genre, show_creator, show_cast, show_crew,
                      show_producer, show_studio, show_keyword

  season           (id, show_id, title, season_number, folder_path, plot, sort_order)
    └─ season_cast, season_crew, season_director, season_producer

    episode        (id, season_id, title, episode_number, file_path,
                    release_date, plot, runtime, sort_order)
      └─ episode_cast, episode_crew

collection         (id, title, folder_path, sort_title, sort_order,
                    selected_cover, sort_mode)

cached_images      thumbnail cache index (small renders next to cover originals)
```

Plus shared lookup tables: `genre`, `maturity_rating`, `person`, `studio`, `keyword`. A SQL view `media_entry_full` flattens the entry hierarchy for grid queries.

**Format = `music`** has its own schema (`artist`, `album`, `song`) — currently scaffolding; no music UI or player yet (see ROADMAP).

### Why this shape

- **`media_entry` as the hierarchy spine** lets a single SQL view drive the grid regardless of whether each row is a movie, a show, or a collection.
- **Detail tables hang off `media_entry.id`** so we can grow per-type fields without polluting the spine.
- **TMDB ids are stored** so re-running metadata on an entry doesn't re-prompt for a match.

---

## Library model

A library = "a place I keep media of one format." Decisions made at creation time:

| Field      | Values             | Effect                                                                                                     |
|------------|--------------------|------------------------------------------------------------------------------------------------------------|
| name       | string             | Display name in sidebar                                                                                    |
| paths      | one or more dirs   | All scanned together into the same library DB                                                              |
| format     | `video` \| `music` | Determines schema and which scanner runs                                                                   |
| managed    | bool               | If `true`, renames/moves entries on disk to match in-app changes. If `false`, the app never touches files. |
| portable   | bool               | If `true`, library DB is stored inside the (first) media folder instead of app-data                        |

Libraries are independent — moving a movie between libraries isn't a thing (yet). Within a library, entries can be moved between collections (managed libraries) or just re-tagged in the DB (unmanaged libraries).

**Rescan** re-reads the filesystem and reconciles with the DB without losing existing TMDB metadata. Triggered from the sidebar context menu.

---

## Filesystem conventions

Folder names are **for humans only** — the app uses DB paths to find files. But because managed libraries write folder names back, there's a defined convention.

```
movies/
  Pulp Fiction (1994)/
    movie.mkv
    covers/
      cover.jpeg
      cover1.png
    covers_thumb/        # auto-generated cached thumbnails
      cover.jpeg
    extras/
      behind-the-scenes.mkv

  Avengers/                                # collection (no year)
    The Avengers (2012)/
      movie.mkv
      covers/cover.jpeg

shows/
  Breaking Bad/
    Season 1/
      S01E01 - Pilot.mkv
      S01E02.mkv
      ...
    Season 2/
      ...
```

### Reserved subfolder names

These are **not** treated as nested entries:

- `covers/` — cover art originals (jpg, jpeg, png, webp, bmp, gif)
- `covers_thumb/` — auto-generated thumbnails (the app writes these)
- `extras/` — behind-the-scenes, deleted scenes, etc.

### Folder naming (managed libraries)

| Entry type | Folder name format                       | Example                  |
|------------|------------------------------------------|--------------------------|
| Movie      | `{sanitized title} ({year})`             | `Pulp Fiction (1994)`    |
| Show       | `{sanitized title}`                      | `Breaking Bad`           |
| Collection | `{sanitized title}` (no year)            | `Avengers`               |

**Sanitization** strips characters that are illegal or annoying in filesystem paths: `< > : " / \ | ? *`. The DB always stores the real title; sanitization is folder-name-only.

### Files

- **Video:** any common format mpv plays (`.mkv`, `.mp4`, `.avi`, …); filename irrelevant
- **Subtitles:** `.srt` etc. alongside the video file (mpv picks them up automatically)
- **Cover originals** in `covers/`; **thumbnails** in `covers_thumb/` (auto-generated for fast grid rendering)

---

## Sorting

Per-collection (and per-library-root) sort mode. Stored in DB so it persists.

| Mode     | Behavior                                                                                |
|----------|-----------------------------------------------------------------------------------------|
| `alpha`  | Alphabetical by title, with leading articles ignored (`The`, `A`, `An`)                 |
| `date`   | By release date (movies); for collections, by latest contained item                     |
| `year`   | By release year                                                                         |
| `custom` | Drag-and-drop order; backed by `sort_order` integer                                     |

Article-stripping is language-aware: English, French, German, Spanish are recognized today (see `generate_sort_title` in [src-tauri/src/commands.rs](src-tauri/src/commands.rs)). Selection is currently hardcoded — a setting is on the TODO list.

---

## Navigation & UI state

Top-level state lives in [src/App.tsx](src/App.tsx). The interesting bits:

- **Breadcrumb stack** — push/pop as you drill into collections. `null` id = library root.
- **Forward stack** — populated when you go back, cleared on any forward navigation. Mouse buttons 4 & 5 (back/forward) are bound globally.
- **Entry cache** — keyed `libraryId:parentId`. Avoids re-querying every time you go back.
- **Scroll cache** — same key. Restored with a double-`requestAnimationFrame` after the grid re-mounts.
- **Thumbnail cache** — cover path → blob URL. Pre-loaded for visible entries before the grid renders to avoid jank.
- **Detail page** — selecting a movie/show pushes a breadcrumb but doesn't reload the grid; clicking back pops it without re-fetching.

**Search** is fuzzy, scoped to the current parent, debounced 200ms. Returns flat results (collections are unpacked).

**Drag & drop** (dnd-kit):
- Drop a movie onto a collection → moves it in
- Drop onto the "move up" zone at the top → moves it to the parent
- In `custom` sort mode, dragging reorders within the current view
- All operations write through to the DB and (in managed libraries) the filesystem

---

## Embedded player

Custom React UI on top of libmpv. No mpv OSC, no mpv keybinds — everything goes through React.

### How libmpv is embedded

[src-tauri/src/player.rs](src-tauri/src/player.rs) loads `libmpv-2.dll` via `libloading`, then hands mpv our window's native `wid` so it renders **into our window** instead of opening its own. The webview stays on top, transparent where we want video to show through.

### Layout modes

Two visible states, plus closed:

1. **Full takeover** — `PlayerView` mounts above the library layout, video fills the whole client area below the titlebar. Titlebar is hidden when fullscreen.
2. **Minimized** — `PlayerView` unmounts, library returns, `PlayerDock` mounts at the bottom of the sidebar. The dock holds a transparent rectangle the same size as where the video should appear, plus mini transport controls.

The dock works without a child window: we use mpv's `video-margin-ratio-{left,right,top,bottom}` properties to letterbox the video into the dock's exact rect. A `ResizeObserver` + `window.resize` listener recomputes on layout changes.

The titlebar offset is implemented the same way: `video-margin-ratio-top = TITLEBAR_HEIGHT / windowHeight`, recomputed on fullscreen toggle.

### Player state

[src/hooks/usePlayer.ts](src/hooks/usePlayer.ts) holds:

- Playback: `isActive`, `isPlaying`, `currentTime`, `duration`, `volume`, `muted`, `loading`
- Layout: `isFullscreen`, `isMinimized`
- Tracks: `audioTracks[]`, `subtitleTracks[]`
- Context: `{ kind: "movie" }` or `{ kind: "episode", episodes[], index, … }` for prev/next nav across seasons
- Settings: `autoPlayNext` (persisted)

Property changes from mpv are pushed to the frontend via Tauri events (`mpv-property-change`, `mpv-file-loaded`, `mpv-end-file`). End-of-file with `reason: 0` triggers auto-advance to the next episode if context is episode + `autoPlayNext` is on.

### Keyboard shortcuts

Live at the App level (in [src/App.tsx](src/App.tsx)) and registered in **capture phase** so they fire even when descendants stop propagation (e.g. the seek-bar wrapper swallowing arrow keys to keep the native `<input type="range">` from drifting).

| Key             | Action                              |
|-----------------|-------------------------------------|
| Space           | Toggle pause                        |
| Left / Right    | Seek ±10s                           |
| Up / Down       | Volume ±5                           |
| F               | Toggle fullscreen                   |
| M               | Toggle mute                         |
| Esc             | Exit fullscreen, else close player  |

Shortcuts are gated on `playerState.isActive` and skipped when focus is in a real text input (slider thumbs are explicitly **not** treated as text inputs).

### Center transport + controls overlay

- `CenterTransport` — large prev / play-pause / next cluster, fixed-grid layout so play/pause never visually shifts when prev/next visibility changes.
- `ControlsOverlay` — top bar (title, minimize, close) + bottom bar (seek, volume, time, autoplay toggle, audio-track menu, subtitle menu, fullscreen).
- Both fade after 3s of no mouse movement, regardless of play/pause state.

---

## TMDB integration

TMDB API token is set in Settings. Without it, scanning still works but no metadata is fetched.

- **Match dialog** — when a movie/show is missing TMDB metadata, the user opens a dialog that searches TMDB and shows candidates. User picks one.
- **Field selection** — after picking, the user toggles which fields to apply (plot, cast, crew, genres, …) so existing local edits aren't clobbered.
- **Image browser** — separate dialog for browsing TMDB posters/backdrops and downloading them into `covers/`.
- **Show detail** — show, season, and episode metadata are matched and applied independently (different dialogs / scopes).

All TMDB code lives in [src-tauri/src/tmdb.rs](src-tauri/src/tmdb.rs).

---

## Settings

Single category today (`General`), persisted in the app DB's `settings` table.

| Setting                | Default      | Notes                                                                                       |
|------------------------|--------------|---------------------------------------------------------------------------------------------|
| `auto_update`          | `true`       | Check for an update on launch                                                               |
| `release_channel`      | `stable`     | `stable` or `prerelease`                                                                    |
| `recycle_bin_max_gb`   | `50`         | When deleting from a managed library: send to Recycle Bin if folder ≤ this size, else permanently delete. `0` = always permanent, `-1` = always Recycle Bin |
| `tmdb_api_token`       | empty        | TMDB v4 read-access token                                                                   |
| `auto_play_next`       | `true`       | Player auto-advances to next episode on EOF (also toggleable in the player UI)              |

The titlebar exposes a custom zoom (Ctrl + `=`/`-`/`0`, Ctrl-scroll), persisted in localStorage independently of these settings.

---

## Build & distribution

- **Bundler:** NSIS installer (Windows). `tauri build` produces an `.exe` installer plus an `latest.json` updater manifest.
- **libmpv:** `src-tauri/lib/libmpv-2.dll` is bundled as a Tauri resource (`resources: ["lib/**/*"]` in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)). At runtime [src-tauri/src/player.rs](src-tauri/src/player.rs) searches resource dir, exe dir, then `src-tauri/lib/` for it.
  - The DLL is currently in the repo. CI auto-download / Git LFS are open items in [TODO.md](TODO.md).
- **Auto-updater:** [tauri-plugin-updater](https://v2.tauri.app/plugin/updater/) polls the GitHub releases endpoint defined in `tauri.conf.json`. On launch, the app silently downloads any available update and toasts a "Restart" button when ready. Manual check is also available in Settings.
- **Signing:** Updater payloads are signed with a minisign key; the public key is in `tauri.conf.json`.
- **Platforms:** macOS / Linux are not actively built or tested. The code aims to be portable (sqlx, Tauri, mpv all are) but reaching parity is on the roadmap.

---

## Conventions worth knowing

- **DB-first writes.** All mutations go to the database first, then the filesystem (in managed libraries). On filesystem failure the operation reports an error and the DB write is rolled back where possible.
- **Caches are conservative.** When a write changes data that affects the grid, the relevant `entryCache` keys are invalidated and reloaded inline.
- **No global state libraries.** Everything is plain `useState` / `useRef` in App, threaded down as props. The single hook with non-trivial internal state is `usePlayer`.
- **Types are duplicated.** Rust structs in `commands.rs`/`player.rs` and TS interfaces in `types.ts` mirror each other. Keep them in sync by hand.
