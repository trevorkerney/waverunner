# waverunner - Design Document

## Overview

Desktop media library manager built with Tauri 2 + React + TypeScript + Tailwind CSS + shadcn/ui.

Manages collections of movies, TV shows, and music. Cross-platform (Windows, macOS, Linux).

---

## Tech Stack

| Layer         | Technology                        |
|---------------|-----------------------------------|
| Desktop shell | Tauri 2 (Rust)                    |
| Frontend      | React 19 + TypeScript             |
| Styling       | Tailwind CSS 4 + shadcn/ui       |
| Build tool    | Vite 7                            |
| Database      | SQLite via sqlx (Rust)            |
| Package mgr   | pnpm                             |

---

## Architecture: Filesystem vs Database

Clear separation of concerns:

- **Filesystem** holds the actual files: video, cover images, extras (behind the scenes, etc.)
- **SQLite** holds all metadata: title, year, collection membership, TMDB data, tags, paths — everything the app needs to display and search. Single source of truth for the app.

The app does **not** parse folder names for metadata. Folder names are human-readable as a convenience for browsing in a file explorer, but the app uses the database path reference to locate files and the database fields for all display data.

### Filesystem Sync

The app keeps the filesystem in sync with the database. When the user:

- **Renames** a movie or collection — the folder on disk is renamed to match
- **Moves** a movie into or out of a collection — the folder is moved on disk accordingly

The database is updated first, then the filesystem operation follows. The database stores the real title (e.g., `Avengers: Endgame`); the folder name uses a sanitized version with the year appended (e.g., `Avengers - Endgame (2019)`).

**Folder name format:** `{sanitized title} ({year})`
- Collections without a year just use the sanitized title (e.g., `Star Wars/`)

**Sanitization rules** (applied to folder names only, not DB titles):

| Character | Replacement |
|-----------|-------------|
| `:`       | ` -`        |
| `" < > \| ? * \` | removed |

---

## Layout

- **Sidebar** — library list, navigation
- **Main area** — displays media covers/content from the selected library

---

## Library Creation

Library creation is a **multi-step wizard**:

### Step 1 — Library Source

| Option | Description |
|--------|-------------|
| **Local folder** | A folder of media on disk — no strings attached |
| **Plex / Jellyfin / Emby** | Connect to a media server and import a library (future) |

### Step 2 — Local Folder Setup

| Field              | Type    | Description                                                  |
|--------------------|---------|--------------------------------------------------------------|
| Name               | string  | Library display name                                         |
| Path               | string  | Folder path to media (browse dialog)                         |
| Format             | enum    | Movies, TV, Music                                            |
| Portable           | toggle  | Store database inside the media folder (travels with the drive) |
| Markdown index     | toggle  | Generate a human-readable `.md` index file in the media folder |
| TMDB fetch         | toggle  | Auto-fetch metadata from TMDB when importing media           |

### Step 2 — Plex / Jellyfin / Emby (future)

| Field              | Type    | Description                                                  |
|--------------------|---------|--------------------------------------------------------------|
| Server URL         | string  | Address of the media server                                  |
| Authentication     | varies  | Login / API key / token depending on platform                |
| Library selection  | picker  | Choose which server library to import (they separate Movies, TV, Music) |
| Name               | string  | Library display name (pre-filled from server library name)   |

### Storage Location

| Mode                   | Database location         | Notes                                       |
|------------------------|---------------------------|---------------------------------------------|
| **Local** (default)    | App data directory        | Fastest, simplest                           |
| **Portable**           | Inside media folder       | Travels with the drive/folder               |

- Database is always SQLite. No JSON index option — SQLite is the single source of truth.
- The **Markdown index** is optional and independent. When enabled, the app generates/updates a human-readable `.md` file in the media folder as a reference for accessing the library without the app. This file is not read by the app.
- Portable option applies to local folder libraries only.

---

## Folder Structure

Media folders use human-readable names. The app does not depend on folder names — it uses database paths to find files.

```
movies/
  Pulp Fiction (1994)/
    movie.mkv
    covers/
      cover.jpeg
      cover1.png
    extras/
      behind-the-scenes.mkv
  The Wolf of Wall Street (2013)/
    movie.mkv
    covers/
      cover.jpeg
      cover1.png
  Avengers/
    The Avengers (2012)/
      movie.mkv
      covers/
        cover.jpeg
    Age of Ultron (2015)/
      movie.mkv
      covers/
        cover.jpeg
  Star Wars/
    Original Trilogy/
      A New Hope (1977)/
        movie.mkv
        covers/
          cover.jpeg
```

### Reserved Folder Names

These folders have special meaning inside a media entry and are **not** treated as nested collections:

- `covers/` — cover art images
- `extras/` — behind-the-scenes, deleted scenes, featurettes, etc.

### Folder Naming

- Names are for human readability only — the app ignores them
- Cross-platform safe: avoid `: " < > | ? * \` in folder names
- Suggested convention: replace `:` with ` -` (e.g., `Avengers - Endgame (2019)`)
- The app stores the real title (with colon) in the database

### File Conventions

- **Video**: any common video format (`.mkv`, `.mp4`, etc.) — filename doesn't matter
- **Cover images**: in `covers/` subfolder — `.jpeg`, `.jpg`, `.png`, `.avif`, multiple allowed
- **Subtitles**: `.srt` and other subtitle formats, alongside the video file
- **Extras**: in `extras/` subfolder — behind-the-scenes, deleted scenes, featurettes, etc.

### Nesting

Folders can contain media or more folders, recursively.

- A folder is either a **media entry** (contains video files) or a **collection** (contains subfolders)
- Nesting depth is unlimited
- Navigation uses breadcrumbs to show depth as the user drills into collections

**Examples:**

| Depth | Structure                                            | Meaning                                                      |
|-------|------------------------------------------------------|--------------------------------------------------------------|
| 1     | `Pulp Fiction (1994)/movie.mkv`                      | Standalone movie                                             |
| 2     | `Avengers/The Avengers (2012)/movie.mkv`             | Movie in a collection                                        |
| 3     | `Star Wars/Original Trilogy/A New Hope (1977)/movie.mkv` | Movie in a sub-collection                                |

---

## Open Questions

- [x] Nesting depth — unlimited
- [x] Database layer — Rust-side, sqlx
- [x] TMDB metadata integration — optional per-library setting + on media import (see below)

---

## TMDB Integration

- **Per-library toggle** at creation time: enable/disable automatic metadata fetching
- **On media import**: when adding a movie, the app can search TMDB, let the user pick the match, and auto-fill metadata (title, year, synopsis, genre, runtime, cast, director, ratings) and download poster art into `covers/`
- Can also be triggered manually on any existing movie
- Requires a TMDB API key (user provides in app settings)
- [x] Search and filtering design (search unpacks collections — see below)

---

## Search

- Search is fuzzy and queries the SQLite database
- Collections are **unpacked** — individual movies appear as flat results, not grouped under their collection
- Each result from a collection shows a breadcrumb indicator of where it lives (e.g., `Star Wars → Original Trilogy`)
- [ ] Filtering design (by year, format, tags, etc.) TBD
- [x] Media playback — launch external player for now, built-in player later (see below)
- [ ] TV show and Music format folder conventions (only Movies defined so far)
- [ ] How existing numbered libraries get migrated/imported

---

## Playback

**Phase 1 (now):** Launch media in the OS default player (or user-configured player), same as double-clicking in file explorer.

**Phase 2 (future):** Built-in player UI within waverunner. This is when Plex/Jellyfin/Emby streaming support becomes relevant — waverunner's player would handle both local files and streams from media servers.

---

## Plex / Jellyfin / Emby Integration (future)

waverunner can act as an **alternative client UI** for existing media servers.

- Connect to a server via its REST API
- Browse and search the server's libraries using waverunner's UI
- Stream media through the server's transcoding/direct-play endpoints
- Plex, Jellyfin, and Emby all separate libraries by content type (Movies, TV, Music) — each maps to a waverunner library
- Requires the built-in player (Phase 2) for streaming playback
