# TODO

## bugs / needs fixing

Rescan is not robust: a single DB error aborts the ENTIRE rescan instead of being isolated per show/season/episode, so one bad item breaks the whole sync and everything sequenced after it silently never updates.

Root cause confirmed in prod (the "(code 2067) UNIQUE constraint failed: episode.season_id, episode.episode_number" error): Family Guy S07 had two video files for the same episode — an alternate "Bale Scene" cut and a "Commentary Audio Track" cut of S07E07 — and both parse to episode number 7. Episodes are inserted with a plain INSERT (commands.rs ~5402) and the table has UNIQUE(season_id, episode_number), so the second file throws the constraint error and the `?` propagation kills the whole rescan. This is why Family Guy S08-S20 were empty (the pass died at S07 before reaching them) and why removing Black Mirror / The Ranch never helped — they were never the culprit; the duplicate was always in Family Guy. It was the only collision in the whole library. (Immediate unblock: delete one of the two S07E07 files and rescan — it self-heals.)

Fix needed:
- Error isolation: a failed episode/season/show should log a warning and continue the rescan, not abort it. (Highest-value fix — turns a library-wide break into one skipped item.)
- Graceful duplicate handling: two files mapping to the same (season, episode_number) must not crash. Decision needed — keep one + warn (simple), or eventually support multiple versions/cuts per episode (bigger feature, schema change; relevant since people deliberately keep alternate cuts/commentary).
- Surface skipped/duplicate items back to the user (ties into the "warn about episodes without episode numbers" item under new features).

Separate, larger follow-up (the original "detect file/folder/file renames and sync accordingly" ask): sync is currently keyed on path, so a rename reads as delete + re-add and loses metadata (TMDB match, etc.). True rename/move detection needs content hashing or fuzzy matching — out of scope for the robustness fix above.

Also likely a casualty of this same abort bug — verify these resolve once rescan completes cleanly: Invincible S4 episodes out of order, and any other "missing season / missing episodes" symptoms for shows added after the rescan started failing.

---

It seems when I rescan to import tv shows brought in after the initial scan, episode numbers and seasons display out of order (not increasing like they should be). Confirmed on Family Guy and Invincible S4 — both added after the library was already created.

Root cause: everything sorts by the `sort_order` column, but that's only assigned meaningfully by the INITIAL scan, which sorts the folders/files by parsed number before numbering them (scan_video_dir: season_dirs.sort_by ~6378, episode_files.sort_by ~6417). The RESCAN doesn't sort at all — disk_seasons and disk_episodes are HashSets, iterated in nondeterministic order, and each new item is stamped sort_order = MAX(existing)+1. So shows present at library creation are ordered correctly; shows added later via rescan get effectively random sort_order, scrambling both seasons and episodes.

Not just cosmetic: get_show_episodes (the flat list used for playback/autoplay) orders by `s.sort_order, ..., e.sort_order` FIRST, so a rescan-added show also AUTOPLAYS its episodes in scrambled order — a functional bug, not just display.

Fix: stop trusting sort_order for seasons/episodes (they have a canonical numeric order) and order by the actual number, with NULL-numbered items (Specials / unnumbered episodes) falling last and sort_order as the final tiebreaker. Three queries — get_show_seasons (ORDER BY season_number IS NULL, season_number, sort_order), get_season_episodes (ORDER BY episode_number IS NULL, episode_number, sort_order), and get_show_episodes (ORDER BY s.season_number IS NULL, s.season_number, e.episode_number IS NULL, e.episode_number, e.sort_order). This fixes all existing scrambled data instantly with no re-import and is robust to any insertion order. (Sorting the rescan's batch instead is insufficient — incrementally added seasons still append after the existing max, e.g. add S04 then S01 later and S01 still lands after S04.)

---

Uncap the TMDB cast import. Cast is currently sliced to the first 20 billed in every match path — single movie match (TmdbMatchDialog extractCast), single show match (TmdbShowMatchDialog extractCast), bulk/library match (TmdbBulkMatchDialog castOf, covers movie/show/season), and the inline "Populate season from TMDB" (MainContent ~2526). The cap silently drops deep-billed but real roles — e.g. Ty Simpkins as Harley Keener, billed 72nd of 105 in Avengers Endgame, never gets imported. Import the full cast in TMDB billing order instead. (Tradeoff to accept/watch: more cast = more Person rows = bigger people pages — may eventually want a character-name/credited filter rather than a flat cap.)

Once uncapped, the cast band on movie/show detail pages can get very long, so it needs a visual cutoff: show the first couple rows with a "View all" button that expands the full list (and collapses again).

---

covers on playlist entries dont get new additions it seems. when i add a cover to a movie through TMDB under the all/movies/tv sidebar pages, that cover is not an option from within a playlist where that movie is referenced. While the entries in the playlists' covers should be independent from their main ones under all/movies/tv, the selection should be from the same pool.

'specials' needs to be added to the list of folders that are counted as extras. Right now 'specials' is being counted as a season on Black Mirror.

when matching library to TMDb, the text in the modal above the progress bar for seasons and episodes should say something like "Season 2 - Game of Thrones" and "Season 2 episodes - Game of Thrones" instead of just "Season 2" and "Season 2 episodes"

make sure TMDB matches (individual AND library) always use year (if exists) when trying to find match

question TMDb match confidence algorithm. seems like sometimes the "ambiguous" matches aren't always that ambiguous but pretty obvious (star wars, terminator 2)

adding collections causes a flash instead of the new collection falling into the grid from somewhere (could be from cursor location, or top, use judgement here). It should fall in and 'animatedly' move the grid down past it like how deleting entries causes the grid to 'animatedly' move back up towards where it was

maybe find a solution to custom sort not having a scrubber resulting in there being more space horizontally, causing a jump when switching to and from custom sort. could just have more padding or an empty element taking the space of the scrubber

Need to be able to add ratings and raters (IMDb id, RT id, TMDB id, etc) info in edit media menu within media detail view

dropping media into a collection (especially when the media is far from the collection based on however the grid is sorted) currently jumps back to where the media was, as opposed to staying where the collection is. the scroll should stay where the collection is.

sometimes after creating a collection, moving media into it, changing the sort method to custom, reordering some movies, maybe renaming some, and going back out of the collection, the scroll is not where the collection is but a bit below or above it. this happens fairly often when doing things along the lines of the process described above. Actually I'm now noticing it sometimes happens when simply clicking into a collection and then going back out by clicking the first breadcrumb.

playlist grid page and individual playlist grid pages are outdated. needs updating with new features seen in other grid pages (virtualization, animation improvements, subtitles showing num of movies and shows + release date range, reordering media still causes cover image warping, etc.)

sometimes the sidebar doesn't always seem to properly take the user to the page it represents. ive noticed a couple times where i'll go from movies to all and it still just shows movies. other instances similar to this have also happened.

people pages top100/all toggle should just be a selection like sorting options on media grid pages, not a toggle. same functionality too - the selection should be remembered

add (copy SVGs from RT site) splat (critic) and spilled popcorn (audience) icons for RT reviews under 60% (or whatever RT's number is)

i accidentally put a tv show (with 1 season) in the TV directory and without a season folder. the episodes were directly in the tv show folder. waverunner treated it like a movie 

movie covers and backdrops downloaded from TMDB or anywhere through the app SHOULD save to the users source folder, if setting enabled (default on)

add a way for users to switch audio (and video?) track within the player (bug because we should've had this by now)


## changes / small new features

export media covers zip

sometimes media is stored on drives that arent fully active all the time. for instance when you start a movie, the drive will spin up and waverunner sorta freezes for a sec while it starts up (i say sorta because it doesn't fully freeze, buttons just stop working), then it loads and starts playing. I'd like to look into solving that issue and making waverunner fully responsive for the couple seconds the disk is booting up. The user should be able to click pause/play, shrink screen to sidebar, stop playback, etc mid drive startup

I want a little thumbnail showing the frame at the hovered spot when cursor is hovering seek bar

personal movie/show ratings

switch to skeleton loaders

ability to edit subtitle size/styling/etc

add some sort of way to choose default library to display

remember size slider position

button somewhere to open source folders, maybe some as well per media

add num of movies/shows/actors/etc on sidebar buttons 

release date scrubber should have more precision. we could probably do steps of 1 but it may be better to do steps of 5

display images (png, jpg, webp, gif, etc) in extras, alongside the video extras (featurettes, webisodes, deleted scenes, etc). Right now the extras scanner only picks up VIDEO files in the reserved extra dirs (collect_extra_files filters is_media_file(VIDEO_EXTENSIONS)); extend it to also collect image files (IMAGE_EXTENSIONS) and store them as extras with a type/kind that distinguishes image vs video. The extras dialog then renders image extras in an image viewer / gallery (lightbox) instead of launching the player, while video extras keep playing as they do now. Use case: promotional stills, behind-the-scenes photos, concept art, posters. (Covers/backgrounds folders are already handled separately as artwork — this is images that live in the extra-content folders, or a dedicated images/stills folder.)


## new features

watch history, resume where left off button, make play say play from beginning if the user has watch history on a movie/show

save cover sets. users should be able to save a set of media covers so that they can easily switch all media covers in a library to the saved set. 

settings system where changes are all set at once on save button click, instead of on settings exit

add warnings about tv episodes without episode numbers (they will likely play out of order)

need to consider some sort of ability to queue up things for the player. TV show autoplay should probably take this system into heavy consideration. Users should be able to queue playlists. Users should be able to queue up individual movies in context menus at their whim. On the player and maybe not on the player, the user should be able to view the queue and manipulate it in a dialog or sidebar or something

bind comma and period to prev frame and next frame on player. KEYBINDS MENU IN SETTINGS

consider how streamed media should be dealt with as opposed to local media (like from a plex server)

library and usage statistics (prompt user to enable/disable usage stats on first startup)

Interactive media support (Netflix-style branching video, e.g. Black Mirror: Bandersnatch). Let waverunner play "interactive" titles where the viewer makes timed choices that branch the story.

The model: an interactive title is ONE linear video file with every branch concatenated end to end, plus a JSON branch graph. "Playing" = seeking between timestamp ranges in that single file based on the graph + the viewer's choices. There are no per-branch video files.

---

The format — Netflix's `interactiveVideoMoments`, the de-facto community standard (adopting it means existing ripped content works on day one). Two JSON files split the work and you need BOTH:
- manifest.json = the segment skeleton: every segment's startTimeMs/endTimeMs in the video, defaultNext + a weighted `next` map, interactionZones (when choices are clickable), initialSegment, viewableId. Times ALL segments, including pure pass-through ones. (Bandersnatch: 250 segments.)
- info.json = the interactivity layer: momentsBySegment (choices, plus tutorials/notifications, each with its own on-screen startMs/endMs), preconditions (boolean/arithmetic expression trees over state: eql/lt/gt/and/or/not/sum/mult), segmentGroups (conditional routing when a segment ends), stateHistory (persistent + global vars — persistent = Bandersnatch's "remembers your choices"), playerControls. Only lists segments that have a moment (Bandersnatch: 208).
- a choice = { text, segmentId (target to jump to), impressionData (state changes to apply on selection) }.
- why both: manifest times every segment (info omits pass-through ones); info has the choice/condition/state logic manifest lacks.

What waverunner needs to build (4 pieces):
1. Format reader — parse manifest + info into Rust structs (mirror Interactive-Player's Models.cs).
2. State + precondition engine — evaluate the expression trees, track persistent/global state, resolve segmentGroups. Small (see Interactive-Player PreconditionChecker.cs).
3. Choice-overlay UI — a timed countdown decision overlay in React, rendered in waverunner's own style from each choice's `text` (no need for Netflix's sprite assets).
4. Seek-based playback driver — libmpv seeks to a segment's startTimeMs, plays, watches for the choice window, applies the pick (or defaultNext on timeout), seeks to the next segment. Same loop as the reference player.

Where the content comes from: community preservation archives / Discords (e.g. "Netflix Interactive Archive"). Two artifacts that MUST be a matched pair — the metadata's absolute-ms timestamps are authored against one specific video encode, so a mismatched video + metadata makes choices fire at the wrong times: (a) the internal video (all branches concatenated; ~5h17m for Bandersnatch), (b) the metadata (manifest.json + info.json). The sprite PNGs/fonts in the packs are cosmetic; direct.json is just a pointer to the video path. Minimal user-supplied set = video + manifest.json + info.json.

User workflow once supported: get the internal video + matching manifest/info from the same source → drop both into a folder for the title in the library → rescan (waverunner detects the JSON next to the video and flags the folder as an interactive title — new entry type/flag) → press Play, which runs the interactive engine instead of linear playback.

Design forks to decide: (a) detection — "video + recognized info.json/manifest.json in the folder" vs a waverunner-native bundle marker; (b) format — parse the community-standard interactiveVideoMoments directly (max compatibility with existing content) and/or define a cleaner native schema + converter; (c) choice rendering — native overlay (recommended; only needs the JSON) vs honoring Netflix's sprite packs (prettier-authentic but means handling their art + a bigger matching problem). Start native-only.

Gotchas: timestamp alignment (matched video+metadata pair is the #1 failure mode); seek performance (libmpv seeks aren't always instant/frame-perfect — Netflix's real player pre-buffers upcoming branches; the emulators accept a small hitch; we could pre-seek-buffer the likely-next segments); an interactive title is a BUNDLE (video + JSON + optional assets), so it's a new entry type, not a plain movie.

Legal / distribution: the engine we write (Rust/JS) is our own original code and is fine to ship publicly — just reimplement from the format/concepts, don't line-by-line port the reference C# (check its LICENSE if lifting any actual code/assets). But the specific title content (the Bandersnatch info.json/manifest/video, etc.) is Netflix's copyright — never bundle or commit it into waverunner or any public repo; users supply their own. (The reference Interactive-Player bundles packs into its installer = its own assumed risk; note its public *source* repo keeps the packs out — model that split.)

Reference material: external-refs/Interactive-Maker (authoring tool — clean view of the data schema) and external-refs/Interactive-Player (C#/.NET + LibVLC player/emulator with a working Bandersnatch implementation — the runtime reference + canonical format). Both gitignored; re-clone via external-refs/sync.sh. A real, verified-working sample (Bandersnatch manifest.json + info.json) currently sits in the local Interactive Player install for writing/testing the parser against.

---


## minor/later

button or ability to import media not currently on media drive

on the first time someone sets sort mode to custom OR creates a collection, show a very quick tutorial about how to drag media

go through everything ensuring compatibility with MacOS and Linux

settings: sorting language selection (determines which articles like "The", "A", "An" are ignored for alphabetical sort — currently hardcoded to English)


## Embedded Player

CI/build script to auto-download libmpv-2.dll before `tauri build` so release builds always bundle it

Git LFS for libmpv-2.dll as an alternative to the CI approach — keeps the DLL in the repo without bloating git history
