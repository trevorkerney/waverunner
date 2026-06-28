# TODO

## test on prod

check for choppy dnd animations when reordering media entries

dropping media into a collection (when the media is far from the collection scroll-wise) currently jumps back to where the media was, as opposed to staying where the collection is. the scroll should stay where the collection is.


## bugs / needs fixing

playlist grid page and individual playlist grid pages are outdated. needs updating with new features seen in other grid pages (virtualization, animation improvements, subtitles showing num of movies and shows + release date range, reordering media still causes cover image warping, etc.)

sometimes the sidebar doesn't always seem to properly take the user to the page it represents. ive noticed a couple times where i'll go from movies to all and it still just shows movies. other instances similar to this have also happened.

people pages top100/all toggle should just be a selection like sorting options on media grid pages, not a toggle. same functionality too - the selection should be remembered

add (copy SVGs from RT site) splat (critic) and spilled popcorn (audience) icons for RT reviews under 60% (or whatever RT's number is)

i accidentally put a tv show (with 1 season) in the TV directory and without a season folder. the episodes were directly in the tv show folder. waverunner treated it like a movie 

movie covers and backdrops downloaded from TMDB or anywhere through the app SHOULD save to the users source folder, if setting enabled (default on)

add a way for users to switch audio (and video?) track within the player (bug because we should've had this by now)

rescanning (when done) seems to place the user in All view while keeping whatever they were on before highlighted in the sidebar.

scan and rescan need to detect double (and even triple, MAYBE MORE IDK) episodes like when a file is named something like S01E01-E02 - one example is "Courage the Cowardly Dog". These should combine both episodes' metadata into the episode




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

INTERACTIVE PLAYER

The format — Netflix's `interactiveVideoMoments` (the one internal format Netflix used for all its interactive titles; see the "standard — scope" note below for what "standard" does and doesn't mean here). Adopting it means the ripped content people actually have works on day one. Two JSON files split the work and you need BOTH:
- manifest.json = the segment skeleton: every segment's startTimeMs/endTimeMs in the video, defaultNext + a weighted `next` map, interactionZones (when choices are clickable), initialSegment, viewableId. Times ALL segments, including pure pass-through ones. (Bandersnatch: 250 segments.)
- info.json = the interactivity layer: momentsBySegment (choices, plus tutorials/notifications, each with its own on-screen startMs/endMs), preconditions (boolean/arithmetic expression trees over state: eql/lt/gt/and/or/not/sum/mult), segmentGroups (conditional routing when a segment ends), stateHistory (persistent + global vars — persistent = Bandersnatch's "remembers your choices"), playerControls. Only lists segments that have a moment (Bandersnatch: 208).
- a choice = { text, segmentId (target to jump to), impressionData (state changes to apply on selection) }.
- why both: manifest times every segment (info omits pass-through ones); info has the choice/condition/state logic manifest lacks.

Standard — scope (so this isn't overstated): interactiveVideoMoments is the de-facto standard ONLY within the narrow niche of Netflix-style branching video and the community that preserves/emulates it. Netflix made the prominent interactive titles (Bandersnatch, Minecraft Story Mode, etc.) all in this one internal format; the community reverse-engineered it; and all the circulating content + tooling (Interactive-Player/Maker, the archives) standardized on it. It is NOT an open/published spec and NOT a universal interactive-media standard — Netflix never published it; it just got reverse-engineered. Interactive video broadly is fragmented with no shared interchange format: Eko (commercial platform, own format), H5P (open-source, education), Twine (interactive fiction — text/HTML, not video), FMV games like Late Shift (bespoke per-game engines), DVD/Blu-ray seamless branching (old disc-spec feature), deprecated YouTube annotations — each a proprietary island. So adopting this format buys compatibility with the existing preserved-Netflix content (the right target, because that's where the content actually is), NOT interoperability with the broader interactive-media world (which doesn't interoperate anyway).

What waverunner needs to build (4 pieces):
1. Format reader — parse manifest + info into Rust structs (mirror Interactive-Player's Models.cs).
2. State + precondition engine — evaluate the expression trees, track persistent/global state, resolve segmentGroups. Small (see Interactive-Player PreconditionChecker.cs).
3. Choice-overlay UI — a timed countdown decision overlay in React, rendered in waverunner's own style from each choice's `text` (no need for Netflix's sprite assets).
4. Seek-based playback driver — libmpv seeks to a segment's startTimeMs, plays, watches for the choice window, applies the pick (or defaultNext on timeout), seeks to the next segment. Same loop as the reference player.

Where the content comes from: community preservation archives / Discords (e.g. "Netflix Interactive Archive"). Two artifacts that MUST be a matched pair — the metadata's absolute-ms timestamps are authored against one specific video encode, so a mismatched video + metadata makes choices fire at the wrong times: (a) the internal video (all branches concatenated; ~5h17m for Bandersnatch), (b) the metadata (manifest.json + info.json). The sprite PNGs/fonts in the packs are cosmetic (see the assets-layer note below); direct.json is just a pointer to the video path. Minimal user-supplied set = video + manifest.json + info.json.

The assets layer (purely cosmetic — waverunner does NOT need it): beyond the video + JSON, a real Netflix interactive also has a UI-asset layer, mirrored from Netflix's CDN at assets.nflxext.com/ffe/oui/interactive/<title>/<asset_type>/<platform>/<date>/ (a full mirror across all titles is ~16k files / 787MB; Bandersnatch is the `bs/` folder, ~68 files / 11MB). Two kinds:
- UI art (choicepoint sprites + inline_tutorial/tooltip + playercontrols) = the visual styling of the choice overlay drawn ON TOP of the video during a decision: the button/underline graphics and their default→focused→selected states, the countdown timer bar, the "Get ready to click!" tutorial prompts, the player-control icons. For Bandersnatch the option TEXT itself comes from info.json — these PNGs are only the decorative chrome around it. info.json references them by URL (e.g. assets.nflxext.com/ffe/oui/interactive/general/inline_tutorial/x2/.../cursor_2x.png), and the .intpak the Interactive-Player extracts is essentially Bandersnatch's `bs/` assets repackaged (the ~150 segment-coded PNGs that land next to your video on install).
- Sounds (per-title <title>/audio/.../m4a or shared general/audio/m4a, .m4a files) = short UI sound EFFECTS the player mixes OVER the film's own audio during interactive moments — NOT part of the movie's soundtrack. Named: sfx_appears (choices pop on), sfx_focus (moving between options), sfx_select (committing a choice), sfx_timeout (timer expires with no pick), sfx_tutorial (the prompt), plus shared reengagement_notification ("still watching?").
waverunner renders its own choice buttons/timer from the info.json `text` and uses its own (or no) sound cues, so none of this art/audio is required — it's only relevant if you ever want to mimic the authentic Netflix look-and-feel. Same copyright footing as the rest: Netflix's assets, fine to keep locally for study, never bundle/redistribute.

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
