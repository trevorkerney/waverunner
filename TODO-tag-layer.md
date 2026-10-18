# TODO: waverunner's own tags (the tag-layer redesign)

Written 2026-10-12, when you paused. **Status 2026-10-15: BUILT (uncommitted), not yet
live-tested.** The decisions below were answered that day and the build landed in one go;
the "What was built" section at the top is the current state. Everything under it is the
design record as written on 2026-10-12.

## What was built (2026-10-15)

Backend compiles clean (`cargo check`, no warnings), 40 unit tests pass, `tsc` clean.

- **`src-tauri/src/tag_fields.rs`** (new): the field registry — one declaration per
  per-track field (key, label, shape text/long_text/list/int, scope track/disc/release/album,
  how the scanner reads it, how the tag writer writes it, app_only / grouping / editable /
  id flags). Fields: title, credits, album_artists, album, track_number, disc_number, date,
  genres, disc_subtitle, comment, lyrics, composer, label, catalog_number, bpm, the three MB
  ids, and the app-only `release_key` (which release folder a track lives in) and
  `identity_key` (the token that binds tracks into one album). Stored form is text (lists
  JSON, ints decimal, "" = none). Compilation flag left out (your call).
- **Overlay at the scanner's input** (`music.rs`): `scan_base` reads each file, applies the
  track's user tier (and MusicBrainz tier) BEFORE grouping, so membership, disc numbers,
  album artists and everything else derive from effective values. Columns are a cache the
  scanner alone writes (full or scoped). The tag tier still records what the FILE says, and
  a field whose file tag changed since the last scan drops its upper tiers (rule kept).
- **Grouping key**: `id:<token>` (identity_key) > `rg:<release group>` > tag key. Combines,
  separates and same-group folds are all expressions of this.
- **Scoped rescan**: every edit runs `rescan_music_library(..., scope)` over the folders it
  touched (plus albums sharing tokens / release keys), under a per-library scan lock, so
  edits, combines, splits and separates apply ON THE SPOT. The staged-directive machinery
  (`pending_change`, STAGED = IMMUTABLE, unstage, the red footer) is gone.
- **Edits** (`music_edit.rs`): `apply_track_edits(library_id, edits[], label)` is the one
  write (track editor, bulk editor, structural actions); History kind `layer_edit`
  (before/after per track/field), undone from History. Album-level edits write through:
  genres → every track's `genres`; artists → every track's `album_artists`; title/date/type
  stay album-level. Combine = identity token on every track (+ `release_key` in merge mode,
  + disc names in the same write); split edition = fresh token; versions-mode carries pins,
  prefs and notes to the keeper; merge mode appends the source's release note.
- **Matching** (`music_mb.rs`): a release match writes the per-track mb tier (ids, date,
  label, catalogue number, medium titles) and album artists; a REGROUP queue folds albums
  that both ended up release-matched to one group (toast `music-auto-combine`); unmatch
  clears the tracks' mb tier and regroups.
- **Tag writer** (`music_tagwrite.rs`, rewritten): intents from the effective tiers of every
  registry field, frames named by the registry; album title to the default release only
  when a tier above the tags disagrees; read-back stored quietly as the tag tier.
- **Schema**: migrations removed; `SCHEMA_EPOCH = 1` in `db.rs`. An older DB is MOVED
  ASIDE to `waverunner.db.pre-epoch-1-<unix>.bak` (plus -wal/-shm), never deleted, and a
  fresh database is created — **every library, video ones too, has to be re-added.**
- **Frontend**: `TrackEditDialog` is registry-driven (`get_tag_fields`, `get_track_edit`,
  `apply_track_edits`; "File tag" / "MusicBrainz" hints per field); new `BulkEditDialog`
  (`src/components/music/BulkEditDialog.tsx`) over a multi-selection on the album page
  (Ctrl/Cmd-click, Shift-click, selection strip with Edit / Select all / Clear): disc
  number, renumber in list order, album (pick an existing album to take its tag + album
  artists), album artists, artists, move to release, and every other registry field;
  `MusicRelease` carries `folder_path`, `label_name`, `catalog_number`. Combine / merge /
  separate / split dialogs say "applied now, undo from History"; the pending-work strip,
  sidebar badge and metadata footer only know the matching-pass queue; the Sources page
  labels every registry field.

### Live tests owed

1. Start the app: the old dev DB is moved aside and the libraries are gone. Re-add the Music
   library (and any video ones).
2. Star Wars: Albums page → select the nine → Combine → Merge, keeper = Episode I → disc
   names optional → Combine. Expect one album at once.
3. On the box's album page: select the Episode II tracks → Edit N tracks → Disc number 2;
   repeat per the disc map (Ep III → 3, IV side 1 → 5, IV side 2 → 6, V side 1 → 7, V side
   2 → 8, VI → 9/10). Expect the disc headers to regroup immediately.
4. Match the album to the box release `92619ab0-…`; mark it partial (disc 4 is the DVD).
   Expect the digital collection to fold in as a second release (auto-combine toast).
5. Edit one track's album artist to another artist → it moves albums at once; undo from
   History → it comes back.
6. Tag writing on a small album: enable in Library settings → Write to files → rescan →
   Sources page shows tiers unchanged.

### Known gaps

- `release_key` is set by the bulk editor's "Move to release" only; the track editor hides
  it. `identity_key` is never typed (combine / separate set it).
- The History page labels the new kinds "tag edit" / "album fields" / "artist split".
- A file moved externally in the same rescan misses its overlay until the next one (same
  caveat as the hash rescue).

## The idea, in your words

> I want to potentially redesign the underlying system so that waverunner essentially has
> its own tags, all of them. Everything should come in exactly how it does now, but the user
> should be able to change everything about tracks. At the end of the day I want to be able
> to fix this star wars album (as in merge it all into a single album) within waverunner.
> I'd need to be able to change the disc numbers of tracks in bulk. Waverunner should have
> its own tier of tags that override the actual tags. This would need to be able to be
> applied back down to the actual tags if the user has that enabled and want to do so.

## Why now: the Star Wars box

Folder: `A:\public\media\music\John Williams\Star Wars. The Ultimate Soundtrack Collection
(Sony Classical 88875167301, 2016)`. It is one 11-disc box, but the rip was tagged per film,
and Episodes IV and V have *different* ALBUM tags on their two halves, so the scanner made
**nine albums** out of it (dev DB, library `18db1adfb548d868`, 2026-10-12, none MB-matched):

| album id | title (tag) | sub-folder | tracks | disc tag | MB medium it is |
|---|---|---|---|---|---|
| 66372 | Star Wars - Episode I The Phantom Menace | 01. Episode I | 17 | 1 | 1 |
| 66390 | Star Wars Episode II: Attack Of The Clones (OMPS) | 02. Episode II | 13 | 1 | 2 |
| 66404 | Star Wars: Episode III - Revenge Of The Sith (OMPS) | 03. Episode III | 15 | 1 | 3 |
| 66305 | Star Wars, Episode IV: A New Hope: (OMPS) | 04. Episode IV | 13 | 1 | 5 (side 1) |
| 66293 | Star Wars, Episode IV - A New Hope (OMPS) | 04. Episode IV | 11 | 2 | 6 (side 2) |
| 66319 | Star Wars, Episode V: The Empire Strikes Back | 05. Episode V | 11 | 1 | 7 (side 1) |
| 66331 | Star Wars: Episode V: The Empire Strikes Back | 05. Episode V | 12 | 2 | 8 (side 2) |
| 66344 | Star Wars, Episode VI: Return of the Jedi | 06. Episode VI | 27 | 1–2 | 9 + 10 |
| 66521 | Interviews with John Williams and Harrison Ford | 07. Bonus Disc | 5 | 11 | 11 |

124 tracks = the box's 140 minus the 16 on disc 4, which is a DVD ("Star Wars: A Musical
Journey") and was never ripped. The interviews disc is tagged 11/11 on purpose: it already
sits where MusicBrainz puts it.

MusicBrainz (saved responses in `temp/sw/box.json` and `temp/sw/digital.json`, gitignored):

- Box: release `92619ab0-f2d6-423d-a901-c08a5eb694bd`, "Star Wars: The Ultimate Soundtrack
  Collection", 2016-01-08, 11 media: CD×3 (Ep I–III), DVD-Video (A Musical Journey), CD×6
  (Ep IV–VI as side 1 / side 2 each), CD (Interviews).
- Digital: release `1ca82006-bf3d-45e2-b3d4-797fe95ad670`, "Star Wars: The Ultimate Digital
  Collection", 2016-01-08, 1 medium, 89 tracks. Your copy (`John Williams - Star Wars The
  Ultimate Digital Collection (2016) [FLAC] {2016 HDtracks}`, album 58271) matches it exactly.
- Both are in the same release group (id starts `bd83cae0`).
- The digital collection is **not** redundant: its Ep IV–VI are the original 1977/80/83 album
  programmes (only 2/6/3 recordings in common with the box's full-score discs), and "Lapti
  Nek" and "Ewok Celebration and Finale" are not on the box at all.

Two ways to resolve it, from the earlier analysis:

- **A. One box album** (the one you want): renumber the discs to match the MB media, merge
  the nine albums into one, match it to the box release with disc 4 as a partial match. The
  same-group auto-combine will then card it with the digital collection as two releases of
  one album, which is correct. Disc map: Ep I → 1 (already), Ep II → 2, Ep III → 3,
  IV side 1 (66305) → 5, IV side 2 (66293) → 6, V side 1 (66319) → 7, V side 2 (66331) → 8,
  VI disc 1 → 9, VI disc 2 → 10, Interviews stays 11.
- **B. Per film**: merge the IV halves and the V halves, match each film to its original
  release, ignore the interviews. Needs no renumbering but leaves nine albums as six.

Today A requires retagging DISCNUMBER in the files. That is the thing you want to stop
having to do.

## What waverunner currently sends you to the files for

1. Which album a track belongs to (the ALBUM tag is the membership; moving a track or making
   it loose is a retag). Track-to-album moves were explicitly declared dead earlier.
2. How albums group (same album-artist and album tags = one album). Two works sharing a name,
   or one work split across mismatched tags like Ep IV / V here.
3. Disc and track numbers. The app never renumbers; merges are refused on a shared
   disc+track slot ("retag one of them").
4. A wrong name on specific files (alias is an everywhere rule, not a per-file fix).
5. Incomplete tags (File problems: "fix the tags externally and rescan").
6. Damaged and stacked-ID3 files ("rewrite the tag at the source, then rescan").
7. Files the scan skipped (Needs attention page).
8. Duplicate albums (remove one folder at the source).
9. Track lists that don't line up with MB ("fix the tags at the source, rescan, Re-check").
10. The edit model itself: "Edits are saved in waverunner, not your files. Retagging a field
    at the source replaces the edit on it."

Items 1–3 are what this redesign is about. 4–9 stay file problems (there is no edit that
fixes a missing file, a stacked tag or a duplicate folder).

## What already exists (about two thirds of the idea)

- **A user tier on tracks and albums.** `field_override` is a tiered value store:
  `tag < mb < user`. Track fields: title, credits, track_number, disc_number
  ([music_edit.rs:30](src-tauri/src/music_edit.rs#L30)). Album fields: title, release_date,
  album_type, genres, artist_credits. Artist: title. Disc names have their own pref table.
  The edit dialog is [EditDialogs.tsx:329](src/components/music/EditDialogs.tsx#L329) over
  `set_track_fields` ([music_edit.rs:1420](src-tauri/src/music_edit.rs#L1420)).
- **Overrides survive rescans by re-stomping.** Every bulk track write ends with
  `reapply_track_overrides` ([music_edit.rs:263](src-tauri/src/music_edit.rs#L263)), which
  writes the resolved values (user, else mb) back onto the `track` columns, including
  disc_number and a recomputed sort_order.
- **Disc overrides already drive merging and matching.** The merge collision gate reads the
  track columns ([music_edit.rs:2989](src-tauri/src/music_edit.rs#L2989); same gate in
  `merge_album_release` at [music_edit.rs:4089](src-tauri/src/music_edit.rs#L4089)). Release
  matching pairs our tracks to MB tracks by (disc, position) from the same columns
  ([music_mb.rs:3700](src-tauri/src/music_mb.rs#L3700)), then writes MB's own disc/position
  into the mb tier. So renumbering is exactly what makes the box line up with its 11 media.
- **The push-down exists.** `music_tagwrite.rs` (per-library opt-in, `TagWriteDialog`)
  writes title, artists (ARTIST + ARTISTS frames), track and disc numbers, album, album
  artists, date, genres and MB ids ([apply_intents, 876](src-tauri/src/music_tagwrite.rs#L876)).
  It writes on a copy and swaps, re-reads each file, stores the tag tier quietly
  (`set_tag_tier_quiet`, no invalidation), drops user edits the file now carries when MB
  doesn't disagree, and re-keys combine directives when the album identity changed
  ([rekey_combines, 1011](src-tauri/src/music_tagwrite.rs#L1011)). Gaps: no DISCTOTAL /
  TRACKTOTAL, stacked-ID3 files refused.
- **A policy already in force.** When a file's tag for a field changes externally, the mb
  and user tiers on that field are dropped: "the base moved, the answers were about the old
  base" ([store_tag_tier, 61](src-tauri/src/music_edit.rs#L61)). A changed TITLE also drops
  the recording match. A changed album title/credits forgets the album's MB match.

### What is missing

- **Coverage.** No user tier for a track's ALBUM / ALBUMARTIST (membership), nor for
  track-level date, genres, compilation flag. (Tracks have no date/genre columns; those two
  only matter through the album derivation and the file.)
- **Where the layer applies.** It is stomped on *after* the scanner derived everything from
  the raw tags. Grouping happens in `assemble_albums`
  ([music.rs:634](src-tauri/src/music.rs#L634)) from the file's ALBUM/ALBUMARTIST, so
  membership can't be overridden, and derived facts miss the overrides: a disc override
  changes the track rows but not `album_release.disc_count`, which comes from the raw read
  ([release_disc_count, 1257](src-tauri/src/music.rs#L1257)).
- **Bulk editing.** There is no multi-select on the album page, only one selected row
  ([AlbumDetailPage.tsx:122](src/components/music/AlbumDetailPage.tsx#L122)).
  `useTrackSelection.ts` is just deselect-on-background-click.
- **An in-app re-key** of combine directives when an edit changes an album's tag identity
  (the tag writer does it; an in-app ALBUM override would have to as well).

## The design I recommended

**Move the user tier to the scanner's input instead of building a second system.** Right
after each file is read (`read_track`, [music.rs:334](src-tauri/src/music.rs#L334), called
from the worker loop in `scan_base`), overlay that track's user-tier values onto the scanned
values, looked up by path the same way the stamp gate looks up prior hashes
([rescan_music_library, 4229](src-tauri/src/music.rs#L4229) builds that map). Keep the raw
read alongside: the tag tier must stay "what the file says" or the Sources view and the
external-retag invalidation break.

Then every derivation runs on effective tags with no new code: grouping, identity
(`album_identity`), disc count, release-date votes, credit parsing, loose-vs-album. ALBUM and
ALBUMARTIST become two more fields, and moving tracks between albums falls out of the grouping,
rescan-proof by construction because track ids survive rescans (hash rescue). That is the
enabler the dead "album reassignment" plan was waiting on. The post-hoc stomp stays as the
instant path for presentation fields.

Rules to keep:

- **Don't fold the combine system into tag overrides.** Versions-mode would reduce to "same
  effective key across folders" (the scanner's own rule), but merge-mode needs two folders
  poured into one release, which tags can't express. Directives stay; the layer is additive.
- **"Rename album" stays presentation.** The album-level title edit does not change tag
  identity. Retagging ALBUM on the tracks is a separate, explicit action.
- **Keep the external-retag policy** (file changes a field → waverunner's edit on it drops).
- Same caveat the stamp gate has: a file moved externally in the same rescan misses its
  overlay until the next one.

**The one hard part: immediacy of structural edits.** Numbers, titles, dates, genres can stay
instant (column stomps). A membership change alters grouping, and the only derivation is the
scanner. Two routes:

1. **Stage → next rescan**, exactly like combines and splits (STAGED = IMMUTABLE, pending
   list, undo = drop the override). Zero new derivation code. Cost: the wait; read-tags still
   probes every file.
2. **Immediate in-process reconcile**: rebuild `ScannedAlbum`s for the touched albums from DB
   rows + effective tags and call `reconcile_album`
   ([music.rs:1815](src-tauri/src/music.rs#L1815)), which already re-parents existing track
   rows and rebuilds releases. Feasible, medium-sized: emptied albums to sweep, a target album
   that doesn't exist yet (`insert_album`), artist regrouping from credits.

Recommendation: 1 first, 2 as a later upgrade if the wait annoys.

## Minimum build if you only want Star Wars fixed

Everything but the first step exists.

1. A bulk "set disc number on these tracks / this release" command: loop the existing
   per-track user override (`set_track_fields` → `reapply_track_overrides`), plus
   multi-select on the album page, or a per-release "Disc number" field in Edit album.
2. Merge the nine into one with the combine dialog's **merge** mode (the gate now passes).
3. Match the keeper to the box release; mark disc 4 partial.
4. Optional: Write to files on the keeper. ALBUM and DISCNUMBER go into the files, the
   next rescan reads one album, and the combine directive becomes a no-op.

Known wart until the layer moves upstream: `disc_count` on the release header lags the
overrides until a rescan.

## Build principles (settled 2026-10-15)

- **Go ahead.** They want this built. Cache model stays: tiers are the truth for editable
  fields, the regular columns are a cache of the resolved value.
- **Be smart about cache invalidation.** The columns must be rewritten at every point the
  resolved value can change, and nowhere else: a scan (which now writes resolved values
  directly, no tag-then-stamp second write), an edit (override + column in one step), a match
  or unmatch (mb tier moves), a reset (user tier deleted), a tag write (tag tier synced). One
  resolution function, called from those points. No "re-stomp after every bulk write" hook.
- **Best solution, not least disruptive.** Standing rule from them: refactor adjacent systems
  when the result fits better, even at the cost of a library reset or reimport. Warn before
  anything that forces a reset; they veto when it's too much.

## Open decisions (yours)

1. **External retag vs waverunner's layer.** Keep today's rule (the file changing a field
   drops the edit on that field) or make the layer always win. Recommended: keep.
2. **Membership edits.** Staged to the next rescan first, in-process reconcile later, or
   build the immediate path now. Recommended: stage first.
3. **Scope of "everything".** Full menu from `ScannedTrack`
   ([music.rs:44](src-tauri/src/music.rs#L44)): title, artists/credits, album artists,
   album, track no, disc no, date, genres, disc subtitle, compilation flag, MB ids. Which of
   date / genres / compilation do you actually want at track level?
4. **The bulk editor's first cut.** Multi-select + set disc N on selected, renumber tracks in
   list order, set album / album artist. Anything else?

## Code map

- Scanner: `src-tauri/src/music.rs` — `ScannedTrack` 44, `read_track` 334, `album_key` 611,
  `assemble_albums` 634, `scan_base` 724, `insert_track_rows` 1309,
  `write_track_side_tables` 1360 (stores the track TAG tier), `write_album_tag_tier` 1451,
  `scanned_identity` 1472, `reconcile_album` 1815, `fold_album` 3582,
  `apply_album_combines` 3788, `rescan_music_library` 4218.
- Tier store + edits: `src-tauri/src/music_edit.rs` — field lists 30–32, `store_tag_tier`
  61, `invalidate_field` 81, `set_tag_tier_quiet` 111, `drop_redundant_user_edits` 128,
  `resolved_values` 236, `reapply_track_overrides` 263, `get_track_edit` 1336,
  `set_track_fields` 1420, `reset_track_fields` 1489, `stage_album_combine` 2863,
  `merge_album_release` 4035.
- Matching: `src-tauri/src/music_mb.rs` — `apply_release_credits` ~3686 (pairing by disc +
  position, mb tier of title/track_number/disc_number).
- Tag writer: `src-tauri/src/music_tagwrite.rs` — `label` 153, `current` 197,
  `album_intents` 416, `track_intents` 504, `prepare_album` 553, `apply_intents` 876,
  `write_file` 945, `sync_track_tier` 989, `rekey_combines` 1011, `execute` 1029.
- Frontend: `src/components/music/EditDialogs.tsx` (Edit track / Edit album),
  `AlbumDetailPage.tsx` (single select), `useTrackSelection.ts`, `TagWriteDialog.tsx`,
  `CombineSelectedDialog.tsx`, `SourcesPage.tsx` (the tier matrix).
- Schema: `field_override (entity_id, field, tier, value, updated_at)` in `db.rs`;
  `album_identity`, `album_combine`, `release_match`, `album_match_gap`.

## Parked (wanted, out of scope for this redesign)

- **A scan changelog.** Something that documents what a rescan changed: edits dropped because
  a file's tag moved underneath them (decision 1 keeps that rule), albums regrouped or
  renamed by a retag, tracks rescued by hash after a move, matches forgotten because an
  identity tag changed. Today these happen silently. Noted 2026-10-15; build after the layer.

## Housekeeping when this goes ahead

- The memory note "album reassignment plan: DEAD, retag + rescan is the answer" gets flipped.
- `TODO.md` is yours; this file is separate so it doesn't touch it.
- Live tests still owed from before (unrelated to this): auto-combine on a release match,
  same-group chip, settle lock, ignored-on-match, duplicate cards, tag writer first run.
