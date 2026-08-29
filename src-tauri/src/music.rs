//! Music library — tag-first scanner and browse queries.
//!
//! Tags are the source of truth, folders are discovery. The expected layout is
//! the industry-standard one (Picard/Lidarr/beets output; what Plex, Jellyfin,
//! and Navidrome read): `<music folder>/<Artist>/<Album>/…` where an album
//! folder holds loose audio files, optionally split across disc subfolders
//! (CD1, Disc 2, …) — exactly ONE release per folder. Editions live as SIBLING
//! album folders ("Kid A", "Kid A (2021 Remaster)"); a grouping pass merges
//! siblings into one album (with the version picker) when their embedded
//! MusicBrainz release-group ids prove they're the same album. No id → they
//! stay separate albums, which is exactly what the incumbents do. Title-based
//! merging is deliberately absent: stripping parentheses would fuse
//! "Weezer (Blue Album)" and "Weezer (Green Album)".
//! Terminology: our `album` = MusicBrainz "release group", our `album_release`
//! = MusicBrainz "release" (the table name dodges the RELEASE SQL keyword).
//!
//! Files that fail the tag bar (album artist/album/title/track number) are not
//! imported — they land in music_scan_issue for the user to fix in a real
//! tagger and rescan. No filename guessing. Audio in a non-disc subfolder of
//! an album is a layout violation and is reported, not guessed about.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::commands::{
    delete_cached_images_for_entry, generate_sort_title, is_image_file, is_media_file,
    is_scannable_dir, AUDIO_EXTENSIONS,
};
use crate::AppState;

// ---------------------------------------------------------------------------
// Scanned (in-memory) shapes
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ScannedTrack {
    /// Path relative to the library base folder (matches track.file_path).
    pub rel: String,
    pub abs: PathBuf,
    /// Title tag; empty = untitled (the UI shows the file name as a
    /// display-only label — filenames are never parsed into metadata).
    pub title: String,
    pub artist: Option<String>,
    /// ALBUMARTIST tag, falling back to ARTIST; empty = artist-less.
    pub album_artist: String,
    /// ALBUM tag; empty = no album — the track imports as a loose track.
    pub album: String,
    /// None = untagged; such tracks order by filename within their container.
    pub track_number: Option<i64>,
    /// Disc number: tag first, disc-folder number as fallback, else 1.
    pub disc_number: i64,
    pub date: Option<String>,
    pub genres: Vec<String>,
    pub duration_secs: i64,
    pub codec: String,
    pub bitrate_kbps: Option<i64>,
    pub sample_rate_hz: Option<i64>,
    pub mb_recording_id: Option<String>,
    pub mb_release_id: Option<String>,
    pub mb_release_group_id: Option<String>,
    /// iTunes-style compilation flag (cpil/TCMP/COMPILATION).
    pub flag_compilation: bool,
    /// Ordered artist credits: main artist(s) first, then features (parsed
    /// from the artist tag, multi-value ARTISTS frames, and the title's
    /// "(feat. …)" parenthetical).
    pub credits: Vec<String>,
    /// Scanned from a sounds-typed base folder (ambient/rain/etc) — the
    /// album/container this lands in gets sound-marked and excluded from
    /// music surfaces. Set by scan_base from the base's type, not by tags.
    pub sound: bool,
    /// Set by apply_artist_splits when `album_artist` matched a split (user
    /// directive or ';' multi-value): the full ordered member list. The album
    /// these tracks form gets them as album_artist_credit rows; album_artist
    /// itself is rewritten to members[0] (the canonical parent). Empty = the
    /// album artist is a single artist, no credit rows written.
    pub album_artist_credits: Vec<String>,
    /// Audio-region content fingerprint ("a:…"), or full-file ("f:…") when
    /// the container couldn't be parsed. None = unreadable. A rescan HINT for
    /// identity migration (moves/renames), never identity itself.
    pub audio_hash: Option<String>,
    /// (size, mtime) captured at read time — the rescan gate: a file whose
    /// stamp is unchanged next scan reuses its stored hash instead of being
    /// re-read end to end. None = stat failed.
    pub content_size: Option<i64>,
    pub content_mtime: Option<i64>,
}

#[derive(Debug)]
pub struct ScannedRelease {
    /// None = the plain/unnamed version (loose files, or a version subfolder
    /// named exactly like the album folder).
    pub label: Option<String>,
    /// Folder holding this release, relative to the library base.
    pub folder_rel: String,
    /// Absolute folder, for cover lookups.
    pub folder_abs: PathBuf,
    pub tracks: Vec<ScannedTrack>,
}

#[derive(Debug)]
pub struct ScannedAlbum {
    pub folder_rel: String,
    pub folder_abs: PathBuf,
    pub releases: Vec<ScannedRelease>,
    /// Index into `releases` of the default version.
    pub default_release: usize,
    /// (album artist, album title) pinned when a combine folds another album
    /// in. Identity is normally a majority vote of the tracks' tags, which
    /// the incoming tracks would swing — the KEEPER's identity has to
    /// survive, both for what the user sees and so further directives
    /// targeting this album still match it.
    pub identity_override: Option<(String, String)>,
}

pub struct ScanIssue {
    pub file_path: String,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Artist-credit parsing
// ---------------------------------------------------------------------------

/// A feature clause becomes ONE credit, verbatim. Nothing is split.
///
/// Every candidate separator turned out to be punctuation inside real names as
/// well as a delimiter between them. Commas: of the eight comma-bearing feature
/// clauses in a 2500-track library, six were the single artist "Tyler, The
/// Creator" — splitting them invented a person called "The Creator" who
/// collected six credits. Ampersands: "Rob Bailey & The Hustle Standard".
/// Semicolons: ";^)" and "DJ Mighty ;)" are real MusicBrainz artists, and
/// splitting those doesn't mis-split so much as silently RENAME them to "^)"
/// and ")".
///
/// So the app doesn't guess. An unsplit clause shows up as one oddly-named
/// credit in the metadata center's unidentified list, where it can be split by
/// hand; a wrong split fabricates artists that nobody notices. Prefer the
/// visible failure.
fn split_feat_list(s: &str) -> Vec<String> {
    let name = s.trim();
    if name.is_empty() {
        Vec::new()
    } else {
        vec![name.to_string()]
    }
}

/// The feature clause of a parenthetical: "… (feat. A & B) …" → "A & B".
/// ASCII-lowercase for matching keeps byte indices aligned with the original.
fn title_feat_clause(title: &str) -> Option<String> {
    paren_feat_span(title).map(|(start, end, _)| title[start..end].trim().to_string())
}

/// Locate a "(feat. …)" / "[ft. …]" segment: returns (clause start, clause
/// end, full segment span end — one past the closing bracket).
fn paren_feat_span(s: &str) -> Option<(usize, usize, (usize, usize))> {
    let lower = s.to_ascii_lowercase();
    for (open, close) in [("(", ")"), ("[", "]")] {
        for marker in ["feat. ", "feat.", "feat ", "featuring ", "ft. ", "ft "] {
            let pat = format!("{open}{marker}");
            if let Some(i) = lower.find(&pat) {
                let start = i + pat.len();
                let end = s[start..].find(close).map(|j| start + j).unwrap_or(s.len());
                if !s[start..end].trim().is_empty() {
                    let seg_end = (end + close.len()).min(s.len());
                    return Some((start, end, (i, seg_end)));
                }
            }
        }
    }
    None
}

/// Pull every parenthesized feat clause OUT of an artist display string:
/// "Frank Ocean (feat. Beyoncé)" → ("Frank Ocean", ["Beyoncé"]). Without this
/// the whole string reads as one artist name and pollutes the artist list.
fn extract_paren_feats(s: &str) -> (String, Vec<String>) {
    let mut remaining = s.to_string();
    let mut names = Vec::new();
    while let Some((start, end, (seg_start, seg_end))) = paren_feat_span(&remaining) {
        names.extend(split_feat_list(remaining[start..end].trim()));
        remaining.replace_range(seg_start..seg_end, " ");
    }
    (remaining.split_whitespace().collect::<Vec<_>>().join(" "), names)
}

/// Decompose an artist display string into its main credit and any feature
/// names: parenthesized clauses ("Frank Ocean (feat. Beyoncé)") first, then
/// bare "Main feat. Others" markers. The main part comes back VERBATIM —
/// never split on commas or ampersands (Earth, Wind & Fire). Feat markers are
/// unambiguous, so this is also safe to apply to grouping identity: no band
/// is named "X Feat. Y".
fn strip_feats(s: &str) -> (String, Vec<String>) {
    let (remaining, mut feats) = extract_paren_feats(s);
    let lower = remaining.to_ascii_lowercase();
    let split_at = [" feat. ", " feat ", " ft. ", " ft ", " featuring "]
        .iter()
        .filter_map(|m| lower.find(m).map(|i| (i, m.len())))
        .min();
    let main = match split_at {
        Some((i, len)) => {
            feats.extend(split_feat_list(remaining[i + len..].trim()));
            remaining[..i].trim().to_string()
        }
        None => remaining.trim().to_string(),
    };
    (main, feats)
}

/// Ordered, de-duplicated credit list for one track: main artist(s) first,
/// then features from the artist tag, multi-value ARTISTS frames, and the
/// title parenthetical.
fn parse_credits(artist_display: &str, extra_artists: &[String], title: &str) -> Vec<String> {
    let mut credits: Vec<String> = Vec::new();
    let push = |name: &str, credits: &mut Vec<String>| {
        let name = name.trim();
        if !name.is_empty() && !credits.iter().any(|c| c.eq_ignore_ascii_case(name)) {
            credits.push(name.to_string());
        }
    };

    let (main_part, feats) = strip_feats(artist_display);
    // Main credit splits only on ';' (multi-value convention) — never on
    // commas or ampersands.
    for p in main_part.split(';') {
        push(p, &mut credits);
    }
    for p in feats {
        push(&p, &mut credits);
    }
    for a in extra_artists {
        push(a, &mut credits);
    }
    if let Some(clause) = title_feat_clause(title) {
        for p in split_feat_list(&clause) {
            push(&p, &mut credits);
        }
    }
    credits
}

// ---------------------------------------------------------------------------
// Tag reading
// ---------------------------------------------------------------------------

/// Read one audio file's tags + properties. Err(reason) = failed the tag bar.
/// `prior` is the previous scan's (hash, size, mtime) for this path: when the
/// file's current stamp matches, the stored hash is reused and the audio
/// region is never read — the tag probe (headers + tag blocks, kilobytes) is
/// all that touches the disk. Retagging bumps mtime, so changed tags always
/// re-read AND re-hash naturally.
fn read_track(
    abs: &Path,
    rel: &str,
    disc_folder_no: Option<i64>,
    prior: Option<&(String, i64, i64)>,
) -> Result<ScannedTrack, String> {
    let tagged = Probe::open(abs)
        .map_err(|e| format!("unreadable file: {e}"))?
        .read()
        .map_err(|e| format!("unreadable tags: {e}"))?;

    let props = tagged.properties();
    let duration_secs = props.duration().as_secs() as i64;
    let bitrate_kbps = props.audio_bitrate().map(|b| b as i64);
    let sample_rate_hz = props.sample_rate().map(|s| s as i64);
    let codec = format!("{:?}", tagged.file_type()).to_lowercase();

    // Universal import: missing tags degrade to fallbacks instead of
    // excluding the file. Only literally unreadable files (the two errors
    // above) are refused. A file with no tag block at all imports as an
    // untitled, artist-less loose track.
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let title = tag
        .and_then(|t| t.title())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let artist = tag
        .and_then(|t| t.artist())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // Feature clauses never define grouping identity: "XXXTENTACION Feat.
    // Trippie Redd" groups under XXXTENTACION and the features ride as track
    // credits (appears-on) — no joint artist is ever born from a feat marker.
    let album_artist_raw = tag
        .and_then(|t| t.get_string(&ItemKey::AlbumArtist))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| artist.clone())
        .unwrap_or_default();
    let (album_artist, album_artist_feats) = strip_feats(&album_artist_raw);
    let album = tag
        .and_then(|t| t.album())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let track_number = tag.and_then(|t| t.track()).map(|t| t as i64).filter(|t| *t > 0);

    let disc_number = tag
        .and_then(|t| t.disk())
        .map(|d| d as i64)
        .filter(|d| *d > 0)
        .or(disc_folder_no)
        .unwrap_or(1);

    // Best release date available: full date tags first, bare year last.
    let date = tag
        .and_then(|t| {
            t.get_string(&ItemKey::RecordingDate)
                .or_else(|| t.get_string(&ItemKey::OriginalReleaseDate))
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| tag.and_then(|t| t.year()).map(|y| y.to_string()));

    let genres: Vec<String> = tag
        .into_iter()
        .flat_map(|t| t.get_strings(&ItemKey::Genre))
        .flat_map(|g| g.split(';'))
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
        .collect();

    let grab = |key: &ItemKey| {
        tag.and_then(|t| t.get_string(key))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    // Multi-value ARTISTS frames (Picard writes these alongside the display
    // ARTIST) are the most reliable per-artist source.
    let extra_artists: Vec<String> = tag
        .into_iter()
        .flat_map(|t| t.get_strings(&ItemKey::TrackArtists))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut credits = if artist.is_some() || !album_artist.is_empty() || !extra_artists.is_empty() {
        parse_credits(artist.as_deref().unwrap_or(&album_artist), &extra_artists, &title)
    } else {
        Vec::new()
    };
    // Features stripped from the album-artist tag still deserve credit.
    for f in album_artist_feats {
        if !credits.iter().any(|c| c.eq_ignore_ascii_case(&f)) {
            credits.push(f);
        }
    }

    // The rescan gate: unchanged (size, mtime) means the stored hash still
    // describes the audio — reuse it and skip reading the region entirely.
    let stamp = crate::content_hash::file_stamp(abs);
    let audio_hash = match (stamp, prior) {
        (Some((size, mtime)), Some((hash, p_size, p_mtime)))
            if size == *p_size && mtime == *p_mtime =>
        {
            Some(hash.clone())
        }
        _ => crate::content_hash::hash_file(abs),
    };

    Ok(ScannedTrack {
        rel: rel.to_string(),
        abs: abs.to_path_buf(),
        title,
        artist,
        album_artist,
        album,
        track_number,
        disc_number,
        date,
        genres,
        duration_secs,
        codec,
        bitrate_kbps,
        sample_rate_hz,
        mb_recording_id: grab(&ItemKey::MusicBrainzRecordingId),
        mb_release_id: grab(&ItemKey::MusicBrainzReleaseId),
        mb_release_group_id: grab(&ItemKey::MusicBrainzReleaseGroupId),
        flag_compilation: tag
            .and_then(|t| t.get_string(&ItemKey::FlagCompilation))
            .map(|v| v == "1")
            .unwrap_or(false),
        credits,
        sound: false,
        album_artist_credits: Vec::new(),
        audio_hash,
        content_size: stamp.map(|(s, _)| s),
        content_mtime: stamp.map(|(_, m)| m),
    })
}

// ---------------------------------------------------------------------------
// Folder classification
// ---------------------------------------------------------------------------

/// "CD1" / "Disc 2" / "disk_03" → Some(n). Anything else → None (= a version).
fn disc_folder_number(name: &str) -> Option<i64> {
    let lower = name.trim().to_lowercase();
    for prefix in ["cd", "disc", "disk"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let digits = rest.trim_start_matches([' ', '.', '-', '_']);
            if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
                return Some(digits.parse().unwrap_or(1));
            }
        }
    }
    None
}

/// Audio files directly inside `dir` (no recursion), sorted by name.
fn audio_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| is_media_file(p, AUDIO_EXTENSIONS))
        .collect();
    files.sort();
    files
}

/// Loose image files directly inside `dir`, sorted by name.
fn image_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_image_file(p))
        .collect();
    files.sort();
    files
}

fn rel_of(path: &Path, base: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

/// Recursively collect every audio file under `dir`, attributed to its
/// "release folder": the folder holding the file — except disc-pattern folders
/// (CD1, Disc 2, …), whose files belong to the PARENT folder with that disc
/// number. Reserved folders (covers/, extras/, …) are skipped. Folder depth is
/// otherwise meaningless: grouping into albums/artists is pure tags.
fn walk_audio(dir: &Path, base: &Path, out: &mut Vec<(PathBuf, String, Option<i64>)>) {
    let rel = rel_of(dir, base);
    let rel = if rel == "." { String::new() } else { rel };
    for abs in audio_files_in(dir) {
        out.push((abs, rel.clone(), None));
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut subdirs: Vec<_> = entries
            .filter_map(|e| e.ok())
            .filter(|e| is_scannable_dir(e))
            .collect();
        subdirs.sort_by_key(|e| e.file_name());
        for sub in subdirs {
            let name = sub.file_name().to_string_lossy().to_string();
            if let Some(n) = disc_folder_number(&name) {
                for abs in audio_files_in(&sub.path()) {
                    out.push((abs, rel.clone(), Some(n)));
                }
                // Disc folders hold audio only — nothing deeper to walk.
            } else {
                walk_audio(&sub.path(), base, out);
            }
        }
    }
}

/// Case-insensitive album identity: (album artist, album title). Exact tag
/// values only — no suffix stripping (that would fuse "Weezer (Blue Album)"
/// with "Weezer (Green Album)"); differently-titled editions merge via
/// MusicBrainz release-group ids instead.
fn album_key(album_artist: &str, album: &str) -> String {
    format!("{}\u{1f}{}", album_artist.trim().to_lowercase(), album.trim().to_lowercase())
}

fn folder_leaf(rel: &str) -> String {
    Path::new(rel)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Most common album tag among a release's tracks.
fn majority_album_tag(release: &ScannedRelease) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for t in &release.tracks {
        *counts.entry(t.album.as_str()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(v, _)| v.to_string())
        .unwrap_or_default()
}

/// Everything one base folder yields: tag-grouped albums plus loose tracks
/// (files with no album tag — they never form albums; they attach to their
/// artist's loose container, or the library's when artist-less too).
pub struct ScanOutput {
    pub albums: Vec<ScannedAlbum>,
    pub loose: Vec<ScannedTrack>,
}

/// Pure tag grouping: tagged tracks (with their release folder) → albums.
/// One folder = one release per album key it contains; releases sharing an
/// album key across folders become editions of ONE album (version picker),
/// even without MBIDs. Tracks without an album tag come out as loose.
fn assemble_albums(tracks: Vec<(ScannedTrack, String, PathBuf)>) -> ScanOutput {
    let mut loose = Vec::new();
    // (release folder, album key) → release
    let mut releases: HashMap<(String, String), ScannedRelease> = HashMap::new();
    for (t, folder_rel, folder_abs) in tracks {
        if t.album.is_empty() {
            loose.push(t);
            continue;
        }
        let key = (folder_rel.clone(), album_key(&t.album_artist, &t.album));
        releases
            .entry(key)
            .or_insert_with(|| ScannedRelease {
                label: None,
                folder_rel,
                folder_abs,
                tracks: Vec::new(),
            })
            .tracks
            .push(t);
    }

    let mut albums: HashMap<String, ScannedAlbum> = HashMap::new();
    for ((_, key), release) in releases {
        albums
            .entry(key)
            .or_insert_with(|| ScannedAlbum {
                folder_rel: String::new(),
                folder_abs: PathBuf::new(),
                releases: Vec::new(),
                default_release: 0,
                identity_override: None,
            })
            .releases
            .push(release);
    }

    let mut out: Vec<ScannedAlbum> = albums.into_values().collect();
    for album in &mut out {
        finalize_album_releases(album);
    }
    out.sort_by(|a, b| a.folder_rel.cmp(&b.folder_rel));
    loose.sort_by(|a, b| a.rel.cmp(&b.rel));
    ScanOutput { albums: out, loose }
}

/// Order an album's releases (default edition first), derive version labels,
/// and set the canonical folder. Default = earliest dated release, then most
/// tracks, then shortest folder name.
fn finalize_album_releases(album: &mut ScannedAlbum) {
    album.releases.sort_by(|a, b| a.folder_rel.cmp(&b.folder_rel));
    let default_idx = album
        .releases
        .iter()
        .enumerate()
        .min_by_key(|(_, r)| {
            (
                release_date_of(r).unwrap_or_else(|| "9999".to_string()),
                std::cmp::Reverse(r.tracks.len()),
                folder_leaf(&r.folder_rel).len(),
            )
        })
        .map(|(i, _)| i)
        .unwrap_or(0);
    let default = album.releases.remove(default_idx);
    album.releases.insert(0, default);
    album.default_release = 0;
    album.folder_rel = album.releases[0].folder_rel.clone();
    album.folder_abs = album.releases[0].folder_abs.clone();

    if album.releases.len() > 1 {
        // Same album tag by construction, so labels come from folder-name
        // remainders or years.
        let group_title = majority_album_tag(&album.releases[0]);
        let default_leaf = folder_leaf(&album.releases[0].folder_rel);
        for i in 1..album.releases.len() {
            let title = majority_album_tag(&album.releases[i]);
            let leaf = folder_leaf(&album.releases[i].folder_rel);
            let year = release_date_of(&album.releases[i])
                .map(|d| d.chars().take(4).collect::<String>());
            album.releases[i].label = Some(derive_release_label(
                &title,
                &group_title,
                &leaf,
                &default_leaf,
                year.as_deref(),
            ));
        }
    }
}

/// Scan one base folder into tag-grouped albums plus loose tracks (pre
/// MBID-merge, pre artist grouping). Only files the reader cannot open land
/// in `issues` — under-tagged files import via fallbacks. Reading tags is the
/// slow part of a scan (the content hash reads the whole audio region), so
/// files are read by a small worker pool — serially the disk sat at queue
/// depth 1 and the phase was bounded by single-stream throughput — with
/// results reassembled in file order, so everything downstream stays
/// deterministic. The cancel flag (when given) is honored per file.
pub fn scan_base(
    base: &Path,
    // Base is sounds-typed — every track scanned here carries the flag.
    sound: bool,
    issues: &mut Vec<ScanIssue>,
    cancel: Option<&AtomicBool>,
    // Previous scan's per-file (hash, size, mtime), keyed by rel path — the
    // unchanged-file gate. None (create scans) or a miss hashes fresh.
    prior: Option<&HashMap<String, (String, i64, i64)>>,
    // (folder, files done, files total) — the walk collects the whole file
    // list before any tag is read, so the total is exact and free.
    mut on_progress: impl FnMut(&str, usize, usize),
) -> Result<ScanOutput, String> {
    let mut files = Vec::new();
    walk_audio(base, base, &mut files);
    let total_files = files.len();

    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let slots: Vec<std::sync::Mutex<Option<Result<ScannedTrack, String>>>> =
        (0..total_files).map(|_| std::sync::Mutex::new(None)).collect();
    let files_ref = &files;
    let slots_ref = &slots;
    let next_ref = &next;
    std::thread::scope(|s| {
        let (tx, rx) = std::sync::mpsc::channel::<usize>();
        for _ in 0..workers {
            let tx = tx.clone();
            s.spawn(move || loop {
                if let Some(cancel) = cancel {
                    if cancel.load(Ordering::SeqCst) {
                        break;
                    }
                }
                let i = next_ref.fetch_add(1, Ordering::SeqCst);
                if i >= total_files {
                    break;
                }
                let (abs, _, disc_no) = &files_ref[i];
                let rel = rel_of(abs, base);
                let prior_entry = prior.and_then(|m| m.get(&rel));
                let res = read_track(abs, &rel, *disc_no, prior_entry);
                *slots_ref[i].lock().unwrap() = Some(res);
                let _ = tx.send(i);
            });
        }
        drop(tx);
        // Progress from the completion stream, throttled: the old per-folder
        // cadence made sense serially; parallel completions interleave
        // folders, so report on folder change and every 10th file.
        let mut done = 0usize;
        let mut last_folder: Option<String> = None;
        while let Ok(i) = rx.recv() {
            done += 1;
            let folder = files_ref[i].1.as_str();
            if last_folder.as_deref() != Some(folder) || done % 10 == 0 || done == total_files {
                let shown = if folder.is_empty() {
                    base.to_string_lossy().into_owned()
                } else {
                    folder.to_string()
                };
                on_progress(&shown, done, total_files);
                last_folder = Some(folder.to_string());
            }
        }
    });
    if let Some(cancel) = cancel {
        if cancel.load(Ordering::SeqCst) {
            return Err("Scan cancelled".to_string());
        }
    }

    let mut tagged = Vec::new();
    for (i, slot) in slots.into_iter().enumerate() {
        let Some(res) = slot.into_inner().unwrap() else {
            continue; // only possible on cancel, which returned above
        };
        let folder_rel = files[i].1.clone();
        match res {
            Ok(mut t) => {
                t.sound = sound;
                // Sounds are fully virtual: no tag- or folder-derived albums.
                // Every sound track pools into the library's sound loose
                // container; apply_sound_homes then places it in a virtual
                // collection (folder-mimicked once, user-directed after).
                // Clearing the artist too keeps sounds from spawning artist
                // pages and routes everything through the one root container.
                if sound {
                    t.album = String::new();
                    t.album_artist = String::new();
                }
                let folder_abs = if folder_rel.is_empty() {
                    base.to_path_buf()
                } else {
                    base.join(&folder_rel)
                };
                tagged.push((t, folder_rel, folder_abs));
            }
            Err(reason) => issues.push(ScanIssue {
                file_path: rel_of(&files[i].0, base),
                reason,
            }),
        }
    }
    Ok(assemble_albums(tagged))
}

// ---------------------------------------------------------------------------
// MBID grouping (differently-titled editions → one album)
// ---------------------------------------------------------------------------

fn release_group_id_of(album: &ScannedAlbum) -> Option<String> {
    album
        .releases
        .iter()
        .find_map(|r| r.tracks.iter().find_map(|t| t.mb_release_group_id.clone()))
}

/// Version label for a non-default sibling: the part of its title that the
/// group title doesn't cover ("LONG.LIVE.A$AP (Deluxe Version)" → "Deluxe
/// Version"), falling back to the folder-name remainder, the release year,
/// then the folder name itself.
fn derive_release_label(
    release_title: &str,
    group_title: &str,
    folder_name: &str,
    default_folder_name: &str,
    year: Option<&str>,
) -> String {
    let strip = |longer: &str, prefix: &str| -> Option<String> {
        if longer.len() > prefix.len() && longer.to_lowercase().starts_with(&prefix.to_lowercase()) {
            let rest = longer[prefix.len()..]
                .trim_matches(|c: char| c.is_whitespace() || "-–—:([{".contains(c))
                .trim_end_matches(|c: char| ")]}".contains(c))
                .trim()
                .to_string();
            if !rest.is_empty() {
                return Some(rest);
            }
        }
        None
    };
    strip(release_title, group_title)
        .or_else(|| strip(folder_name, default_folder_name))
        .or_else(|| year.map(|y| y.to_string()))
        .unwrap_or_else(|| folder_name.to_string())
}

fn folder_name_of(album: &ScannedAlbum) -> String {
    album
        .folder_abs
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Merge sibling album folders that provably belong to one release group
/// (matching embedded MusicBrainz release-group ids). Folders without an id —
/// or with unique ids — pass through untouched as single-release albums.
/// The plainest edition (shortest tag title) becomes the default release and
/// names the merged album; the others get derived version labels.
pub fn group_sibling_albums(albums: Vec<ScannedAlbum>) -> Vec<ScannedAlbum> {
    let mut by_rg: HashMap<String, Vec<ScannedAlbum>> = HashMap::new();
    let mut out: Vec<ScannedAlbum> = Vec::new();
    for album in albums {
        match release_group_id_of(&album) {
            Some(rg) => by_rg.entry(rg).or_default().push(album),
            None => out.push(album),
        }
    }
    for (_, mut group) in by_rg {
        if group.len() == 1 {
            out.push(group.pop().unwrap());
            continue;
        }
        // Deterministic order regardless of HashMap/disk quirks.
        group.sort_by_key(folder_name_of);
        // Default = plainest edition: shortest tag title, folder name as tiebreak.
        let default_idx = group
            .iter()
            .enumerate()
            .min_by_key(|(_, a)| (album_title_of(a).len(), folder_name_of(a)))
            .map(|(i, _)| i)
            .unwrap_or(0);
        let group_title = album_title_of(&group[default_idx]);
        let default_folder_name = folder_name_of(&group[default_idx]);
        let folder_rel = group[default_idx].folder_rel.clone();
        let folder_abs = group[default_idx].folder_abs.clone();

        let mut releases: Vec<ScannedRelease> = Vec::new();
        for (i, sibling) in group.into_iter().enumerate() {
            let title = album_title_of(&sibling);
            let name = folder_name_of(&sibling);
            for mut release in sibling.releases {
                release.label = if i == default_idx {
                    None
                } else {
                    let year = release
                        .tracks
                        .iter()
                        .filter_map(|t| t.date.clone())
                        .min()
                        .map(|d| d.chars().take(4).collect::<String>());
                    Some(derive_release_label(
                        &title,
                        &group_title,
                        &name,
                        &default_folder_name,
                        year.as_deref(),
                    ))
                };
                // Default first so is_default lands on it at insert time.
                if i == default_idx {
                    releases.insert(0, release);
                } else {
                    releases.push(release);
                }
            }
        }
        out.push(ScannedAlbum {
            folder_rel,
            folder_abs,
            releases,
            default_release: 0,
            identity_override: None,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Cover caching (music-specific: loose folder images + embedded art fallback)
// ---------------------------------------------------------------------------

/// Desired cover set for an album/artist folder: loose images in the folder;
/// for albums with none, the default release's folder; else first track's
/// embedded picture (written to cache as "embedded.jpg" — media folders are
/// read-only). Returns (source_filename, produce) pairs.
enum CoverSource {
    File(PathBuf),
    Embedded(PathBuf), // audio file to pull the picture from
}

/// Loose images in `dir` PLUS anything in its `covers/` subfolder (the same
/// convention video entries use; matched case-insensitively so "Covers"
/// works on case-sensitive filesystems too), first filename occurrence wins.
fn folder_cover_files(dir: &Path) -> Vec<(String, CoverSource)> {
    let covers_dirs: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .map(|n| n.to_string_lossy().eq_ignore_ascii_case("covers"))
                    .unwrap_or(false)
        })
        .collect();

    let mut out: Vec<(String, CoverSource)> = Vec::new();
    for p in image_files_in(dir)
        .into_iter()
        .chain(covers_dirs.iter().flat_map(|d| image_files_in(d)))
    {
        if let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) {
            if !out.iter().any(|(existing, _)| *existing == name) {
                out.push((name, CoverSource::File(p)));
            }
        }
    }
    out
}

fn desired_covers(folder_abs: &Path, album: Option<&ScannedAlbum>) -> Vec<(String, CoverSource)> {
    let mut out = folder_cover_files(folder_abs);
    let Some(album) = album else { return out };

    fn add(out: &mut Vec<(String, CoverSource)>, name: String, src: CoverSource) {
        if !out.iter().any(|(existing, _)| *existing == name) {
            out.push((name, src));
        }
    }

    // Every release pools its art into the card, default release first so its
    // bare (unprefixed) names keep matching cover rows cached by earlier
    // builds. Art is looked for in each release's own folder AND every folder
    // its tracks actually live in — disc subfolders (CD1/CD2 rips) and
    // merged/combined-in source folders both surface through the track paths,
    // which a release-folder-only walk would miss.
    let mut order: Vec<usize> = (0..album.releases.len()).collect();
    if album.default_release < order.len() {
        let d = order.remove(album.default_release);
        order.insert(0, d);
    }
    for idx in order {
        let release = &album.releases[idx];
        let mut folders: Vec<PathBuf> = vec![release.folder_abs.clone()];
        for t in &release.tracks {
            if let Some(parent) = t.abs.parent() {
                if !folders.iter().any(|f| f.as_path() == parent) {
                    folders.push(parent.to_path_buf());
                }
            }
        }
        for folder in &folders {
            // The album root and the default release's folder keep bare
            // filenames; everything else is prefixed with its folder name so
            // same-named art (folder.jpg everywhere) coexists in the picker
            // instead of deduping away.
            let bare = folder.as_path() == folder_abs
                || (idx == album.default_release && folder == &release.folder_abs);
            let prefix = if bare {
                None
            } else {
                folder.file_name().map(|n| n.to_string_lossy().to_string())
            };
            let files = folder_cover_files(folder);
            if files.is_empty() {
                // No file art here: fall back to the embedded picture of the
                // first track living in this folder, keyed per folder so each
                // source's art still reaches the picker.
                let first_here = release
                    .tracks
                    .iter()
                    .find(|t| t.abs.parent() == Some(folder.as_path()));
                if let Some(t) = first_here {
                    let name = match &prefix {
                        Some(p) => format!("{p}_embedded.jpg"),
                        None => "embedded.jpg".to_string(),
                    };
                    add(&mut out, name, CoverSource::Embedded(t.abs.clone()));
                }
                continue;
            }
            for (name, src) in files {
                let keyed = match &prefix {
                    Some(p) => format!("{p}_{name}"),
                    None => name,
                };
                add(&mut out, keyed, src);
            }
        }
    }
    out
}

fn produce_cover_bytes(src: &CoverSource) -> Option<Vec<u8>> {
    match src {
        CoverSource::File(p) => std::fs::read(p).ok(),
        CoverSource::Embedded(audio) => {
            let tagged = Probe::open(audio).ok()?.read().ok()?;
            let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
            tag.pictures().first().map(|pic| pic.data().to_vec())
        }
    }
}

/// Diff-aware cover sync for one music entry folder (mirrors the video
/// sync_cached_images_for_entry conventions: cache under <rel>/covers/ with a
/// covers_thumb/ sibling the grid loads directly).
async fn sync_music_covers(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
    entry_rel: &str,
    desired: &[(String, CoverSource)],
) -> Result<(), String> {
    let cache_dir = cache_base.join(entry_rel).join("covers");
    let thumb_dir = cache_base.join(entry_rel).join("covers_thumb");

    let db_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT source_filename, cached_path FROM cached_images
         WHERE library_id = ? AND entry_folder_path = ? AND image_type = 'cover' AND origin = 'library'",
    )
    .bind(library_id)
    .bind(entry_rel)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let want: HashSet<&str> = desired.iter().map(|(n, _)| n.as_str()).collect();
    for (filename, cached_path) in &db_rows {
        if !want.contains(filename.as_str()) {
            let _ = std::fs::remove_file(cached_path);
            let _ = std::fs::remove_file(thumb_dir.join(filename));
            sqlx::query(
                "DELETE FROM cached_images WHERE library_id = ? AND entry_folder_path = ?
                 AND image_type = 'cover' AND source_filename = ? AND origin = 'library'",
            )
            .bind(library_id)
            .bind(entry_rel)
            .bind(filename)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    let have: HashSet<String> = db_rows.into_iter().map(|(f, _)| f).collect();
    let _ = std::fs::create_dir_all(&cache_dir);
    let _ = std::fs::create_dir_all(&thumb_dir);
    for (filename, source) in desired {
        if have.contains(filename) {
            continue;
        }
        let Some(bytes) = produce_cover_bytes(source) else { continue };
        let cached = cache_dir.join(filename);
        if std::fs::write(&cached, &bytes).is_err() {
            continue;
        }
        // Same undecodable-format fallback as the video pipeline (AVIF et al).
        let thumbed = image::load_from_memory(&bytes)
            .ok()
            .and_then(|img| img.thumbnail(600, 900).save(thumb_dir.join(filename)).ok())
            .is_some();
        if !thumbed {
            let _ = std::fs::copy(&cached, thumb_dir.join(filename));
        }
        sqlx::query(
            "INSERT OR REPLACE INTO cached_images
                (library_id, entry_folder_path, image_type, source_filename, cached_path, origin)
             VALUES (?, ?, 'cover', ?, ?, 'library')",
        )
        .bind(library_id)
        .bind(entry_rel)
        .bind(filename)
        .bind(cached.to_string_lossy().to_string())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// DB insertion / reconciliation
// ---------------------------------------------------------------------------

async fn entry_type_id(pool: &SqlitePool, name: &str) -> Result<i64, String> {
    let row: (i64,) = sqlx::query_as("SELECT id FROM media_entry_type WHERE name = ?")
        .bind(name)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.0)
}

/// Earliest dated release's date, for the album row.
fn album_release_date(album: &ScannedAlbum) -> Option<String> {
    album
        .releases
        .iter()
        .filter_map(|r| r.tracks.iter().filter_map(|t| t.date.clone()).min())
        .min()
}

fn release_date_of(release: &ScannedRelease) -> Option<String> {
    release.tracks.iter().filter_map(|t| t.date.clone()).min()
}

fn release_disc_count(release: &ScannedRelease) -> i64 {
    release.tracks.iter().map(|t| t.disc_number).max().unwrap_or(1)
}

fn release_mb_id(release: &ScannedRelease) -> Option<String> {
    release.tracks.iter().find_map(|t| t.mb_release_id.clone())
}

/// Release-type classification for the album card / artist subtitles. Real
/// type tags are rare outside Picard libraries, so this is the standard
/// heuristic: compilation via the iTunes flag or a Various Artists credit,
/// then track count of the default release (≤3 single, 4–6 EP, else album).
/// Future MusicBrainz matching can overwrite album_type with the real value.
fn album_type_of(album: &ScannedAlbum) -> &'static str {
    let def = &album.releases[album.default_release];
    let flagged = def.tracks.iter().filter(|t| t.flag_compilation).count() * 2 > def.tracks.len();
    if flagged || album_artist_of(album).eq_ignore_ascii_case("various artists") {
        return "compilation";
    }
    match def.tracks.len() {
        0..=3 => "single",
        4..=6 => "ep",
        _ => "album",
    }
}

/// Album (release-group) title: the default release's album tag by majority.
fn album_title_of(album: &ScannedAlbum) -> String {
    if let Some((_, title)) = &album.identity_override {
        return title.clone();
    }
    let def = &album.releases[album.default_release];
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for t in &def.tracks {
        *counts.entry(t.album.as_str()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(v, _)| v.to_string())
        .unwrap_or_else(|| {
            album
                .folder_abs
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        })
}

/// Ordering key within a release/container: numbered tracks by disc+number,
/// unnumbered ones after them in file order (`idx` = the track's position in
/// the release's filename-sorted list).
fn track_sort_order(t: &ScannedTrack, idx: usize) -> i64 {
    match t.track_number {
        Some(n) => t.disc_number * 1_000_000 + n * 1000,
        None => t.disc_number * 1_000_000 + 900_000 + idx as i64,
    }
}

async fn insert_track_rows(
    pool: &SqlitePool,
    library_id: &str,
    album_entry_id: i64,
    track_type: i64,
    release_id: i64,
    t: &ScannedTrack,
    sort_order: i64,
) -> Result<i64, String> {
    let res = sqlx::query(
        "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
    )
    .bind(library_id)
    .bind(album_entry_id)
    .bind(track_type)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    let id = res.last_insert_rowid();
    sqlx::query(
        "INSERT INTO track (id, title, sort_title, file_path, sort_order, track_number, disc_number, runtime, audio_hash, content_size, content_mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(&t.title)
    .bind(generate_sort_title(&t.title, "en"))
    .bind(&t.rel)
    .bind(sort_order)
    .bind(t.track_number)
    .bind(t.disc_number)
    .bind(t.duration_secs)
    .bind(&t.audio_hash)
    .bind(t.content_size)
    .bind(t.content_mtime)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    write_track_side_tables(pool, id, release_id, t, true).await?;
    Ok(id)
}

/// One-file tag read for the editor's reset/hints paths (no disc-folder
/// context — the tag's own disc number, else 1).
pub(crate) fn read_track_at(abs: &Path, rel: &str) -> Result<ScannedTrack, String> {
    read_track(abs, rel, None, None)
}

/// `write_credits: false` preserves existing track_credit rows — used when
/// reconciling albums whose credits MusicBrainz already provided (tag-parsed
/// credits must not clobber them on rescan). Ends by re-stomping any user
/// overrides, so every bulk write path respects edits.
pub(crate) async fn write_track_side_tables(
    pool: &SqlitePool,
    track_id: i64,
    release_id: i64,
    t: &ScannedTrack,
    write_credits: bool,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO track_release (track_id, release_id) VALUES (?, ?)
         ON CONFLICT(track_id) DO UPDATE SET release_id = excluded.release_id",
    )
    .bind(track_id)
    .bind(release_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO track_meta (track_id, artist_name, mb_recording_id, codec, bitrate_kbps, sample_rate_hz)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(track_id) DO UPDATE SET
            artist_name = excluded.artist_name,
            mb_recording_id = excluded.mb_recording_id,
            codec = excluded.codec,
            bitrate_kbps = excluded.bitrate_kbps,
            sample_rate_hz = excluded.sample_rate_hz",
    )
    .bind(track_id)
    .bind(t.artist.as_deref().unwrap_or(&t.album_artist))
    .bind(&t.mb_recording_id)
    .bind(&t.codec)
    .bind(t.bitrate_kbps)
    .bind(t.sample_rate_hz)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    if write_credits {
        // Rebuild the ordered credit list.
        sqlx::query("DELETE FROM track_credit WHERE track_id = ?")
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        for (i, name) in t.credits.iter().enumerate() {
            sqlx::query("INSERT INTO track_credit (track_id, position, name) VALUES (?, ?, ?)")
                .bind(track_id)
                .bind(i as i64)
                .bind(name)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    crate::music_edit::reapply_track_overrides(pool, track_id).await?;
    Ok(())
}

async fn link_album_genres(
    pool: &SqlitePool,
    album_entry_id: i64,
    album: &ScannedAlbum,
) -> Result<(), String> {
    let mut genres: HashSet<String> = HashSet::new();
    for r in &album.releases {
        for t in &r.tracks {
            for g in &t.genres {
                genres.insert(g.clone());
            }
        }
    }
    for g in genres {
        sqlx::query("INSERT OR IGNORE INTO genre (name) VALUES (?)")
            .bind(&g)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT OR IGNORE INTO album_genre (album_id, genre_id)
             SELECT ?, id FROM genre WHERE name = ?",
        )
        .bind(album_entry_id)
        .bind(&g)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Insert a freshly scanned album (entry + rows + releases + tracks + covers).
/// Albums carry NO artist parent — membership on artist pages is entirely the
/// album_artist_credit rows written at the end of this function. (Loose
/// containers are the one deliberate exception; see ensure_loose_container.)
async fn insert_album(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
    album: &ScannedAlbum,
    sort_order: i64,
) -> Result<i64, String> {
    let album_type = entry_type_id(pool, "album").await?;
    let track_type = entry_type_id(pool, "track").await?;

    let title = album_title_of(album);
    let res = sqlx::query(
        "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
    )
    .bind(library_id)
    .bind(album_type)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    let album_entry_id = res.last_insert_rowid();

    let def = &album.releases[album.default_release];
    sqlx::query(
        "INSERT INTO album (id, title, sort_title, folder_path, sort_order, release_date, disc_count, album_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(album_entry_id)
    .bind(&title)
    .bind(generate_sort_title(&title, "en"))
    .bind(&album.folder_rel)
    .bind(sort_order)
    .bind(album_release_date(album))
    .bind(release_disc_count(def))
    .bind(album_type_of(album))
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    set_sound_marker(pool, album_entry_id, album_is_sound(album)).await?;

    if let Some(rg) = album
        .releases
        .iter()
        .find_map(|r| r.tracks.iter().find_map(|t| t.mb_release_group_id.clone()))
    {
        sqlx::query(
            "UPDATE album SET mb_release_group_id = ? WHERE id = ?",
        )
        .bind(rg)
        .bind(album_entry_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    for (i, release) in album.releases.iter().enumerate() {
        let res = sqlx::query(
            "INSERT INTO album_release (album_id, label, folder_path, release_date, mb_release_id, is_default, disc_count)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(album_entry_id)
        .bind(&release.label)
        .bind(&release.folder_rel)
        .bind(release_date_of(release))
        .bind(release_mb_id(release))
        .bind((i == album.default_release) as i64)
        .bind(release_disc_count(release))
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        let release_id = res.last_insert_rowid();
        for (ti, t) in release.tracks.iter().enumerate() {
            insert_track_rows(
                pool,
                library_id,
                album_entry_id,
                track_type,
                release_id,
                t,
                track_sort_order(t, ti),
            )
            .await?;
        }
    }

    write_album_credits(pool, album_entry_id, album, true).await?;
    link_album_genres(pool, album_entry_id, album).await?;
    sync_music_covers(
        pool,
        library_id,
        cache_base,
        &album.folder_rel,
        &desired_covers(&album.folder_abs, Some(album)),
    )
    .await?;
    crate::music_edit::reapply_album_overrides(pool, album_entry_id).await?;
    apply_release_prefs(pool, album_entry_id).await?;
    Ok(album_entry_id)
}

/// Re-stomp the user's per-release preferences (custom label, chosen default)
/// onto freshly rebuilt album_release rows. Prefs key on FOLDER because the
/// rows themselves get new ids every rescan; a pref whose folder no longer
/// exists simply matches nothing.
pub(crate) async fn apply_release_prefs(pool: &SqlitePool, album_id: i64) -> Result<(), String> {
    let prefs: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT folder_path, label, is_default FROM album_release_pref WHERE album_id = ?",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if prefs.is_empty() {
        return Ok(());
    }
    for (folder, label, _) in &prefs {
        if let Some(label) = label {
            sqlx::query("UPDATE album_release SET label = ? WHERE album_id = ? AND folder_path = ?")
                .bind(label)
                .bind(album_id)
                .bind(folder)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    if let Some((folder, _, _)) = prefs.iter().find(|(_, _, d)| *d != 0) {
        let hit: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM album_release WHERE album_id = ? AND folder_path = ?")
                .bind(album_id)
                .bind(folder)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((rid,)) = hit {
            sqlx::query("UPDATE album_release SET is_default = (id = ?) WHERE album_id = ?")
                .bind(rid)
                .bind(album_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Reconcile an existing album entry against a fresh scan: update the album
/// row (including the canonical folder — the default edition can change when
/// siblings merge), rebuild the release rows, upsert tracks by file_path.
/// Tracks are matched from the LIBRARY-WIDE map and reparented onto this
/// album, so entry ids — and play history — survive sibling merges (e.g.
/// MBIDs appearing after a Picard pass fusing two previously separate
/// albums). Vanished files are handled by the caller's global sweep.
async fn reconcile_album(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
    album_entry_id: i64,
    album: &ScannedAlbum,
    existing_tracks: &mut HashMap<String, i64>,
) -> Result<(), String> {
    let track_type = entry_type_id(pool, "track").await?;

    // Credits for MB-matched albums are authoritative — a rescan's tag re-parse
    // must not clobber them (the stamp keeps the fetch from re-running).
    let mb_matched: Option<(String,)> =
        sqlx::query_as("SELECT status FROM mb_credit_fetch WHERE album_id = ? AND status = 'matched'")
            .bind(album_entry_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let write_credits = mb_matched.is_none();

    // Folder placement is re-derived every rescan — retyping a folder
    // (music ↔ sounds) flips its albums here.
    set_sound_marker(pool, album_entry_id, album_is_sound(album)).await?;

    let title = album_title_of(album);
    let def = &album.releases[album.default_release];
    if write_credits {
        sqlx::query(
            "UPDATE album SET title = ?, sort_title = ?, folder_path = ?, release_date = ?, disc_count = ?, album_type = ? WHERE id = ?",
        )
        .bind(&title)
        .bind(generate_sort_title(&title, "en"))
        .bind(&album.folder_rel)
        .bind(album_release_date(album))
        .bind(release_disc_count(def))
        .bind(album_type_of(album))
        .bind(album_entry_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    } else {
        // MB-matched album: its type came from MusicBrainz (not the track-count
        // heuristic) and its date may be an MB gap-fill — a tag re-parse only
        // overrides the date when the tags actually carry one.
        sqlx::query(
            "UPDATE album SET title = ?, sort_title = ?, folder_path = ?, release_date = COALESCE(?, release_date), disc_count = ? WHERE id = ?",
        )
        .bind(&title)
        .bind(generate_sort_title(&title, "en"))
        .bind(&album.folder_rel)
        .bind(album_release_date(album))
        .bind(release_disc_count(def))
        .bind(album_entry_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    if let Some(rg) = release_group_id_of(album) {
        sqlx::query(
            "UPDATE album SET mb_release_group_id = ? WHERE id = ?",
        )
        .bind(rg)
        .bind(album_entry_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    // Rebuild releases (track entry ids survive; membership is re-mapped).
    sqlx::query("DELETE FROM album_release WHERE album_id = ?")
        .bind(album_entry_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    for (i, release) in album.releases.iter().enumerate() {
        let res = sqlx::query(
            "INSERT INTO album_release (album_id, label, folder_path, release_date, mb_release_id, is_default, disc_count)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(album_entry_id)
        .bind(&release.label)
        .bind(&release.folder_rel)
        .bind(release_date_of(release))
        .bind(release_mb_id(release))
        .bind((i == album.default_release) as i64)
        .bind(release_disc_count(release))
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        let release_id = res.last_insert_rowid();

        // Credits are protected PER RELEASE: a release with a pinned pressing
        // carries MB-authored credits the tag re-parse must not clobber; an
        // unpinned sibling (or one whose pin a merge just dropped) rebuilds
        // from tags like any unmatched album.
        // A sentinel "no MB counterpart" row is NOT a pin — that release's
        // credits stay tag-authored and must keep rebuilding from tags.
        let release_pinned = crate::music_mb::release_match_of(
            pool,
            album_entry_id,
            &release.folder_rel,
        )
        .await?
        .is_some_and(|(v, _)| !v.is_empty());
        let write_release_credits = write_credits || !release_pinned;

        for (ti, t) in release.tracks.iter().enumerate() {
            let sort_order = track_sort_order(t, ti);
            if let Some(track_id) = existing_tracks.remove(&t.rel) {
                sqlx::query(
                    "UPDATE track SET title = ?, sort_title = ?, sort_order = ?, track_number = ?, disc_number = ?, runtime = ?, audio_hash = ?, content_size = ?, content_mtime = ?
                     WHERE id = ?",
                )
                .bind(&t.title)
                .bind(generate_sort_title(&t.title, "en"))
                .bind(sort_order)
                .bind(t.track_number)
                .bind(t.disc_number)
                .bind(t.duration_secs)
                .bind(&t.audio_hash)
                .bind(t.content_size)
                .bind(t.content_mtime)
                .bind(track_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
                // Reparent — the track may have belonged to a sibling album
                // that just merged into this one.
                sqlx::query("UPDATE media_entry SET parent_id = ? WHERE id = ?")
                    .bind(album_entry_id)
                    .bind(track_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                write_track_side_tables(pool, track_id, release_id, t, write_release_credits)
                    .await?;
            } else {
                insert_track_rows(
                    pool,
                    library_id,
                    album_entry_id,
                    track_type,
                    release_id,
                    t,
                    sort_order,
                )
                .await?;
            }
        }
    }

    write_album_credits(pool, album_entry_id, album, write_credits).await?;
    link_album_genres(pool, album_entry_id, album).await?;
    sync_music_covers(
        pool,
        library_id,
        cache_base,
        &album.folder_rel,
        &desired_covers(&album.folder_abs, Some(album)),
    )
    .await?;
    crate::music_edit::reapply_album_overrides(pool, album_entry_id).await?;
    apply_release_prefs(pool, album_entry_id).await?;
    Ok(())
}


// ---------------------------------------------------------------------------
// Loose-track containers
// ---------------------------------------------------------------------------

/// Find or create the hidden container album holding loose tracks under
/// `parent` (an artist entry id, or None for the library-root container that
/// takes artist-less tracks). Containers are flagged in loose_album and
/// excluded from every album-facing surface. Returns (album_id, release_id).
///
/// DELIBERATE EXCEPTION: containers are the only "albums" that still use
/// media_entry.parent_id. Real albums live on their album_artist_credit rows;
/// a container is per-artist infrastructure with exactly one owner by
/// definition, has no credit of its own, and its identity IS (library,
/// artist, sound) — the parent column states that directly.
async fn ensure_loose_container(
    pool: &SqlitePool,
    library_id: &str,
    parent: Option<i64>,
    // Sound loose tracks get their OWN container (also sound-marked), so
    // the album-level marker keeps covering every exclusion.
    sound: bool,
) -> Result<(i64, i64), String> {
    let marker = if sound {
        "AND EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = la.album_id)"
    } else {
        "AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = la.album_id)"
    };
    let existing: Option<(i64,)> = match parent {
        Some(pid) => sqlx::query_as(&format!(
            "SELECT la.album_id FROM loose_album la
             JOIN media_entry me ON me.id = la.album_id
             WHERE me.library_id = ? AND me.parent_id = ? {marker}",
        ))
        .bind(library_id)
        .bind(pid)
        .fetch_optional(pool)
        .await,
        None => sqlx::query_as(&format!(
            "SELECT la.album_id FROM loose_album la
             JOIN media_entry me ON me.id = la.album_id
             WHERE me.library_id = ? AND me.parent_id IS NULL {marker}",
        ))
        .bind(library_id)
        .fetch_optional(pool)
        .await,
    }
    .map_err(|e| e.to_string())?;

    let album_id = match existing {
        Some((id,)) => id,
        None => {
            let album_type = entry_type_id(pool, "album").await?;
            let res = sqlx::query(
                "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
            )
            .bind(library_id)
            .bind(parent)
            .bind(album_type)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            let id = res.last_insert_rowid();
            sqlx::query(
                "INSERT INTO album (id, title, sort_title, folder_path, sort_order) VALUES (?, '', '', '', 999999)",
            )
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO loose_album (album_id) VALUES (?)")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            set_sound_marker(pool, id, sound).await?;
            id
        }
    };

    let release: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM album_release WHERE album_id = ? AND is_default = 1")
            .bind(album_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let release_id = match release {
        Some((id,)) => id,
        None => {
            let res = sqlx::query(
                "INSERT INTO album_release (album_id, label, folder_path, is_default) VALUES (?, NULL, '', 1)",
            )
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            res.last_insert_rowid()
        }
    };
    Ok((album_id, release_id))
}

/// Insert/refresh loose tracks under a container. Tracks are matched from the
/// library-wide map, so an album tag appearing or vanishing moves the same
/// entry (ids and play history survive). Loose tracks are never MB-matched,
/// so tag-parsed credits always write.
async fn reconcile_loose_tracks(
    pool: &SqlitePool,
    library_id: &str,
    container_id: i64,
    release_id: i64,
    tracks: &[ScannedTrack],
    existing_tracks: &mut HashMap<String, i64>,
) -> Result<(), String> {
    let track_type = entry_type_id(pool, "track").await?;
    for (ti, t) in tracks.iter().enumerate() {
        let sort_order = track_sort_order(t, ti);
        if let Some(track_id) = existing_tracks.remove(&t.rel) {
            sqlx::query(
                "UPDATE track SET title = ?, sort_title = ?, sort_order = ?, track_number = ?, disc_number = ?, runtime = ?
                 WHERE id = ?",
            )
            .bind(&t.title)
            .bind(generate_sort_title(&t.title, "en"))
            .bind(sort_order)
            .bind(t.track_number)
            .bind(t.disc_number)
            .bind(t.duration_secs)
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query("UPDATE media_entry SET parent_id = ? WHERE id = ?")
                .bind(container_id)
                .bind(track_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            write_track_side_tables(pool, track_id, release_id, t, true).await?;
        } else {
            insert_track_rows(pool, library_id, container_id, track_type, release_id, t, sort_order)
                .await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Sound collections (virtual)
// ---------------------------------------------------------------------------

/// Reserved "misc" folder check (junk-stripped, case-insensitive — `_misc`,
/// `~Misc`, `MISC` all match, mirroring is_scannable_dir's prefix rules):
/// files under such a component, or at a base root, stay loose instead of
/// folder-mimicking into a collection.
fn is_misc_component(name: &str) -> bool {
    name.trim_start_matches(['~', '-', '_', ' ', '.'])
        .eq_ignore_ascii_case("misc")
}

/// Find (by case-insensitive title) or create a virtual sound collection.
/// `folder` anchors cover art to a source folder when the collection is being
/// folder-mimicked; user-created collections pass None and stay artless.
pub(crate) async fn ensure_sound_collection(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
    title: &str,
    folder: Option<(&str, &Path)>,
) -> Result<i64, String> {
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT al.id FROM album al
         JOIN media_entry me ON me.id = al.id
         JOIN sound_collection sc ON sc.album_id = al.id
         WHERE me.library_id = ? AND LOWER(al.title) = LOWER(?)",
    )
    .bind(library_id)
    .bind(title)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some((id,)) = existing {
        return Ok(id);
    }
    let album_type = entry_type_id(pool, "album").await?;
    let res = sqlx::query(
        "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
    )
    .bind(library_id)
    .bind(album_type)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    let id = res.last_insert_rowid();
    sqlx::query(
        "INSERT INTO album (id, title, sort_title, folder_path, sort_order) VALUES (?, ?, ?, ?, 0)",
    )
    .bind(id)
    .bind(title)
    .bind(generate_sort_title(title, "en"))
    .bind(folder.map(|(rel, _)| rel).unwrap_or(""))
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO album_release (album_id, label, folder_path, is_default) VALUES (?, NULL, '', 1)",
    )
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO sound_album (album_id) VALUES (?)")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO sound_collection (album_id) VALUES (?)")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    if let Some((rel, abs)) = folder {
        sync_music_covers(pool, library_id, cache_base, rel, &desired_covers(abs, None)).await?;
    }
    Ok(id)
}

/// Reparent a sound track onto a collection or loose container: media_entry
/// parent plus the track_release row onto the target's default release.
async fn reparent_sound_track(
    pool: &SqlitePool,
    track_id: i64,
    album_id: i64,
) -> Result<(), String> {
    sqlx::query("UPDATE media_entry SET parent_id = ? WHERE id = ?")
        .bind(album_id)
        .bind(track_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    let release: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM album_release WHERE album_id = ? AND is_default = 1")
            .bind(album_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    if let Some((release_id,)) = release {
        sqlx::query(
            "INSERT INTO track_release (track_id, release_id) VALUES (?, ?)
             ON CONFLICT(track_id) DO UPDATE SET release_id = excluded.release_id",
        )
        .bind(track_id)
        .bind(release_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Place every sound track. All sound tracks arrive pooled in the loose
/// container after a scan/rescan; this pass then applies, in order of
/// authority: an existing sound_track_home row (NULL = explicitly loose,
/// id = that collection — the USER's word, never overridden), else
/// folder-mimicking — the track's leaf source folder becomes a collection
/// (created on demand), while base-root and misc-folder files stay loose.
/// Mimicked placements write a home row, so they only ever happen once per
/// track; a pre-collections library migrates by the same rule.
pub(crate) async fn apply_sound_homes(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
) -> Result<(), String> {
    let tracks: Vec<(i64, String)> = sqlx::query_as(
        "SELECT t.id, t.file_path FROM track t
         JOIN media_entry me ON me.id = t.id
         JOIN loose_album la ON la.album_id = me.parent_id
         JOIN sound_album sa ON sa.album_id = me.parent_id
         WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if tracks.is_empty() {
        return Ok(());
    }
    let homes: HashMap<i64, Option<i64>> = sqlx::query_as::<_, (i64, Option<i64>)>(
        "SELECT sth.track_id, sth.album_id FROM sound_track_home sth
         JOIN media_entry me ON me.id = sth.track_id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .collect();
    let collections: HashSet<i64> = sqlx::query_as::<_, (i64,)>(
        "SELECT sc.album_id FROM sound_collection sc
         JOIN media_entry me ON me.id = sc.album_id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(id,)| id)
    .collect();

    // folder_rel → collection id, so a folder's files share one create.
    let mut mimic_cache: HashMap<String, i64> = HashMap::new();
    for (track_id, rel) in tracks {
        match homes.get(&track_id) {
            Some(Some(album_id)) if collections.contains(album_id) => {
                reparent_sound_track(pool, track_id, *album_id).await?;
            }
            Some(Some(_)) => {
                // Directive points at a vanished collection — demote to loose.
                sqlx::query("UPDATE sound_track_home SET album_id = NULL WHERE track_id = ?")
                    .bind(track_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Some(None) => {} // explicitly loose — already in the container
            None => {
                let norm = rel.replace('\\', "/");
                let mut comps: Vec<&str> = norm.split('/').filter(|c| !c.is_empty()).collect();
                comps.pop(); // file name
                if comps.is_empty() || comps.iter().any(|c| is_misc_component(c)) {
                    continue; // root or misc — stays loose, stays row-less
                }
                let leaf = (*comps.last().unwrap()).to_string();
                let folder_rel = comps.join("/");
                let album_id = match mimic_cache.get(&folder_rel) {
                    Some(id) => *id,
                    None => {
                        // Source folder for cover art — best-effort (skipped
                        // when the path doesn't resolve against any base).
                        let abs_folder = resolve_music_path(pool, library_id, &rel)
                            .await
                            .ok()
                            .and_then(|f| Path::new(&f).parent().map(|p| p.to_path_buf()));
                        let id = ensure_sound_collection(
                            pool,
                            library_id,
                            cache_base,
                            &leaf,
                            abs_folder.as_deref().map(|abs| (folder_rel.as_str(), abs)),
                        )
                        .await?;
                        mimic_cache.insert(folder_rel.clone(), id);
                        id
                    }
                };
                sqlx::query(
                    "INSERT OR REPLACE INTO sound_track_home (track_id, album_id) VALUES (?, ?)",
                )
                .bind(track_id)
                .bind(album_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
                reparent_sound_track(pool, track_id, album_id).await?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct SoundCollectionRow {
    pub id: i64,
    pub title: String,
}

/// The library's virtual sound collections, A–Z — the move-to-collection
/// picker's option list.
#[tauri::command]
pub async fn list_sound_collections(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<Vec<SoundCollectionRow>, String> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT al.id, al.title FROM album al
         JOIN media_entry me ON me.id = al.id
         JOIN sound_collection sc ON sc.album_id = al.id
         WHERE me.library_id = ?
         ORDER BY al.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(id, title)| SoundCollectionRow { id, title }).collect())
}

/// Create an empty virtual collection. Names are unique per library
/// (case-insensitive) — ensure_ finds an existing one, which the caller
/// experiences as "already exists".
#[tauri::command]
pub async fn create_sound_collection(
    state: State<'_, AppState>,
    library_id: String,
    title: String,
) -> Result<i64, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Collection name can't be empty".to_string());
    }
    let dup: Option<(i64,)> = sqlx::query_as(
        "SELECT al.id FROM album al
         JOIN media_entry me ON me.id = al.id
         JOIN sound_collection sc ON sc.album_id = al.id
         WHERE me.library_id = ? AND LOWER(al.title) = LOWER(?)",
    )
    .bind(&library_id)
    .bind(title)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    if dup.is_some() {
        return Err(format!("A collection named \"{title}\" already exists"));
    }
    // No folder → cache_base is never touched; empty path stands in.
    ensure_sound_collection(&state.app_db, &library_id, Path::new(""), title, None).await
}

/// Delete a collection: members demote to loose (their home rows pin them
/// there — the source folder can't re-mimic them back), then the entry goes.
#[tauri::command]
pub async fn delete_sound_collection(
    state: State<'_, AppState>,
    album_id: i64,
) -> Result<(), String> {
    let pool = &state.app_db;
    let library_id: String = sqlx::query_as::<_, (String,)>(
        "SELECT me.library_id FROM media_entry me
         JOIN sound_collection sc ON sc.album_id = me.id
         WHERE me.id = ?",
    )
    .bind(album_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .map(|(id,)| id)
    .ok_or_else(|| "Not a sound collection".to_string())?;
    let members: Vec<(i64,)> = sqlx::query_as("SELECT id FROM media_entry WHERE parent_id = ?")
        .bind(album_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    if !members.is_empty() {
        let (container_id, _) = ensure_loose_container(pool, &library_id, None, true).await?;
        for (track_id,) in members {
            sqlx::query(
                "INSERT OR REPLACE INTO sound_track_home (track_id, album_id) VALUES (?, NULL)",
            )
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            reparent_sound_track(pool, track_id, container_id).await?;
        }
    }
    sqlx::query("DELETE FROM media_entry WHERE id = ?")
        .bind(album_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Move a sound track into a collection (or None = out to loose). Writes the
/// home directive — the user's word — and reparents immediately.
#[tauri::command]
pub async fn move_sound_track(
    state: State<'_, AppState>,
    track_id: i64,
    collection_id: Option<i64>,
) -> Result<(), String> {
    let pool = &state.app_db;
    let library_id: String =
        sqlx::query_as::<_, (String,)>("SELECT library_id FROM media_entry WHERE id = ?")
            .bind(track_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .map(|(id,)| id)
            .ok_or_else(|| "Track no longer exists".to_string())?;
    match collection_id {
        Some(cid) => {
            let valid: Option<(i64,)> = sqlx::query_as(
                "SELECT sc.album_id FROM sound_collection sc
                 JOIN media_entry me ON me.id = sc.album_id
                 WHERE sc.album_id = ? AND me.library_id = ?",
            )
            .bind(cid)
            .bind(&library_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            if valid.is_none() {
                return Err("Collection no longer exists".to_string());
            }
            sqlx::query(
                "INSERT OR REPLACE INTO sound_track_home (track_id, album_id) VALUES (?, ?)",
            )
            .bind(track_id)
            .bind(cid)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            reparent_sound_track(pool, track_id, cid).await?;
        }
        None => {
            sqlx::query(
                "INSERT OR REPLACE INTO sound_track_home (track_id, album_id) VALUES (?, NULL)",
            )
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            let (container_id, _) = ensure_loose_container(pool, &library_id, None, true).await?;
            reparent_sound_track(pool, track_id, container_id).await?;
        }
    }
    Ok(())
}

async fn write_issues(
    pool: &SqlitePool,
    library_id: &str,
    issues: &[ScanIssue],
    // Sounds-typed base: recorded so the metadata center can leave them out.
    sound: bool,
) -> Result<(), String> {
    for issue in issues {
        sqlx::query("INSERT INTO music_scan_issue (library_id, file_path, reason, is_sound) VALUES (?, ?, ?, ?)")
            .bind(library_id)
            .bind(&issue.file_path)
            .bind(&issue.reason)
            .bind(sound as i64)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn clear_issues(pool: &SqlitePool, library_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM music_scan_issue WHERE library_id = ?")
        .bind(library_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Artist grouping (pure tags)
// ---------------------------------------------------------------------------

/// One tag-derived artist and everything scanned for them.
pub struct ScannedArtist {
    pub title: String,
    pub albums: Vec<ScannedAlbum>,
    /// Album-less tracks credited to this artist (via ALBUMARTIST/ARTIST
    /// tags); persisted under the artist's hidden loose container.
    pub loose: Vec<ScannedTrack>,
}

/// Scanned material that names no artist at all: albums whose tracks carry no
/// artist tags, and loose tracks with neither album nor artist. Persisted at
/// the library root (no artist entry is invented for them).
#[derive(Default)]
pub struct ScannedOrphans {
    pub albums: Vec<ScannedAlbum>,
    pub loose: Vec<ScannedTrack>,
}

/// Majority album-artist tag across an album's tracks.
/// An album is a SOUND album when any of its tracks came from a sounds base
/// (folder placement, not tags — "any" so a mixed oddity stays out of music
/// surfaces rather than leaking in).
fn album_is_sound(album: &ScannedAlbum) -> bool {
    album
        .releases
        .iter()
        .flat_map(|r| r.tracks.iter())
        .any(|t| t.sound)
}

/// Stamp/unstamp an album's sound marker to match the scan's verdict.
async fn set_sound_marker(pool: &SqlitePool, album_id: i64, sound: bool) -> Result<(), String> {
    if sound {
        sqlx::query("INSERT OR IGNORE INTO sound_album (album_id) VALUES (?)")
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        sqlx::query("DELETE FROM sound_album WHERE album_id = ?")
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn album_artist_of(album: &ScannedAlbum) -> String {
    if let Some((artist, _)) = &album.identity_override {
        return artist.clone();
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for r in &album.releases {
        for t in &r.tracks {
            *counts.entry(t.album_artist.as_str()).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(v, _)| v.to_string())
        .unwrap_or_default()
}

/// Group albums and loose tracks by album-artist tag (case-insensitive; the
/// most common casing becomes the display title). Folder placement plays no
/// part — this is what makes numbered/misfiled folders group correctly.
/// Material naming no artist at all comes back separately as orphans.
/// User split directives for one library: lowercased source string → ordered
/// member names ("jay-z & kanye west" → [JAY-Z, Kanye West]).
pub(crate) type ArtistSplits = HashMap<String, Vec<String>>;

pub(crate) async fn load_artist_splits(
    pool: &SqlitePool,
    library_id: &str,
) -> Result<ArtistSplits, String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT source_name, members FROM artist_split WHERE library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter_map(|(src, members)| {
            let list: Vec<String> = serde_json::from_str(&members).ok()?;
            (list.len() >= 2).then(|| (src.to_lowercase(), list))
        })
        .collect())
}

/// The member list a raw artist-name string resolves to, or None when it's a
/// single artist. Split directives win; the ';' multi-value tag convention
/// ("Drake; Future") splits automatically — it's an explicit separator, unlike
/// '&'/',' which legitimately appear inside band names.
pub(crate) fn split_members(splits: &ArtistSplits, name: &str) -> Option<Vec<String>> {
    if let Some(m) = splits.get(&name.to_lowercase()) {
        return Some(m.clone());
    }
    if name.contains(';') {
        let parts: Vec<String> = name
            .split(';')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        if parts.len() >= 2 {
            return Some(parts);
        }
    }
    None
}

/// Rewrite scanned data through the split directives BEFORE artist grouping:
/// a split album-artist re-homes under its first member (full list preserved
/// for album_artist_credit rows), and any track credit that IS a split source
/// expands into the members in place.
pub(crate) fn apply_artist_splits(
    splits: &ArtistSplits,
    albums: &mut [ScannedAlbum],
    loose: &mut [ScannedTrack],
) {
    // Note: even with no directives, the ';' multi-value convention applies.
    let fix_track = |t: &mut ScannedTrack| {
        if let Some(members) = split_members(splits, &t.album_artist) {
            t.album_artist = members[0].clone();
            t.album_artist_credits = members;
        }
        if t.credits.iter().any(|c| split_members(splits, c).is_some()) {
            let mut expanded: Vec<String> = Vec::new();
            for c in t.credits.drain(..) {
                match split_members(splits, &c) {
                    Some(members) => {
                        for m in members {
                            if !expanded.iter().any(|e| e.eq_ignore_ascii_case(&m)) {
                                expanded.push(m);
                            }
                        }
                    }
                    None => {
                        if !expanded.iter().any(|e| e.eq_ignore_ascii_case(&c)) {
                            expanded.push(c);
                        }
                    }
                }
            }
            t.credits = expanded;
        }
    };
    for album in albums.iter_mut() {
        for release in album.releases.iter_mut() {
            for t in release.tracks.iter_mut() {
                fix_track(t);
            }
        }
    }
    for t in loose.iter_mut() {
        fix_track(t);
    }
}

/// The ordered multi-artist credit for an album, majority-voted across its
/// tracks (same casing rule as album_artist_of). Empty = single-artist album.
fn album_credit_names(album: &ScannedAlbum) -> Vec<String> {
    let mut counts: HashMap<String, (usize, Vec<String>)> = HashMap::new();
    for r in &album.releases {
        for t in &r.tracks {
            if t.album_artist_credits.len() >= 2 {
                let key = t
                    .album_artist_credits
                    .iter()
                    .map(|n| n.to_lowercase())
                    .collect::<Vec<_>>()
                    .join("\u{1f}");
                let e = counts.entry(key).or_insert((0, t.album_artist_credits.clone()));
                e.0 += 1;
            }
        }
    }
    counts
        .into_values()
        .max_by_key(|(n, _)| *n)
        .map(|(_, names)| names)
        .unwrap_or_default()
}

/// Stamp the album's artist credit rows to match the scan (delete-then-
/// insert). EVERY album gets rows — a solo album's one row comes from its
/// album-artist tag, the same string artist grouping keys on — because the
/// credit list is the sole record of whose album this is.
/// `overwrite: false` (MB-matched albums, whose credits are authoritative)
/// only fills a gap — scan-derived credits land when no rows exist, and
/// existing MB-written rows are never clobbered by a tag re-parse.
async fn write_album_credits(
    pool: &SqlitePool,
    album_id: i64,
    album: &ScannedAlbum,
    overwrite: bool,
) -> Result<(), String> {
    let mut names = album_credit_names(album);
    if names.is_empty() {
        let solo = album_artist_of(album);
        if !solo.is_empty() {
            names.push(solo);
        }
    }
    if !overwrite {
        let existing: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM album_artist_credit WHERE album_id = ?")
                .bind(album_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
        if existing > 0 || names.is_empty() {
            return Ok(());
        }
    } else {
        sqlx::query("DELETE FROM album_artist_credit WHERE album_id = ?")
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    for (i, name) in names.iter().enumerate() {
        // Stamped right here (not just at the scan-end pass) so the album is
        // reachable on its artists' pages the moment it lands mid-scan. The
        // subselect's ASCII LOWER is a best effort; resolve_credit_ids
        // re-stamps with the Unicode rule when the scan settles.
        sqlx::query(
            "INSERT INTO album_artist_credit (album_id, position, name, artist_id)
             VALUES (?1, ?2, ?3,
                     (SELECT an.artist_id FROM artist_names an
                      JOIN media_entry ame ON ame.id = an.artist_id
                      JOIN media_entry alme ON alme.id = ?1
                      WHERE ame.library_id = alme.library_id
                        AND LOWER(an.name) = LOWER(?3) LIMIT 1))",
        )
        .bind(album_id)
        .bind(i as i64)
        .bind(name)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn group_by_artist(
    albums: Vec<ScannedAlbum>,
    loose: Vec<ScannedTrack>,
) -> (Vec<ScannedArtist>, ScannedOrphans) {
    let mut groups: HashMap<String, (HashMap<String, usize>, Vec<ScannedAlbum>, Vec<ScannedTrack>)> =
        HashMap::new();
    for album in albums {
        let name = album_artist_of(&album);
        let entry = groups.entry(name.to_lowercase()).or_default();
        *entry.0.entry(name).or_insert(0) += 1;
        entry.1.push(album);
    }
    for t in loose {
        let name = t.album_artist.clone();
        let entry = groups.entry(name.to_lowercase()).or_default();
        *entry.0.entry(name).or_insert(0) += 1;
        entry.2.push(t);
    }
    let mut orphans = ScannedOrphans::default();
    if let Some((_, albums, loose)) = groups.remove("") {
        orphans.albums = albums;
        orphans.loose = loose;
    }
    let mut out: Vec<ScannedArtist> = groups
        .into_values()
        .map(|(casings, albums, loose)| ScannedArtist {
            title: casings
                .into_iter()
                .max_by_key(|(_, n)| *n)
                .map(|(v, _)| v)
                .unwrap_or_default(),
            albums,
            loose,
        })
        .collect();
    out.sort_by_key(|a| a.title.to_lowercase());
    (out, orphans)
}

/// Where to look for artist images: the single common parent folder of every
/// release folder, when there is one (the standard Artist/Album layout). An
/// artist scattered across unrelated folders gets no folder art. The library
/// root never counts as an artist folder.
fn artist_common_parent(artist: &ScannedArtist) -> Option<(String, PathBuf)> {
    let mut parent: Option<(String, PathBuf)> = None;
    for album in &artist.albums {
        for release in &album.releases {
            let rel = Path::new(&release.folder_rel)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let abs = release.folder_abs.parent()?.to_path_buf();
            match &parent {
                None => parent = Some((rel, abs)),
                Some((existing, _)) if *existing == rel => {}
                _ => return None,
            }
        }
    }
    parent.filter(|(rel, _)| !rel.is_empty())
}

/// Sort scanned albums for sort_order assignment: release date then title.
fn album_sort_key(a: &ScannedAlbum) -> (String, String) {
    (
        album_release_date(a).unwrap_or_else(|| "9999".to_string()),
        album_title_of(a).to_lowercase(),
    )
}

pub(crate) async fn find_artist_by_title(
    pool: &SqlitePool,
    library_id: &str,
    title: &str,
) -> Result<Option<i64>, String> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT a.id FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ? AND LOWER(a.title) = LOWER(?)",
    )
    .bind(library_id)
    .bind(title)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|(id,)| id))
}

pub(crate) async fn next_artist_order(pool: &SqlitePool, library_id: &str) -> Result<i64, String> {
    let row: (Option<i64>,) = sqlx::query_as(
        "SELECT MAX(a.sort_order) FROM artist a JOIN media_entry me ON me.id = a.id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.0.map(|m| m + 1).unwrap_or(0))
}

/// Insert the artist row (no albums) and cache its folder art when it has a
/// canonical folder.
pub(crate) async fn insert_artist_row(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
    artist: &ScannedArtist,
    sort_order: i64,
) -> Result<i64, String> {
    let artist_type = entry_type_id(pool, "artist").await?;
    let parent = artist_common_parent(artist);
    let res = sqlx::query(
        "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
    )
    .bind(library_id)
    .bind(artist_type)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    let artist_entry_id = res.last_insert_rowid();

    sqlx::query(
        "INSERT INTO artist (id, title, sort_title, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(artist_entry_id)
    .bind(&artist.title)
    .bind(generate_sort_title(&artist.title, "en"))
    .bind(parent.as_ref().map(|(rel, _)| rel.as_str()).unwrap_or(""))
    .bind(sort_order)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some((rel, abs)) = &parent {
        sync_music_covers(pool, library_id, cache_base, rel, &desired_covers(abs, None)).await?;
    }
    Ok(artist_entry_id)
}

/// Punctuation-blind identity key for artist/credit names: "J Cole"/"J. Cole",
/// "Jay-Z"/"Jay Z", and joint-credit separator variants ("A & B", "A/B",
/// "A + B") collapse together; genuinely different names don't. Each ASCII
/// mark folds together with its full typographic Unicode class (MusicBrainz
/// canonicalizes to U+2010 hyphens, curly apostrophes, …). Key collisions
/// only ever produce merge SUGGESTIONS, so aggressive collapsing is safe.
pub(crate) fn credit_name_key(s: &str) -> String {
    let cleaned: String = s
        .to_lowercase()
        .chars()
        .map(|c| match c {
            // Periods & ellipsis.
            '.' | '…' => ' ',
            // Apostrophes & single/double quotes.
            '\'' | '’' | '‘' | '‛' | 'ʼ' | '`' | '´' | '"' | '“' | '”' | '„' => ' ',
            // Hyphens, dashes & minus signs.
            ',' | '-' | '‐' | '‑' | '‒' | '–' | '—' | '―' | '−' | '－' => ' ',
            // Joint-credit separators.
            '&' | '/' | '+' => ' ',
            c => c,
        })
        .collect();
    cleaned
        .split_whitespace()
        .filter(|w| *w != "and")
        .collect::<Vec<_>>()
        .join(" ")
}

/// Feature-only artists: every credit name that isn't already an artist (by
/// title OR alias) becomes one (no folder, no albums — their page shows what
/// they appear on). A name whose punctuation-blind key matches an EXISTING
/// artist doesn't spawn a lookalike — it becomes a pending merge suggestion
/// for the Match-to-MusicBrainz modal instead (unless previously rejected).
/// Returns how many artists were created.
pub async fn ensure_credit_artists(pool: &SqlitePool, library_id: &str) -> Result<usize, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT tc.name FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id
         WHERE me.library_id = ?1
           AND NOT EXISTS (
               SELECT 1 FROM artist_names an JOIN media_entry ame ON ame.id = an.artist_id
               WHERE ame.library_id = me.library_id AND LOWER(an.name) = LOWER(tc.name)
           )
         UNION ALL
         SELECT ac.name FROM album_artist_credit ac
         JOIN media_entry me ON me.id = ac.album_id
         WHERE me.library_id = ?1
           AND NOT EXISTS (
               SELECT 1 FROM artist_names an JOIN media_entry ame ON ame.id = an.artist_id
               WHERE ame.library_id = me.library_id AND LOWER(an.name) = LOWER(ac.name)
           )",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Most common casing per name wins as the display title.
    let mut casings: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for (name,) in rows {
        *casings
            .entry(name.to_lowercase())
            .or_default()
            .entry(name)
            .or_insert(0) += 1;
    }
    let mut names: Vec<String> = casings
        .into_values()
        .filter_map(|c| c.into_iter().max_by_key(|(_, n)| *n).map(|(v, _)| v))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());

    // Punctuation-blind keys of every existing artist name, most-albums-first
    // (by credit rows — albums have no artist parent) so the real "J. Cole"
    // is the suggested keep-target over any lookalike.
    let existing: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT a.id, a.title, an.name FROM artist a
         JOIN media_entry me ON me.id = a.id
         JOIN artist_names an ON an.artist_id = a.id
         WHERE me.library_id = ?
         ORDER BY (SELECT COUNT(*) FROM album_artist_credit ac WHERE ac.artist_id = a.id) DESC, a.id ASC",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut artist_by_key: HashMap<String, (i64, String)> = HashMap::new();
    // Two EXISTING artists sharing a key ("Martin O'Donnell & Michael
    // Salvatori" vs ".../Michael Salvatori") also become merge suggestions —
    // tag-created lookalikes, not just credit-vs-artist ones.
    let mut pair_suggestions: Vec<(String, serde_json::Value)> = Vec::new();
    for (id, title, name) in existing {
        let key = credit_name_key(&name);
        match artist_by_key.get(&key) {
            None => {
                artist_by_key.insert(key, (id, title));
            }
            Some((keep_id, keep_title)) if *keep_id != id => {
                pair_suggestions.push((
                    title.to_lowercase(),
                    serde_json::json!({
                        "keep_id": keep_id,
                        "keep_title": keep_title,
                        "other_name": title,
                    }),
                ));
            }
            _ => {}
        }
    }
    for (target_key, payload) in pair_suggestions {
        sqlx::query(
            "INSERT OR IGNORE INTO mb_suggestion (library_id, kind, target_key, payload)
             VALUES (?, 'artist_merge', ?, ?)",
        )
        .bind(library_id)
        .bind(target_key)
        .bind(payload.to_string())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    let mut next_order = next_artist_order(pool, library_id).await?;
    let mut created = 0usize;
    for name in names {
        if let Some((keep_id, keep_title)) = artist_by_key.get(&credit_name_key(&name)) {
            // Lookalike of an existing artist → suggest, don't spawn.
            // INSERT OR IGNORE: a previously rejected suggestion stays
            // rejected (the unique key holds it) and we never re-ask.
            let payload = serde_json::json!({
                "keep_id": keep_id,
                "keep_title": keep_title,
                "other_name": name,
            });
            sqlx::query(
                "INSERT OR IGNORE INTO mb_suggestion (library_id, kind, target_key, payload)
                 VALUES (?, 'artist_merge', ?, ?)",
            )
            .bind(library_id)
            .bind(name.to_lowercase())
            .bind(payload.to_string())
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            continue;
        }
        let artist = ScannedArtist { title: name.clone(), albums: Vec::new(), loose: Vec::new() };
        let id = insert_artist_row(pool, library_id, Path::new(""), &artist, next_order).await?;
        artist_by_key.insert(credit_name_key(&name), (id, name));
        next_order += 1;
        created += 1;
    }
    // Every mutation path already ends here (scan/rescan tails, matching
    // pass, credit edits), which makes this the natural place to stamp: the
    // credit set is final and the artists it names now exist.
    resolve_credit_ids(pool, library_id).await?;
    Ok(created)
}

/// Resolve an artist by ANY name they answer to (title + aliases,
/// case-insensitive), creating a minimal artist page when nobody does. The
/// ownership half of album credit edits: a reassigned album needs a real
/// parent entity for the name the user typed.
pub(crate) async fn resolve_or_create_artist(
    pool: &SqlitePool,
    library_id: &str,
    name: &str,
) -> Result<i64, String> {
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT an.artist_id FROM artist_names an
         JOIN media_entry me ON me.id = an.artist_id
         WHERE me.library_id = ? AND LOWER(an.name) = LOWER(?)
         LIMIT 1",
    )
    .bind(library_id)
    .bind(name)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some((id,)) = existing {
        return Ok(id);
    }
    let next_order = next_artist_order(pool, library_id).await?;
    let artist = ScannedArtist { title: name.to_string(), albums: Vec::new(), loose: Vec::new() };
    insert_artist_row(pool, library_id, Path::new(""), &artist, next_order).await
}

// ---------------------------------------------------------------------------
// Full scan (library creation) & rescan
// ---------------------------------------------------------------------------

/// Fresh scan of one music base folder (library creation). Grouping is pure
/// tags; a second base folder contributing albums for an artist the first
/// already created appends to the same artist row.
/// Fold one scanned album into another per a combine directive. `into_folder`
/// names the keeper EDITION a merge lands in (None = its default edition);
/// versions mode ignores it, since every incoming edition is appended.
fn fold_album(
    target: &mut ScannedAlbum,
    mut src: ScannedAlbum,
    mode: &str,
    into_folder: Option<&str>,
) {
    // Pin the keeper's identity BEFORE its track pool changes — otherwise the
    // incoming tracks outvote it and the album takes the folded-in album's
    // name (a 22-track Disc 2 renaming the 17-track Disc 1 it merged into).
    if target.identity_override.is_none() {
        target.identity_override = Some((album_artist_of(target), album_title_of(target)));
    }
    if mode == "merge" {
        let di = into_folder
            .and_then(|f| {
                target
                    .releases
                    .iter()
                    .position(|r| r.folder_rel.eq_ignore_ascii_case(f))
            })
            .unwrap_or(target.default_release);
        for rel in src.releases.drain(..) {
            target.releases[di].tracks.extend(rel.tracks);
        }
        // Coherent disc/track ordering across the merged material.
        target.releases[di]
            .tracks
            .sort_by(|a, b| {
                (a.disc_number, a.track_number.unwrap_or(i64::MAX), a.rel.clone())
                    .cmp(&(b.disc_number, b.track_number.unwrap_or(i64::MAX), b.rel.clone()))
            });
    } else {
        let src_title = album_title_of(&src);
        for mut rel in src.releases.drain(..) {
            // The source's unnamed release takes the source album's title as
            // its version label; a labelled one keeps its label but gains the
            // source title so "Deluxe Edition" still reads as WHOSE deluxe.
            rel.label = Some(match rel.label.take() {
                Some(l) if !l.eq_ignore_ascii_case(&src_title) => format!("{src_title} — {l}"),
                _ => src_title.clone(),
            });
            // Labels are what the picker shows, so they must stay distinct —
            // duplicates would be two identical, unchoosable entries.
            let base = rel.label.clone().unwrap_or_default();
            let mut label = base.clone();
            let mut n = 2;
            while target
                .releases
                .iter()
                .any(|r| r.label.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(&label)))
            {
                label = format!("{base} ({n})");
                n += 1;
            }
            rel.label = Some(label);
            target.releases.push(rel);
        }
    }
}

/// Pull user-split editions out into their own albums — the inverse of the
/// scanner's automatic grouping (two folders with identical album tags become
/// one album with two editions). A folder listed in album_release_split must
/// stand alone, so its release leaves that album and becomes an album of its
/// own. Runs BEFORE combines, so a split edition can then be combined
/// somewhere else. An album whose every edition is split keeps the last one
/// (something has to hold the tag identity).
pub(crate) async fn apply_release_splits(
    pool: &SqlitePool,
    library_id: &str,
    albums: &mut Vec<ScannedAlbum>,
) -> Result<(), String> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT folder_path FROM album_release_split WHERE library_id = ?")
            .bind(library_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(());
    }
    let split: HashSet<String> = rows.into_iter().map(|(f,)| f.to_lowercase()).collect();

    let mut extracted: Vec<ScannedAlbum> = Vec::new();
    for album in albums.iter_mut() {
        if album.releases.len() < 2 {
            continue; // a lone edition IS its own album already
        }
        let mut i = 0;
        while i < album.releases.len() && album.releases.len() > 1 {
            if split.contains(&album.releases[i].folder_rel.to_lowercase()) {
                let mut rel = album.releases.remove(i);
                // Standing alone, it's nobody's alternate cut any more.
                rel.label = None;
                let mut solo = ScannedAlbum {
                    folder_rel: rel.folder_rel.clone(),
                    folder_abs: rel.folder_abs.clone(),
                    releases: vec![rel],
                    default_release: 0,
                    identity_override: None,
                };
                finalize_album_releases(&mut solo);
                extracted.push(solo);
            } else {
                i += 1;
            }
        }
        // Removals shift the default index and can strand version labels —
        // re-derive both from what's left.
        finalize_album_releases(album);
    }
    albums.extend(extracted);
    Ok(())
}

/// Apply the library's album-combine directives to the scanned structures,
/// BEFORE reconcile: source albums are pulled out and folded into their
/// targets, so scans reproduce user combines instead of re-splitting them.
/// A directive whose source or target isn't present this scan is dormant.
pub(crate) async fn apply_album_combines(
    pool: &SqlitePool,
    library_id: &str,
    artists: &mut Vec<ScannedArtist>,
    orphans: &mut ScannedOrphans,
) -> Result<(), String> {
    let directives: Vec<(String, String, String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT c.source_artist, c.source_title, c.target_artist, c.target_title, c.mode,
                c.target_folder
         FROM album_combine c
         WHERE c.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if directives.is_empty() {
        return Ok(());
    }

    let key_matches = |album: &ScannedAlbum, artist: &str, title: &str| {
        album_artist_of(album).to_lowercase() == artist
            && album_title_of(album).to_lowercase() == title
    };

    // Pull sources out, remembering where they came from for dormant put-back.
    enum Origin {
        Artist(usize),
        Orphan,
    }
    let mut pulled: Vec<(usize, Origin, ScannedAlbum)> = Vec::new();
    for (ai, artist) in artists.iter_mut().enumerate() {
        let mut i = 0;
        while i < artist.albums.len() {
            if let Some(di) = directives
                .iter()
                .position(|d| key_matches(&artist.albums[i], &d.0, &d.1))
            {
                pulled.push((di, Origin::Artist(ai), artist.albums.remove(i)));
            } else {
                i += 1;
            }
        }
    }
    {
        let mut i = 0;
        while i < orphans.albums.len() {
            if let Some(di) = directives
                .iter()
                .position(|d| key_matches(&orphans.albums[i], &d.0, &d.1))
            {
                pulled.push((di, Origin::Orphan, orphans.albums.remove(i)));
            } else {
                i += 1;
            }
        }
    }

    // (album folder, poured-into RELEASE folder) — a merge only invalidates
    // the release whose track list actually changed; the card's other
    // releases keep their own pinned pressings.
    let mut merge_targets: Vec<(String, String)> = Vec::new();
    for (di, origin, src) in pulled {
        let d = &directives[di];
        // Locate the target by index so the fold can borrow mutably.
        let mut found: Option<(Option<usize>, usize)> = None;
        'search: for (ai, artist) in artists.iter().enumerate() {
            for (bi, album) in artist.albums.iter().enumerate() {
                if key_matches(album, &d.2, &d.3) {
                    found = Some((Some(ai), bi));
                    break 'search;
                }
            }
        }
        if found.is_none() {
            for (bi, album) in orphans.albums.iter().enumerate() {
                if key_matches(album, &d.2, &d.3) {
                    found = Some((None, bi));
                    break;
                }
            }
        }
        // A merge invalidates the poured-into release's pin ONLY on its FIRST
        // application — the one that actually changes the track list, proven
        // by the source still existing as its own album row. The directive is
        // permanent and re-folds on every rescan; wiping the pin each time
        // unmatched the release on every rescan (it did exactly that).
        let first_application = if d.4 == "merge" {
            sqlx::query_as::<_, (i64,)>(
                "SELECT al.id FROM album al JOIN media_entry me ON me.id = al.id
                 WHERE me.library_id = ? AND al.folder_path = ? AND LOWER(al.title) = ?",
            )
            .bind(library_id)
            .bind(&src.folder_rel)
            .bind(&d.1)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .is_some()
        } else {
            false
        };
        match found {
            Some((Some(ai), bi)) => {
                if d.4 == "merge" && first_application {
                    let t = &artists[ai].albums[bi];
                    let rf = d
                        .5
                        .clone()
                        .unwrap_or_else(|| t.releases[t.default_release].folder_rel.clone());
                    let key = (t.folder_rel.clone(), rf);
                    if !merge_targets.contains(&key) {
                        merge_targets.push(key);
                    }
                }
                fold_album(&mut artists[ai].albums[bi], src, &d.4, d.5.as_deref())
            }
            Some((None, bi)) => {
                if d.4 == "merge" && first_application {
                    let t = &orphans.albums[bi];
                    let rf = d
                        .5
                        .clone()
                        .unwrap_or_else(|| t.releases[t.default_release].folder_rel.clone());
                    let key = (t.folder_rel.clone(), rf);
                    if !merge_targets.contains(&key) {
                        merge_targets.push(key);
                    }
                }
                fold_album(&mut orphans.albums[bi], src, &d.4, d.5.as_deref())
            }
            None => match origin {
                // Target absent this scan — put the source back untouched.
                Origin::Artist(ai) => artists[ai].albums.push(src),
                Origin::Orphan => orphans.albums.push(src),
            },
        }
    }

    // A merge rewrites ONE release's track list, which invalidates the
    // pressing pinned to it: that release would keep reading matched while
    // its merged-in tracks never received the release's credits. Dropping
    // that release's pin HERE — before reconcile — makes this same rescan
    // rebuild tag credits for its tracks uniformly (the per-release credits
    // guard only protects pinned releases); a fresh pin then applies to the
    // complete list. The album's GROUP identity and every other release's
    // pin survive untouched. (Versions mode changes no track list at all.)
    for (album_folder, release_folder) in merge_targets {
        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT al.id FROM album al JOIN media_entry me ON me.id = al.id
             WHERE me.library_id = ? AND al.folder_path = ?",
        )
        .bind(library_id)
        .bind(&album_folder)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        let Some((album_id,)) = row else { continue };
        sqlx::query("DELETE FROM release_match WHERE album_id = ? AND folder_path = ?")
            .bind(album_id)
            .bind(&release_folder)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM album_match_gap WHERE album_id = ? AND folder_path = ?")
            .bind(album_id)
            .bind(&release_folder)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn scan_music_library(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    library_id: &str,
    base_path: &Path,
    cache_base: &Path,
    cancel: &AtomicBool,
    // The base is a sounds-typed folder — everything scanned is sound-marked.
    sound: bool,
) -> Result<(), String> {
    let mut issues = Vec::new();
    let ScanOutput { albums, loose } = scan_base(base_path, sound, &mut issues, Some(cancel), None, |folder, done, total| {
        crate::commands::emit_scan_progress_phased(app, library_id, folder, "read-tags", done, total);
    })?;
    write_issues(pool, library_id, &issues, sound).await?;
    let mut albums = group_sibling_albums(albums);
    apply_release_splits(pool, library_id, &mut albums).await?;
    let mut loose = loose;
    // Split directives + ';' multi-value album artists re-home BEFORE grouping.
    let splits = load_artist_splits(pool, library_id).await?;
    apply_artist_splits(&splits, &mut albums, &mut loose);
    let (mut artists, mut orphans) = group_by_artist(albums, loose);
    apply_album_combines(pool, library_id, &mut artists, &mut orphans).await?;

    // Build phase: one unit per album insert plus one per loose-track group —
    // the two kinds of work the loop below actually pays for (cover decode +
    // thumbnailing dominating). Known exactly once grouping settles.
    let build_total: usize = artists
        .iter()
        .map(|a| a.albums.len() + usize::from(!a.loose.is_empty()))
        .sum::<usize>()
        + orphans.albums.len()
        + usize::from(!orphans.loose.is_empty());
    let mut built = 0usize;

    let mut next_order = next_artist_order(pool, library_id).await?;
    for artist in artists {
        if cancel.load(Ordering::SeqCst) {
            return Err("Library creation cancelled".to_string());
        }
        crate::commands::emit_scan_progress_phased(app, library_id, &artist.title, "build", built, build_total);
        let artist_id = match find_artist_by_title(pool, library_id, &artist.title).await? {
            Some(id) => id,
            None => {
                let id = insert_artist_row(pool, library_id, cache_base, &artist, next_order).await?;
                next_order += 1;
                id
            }
        };
        let mut sorted = artist.albums;
        sorted.sort_by_key(album_sort_key);
        for (j, album) in sorted.iter().enumerate() {
            // Inserting is the other slow half (cover decode + thumbnailing),
            // so it reports per album too.
            crate::commands::emit_scan_progress_phased(
                app,
                library_id,
                &format!("{} — {}", artist.title, album_title_of(album)),
                "build",
                built,
                build_total,
            );
            insert_album(pool, library_id, cache_base, album, j as i64).await?;
            built += 1;
        }
        if !artist.loose.is_empty() {
            crate::commands::emit_scan_progress_phased(
                app,
                library_id,
                &format!("{} — loose tracks", artist.title),
                "build",
                built,
                build_total,
            );
            let (container_id, release_id) =
                ensure_loose_container(pool, library_id, Some(artist_id), sound).await?;
            let mut none = HashMap::new();
            reconcile_loose_tracks(pool, library_id, container_id, release_id, &artist.loose, &mut none)
                .await?;
            built += 1;
        }
    }

    // Material naming no artist at all: credit-less albums, artist-less loose
    // tracks under the library-root container.
    for (j, album) in orphans.albums.iter().enumerate() {
        crate::commands::emit_scan_progress_phased(
            app,
            library_id,
            &album_title_of(album),
            "build",
            built,
            build_total,
        );
        insert_album(pool, library_id, cache_base, album, j as i64).await?;
        built += 1;
    }
    if !orphans.loose.is_empty() {
        crate::commands::emit_scan_progress_phased(app, library_id, "loose tracks", "build", built, build_total);
        let (container_id, release_id) = ensure_loose_container(pool, library_id, None, sound).await?;
        let mut none = HashMap::new();
        reconcile_loose_tracks(pool, library_id, container_id, release_id, &orphans.loose, &mut none)
            .await?;
    }

    // Featured names without a page of their own become artists too.
    ensure_credit_artists(pool, library_id).await?;
    // Sound tracks pooled loose above get their collections (folder-mimicked
    // or directive-placed).
    apply_sound_homes(pool, library_id, cache_base).await?;
    Ok(())
}

/// Rescan all music base folders of a library. Grouping is pure tags, so this
/// also absorbs re-taggings: albums are matched by any of their release
/// folders and reparented onto their (possibly different) artist; tracks are
/// matched library-wide by file_path and reparented — entry ids and play
/// history survive merges, splits, and artist renames. Whatever nothing
/// claims is swept at the end.
pub async fn rescan_music_library(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    library_id: &str,
    // (base, is_sounds) — sounds-typed bases sound-mark everything they yield.
    base_paths: &[(PathBuf, bool)],
    cache_base: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    clear_issues(pool, library_id).await?;

    // The unchanged-file gate: every track's stored (hash, size, mtime), so
    // files whose stamp still matches skip the full audio read entirely and
    // read-tags costs a stat + tag probe. Rows without stamps (pre-gate data)
    // simply miss and hash once.
    let prior: HashMap<String, (String, i64, i64)> = sqlx::query_as::<
        _,
        (String, Option<String>, Option<i64>, Option<i64>),
    >(
        "SELECT t.file_path, t.audio_hash, t.content_size, t.content_mtime
         FROM track t JOIN media_entry me ON me.id = t.id
         WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .filter_map(|(rel, h, s, m)| Some((rel, (h?, s?, m?))))
    .collect();

    let mut all_albums = Vec::new();
    let mut all_loose = Vec::new();
    // Bases scan sequentially, each learning its own file count up front —
    // the offset keeps the displayed numbers cumulative instead of resetting
    // per base (the total honestly grows as later bases are discovered).
    let mut files_offset = 0usize;
    for (base_path, sound) in base_paths {
        if cancel.load(Ordering::SeqCst) {
            return Err("Rescan cancelled".to_string());
        }
        let mut issues = Vec::new();
        let mut base_total = 0usize;
        let out = scan_base(
            base_path,
            *sound,
            &mut issues,
            Some(cancel),
            Some(&prior),
            |folder, done, total| {
                base_total = total;
                crate::commands::emit_scan_progress_phased(
                    app,
                    library_id,
                    folder,
                    "read-tags",
                    files_offset + done,
                    files_offset + total,
                );
            },
        )?;
        files_offset += base_total;
        all_albums.extend(out.albums);
        all_loose.extend(out.loose);
        write_issues(pool, library_id, &issues, *sound).await?;
    }
    let mut albums = group_sibling_albums(all_albums);
    apply_release_splits(pool, library_id, &mut albums).await?;
    let mut all_loose = all_loose;
    let splits = load_artist_splits(pool, library_id).await?;
    apply_artist_splits(&splits, &mut albums, &mut all_loose);
    let (mut artists, mut orphans) = group_by_artist(albums, all_loose);
    apply_album_combines(pool, library_id, &mut artists, &mut orphans).await?;

    // Build phase counting, same units as the create scan: one per album
    // (claimed or fresh) plus one per loose-track group.
    let build_total: usize = artists
        .iter()
        .map(|a| a.albums.len() + usize::from(!a.loose.is_empty()))
        .sum::<usize>()
        + orphans.albums.len()
        + usize::from(!orphans.loose.is_empty());
    let mut built = 0usize;

    // DB state up front. Artists match by EVERY name they answer to (title +
    // aliases) — a user-renamed artist keeps their old tag name as an alias,
    // so the scan still finds them instead of re-creating the tag-named one.
    let db_artists: Vec<(i64, String)> = sqlx::query_as(
        "SELECT an.artist_id, an.name FROM artist_names an
         JOIN media_entry me ON me.id = an.artist_id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    // Every album, by its canonical folder AND every release folder it holds —
    // a scanned album claims an existing entry if ANY of its edition folders
    // is already known, so a change of default edition doesn't orphan history.
    // Loose containers are excluded: their folder_path is '' and would collide
    // with genuine root-folder albums; they're claimed via loose_album instead.
    // Virtual sound collections are excluded like loose containers: they're
    // never folder-claimed (a mimicked folder_path is an ART anchor, not an
    // identity) and never swept — they live until the user deletes them.
    let db_albums: Vec<(i64, String)> = sqlx::query_as(
        "SELECT al.id, al.folder_path FROM album al
         JOIN media_entry me ON me.id = al.id WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_collection sc WHERE sc.album_id = al.id)",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let db_release_folders: Vec<(i64, String)> = sqlx::query_as(
        "SELECT ar.album_id, ar.folder_path FROM album_release ar
         JOIN media_entry me ON me.id = ar.album_id WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = ar.album_id)
           AND NOT EXISTS (SELECT 1 FROM sound_collection sc WHERE sc.album_id = ar.album_id)",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let db_tracks: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT t.id, t.file_path, me.parent_id FROM track t
         JOIN media_entry me ON me.id = t.id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let artist_by_lower: HashMap<String, i64> = db_artists
        .into_iter()
        .map(|(id, t)| (t.to_lowercase(), id))
        .collect();
    // One folder can hold SEVERAL tag-albums ("Relapse" + "Relapse: Refill"
    // discs in one download folder), so folder → candidates is a list; the
    // claim disambiguates by which entry already owns the scanned files.
    let mut albums_by_folder: HashMap<String, Vec<i64>> = HashMap::new();
    for (id, p) in &db_albums {
        let v = albums_by_folder.entry(p.clone()).or_default();
        if !v.contains(id) {
            v.push(*id);
        }
    }
    for (id, p) in db_release_folders {
        let v = albums_by_folder.entry(p).or_default();
        if !v.contains(&id) {
            v.push(id);
        }
    }
    let album_folder_by_id: HashMap<i64, String> = db_albums.into_iter().collect();
    // Which album each known file currently belongs to — the tie-breaker for
    // same-folder multi-album claims (file paths survive retitles and MB
    // renames, unlike titles).
    let track_album_by_path: HashMap<String, i64> = db_tracks
        .iter()
        .filter_map(|(_, p, parent)| parent.map(|a| (p.clone(), a)))
        .collect();
    // Which track ids existed BEFORE this scan — the hash rescue in the sweep
    // only pairs disappeared rows with rows created THIS scan.
    let original_track_ids: HashSet<i64> = db_tracks.iter().map(|(id, _, _)| *id).collect();
    let mut existing_tracks: HashMap<String, i64> =
        db_tracks.into_iter().map(|(id, p, _)| (p, id)).collect();

    let mut seen_album_ids: HashSet<i64> = HashSet::new();
    let mut next_order = next_artist_order(pool, library_id).await?;

    // Which existing album a scanned album IS. A lone unclaimed candidate in
    // its folders claims directly (retitled tags keep their history). With
    // several candidates (same-folder multi-album), the entry owning the most
    // of this album's files wins — no shared files means a genuinely new
    // album in a shared folder, inserted fresh.
    let claim_album = |album: &ScannedAlbum, seen: &HashSet<i64>| -> Option<i64> {
        let mut cands: Vec<i64> = Vec::new();
        for r in &album.releases {
            if let Some(ids) = albums_by_folder.get(&r.folder_rel) {
                for id in ids {
                    if !seen.contains(id) && !cands.contains(id) {
                        cands.push(*id);
                    }
                }
            }
        }
        if cands.len() <= 1 {
            return cands.first().copied();
        }
        let mut votes: HashMap<i64, usize> = HashMap::new();
        for r in &album.releases {
            for t in &r.tracks {
                if let Some(owner) = track_album_by_path.get(&t.rel) {
                    if cands.contains(owner) {
                        *votes.entry(*owner).or_insert(0) += 1;
                    }
                }
            }
        }
        votes.into_iter().max_by_key(|(_, n)| *n).map(|(id, _)| id)
    };

    for artist in artists {
        // Cancel lands BETWEEN artists, never mid-artist: each finished
        // artist is fully reconciled, the end-of-scan sweep never runs, and
        // the next rescan simply completes the rest. Nothing is deleted.
        if cancel.load(Ordering::SeqCst) {
            return Err("Rescan cancelled".to_string());
        }
        crate::commands::emit_scan_progress_phased(app, library_id, &artist.title, "build", built, build_total);
        let artist_id = match artist_by_lower.get(&artist.title.to_lowercase()) {
            Some(id) => {
                let parent = artist_common_parent(&artist);
                // Casing refresh ONLY when the scanned tag name IS the
                // artist's current title (differing at most by case). A group
                // matched through an ALIAS (merged variant, user rename) must
                // never rewrite the title to the alias spelling — otherwise a
                // library tagged with both "A & B" and "A/B" flip-flops the
                // artist's name to whichever variant scans last.
                let (current_title,): (String,) =
                    sqlx::query_as("SELECT title FROM artist WHERE id = ?")
                        .bind(id)
                        .fetch_one(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                if current_title.eq_ignore_ascii_case(&artist.title) {
                    sqlx::query("UPDATE artist SET title = ?, sort_title = ?, folder_path = ? WHERE id = ?")
                        .bind(&artist.title)
                        .bind(generate_sort_title(&artist.title, "en"))
                        .bind(parent.as_ref().map(|(rel, _)| rel.as_str()).unwrap_or(""))
                        .bind(id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    crate::music_edit::reapply_artist_overrides(pool, *id).await?;
                } else {
                    // Alias-matched: keep the name; still refresh the art
                    // anchor folder.
                    sqlx::query("UPDATE artist SET folder_path = ? WHERE id = ?")
                        .bind(parent.as_ref().map(|(rel, _)| rel.as_str()).unwrap_or(""))
                        .bind(id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                if let Some((rel, abs)) = &parent {
                    sync_music_covers(pool, library_id, cache_base, rel, &desired_covers(abs, None))
                        .await?;
                }
                *id
            }
            None => {
                let id = insert_artist_row(pool, library_id, cache_base, &artist, next_order).await?;
                next_order += 1;
                id
            }
        };

        let mut sorted = artist.albums;
        sorted.sort_by_key(album_sort_key);
        for (j, album) in sorted.iter().enumerate() {
            crate::commands::emit_scan_progress_phased(
                app,
                library_id,
                &format!("{} — {}", artist.title, album_title_of(album)),
                "build",
                built,
                build_total,
            );
            built += 1;
            // Only claim an entry once — if two DB albums merged into one
            // scanned album, the first wins and the other empties out
            // (its tracks reparent) and is swept below.
            let target = claim_album(album, &seen_album_ids);
            match target {
                Some(album_id) => {
                    seen_album_ids.insert(album_id);
                    sqlx::query("UPDATE album SET sort_order = ? WHERE id = ?")
                        .bind(j as i64)
                        .bind(album_id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    // No reparent: a changed album-artist tag moves the album
                    // through its CREDIT rows — reconcile_album rewrites them
                    // from tags (unless MusicBrainz already owns them).
                    reconcile_album(pool, library_id, cache_base, album_id, album, &mut existing_tracks)
                        .await?;
                }
                None => {
                    // Fresh entries; any old same-path entries left in
                    // existing_tracks are stale and belong to the sweep.
                    let id = insert_album(pool, library_id, cache_base, album, j as i64).await?;
                    seen_album_ids.insert(id);
                }
            }
        }

        if !artist.loose.is_empty() {
            crate::commands::emit_scan_progress_phased(
                app,
                library_id,
                &format!("{} — loose tracks", artist.title),
                "build",
                built,
                build_total,
            );
            built += 1;
            // Bases differ in type across a rescan, so a mixed list splits
            // into the music container and the sound-marked one.
            let (sound_loose, music_loose): (Vec<_>, Vec<_>) =
                artist.loose.into_iter().partition(|t| t.sound);
            for (loose, sound) in [(music_loose, false), (sound_loose, true)] {
                if loose.is_empty() {
                    continue;
                }
                let (container_id, release_id) =
                    ensure_loose_container(pool, library_id, Some(artist_id), sound).await?;
                reconcile_loose_tracks(
                    pool,
                    library_id,
                    container_id,
                    release_id,
                    &loose,
                    &mut existing_tracks,
                )
                .await?;
            }
        }
    }

    // Material naming no artist: albums live at the root, artist-less loose
    // tracks under the library-root container.
    for (j, album) in orphans.albums.iter().enumerate() {
        crate::commands::emit_scan_progress_phased(app, library_id, &album_title_of(album), "build", built, build_total);
        built += 1;
        let target = claim_album(album, &seen_album_ids);
        match target {
            Some(album_id) => {
                seen_album_ids.insert(album_id);
                sqlx::query("UPDATE album SET sort_order = ? WHERE id = ?")
                    .bind(j as i64)
                    .bind(album_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                reconcile_album(pool, library_id, cache_base, album_id, album, &mut existing_tracks)
                    .await?;
            }
            None => {
                let id = insert_album(pool, library_id, cache_base, album, j as i64).await?;
                seen_album_ids.insert(id);
            }
        }
    }
    if !orphans.loose.is_empty() {
        crate::commands::emit_scan_progress_phased(app, library_id, "loose tracks", "build", built, build_total);
        let (sound_loose, music_loose): (Vec<_>, Vec<_>) =
            orphans.loose.into_iter().partition(|t| t.sound);
        for (loose, sound) in [(music_loose, false), (sound_loose, true)] {
            if loose.is_empty() {
                continue;
            }
            let (container_id, release_id) =
                ensure_loose_container(pool, library_id, None, sound).await?;
            reconcile_loose_tracks(
                pool,
                library_id,
                container_id,
                release_id,
                &loose,
                &mut existing_tracks,
            )
            .await?;
        }
    }

    // Global sweeps for anything the scan never claimed.
    // 1. Tracks whose files are gone (or are now unreadable) — after the
    //    hash rescue: a disappeared row whose audio fingerprint reappeared at
    //    exactly one path CREATED THIS SCAN is the same recording moved or
    //    renamed (retagging can't change the fingerprint — it covers the
    //    audio region only). Its identity migrates — plays, loved, playlist
    //    links, user overrides and MB ids — instead of dying with the path.
    //    Strictly one-to-one: duplicate rips legitimately share hashes, and
    //    history must never be spliced onto a guess, so any ambiguity falls
    //    through to today's delete + add.
    let dead: Vec<(String, i64)> = existing_tracks.into_iter().collect();
    let mut dead_by_hash: HashMap<String, Vec<i64>> = HashMap::new();
    for (_, id) in &dead {
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT audio_hash FROM track WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((Some(h),)) = row {
            dead_by_hash.entry(h).or_default().push(*id);
        }
    }
    for (hash, olds) in dead_by_hash {
        if olds.len() != 1 {
            continue; // several vanished copies share this sound — ambiguous
        }
        let old_id = olds[0];
        let mut news: Vec<i64> = sqlx::query_as::<_, (i64,)>(
            "SELECT t.id FROM track t JOIN media_entry me ON me.id = t.id
             WHERE me.library_id = ? AND t.audio_hash = ? AND t.id != ?",
        )
        .bind(library_id)
        .bind(&hash)
        .bind(old_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id,)| id)
        .filter(|id| !original_track_ids.contains(id))
        .collect();
        if news.len() != 1 {
            continue; // no reappearance, or several candidates — ambiguous
        }
        let new_id = news.remove(0);
        // Same recording, new row: everything attached to the old identity
        // moves over. Credits/tags stay the NEW row's (tags are truth for
        // organization); history/curation follow the sound.
        sqlx::query("UPDATE music_play SET track_id = ? WHERE track_id = ?")
            .bind(new_id)
            .bind(old_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT OR IGNORE INTO track_loved (track_id, loved_at)
             SELECT ?, loved_at FROM track_loved WHERE track_id = ?",
        )
        .bind(new_id)
        .bind(old_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE media_link SET target_entry_id = ? WHERE target_entry_id = ?")
            .bind(new_id)
            .bind(old_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        // User edits and MB recording ids ride along; collisions (the new
        // row somehow already has the field) keep the new row's value and
        // the leftovers die with the old row.
        sqlx::query("UPDATE OR IGNORE field_override SET entity_id = ? WHERE entity_id = ?")
            .bind(new_id)
            .bind(old_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    for (_, track_id) in dead {
        sqlx::query("DELETE FROM media_entry WHERE id = ?")
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    // 1b. Loose containers left empty (their tracks vanished or gained album
    //     tags and moved into real albums). Runs before the album/artist
    //     sweeps so an artist holding only an empty container reads childless.
    sqlx::query(
        "DELETE FROM media_entry WHERE id IN (
            SELECT la.album_id FROM loose_album la
            JOIN media_entry me ON me.id = la.album_id
            WHERE me.library_id = ?
              AND NOT EXISTS (SELECT 1 FROM media_entry c WHERE c.parent_id = la.album_id)
        )",
    )
    .bind(library_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    // 2. Albums nothing claimed: folder gone, or merged away into another
    //    album (their tracks were reparented before this runs). Cache cleanup
    //    skips folders another album still uses (mixed-tag folders).
    for (id, rel) in album_folder_by_id.iter() {
        if seen_album_ids.contains(id) {
            continue;
        }
        sqlx::query("DELETE FROM media_entry WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        if !rel.is_empty() {
            let shared: Option<(i64,)> = sqlx::query_as(
                "SELECT 1 FROM album al JOIN media_entry me ON me.id = al.id
                 WHERE me.library_id = ? AND al.folder_path = ? LIMIT 1",
            )
            .bind(library_id)
            .bind(rel)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            if shared.is_none() {
                delete_cached_images_for_entry(pool, library_id, cache_base, rel).await?;
            }
        }
    }
    // Joint-name credits preserved inside MB-matched albums (reconcile keeps
    // MB-tier credits) split in place, so a split-away artist can't survive
    // through them.
    apply_splits_to_stored_credits(pool, library_id, &splits).await?;

    // 3. Artists left childless (tag renamed away, or everything under them
    //    vanished) — UNLESS they're still credited somewhere.
    sweep_orphan_artists(pool, library_id, cache_base).await?;

    // Featured names without a page of their own become artists too (runs
    // after the sweeps so it sees the final credit set).
    ensure_credit_artists(pool, library_id).await?;

    // Sound tracks pooled loose above get their collections back (home
    // directives win; new/never-placed files folder-mimic once). Runs after
    // the sweeps so vanished-collection directives demote cleanly.
    apply_sound_homes(pool, library_id, cache_base).await?;

    Ok(())
}

/// Delete artists that neither hold anything nor are credited anywhere
/// (alias-aware). Runs in rescans AND at the end of every matching pass — the
/// pass replaces parsed credits with authoritative ones, which can orphan an
/// artist that only existed to back a since-replaced credit string (e.g. a
/// "2 Chainz, Lil Wayne" joint credit decomposed by MusicBrainz). Cache
/// cleanup is deliberately shallow: the folder usually still exists and holds
/// live album caches (only the TAG changed), so only the artist's own covers
/// pair goes — and only when no surviving artist shares the folder.
/// Expand STORED track-credit rows that are themselves a split source ("A & B"
/// as one credit → the members, in place). The scan-time expansion only
/// reaches credits being rewritten — reconcile preserves MB-tier credits
/// untouched, so joint strings inside MB-matched albums would otherwise keep
/// the joint artist alive forever.
async fn apply_splits_to_stored_credits(
    pool: &SqlitePool,
    library_id: &str,
    splits: &ArtistSplits,
) -> Result<(), String> {
    for (source_lower, members) in splits {
        let rows: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT tc.track_id, tc.position FROM track_credit tc
             JOIN media_entry me ON me.id = tc.track_id
             WHERE me.library_id = ?1 AND LOWER(tc.name) = ?2",
        )
        .bind(library_id)
        .bind(source_lower)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        for (track_id, position) in rows {
            let existing: Vec<String> = sqlx::query_as::<_, (String,)>(
                "SELECT name FROM track_credit WHERE track_id = ?",
            )
            .bind(track_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(n,)| n)
            .collect();
            sqlx::query("DELETE FROM track_credit WHERE track_id = ? AND position = ?")
                .bind(track_id)
                .bind(position)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            // First member takes the vacated slot; the rest append past BOTH
            // the remaining max and the vacated slot (when the joint string
            // was the only credit, MAX is empty and appending at 0 would
            // collide with the slot the first member just took).
            let max_remaining: i64 = sqlx::query_scalar::<_, Option<i64>>(
                "SELECT MAX(position) FROM track_credit WHERE track_id = ?",
            )
            .bind(track_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(-1);
            let mut next_pos: i64 = std::cmp::max(max_remaining + 1, position + 1);
            let mut first = true;
            for member in members {
                if existing.iter().any(|e| e.eq_ignore_ascii_case(member)) {
                    continue;
                }
                let pos = if first { position } else { next_pos };
                if !first {
                    next_pos += 1;
                }
                sqlx::query(
                    "INSERT INTO track_credit (track_id, position, name) VALUES (?, ?, ?)",
                )
                .bind(track_id)
                .bind(pos)
                .bind(member)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
                first = false;
            }
        }
    }
    Ok(())
}

pub(crate) async fn sweep_orphan_artists(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
) -> Result<usize, String> {
    let childless: Vec<(i64, String)> = sqlx::query_as(
        "SELECT a.id, a.folder_path FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM media_entry c WHERE c.parent_id = a.id)
           AND NOT EXISTS (
               SELECT 1 FROM track_credit tc
               JOIN media_entry tme ON tme.id = tc.track_id
               JOIN artist_names an ON an.artist_id = a.id
               WHERE tme.library_id = me.library_id AND LOWER(tc.name) = LOWER(an.name)
           )
           AND NOT EXISTS (
               SELECT 1 FROM album_artist_credit ac
               JOIN media_entry ame2 ON ame2.id = ac.album_id
               JOIN artist_names an2 ON an2.artist_id = a.id
               WHERE ame2.library_id = me.library_id AND LOWER(ac.name) = LOWER(an2.name)
           )",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let swept = childless.len();
    for (id, rel) in childless {
        crate::music_art::purge_artist_images(pool, library_id, cache_base, id).await?;
        sqlx::query("DELETE FROM media_entry WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        if !rel.is_empty() {
            let shared: Option<(i64,)> = sqlx::query_as(
                "SELECT 1 FROM artist a JOIN media_entry me ON me.id = a.id
                 WHERE me.library_id = ? AND a.folder_path = ? LIMIT 1",
            )
            .bind(library_id)
            .bind(&rel)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            if shared.is_none() {
                sqlx::query(
                    "DELETE FROM cached_images WHERE library_id = ? AND entry_folder_path = ?",
                )
                .bind(library_id)
                .bind(&rel)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
                let _ = std::fs::remove_dir_all(cache_base.join(&rel).join("covers"));
                let _ = std::fs::remove_dir_all(cache_base.join(&rel).join("covers_thumb"));
            }
        }
    }
    Ok(swept)
}

// ---------------------------------------------------------------------------
// Browse queries (commands)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct AlbumCard {
    pub id: i64,
    pub title: String,
    pub year: Option<String>,
    /// Full release date (YYYY or YYYY-MM-DD) — client-side date sorting.
    pub release_date: Option<String>,
    pub covers: Vec<String>,
    pub selected_cover: Option<String>,
    pub track_count: i64,
    pub release_count: i64,
    pub runtime_secs: i64,
    /// Owning artist — set on appears-on cards (another artist's album).
    pub artist_title: Option<String>,
    /// Full artist credit for the album header line: the album_artist_credit
    /// rows when multi-artist, else the single owner. Each linkable when the
    /// library has that artist.
    pub artists: Vec<CreditView>,
}

#[derive(Debug, Serialize)]
pub struct ArtistDetail {
    pub id: i64,
    pub title: String,
    pub covers: Vec<String>,
    pub selected_cover: Option<String>,
    pub album_count: i64,
    pub track_count: i64,
    pub albums: Vec<AlbumCard>,
    /// Other artists' albums this artist is credited on (features).
    pub appears_on: Vec<AlbumCard>,
    /// Album-less tracks (from the artist's hidden loose container),
    /// rendered as a flat "Tracks" section.
    pub loose_tracks: Vec<TrackView>,
    /// User-written biography (nothing fills this automatically yet).
    pub biography: Option<String>,
}

async fn covers_for(
    pool: &SqlitePool,
    library_id: &str,
    folder_path: &str,
) -> Result<Vec<String>, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT cached_path FROM cached_images
         WHERE library_id = ? AND entry_folder_path = ? AND image_type = 'cover'
         ORDER BY source_filename",
    )
    .bind(library_id)
    .bind(folder_path)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

/// Both halves of alias-aware artist resolution for one library:
/// lowercased name (title or alias) → artist id, and artist id → CURRENT
/// display title. Credit/artist names shown in the UI resolve through these,
/// so a rename shows everywhere the artist is referenced — rescan- and
/// matching-pass-proof, since stored rows are never rewritten.
pub(crate) async fn artist_resolution_maps(
    pool: &SqlitePool,
    library_id: &str,
) -> Result<(HashMap<String, i64>, HashMap<i64, String>), String> {
    let name_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT an.artist_id, an.name FROM artist_names an
         JOIN media_entry me ON me.id = an.artist_id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let title_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT a.id, a.title FROM artist a
         JOIN media_entry me ON me.id = a.id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok((
        name_rows.into_iter().map(|(id, t)| (t.to_lowercase(), id)).collect(),
        title_rows.into_iter().collect(),
    ))
}

/// A display credit from a stamped row: linked when its artist_id points at a
/// live artist, shown under that artist's current title (renames propagate).
/// A NULL or stale id keeps the as-credited spelling, unlinked. No name
/// matching happens here — resolve_credit_ids already decided who this is.
fn credit_view(name: String, artist_id: Option<i64>, titles: &HashMap<i64, String>) -> CreditView {
    match artist_id.and_then(|id| titles.get(&id).map(|t| (id, t.clone()))) {
        Some((id, title)) => CreditView { name: title, artist_id: Some(id) },
        None => CreditView { name, artist_id: None },
    }
}

/// Stamp artist ids onto every credit row of a library — the ONE place
/// credit identity is decided. Names resolve through artist_names (title ∪
/// redirects) with Rust Unicode lowercasing, exactly the rule the display
/// maps use for tag strings, so SQL's ASCII-only LOWER can't diverge from it.
///
/// Also gives rowless albums their solo credit row from the folder parent —
/// every album carries its credit; the parent is only where the album lives.
///
/// Runs after anything that changes credits, artists, or redirects (scan and
/// rescan tails via ensure_credit_artists, matching passes, merges, credit
/// edits). Idempotent, and re-running heals stale stamps left by artist
/// deletes — which is why artist_id carries no FOREIGN KEY.
pub(crate) async fn resolve_credit_ids(pool: &SqlitePool, library_id: &str) -> Result<(), String> {
    let (by_lower, _) = artist_resolution_maps(pool, library_id).await?;

    // ONE transaction for every write. On a fresh create this pass stamps
    // every credit row in the library (~thousands), and each autocommit
    // statement costs SQLite a journal sync — several thousand fsyncs made
    // the scan look hung at its tail. Batched, it's one sync.
    // (The old parent→solo-row backfill is gone with the artist parent
    // itself: write_album_credits guarantees rows on every insert/reconcile.)
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    let track_rows: Vec<(i64, i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT tc.track_id, tc.position, tc.name, tc.artist_id FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    for (track_id, position, name, stored) in track_rows {
        let resolved = by_lower.get(&name.to_lowercase()).copied();
        if resolved != stored {
            sqlx::query("UPDATE track_credit SET artist_id = ? WHERE track_id = ? AND position = ?")
                .bind(resolved)
                .bind(track_id)
                .bind(position)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    let album_rows: Vec<(i64, i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT ac.album_id, ac.position, ac.name, ac.artist_id FROM album_artist_credit ac
         JOIN media_entry me ON me.id = ac.album_id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    for (album_id, position, name, stored) in album_rows {
        let resolved = by_lower.get(&name.to_lowercase()).copied();
        if resolved != stored {
            sqlx::query(
                "UPDATE album_artist_credit SET artist_id = ? WHERE album_id = ? AND position = ?",
            )
            .bind(resolved)
            .bind(album_id)
            .bind(position)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().await.map_err(|e| e.to_string())
}

/// Same canonicalization for the track_meta main-artist name.
pub(crate) fn canonical_artist_name(
    name: Option<String>,
    by_lower: &HashMap<String, i64>,
    titles: &HashMap<i64, String>,
) -> Option<String> {
    name.map(|n| {
        by_lower
            .get(&n.to_lowercase())
            .and_then(|id| titles.get(id).cloned())
            .unwrap_or(n)
    })
}

/// Tracks in the loose container under `parent` (an artist entry, or None for
/// the library-root container), as full TrackViews with resolved credits.
/// Empty when no container exists.
pub(crate) async fn loose_tracks_for(
    pool: &SqlitePool,
    library_id: &str,
    parent: Option<i64>,
) -> Result<Vec<TrackView>, String> {
    // The MUSIC container only — sound loose tracks live in their own
    // sound-marked container and never surface here.
    let container: Option<(i64,)> = match parent {
        Some(pid) => sqlx::query_as(
            "SELECT la.album_id FROM loose_album la
             JOIN media_entry me ON me.id = la.album_id
             WHERE me.library_id = ? AND me.parent_id = ?
               AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = la.album_id)",
        )
        .bind(library_id)
        .bind(pid)
        .fetch_optional(pool)
        .await,
        None => sqlx::query_as(
            "SELECT la.album_id FROM loose_album la
             JOIN media_entry me ON me.id = la.album_id
             WHERE me.library_id = ? AND me.parent_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = la.album_id)",
        )
        .bind(library_id)
        .fetch_optional(pool)
        .await,
    }
    .map_err(|e| e.to_string())?;
    let Some((container_id,)) = container else {
        return Ok(Vec::new());
    };

    let (artist_by_lower, artist_titles) = artist_resolution_maps(pool, library_id).await?;

    let credit_rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT tc.track_id, tc.name, tc.artist_id FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id
         WHERE me.parent_id = ?
         ORDER BY tc.track_id, tc.position",
    )
    .bind(container_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credits_by_track: HashMap<i64, Vec<CreditView>> = HashMap::new();
    for (track_id, name, artist_id) in credit_rows {
        credits_by_track
            .entry(track_id)
            .or_default()
            .push(credit_view(name, artist_id, &artist_titles));
    }

    let track_rows: Vec<(i64, String, Option<i64>, Option<i64>, Option<i64>, Option<String>, String, i64, i64)> =
        sqlx::query_as(
            "SELECT t.id, t.title, t.track_number, t.disc_number, t.runtime, tm.artist_name, t.file_path,
                    (SELECT COUNT(*) FROM music_play mp WHERE mp.track_id = t.id AND mp.scrobbled = 1),
                    EXISTS(SELECT 1 FROM track_loved tl WHERE tl.track_id = t.id)
             FROM track t
             JOIN media_entry me ON me.id = t.id
             LEFT JOIN track_meta tm ON tm.track_id = t.id
             WHERE me.parent_id = ?
             ORDER BY t.sort_order, t.file_path COLLATE NOCASE",
        )
        .bind(container_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut tracks = Vec::new();
    for (id, title, track_number, disc_number, runtime, artist_name, rel, play_count, loved) in track_rows {
        tracks.push(TrackView {
            id,
            title,
            track_number,
            disc_number,
            runtime_secs: runtime,
            artist_name: canonical_artist_name(artist_name, &artist_by_lower, &artist_titles),
            file_path: resolve_music_path(pool, library_id, &rel).await?,
            play_count,
            loved: loved != 0,
            credits: credits_by_track.remove(&id).unwrap_or_default(),
        });
    }
    Ok(tracks)
}

#[tauri::command]
pub async fn get_artist_detail(
    state: State<'_, AppState>,
    entry_id: i64,
) -> Result<ArtistDetail, String> {
    let pool = &state.app_db;
    let (library_id, title, folder_path, selected_cover, biography): (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT me.library_id, a.title, a.folder_path, a.selected_cover, a.biography
         FROM artist a JOIN media_entry me ON me.id = a.id WHERE a.id = ?",
    )
    .bind(entry_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    let album_rows: Vec<(i64, String, Option<String>, String, Option<String>, i64, i64, i64)> =
        sqlx::query_as(
            "SELECT al.id, al.title, al.release_date, al.folder_path, al.selected_cover,
                    (SELECT COUNT(*) FROM media_entry t WHERE t.parent_id = al.id),
                    (SELECT COUNT(*) FROM album_release ar WHERE ar.album_id = al.id),
                    COALESCE((SELECT SUM(t.runtime) FROM track t
                              JOIN media_entry me2 ON me2.id = t.id
                              JOIN track_release tr ON tr.track_id = t.id
                              JOIN album_release ar2 ON ar2.id = tr.release_id
                              WHERE me2.parent_id = al.id AND ar2.is_default = 1), 0)
             FROM album al
             JOIN media_entry me ON me.id = al.id
             WHERE EXISTS (SELECT 1 FROM album_artist_credit ac
                           WHERE ac.album_id = al.id
                             AND (ac.artist_id = ?1
                                  -- An alter ego's records are this artist's
                                  -- records: same human, so they belong in
                                  -- the discography rather than the
                                  -- appears-on shelf below.
                                  OR ac.artist_id IN (SELECT persona_id FROM artist_persona
                                                      WHERE parent_id = ?1)))
               AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
               AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
             ORDER BY al.sort_order, al.release_date, al.sort_title COLLATE NOCASE",
        )
        .bind(entry_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Album-level credits for the per-album artist lines — every album has
    // rows now, so the owner argument is only a mid-scan/rowless fallback.
    let self_title_for_cards = title.clone();
    let (_, artist_titles) = artist_resolution_maps(pool, &library_id).await?;
    let credit_rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT ac.album_id, ac.name, ac.artist_id FROM album_artist_credit ac
         JOIN media_entry me ON me.id = ac.album_id
         WHERE me.library_id = ? ORDER BY ac.album_id, ac.position",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credits_by_album: HashMap<i64, Vec<(String, Option<i64>)>> = HashMap::new();
    for (aid, name, artist_id) in credit_rows {
        credits_by_album.entry(aid).or_default().push((name, artist_id));
    }
    let album_artists = |album_id: i64, owner: Option<(&str, i64)>| -> Vec<CreditView> {
        match credits_by_album.get(&album_id) {
            Some(rows) if !rows.is_empty() => rows
                .iter()
                .map(|(n, id)| credit_view(n.clone(), *id, &artist_titles))
                .collect(),
            _ => owner
                .map(|(name, id)| vec![CreditView { name: name.to_string(), artist_id: Some(id) }])
                .unwrap_or_default(),
        }
    };

    let mut albums = Vec::new();
    let mut track_count = 0;
    for (id, title, release_date, folder, sel, tracks, releases, runtime) in album_rows {
        track_count += tracks;
        albums.push(AlbumCard {
            id,
            title: title.clone(),
            year: release_date.as_ref().map(|d| d.chars().take(4).collect()),
            release_date,
            covers: covers_for(pool, &library_id, &folder).await?,
            selected_cover: sel,
            track_count: tracks,
            release_count: releases,
            runtime_secs: runtime,
            artist_title: None,
            artists: album_artists(id, Some((&self_title_for_cards, entry_id))),
        });
    }

    // Other artists' albums where this artist appears in a track credit —
    // the whole page for feature-only artists, a bonus section for the rest.
    let appears_rows: Vec<(i64, String, Option<String>, String, Option<String>, Option<String>, i64)> =
        sqlx::query_as(
            "SELECT DISTINCT al.id, al.title, al.release_date, al.folder_path, al.selected_cover,
                    (SELECT ac0.name FROM album_artist_credit ac0
                     WHERE ac0.album_id = al.id ORDER BY ac0.position LIMIT 1),
                    (SELECT COUNT(DISTINCT tc2.track_id) FROM track_credit tc2
                     JOIN media_entry tme2 ON tme2.id = tc2.track_id
                     WHERE tme2.parent_id = al.id AND tc2.artist_id = ?1)
             FROM track_credit tc
             JOIN media_entry tme ON tme.id = tc.track_id
             JOIN album al ON al.id = tme.parent_id
             JOIN media_entry ame ON ame.id = al.id
             WHERE ame.library_id = ?2
               AND tc.artist_id = ?1
               AND NOT EXISTS (SELECT 1 FROM album_artist_credit ac
                               WHERE ac.album_id = al.id
                                 AND (ac.artist_id = ?1
                                      OR ac.artist_id IN (SELECT persona_id FROM artist_persona
                                                          WHERE parent_id = ?1)))
               AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
               AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
             ORDER BY al.release_date, al.sort_title COLLATE NOCASE",
        )
        .bind(entry_id)
        .bind(&library_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut appears_on = Vec::new();
    for (id, atitle, release_date, folder, sel, owner, credited_tracks) in appears_rows {
        let artists = match credits_by_album.get(&id) {
            Some(rows) if !rows.is_empty() => rows
                .iter()
                .map(|(n, aid)| credit_view(n.clone(), *aid, &artist_titles))
                .collect(),
            _ => owner
                .clone()
                .map(|o| vec![CreditView { name: o, artist_id: None }])
                .unwrap_or_default(),
        };
        appears_on.push(AlbumCard {
            id,
            title: atitle,
            year: release_date.as_ref().map(|d| d.chars().take(4).collect()),
            release_date,
            covers: covers_for(pool, &library_id, &folder).await?,
            selected_cover: sel,
            track_count: credited_tracks,
            release_count: 1,
            runtime_secs: 0,
            artist_title: owner,
            artists,
        });
    }

    let loose_tracks = loose_tracks_for(pool, &library_id, Some(entry_id)).await?;
    track_count += loose_tracks.len() as i64;

    // Folder art first, fetched images appended after — gap-fill precedence.
    let mut covers = covers_for(pool, &library_id, &folder_path).await?;
    covers.extend(covers_for(pool, &library_id, &crate::music_art::artist_fetch_rel(entry_id)).await?);

    Ok(ArtistDetail {
        id: entry_id,
        title,
        covers,
        selected_cover,
        album_count: albums.len() as i64,
        track_count,
        albums,
        appears_on,
        loose_tracks,
        biography,
    })
}

#[derive(Debug, Serialize)]
pub struct CreditView {
    pub name: String,
    /// Artist entry id when this library has them as an artist (linkable).
    pub artist_id: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct TrackView {
    pub id: i64,
    pub title: String,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub runtime_secs: Option<i64>,
    pub artist_name: Option<String>,
    pub file_path: String,
    pub play_count: i64,
    pub loved: bool,
    /// Ordered credits (main first, then features), comma-joined by the UI.
    pub credits: Vec<CreditView>,
}

#[derive(Debug, Serialize)]
pub struct ReleaseView {
    pub id: i64,
    pub label: Option<String>,
    pub is_default: bool,
    pub disc_count: i64,
    pub year: Option<String>,
    /// Folder leaf — the versions menu's differentiator when labels collide.
    pub folder: String,
    /// Distinct codecs of this release's tracks, uppercased ("FLAC", "WAV").
    pub codecs: Vec<String>,
    /// The FILES carry a MusicBrainz release id — this copy can pin the
    /// album's release exactly.
    pub has_mb_tag: bool,
    /// This release holds its own pinned MusicBrainz pressing.
    pub mb_matched: bool,
    pub tracks: Vec<TrackView>,
}

#[derive(Debug, Serialize)]
pub struct AlbumDetail {
    pub id: i64,
    pub title: String,
    /// "album" | "single" | "ep" | "compilation" | … — drives the page eyebrow.
    pub album_type: String,
    pub year: Option<String>,
    /// None = artist-less album (lives at the library root).
    pub artist_id: Option<i64>,
    pub artist_title: Option<String>,
    /// Multi-artist albums: the full ordered credit ("Drake · Future"), each
    /// linkable when the library has that artist. Empty = single artist —
    /// the header shows artist_title as before.
    pub artist_credits: Vec<CreditView>,
    pub covers: Vec<String>,
    pub selected_cover: Option<String>,
    pub genres: Vec<String>,
    pub releases: Vec<ReleaseView>,
    /// Sound-side entry (a virtual collection) — the page swaps its music
    /// affordances (MB, credits) for collection ones (move tracks, etc.).
    pub is_sound: bool,
    /// Matched to a MusicBrainz release: enables re-checking our track list
    /// against it, which is how a mistagged track that silently kept its own
    /// credits gets found.
    pub mb_matched: bool,
    /// Owning library — collection dialogs (move/create) are library-scoped.
    pub library_id: String,
}

/// Resolve a track's library-relative file path to an absolute one by probing
/// the library's music base folders.
pub(crate) async fn resolve_music_path(
    pool: &SqlitePool,
    library_id: &str,
    rel: &str,
) -> Result<String, String> {
    let bases: Vec<(String,)> = sqlx::query_as(
        "SELECT path FROM library_path WHERE library_id = ? AND kind = 'music' ORDER BY sort_order, id",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (base,) in &bases {
        let abs = Path::new(base).join(rel);
        if abs.exists() {
            return Ok(abs.to_string_lossy().to_string());
        }
    }
    // Fall back to the first base even if the probe failed (network drive
    // hiccups shouldn't hard-error the whole album page).
    bases
        .first()
        .map(|(b,)| Path::new(b).join(rel).to_string_lossy().to_string())
        .ok_or_else(|| "library has no music folders".to_string())
}

#[tauri::command]
pub async fn get_album_detail(
    state: State<'_, AppState>,
    entry_id: i64,
) -> Result<AlbumDetail, String> {
    let pool = &state.app_db;
    let (library_id, title, release_date, folder_path, selected_cover, album_type): (
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        String,
    ) = sqlx::query_as(
        "SELECT me.library_id, al.title, al.release_date, al.folder_path, al.selected_cover, al.album_type
         FROM album al JOIN media_entry me ON me.id = al.id WHERE al.id = ?",
    )
    .bind(entry_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    // The album's artist is its FIRST credit row (albums have no artist
    // parent). Credit-less albums (no artist tags anywhere) have neither.
    let first_credit: Option<(String, Option<i64>)> = sqlx::query_as(
        "SELECT name, artist_id FROM album_artist_credit
         WHERE album_id = ? ORDER BY position LIMIT 1",
    )
    .bind(entry_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    // Display the linked artist's CANONICAL title when the credit resolves
    // (same rule as credit_view) — the raw credit string only when it doesn't.
    let parent_id: Option<i64> = first_credit.as_ref().and_then(|(_, aid)| *aid);
    let artist_title: Option<String> = match parent_id {
        Some(aid) => sqlx::query_as::<_, (String,)>("SELECT title FROM artist WHERE id = ?")
            .bind(aid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .map(|(t,)| t)
            .or_else(|| first_credit.as_ref().map(|(n, _)| n.clone())),
        None => first_credit.as_ref().map(|(n, _)| n.clone()),
    };

    let genres: Vec<(String,)> = sqlx::query_as(
        "SELECT g.name FROM album_genre ag JOIN genre g ON g.id = ag.genre_id
         WHERE ag.album_id = ? ORDER BY g.name",
    )
    .bind(entry_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let release_rows: Vec<(i64, Option<String>, i64, i64, Option<String>, String, Option<String>)> =
        sqlx::query_as(
            "SELECT id, label, is_default, disc_count, release_date, folder_path, mb_release_id
         FROM album_release WHERE album_id = ?
         ORDER BY is_default DESC, label",
        )
        .bind(entry_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Every name each library artist answers to (title + aliases), for
    // linking credits to their pages — displayed under current artist titles.
    let (artist_by_lower, artist_titles) = artist_resolution_maps(pool, &library_id).await?;

    // The album's artist credit line (every album carries rows).
    let album_credit_rows: Vec<(String, Option<i64>)> = sqlx::query_as(
        "SELECT name, artist_id FROM album_artist_credit WHERE album_id = ? ORDER BY position",
    )
    .bind(entry_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let artist_credits: Vec<CreditView> = album_credit_rows
        .into_iter()
        .map(|(n, aid)| credit_view(n, aid, &artist_titles))
        .collect();

    // All credits for the album's tracks, grouped per track in order.
    let credit_rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT tc.track_id, tc.name, tc.artist_id FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id
         WHERE me.parent_id = ?
         ORDER BY tc.track_id, tc.position",
    )
    .bind(entry_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credits_by_track: HashMap<i64, Vec<CreditView>> = HashMap::new();
    for (track_id, name, artist_id) in credit_rows {
        credits_by_track
            .entry(track_id)
            .or_default()
            .push(credit_view(name, artist_id, &artist_titles));
    }

    let mut releases = Vec::new();
    for (rid, label, is_default, disc_count, rdate, folder_path, mb_release_id) in release_rows {
        let track_rows: Vec<(i64, String, Option<i64>, Option<i64>, Option<i64>, Option<String>, String, i64, i64, Option<String>)> =
            sqlx::query_as(
                "SELECT t.id, t.title, t.track_number, t.disc_number, t.runtime, tm.artist_name, t.file_path,
                        (SELECT COUNT(*) FROM music_play mp WHERE mp.track_id = t.id AND mp.scrobbled = 1),
                        EXISTS(SELECT 1 FROM track_loved tl WHERE tl.track_id = t.id),
                        tm.codec
                 FROM track t
                 JOIN track_release tr ON tr.track_id = t.id
                 LEFT JOIN track_meta tm ON tm.track_id = t.id
                 WHERE tr.release_id = ?
                 ORDER BY t.sort_order, t.title COLLATE NOCASE",
            )
            .bind(rid)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
        let mut tracks = Vec::new();
        let mut codecs: Vec<String> = Vec::new();
        for (id, title, track_number, disc_number, runtime, artist_name, rel, play_count, loved, codec) in track_rows {
            if let Some(c) = codec.filter(|c| !c.is_empty()) {
                let c = c.to_uppercase();
                if !codecs.contains(&c) {
                    codecs.push(c);
                }
            }
            tracks.push(TrackView {
                id,
                title,
                track_number,
                disc_number,
                runtime_secs: runtime,
                artist_name: canonical_artist_name(artist_name, &artist_by_lower, &artist_titles),
                file_path: resolve_music_path(pool, &library_id, &rel).await?,
                play_count,
                loved: loved != 0,
                credits: credits_by_track.remove(&id).unwrap_or_default(),
            });
        }
        releases.push(ReleaseView {
            id: rid,
            label,
            is_default: is_default != 0,
            disc_count,
            year: rdate.map(|d| d.chars().take(4).collect()),
            folder: folder_path
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or(&folder_path)
                .to_string(),
            codecs,
            has_mb_tag: mb_release_id.as_deref().is_some_and(|m| !m.is_empty()),
            mb_matched: crate::music_mb::release_match_of(pool, entry_id, &folder_path)
                .await?
                .is_some_and(|(v, _)| !v.is_empty()),
            tracks,
        });
    }

    let is_sound: bool = sqlx::query_as::<_, (i64,)>(
        "SELECT EXISTS(SELECT 1 FROM sound_album sa WHERE sa.album_id = ?)",
    )
    .bind(entry_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?
    .0 != 0;

    // Matched to a MusicBrainz release — the page offers a track-list check.
    // Per-release pins: ANY release holding one qualifies the card.
    let mb_matched: bool = sqlx::query_as::<_, (i64,)>(
        "SELECT EXISTS(SELECT 1 FROM release_match rm WHERE rm.album_id = ? AND rm.mb_release_id <> '')",
    )
    .bind(entry_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?
    .0 != 0;

    Ok(AlbumDetail {
        id: entry_id,
        title,
        album_type,
        year: release_date.map(|d| d.chars().take(4).collect()),
        artist_id: parent_id,
        artist_title,
        artist_credits,
        covers: covers_for(pool, &library_id, &folder_path).await?,
        selected_cover,
        genres: genres.into_iter().map(|(g,)| g).collect(),
        releases,
        is_sound,
        mb_matched,
        library_id,
    })
}

#[derive(Debug, Serialize)]
pub struct MusicCounts {
    pub artists: i64,
    pub albums: i64,
    pub tracks: i64,
    pub sounds: i64,
    pub issues: i64,
}

/// Sidebar counts for a music library.
#[tauri::command]
pub async fn get_music_counts(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<MusicCounts, String> {
    // Sound-marked content lives on its own node: the sounds count is TOTAL
    // sound tracks (every collection plus the loose pool — not collections),
    // and it's excluded from artists/albums/tracks.
    let (artists, albums, tracks, sounds): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
            COALESCE(SUM(CASE WHEN met.name = 'artist'
                AND (NOT EXISTS (SELECT 1 FROM media_entry ch WHERE ch.parent_id = me.id)
                     OR EXISTS (SELECT 1 FROM media_entry ch WHERE ch.parent_id = me.id
                                AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = ch.id))
                     OR EXISTS (SELECT 1 FROM album_artist_credit ac WHERE ac.artist_id = me.id))
                THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN met.name = 'album'
                AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = me.id)
                AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.id)
                THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN met.name = 'track'
                AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.parent_id)
                THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN met.name = 'track'
                AND EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.parent_id)
                THEN 1 ELSE 0 END), 0)
         FROM media_entry me
         JOIN media_entry_type met ON met.id = me.entry_type_id
         WHERE me.library_id = ?",
    )
    .bind(&library_id)
    .fetch_one(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let (issues,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM music_scan_issue WHERE library_id = ?")
            .bind(&library_id)
            .fetch_one(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    Ok(MusicCounts { artists, albums, tracks, sounds, issues })
}

#[derive(Debug, Serialize)]
pub struct LibraryTrackRow {
    pub id: i64,
    pub title: String,
    /// File name (no directories) — the display-only label for untitled
    /// tracks. Never parsed into metadata.
    pub file_name: String,
    pub file_path: String,
    pub runtime_secs: Option<i64>,
    pub artist_name: Option<String>,
    /// Artist entry the track hangs under (via its album/container), when any.
    pub artist_id: Option<i64>,
    /// Album entry — None for loose tracks (their container is hidden).
    pub album_id: Option<i64>,
    pub album_title: Option<String>,
    /// The album's display cover (cached path) — the now-playing bar's art.
    pub cover: Option<String>,
    pub play_count: i64,
    pub loved: bool,
    pub credits: Vec<CreditView>,
}

/// Every track in the library — the all-Tracks page. Loose tracks (no album,
/// possibly no artist) appear like any other, with their album/artist columns
/// simply empty.
#[tauri::command]
pub async fn get_music_tracks(
    state: State<'_, AppState>,
    library_id: String,
    // Only tracks living in loose containers — the Albums page's
    // "Loose tracks" section. Omitted/false = every track (the Tracks page).
    loose_only: Option<bool>,
    // true = the SOUNDS side of the library (sound-marked containers) instead
    // of music. Pairs with loose_only for the Sounds page's loose section.
    sounds: Option<bool>,
) -> Result<Vec<LibraryTrackRow>, String> {
    let pool = &state.app_db;

    let bases: Vec<(String,)> = sqlx::query_as(
        "SELECT path FROM library_path WHERE library_id = ? AND kind = 'music' ORDER BY sort_order, id",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let (artist_by_lower, artist_titles) = artist_resolution_maps(pool, &library_id).await?;

    let credit_rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT tc.track_id, tc.name, tc.artist_id FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id
         WHERE me.library_id = ?
         ORDER BY tc.track_id, tc.position",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credits_by_track: HashMap<i64, Vec<CreditView>> = HashMap::new();
    for (track_id, name, artist_id) in credit_rows {
        credits_by_track
            .entry(track_id)
            .or_default()
            .push(credit_view(name, artist_id, &artist_titles));
    }

    // Album cover art for the now-playing bar, keyed by album folder.
    let covers_map = crate::commands::get_all_cached_covers(pool, &library_id)
        .await
        .map_err(|e| e.to_string())?;

    let loose_clause = if loose_only.unwrap_or(false) {
        "AND EXISTS (SELECT 1 FROM loose_album lo WHERE lo.album_id = me.parent_id)"
    } else {
        ""
    };
    let sound_clause = if sounds.unwrap_or(false) {
        "AND EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.parent_id)"
    } else {
        "AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.parent_id)"
    };
    let rows: Vec<(i64, String, String, Option<i64>, Option<String>, Option<i64>, Option<String>, i64, Option<i64>, i64, i64, Option<String>, Option<String>)> =
        sqlx::query_as(&format!(
            "SELECT t.id, t.title, t.file_path, t.runtime, tm.artist_name,
                    al.id, al.title, COALESCE((SELECT 1 FROM loose_album la WHERE la.album_id = al.id), 0),
                    COALESCE((SELECT ac0.artist_id FROM album_artist_credit ac0
                              WHERE ac0.album_id = alme.id ORDER BY ac0.position LIMIT 1),
                             alme.parent_id),
                    (SELECT COUNT(*) FROM music_play mp WHERE mp.track_id = t.id AND mp.scrobbled = 1),
                    EXISTS(SELECT 1 FROM track_loved tl WHERE tl.track_id = t.id),
                    al.folder_path, al.selected_cover
             FROM track t
             JOIN media_entry me ON me.id = t.id
             LEFT JOIN track_meta tm ON tm.track_id = t.id
             LEFT JOIN media_entry alme ON alme.id = me.parent_id
             LEFT JOIN album al ON al.id = alme.id
             WHERE me.library_id = ?
               {sound_clause}
               {loose_clause}
             ORDER BY t.sort_title = '', t.sort_title COLLATE NOCASE, t.file_path COLLATE NOCASE",
        ))
        .bind(&library_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let single_base = if bases.len() == 1 { Some(bases[0].0.clone()) } else { None };
    let mut out = Vec::with_capacity(rows.len());
    for (id, title, rel, runtime, artist_name, album_id, album_title, is_loose, album_parent, play_count, loved, album_folder, album_selected_cover) in rows {
        let file_name = Path::new(&rel)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rel.clone());
        let abs = match &single_base {
            Some(b) => Path::new(b).join(&rel).to_string_lossy().to_string(),
            None => resolve_music_path(pool, &library_id, &rel).await?,
        };
        let loose = is_loose != 0;
        // Album display cover: the selected one when it's still cached, else
        // the first cached cover for the album's folder. Loose tracks have none.
        let cover = if loose {
            None
        } else {
            album_folder.and_then(|folder| {
                let covers = covers_map.get(&folder)?;
                match album_selected_cover {
                    Some(sel) if covers.contains(&sel) => Some(sel),
                    _ => covers.first().cloned(),
                }
            })
        };
        out.push(LibraryTrackRow {
            id,
            title,
            file_name,
            file_path: abs,
            runtime_secs: runtime,
            artist_name: canonical_artist_name(
                artist_name.filter(|s| !s.is_empty()),
                &artist_by_lower,
                &artist_titles,
            ),
            artist_id: album_parent,
            album_id: if loose { None } else { album_id },
            album_title: if loose { None } else { album_title },
            cover,
            play_count,
            loved: loved != 0,
            credits: credits_by_track.remove(&id).unwrap_or_default(),
        });
    }
    Ok(out)
}

/// Everything the frontend queue needs to play one track outside its album
/// page — playlists first. Ordered to match the requested ids.
#[derive(Debug, Serialize)]
pub struct TrackQueueItem {
    pub track_id: i64,
    pub title: String,
    pub artist_name: Option<String>,
    /// Main credit's artist entry, falling back to the album's artist.
    pub artist_id: Option<i64>,
    pub artists: Vec<CreditView>,
    /// None for loose tracks (their container is hidden).
    pub album_id: Option<i64>,
    pub album_title: Option<String>,
    /// The album's display cover (cached path) — the now-playing bar's art.
    pub cover: Option<String>,
    pub file_path: String,
    pub duration_secs: Option<i64>,
    pub loved: bool,
}

/// Resolve a list of track entry ids (one playlist's worth) into playable
/// queue items. Unknown ids are skipped; order follows the input.
#[tauri::command]
pub async fn get_track_queue_items(
    state: State<'_, AppState>,
    track_ids: Vec<i64>,
) -> Result<Vec<TrackQueueItem>, String> {
    let pool = &state.app_db;
    let mut out = Vec::with_capacity(track_ids.len());
    let mut maps: Option<(String, HashMap<String, i64>, HashMap<i64, String>, HashMap<String, Vec<String>>)> = None;
    for id in track_ids {
        let row: Option<(String, String, Option<i64>, Option<String>, String, Option<String>, Option<i64>, Option<i64>, i64, i64, Option<String>, Option<String>)> =
            sqlx::query_as(
                "SELECT t.title, t.file_path, t.runtime, tm.artist_name, me.library_id,
                        al.title, al.id,
                        COALESCE((SELECT ac0.artist_id FROM album_artist_credit ac0
                                  WHERE ac0.album_id = alme.id ORDER BY ac0.position LIMIT 1),
                                 alme.parent_id),
                        COALESCE((SELECT 1 FROM loose_album la WHERE la.album_id = al.id), 0),
                        EXISTS(SELECT 1 FROM track_loved tl WHERE tl.track_id = t.id),
                        al.folder_path, al.selected_cover
                 FROM track t
                 JOIN media_entry me ON me.id = t.id
                 LEFT JOIN track_meta tm ON tm.track_id = t.id
                 LEFT JOIN media_entry alme ON alme.id = me.parent_id
                 LEFT JOIN album al ON al.id = alme.id
                 WHERE t.id = ?",
            )
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
        let Some((title, rel, runtime, artist_name, library_id, album_title, album_id, album_artist_id, is_loose, loved, album_folder, album_selected_cover)) = row else {
            continue;
        };
        // Playlists are single-library, so the maps resolve once in practice.
        if maps.as_ref().map(|(lib, _, _, _)| lib != &library_id).unwrap_or(true) {
            let (by_lower, titles) = artist_resolution_maps(pool, &library_id).await?;
            let covers = crate::commands::get_all_cached_covers(pool, &library_id)
                .await
                .map_err(|e| e.to_string())?;
            maps = Some((library_id.clone(), by_lower, titles, covers));
        }
        let (_, by_lower, titles, covers_map) = maps.as_ref().unwrap();
        let credit_names: Vec<(String, Option<i64>)> = sqlx::query_as(
            "SELECT name, artist_id FROM track_credit WHERE track_id = ? ORDER BY position",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        let artists: Vec<CreditView> = credit_names
            .into_iter()
            .map(|(name, aid)| credit_view(name, aid, titles))
            .collect();
        let loose = is_loose != 0;
        let cover = if loose {
            None
        } else {
            album_folder.and_then(|folder| {
                let covers = covers_map.get(&folder)?;
                match album_selected_cover {
                    Some(sel) if covers.contains(&sel) => Some(sel),
                    _ => covers.first().cloned(),
                }
            })
        };
        out.push(TrackQueueItem {
            track_id: id,
            title,
            artist_name: canonical_artist_name(artist_name, by_lower, titles),
            artist_id: artists.iter().find_map(|c| c.artist_id).or(album_artist_id),
            artists,
            album_id: if loose { None } else { album_id },
            album_title: if loose { None } else { album_title },
            cover,
            file_path: resolve_music_path(pool, &library_id, &rel).await?,
            duration_secs: runtime,
            loved: loved != 0,
        });
    }
    Ok(out)
}

/// "Remove from Recently listened to": hides the track's plays up to now from
/// recency surfaces (the play log itself is untouched — stats keep
/// everything). A newer play resurfaces it.
#[tauri::command]
pub async fn dismiss_recent_listen(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO music_listen_dismiss (track_id, dismissed_at) VALUES (?, datetime('now'))
         ON CONFLICT(track_id) DO UPDATE SET dismissed_at = datetime('now')",
    )
    .bind(track_id)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Love/unlove a track. Idempotent in both directions.
#[tauri::command]
pub async fn set_track_loved(
    state: State<'_, AppState>,
    track_id: i64,
    loved: bool,
) -> Result<(), String> {
    let pool = &state.app_db;
    if loved {
        sqlx::query("INSERT OR IGNORE INTO track_loved (track_id) VALUES (?)")
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        sqlx::query("DELETE FROM track_loved WHERE track_id = ?")
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Loved-track count per artist (track → parent album/container → parent
/// artist). Sound-marked containers are excluded, matching every other
/// artists-grid aggregate. Backs the Artists page "Most loved" sort — both the
/// backend order on fresh loads and the frontend's instant local re-sort.
pub(crate) async fn artist_loved_counts(
    pool: &SqlitePool,
    library_id: &str,
) -> Result<Vec<(i64, i64)>, String> {
    // An album has ARTISTS, not one main artist. A loved track counts for
    // everyone credited on the ALBUM it belongs to — What a Time to Be Alive
    // is Drake's and Future's, so its ten loved tracks are ten for each of
    // them; Sneakin' credits Drake and 21 Savage, so both get it.
    //
    // TRACK credits deliberately don't count here. A guest on one song of
    // someone else's album hasn't got a loved album track — the album is not
    // theirs. The exception is a loose track, which has no real album, so its
    // own credits are the only thing that can attribute it.
    //
    // Credit rows carry stamped artist_ids (every album has rows, solo
    // included), so this reads them directly — no name resolution, no
    // parent_id fallback.
    //
    // The final UNION rolls a PERSONA's loves up to the human behind it (an
    // alter ego's loves are the same person's), while the persona keeps its
    // own tally. UNION not SUM: a track credited to both identities is one
    // love, not two.
    //
    // NB: this string uses `\` line continuations, which strip the newlines —
    // so a `--` comment inside the SQL would swallow everything after it.
    // Explanations live out here for that reason.
    sqlx::query_as(
        "WITH loved AS ( \
             SELECT tl.track_id, ar.album_id, \
                    EXISTS(SELECT 1 FROM loose_album la WHERE la.album_id = ar.album_id) AS loose \
             FROM track_loved tl \
             JOIN media_entry tme ON tme.id = tl.track_id AND tme.library_id = ? \
             JOIN track_release tr ON tr.track_id = tl.track_id \
             JOIN album_release ar ON ar.id = tr.release_id \
             WHERE NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = ar.album_id) \
         ), attributed AS ( \
             SELECT aac.artist_id AS artist_id, l.track_id \
             FROM loved l \
             JOIN album_artist_credit aac ON aac.album_id = l.album_id \
             WHERE NOT l.loose AND aac.artist_id IS NOT NULL \
             UNION \
             SELECT tc.artist_id, l.track_id \
             FROM loved l \
             JOIN track_credit tc ON tc.track_id = l.track_id \
             WHERE l.loose AND tc.artist_id IS NOT NULL \
         ) \
         SELECT artist_id, COUNT(DISTINCT track_id) FROM ( \
             SELECT artist_id, track_id FROM attributed \
             UNION \
             SELECT p.parent_id, a.track_id FROM attributed a \
             JOIN artist_persona p ON p.persona_id = a.artist_id \
         ) GROUP BY artist_id",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

/// Loved snapshot for one track — the now-playing bar's heart indicator
/// (queue items don't carry loved state; toggles stay live via the frontend
/// override store on top of this).
#[tauri::command]
pub async fn get_track_loved(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<bool, String> {
    sqlx::query_as::<_, (i64,)>("SELECT EXISTS(SELECT 1 FROM track_loved WHERE track_id = ?)")
        .bind(track_id)
        .fetch_one(&state.app_db)
        .await
        .map(|(v,)| v != 0)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_artist_loved_counts(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<Vec<(i64, i64)>, String> {
    artist_loved_counts(&state.app_db, &library_id).await
}

#[derive(Debug, Serialize)]
pub struct UnlinkedCredit {
    pub name: String,
    pub track_count: i64,
    pub album_count: i64,
    /// An existing artist whose punctuation/diacritic-blind key matches the
    /// name — the likely intended target, offered as a one-click link.
    pub near_miss_id: Option<i64>,
    pub near_miss_title: Option<String>,
}

/// Credit names that resolve to NO artist. After a scan this list is small by
/// construction — ensure_credit_artists gives every plain new name a page —
/// so what's left is the interesting residue: lookalikes of an existing
/// artist that were routed to a merge suggestion (pending or rejected)
/// instead of spawning a duplicate page. Surfaced for manual linking; never
/// auto-resolved.
#[tauri::command]
pub async fn get_unlinked_credits(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<Vec<UnlinkedCredit>, String> {
    let pool = &state.app_db;
    let track_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT tc.name, COUNT(DISTINCT tc.track_id) FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id
         WHERE me.library_id = ? AND tc.artist_id IS NULL
         GROUP BY LOWER(tc.name)",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let album_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT ac.name, COUNT(DISTINCT ac.album_id) FROM album_artist_credit ac
         JOIN media_entry me ON me.id = ac.album_id
         WHERE me.library_id = ? AND ac.artist_id IS NULL
         GROUP BY LOWER(ac.name)",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Merge the two sides on the lowercased name (first-seen casing wins).
    let mut by_lower: HashMap<String, (String, i64, i64)> = HashMap::new();
    for (name, n) in track_rows {
        by_lower.entry(name.to_lowercase()).or_insert((name, 0, 0)).1 += n;
    }
    for (name, n) in album_rows {
        by_lower.entry(name.to_lowercase()).or_insert((name, 0, 0)).2 += n;
    }

    // Same lookalike keying (and same most-albums-first tiebreak) as
    // ensure_credit_artists, so the hint names the artist the suggestion
    // machinery would have picked.
    let existing: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT a.id, a.title, an.name FROM artist a
         JOIN media_entry me ON me.id = a.id
         JOIN artist_names an ON an.artist_id = a.id
         WHERE me.library_id = ?
         ORDER BY (SELECT COUNT(*) FROM album_artist_credit ac WHERE ac.artist_id = a.id) DESC, a.id ASC",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut artist_by_key: HashMap<String, (i64, String)> = HashMap::new();
    for (id, title, name) in existing {
        artist_by_key.entry(credit_name_key(&name)).or_insert((id, title));
    }

    let mut out: Vec<UnlinkedCredit> = by_lower
        .into_values()
        .map(|(name, track_count, album_count)| {
            let near = artist_by_key.get(&credit_name_key(&name));
            UnlinkedCredit {
                track_count,
                album_count,
                near_miss_id: near.map(|(id, _)| *id),
                near_miss_title: near.map(|(_, t)| t.clone()),
                name,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        (b.track_count + b.album_count, &a.name.to_lowercase())
            .cmp(&(a.track_count + a.album_count, &b.name.to_lowercase()))
    });
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct TagFallbackRow {
    pub track_id: i64,
    pub file_path: String,
    /// Which fields fell back at import ("title", "artist", "album",
    /// "track number") — informational, shown in the metadata center.
    pub missing: Vec<String>,
}

/// Tracks imported with incomplete tags — the metadata center's
/// "incomplete tags" category. Purely informational; the files play fine.
#[tauri::command]
pub async fn get_music_tag_fallbacks(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<Vec<TagFallbackRow>, String> {
    let rows: Vec<(i64, String, String, Option<i64>, i64, Option<String>)> = sqlx::query_as(
        "SELECT t.id, t.title, t.file_path, t.track_number,
                COALESCE((SELECT 1 FROM loose_album la WHERE la.album_id = me.parent_id), 0),
                tm.artist_name
         FROM track t
         JOIN media_entry me ON me.id = t.id
         LEFT JOIN track_meta tm ON tm.track_id = t.id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.parent_id)
         ORDER BY t.file_path COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for (id, title, file_path, track_number, is_loose, artist_name) in rows {
        let mut missing = Vec::new();
        if title.is_empty() {
            missing.push("title".to_string());
        }
        if artist_name.as_deref().unwrap_or("").is_empty() {
            missing.push("artist".to_string());
        }
        if is_loose != 0 {
            missing.push("album".to_string());
        }
        if track_number.is_none() {
            missing.push("track number".to_string());
        }
        if !missing.is_empty() {
            out.push(TagFallbackRow { track_id: id, file_path, missing });
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct MusicScanIssue {
    pub file_path: String,
    pub reason: String,
}

#[tauri::command]
pub async fn get_music_scan_issues(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<Vec<MusicScanIssue>, String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT file_path, reason FROM music_scan_issue
         WHERE library_id = ? AND is_sound = 0
         ORDER BY file_path",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(file_path, reason)| MusicScanIssue { file_path, reason })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_album(folder: &str, album_tag: &str, rg_mbid: Option<&str>, date: &str) -> ScannedAlbum {
        let track = ScannedTrack {
            rel: format!("Artist\\{folder}\\01 Song.flac"),
            abs: PathBuf::from(format!(r"X:\m\Artist\{folder}\01 Song.flac")),
            title: "Song".to_string(),
            artist: None,
            album_artist: "Artist".to_string(),
            album: album_tag.to_string(),
            track_number: Some(1),
            disc_number: 1,
            date: Some(date.to_string()),
            genres: vec![],
            duration_secs: 180,
            codec: "flac".to_string(),
            bitrate_kbps: None,
            sample_rate_hz: None,
            mb_recording_id: None,
            mb_release_id: None,
            mb_release_group_id: rg_mbid.map(|s| s.to_string()),
            flag_compilation: false,
            credits: vec![],
            sound: false,
            album_artist_credits: Vec::new(),
            audio_hash: None,
            content_size: None,
            content_mtime: None,
        };
        ScannedAlbum {
            identity_override: None,
            folder_rel: format!("Artist\\{folder}"),
            folder_abs: PathBuf::from(format!(r"X:\m\Artist\{folder}")),
            releases: vec![ScannedRelease {
                label: None,
                folder_rel: format!("Artist\\{folder}"),
                folder_abs: PathBuf::from(format!(r"X:\m\Artist\{folder}")),
                tracks: vec![track],
            }],
            default_release: 0,
        }
    }

    #[test]
    fn siblings_with_matching_rg_mbid_merge() {
        let merged = group_sibling_albums(vec![
            fake_album("Kid A (2021 Remaster)", "Kid A (2021 Remaster)", Some("rg-1"), "2021"),
            fake_album("Kid A", "Kid A", Some("rg-1"), "2000"),
            fake_album("Amnesiac", "Amnesiac", Some("rg-2"), "2001"),
        ]);
        assert_eq!(merged.len(), 2);
        let kid_a = merged
            .iter()
            .find(|a| a.releases.len() == 2)
            .expect("Kid A siblings should merge into one album");
        // Plainest edition is the default, names the album, comes first.
        assert_eq!(kid_a.default_release, 0);
        assert_eq!(album_title_of(kid_a), "Kid A");
        assert!(kid_a.folder_rel.ends_with("Kid A"));
        assert_eq!(kid_a.releases[0].label, None);
        assert_eq!(kid_a.releases[1].label.as_deref(), Some("2021 Remaster"));
    }

    #[test]
    fn no_mbid_means_no_merging() {
        // The Weezer case: parenthetical suffixes that are NOT editions. Title
        // heuristics would fuse these; MBID-only grouping must not.
        let out = group_sibling_albums(vec![
            fake_album("Weezer (Blue Album)", "Weezer (Blue Album)", None, "1994"),
            fake_album("Weezer (Green Album)", "Weezer (Green Album)", None, "2001"),
        ]);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|a| a.releases.len() == 1));
    }

    #[test]
    fn release_labels_derive_sensibly() {
        assert_eq!(
            derive_release_label(
                "LONG.LIVE.A$AP (Deluxe Version)",
                "LONG.LIVE.A$AP",
                "LONG.LIVE.A$AP (Deluxe Version)",
                "LONG.LIVE.A$AP",
                Some("2013"),
            ),
            "Deluxe Version"
        );
        // Same tag title on both folders → folder-name remainder.
        assert_eq!(
            derive_release_label("Kid A", "Kid A", "Kid A [MFSL]", "Kid A", Some("2000")),
            "MFSL"
        );
        // Nothing derivable → the year.
        assert_eq!(
            derive_release_label("Kid A", "Kid A", "KidA-flac24", "Kid A", Some("2021")),
            "2021"
        );
    }

    fn fixture_track(rel: &str, title: &str, credits: &[&str], track_number: i64) -> ScannedTrack {
        ScannedTrack {
            rel: rel.to_string(),
            abs: PathBuf::from(format!(r"X:\m\{rel}")),
            title: title.to_string(),
            artist: Some(credits.first().copied().unwrap_or("A").to_string()),
            album_artist: credits.first().copied().unwrap_or("A").to_string(),
            album: "A1".to_string(),
            track_number: Some(track_number),
            disc_number: 1,
            date: Some("2020".to_string()),
            genres: vec![],
            duration_secs: 180,
            codec: "flac".to_string(),
            bitrate_kbps: None,
            sample_rate_hz: None,
            mb_recording_id: None,
            mb_release_id: None,
            mb_release_group_id: None,
            flag_compilation: false,
            credits: credits.iter().map(|c| c.to_string()).collect(),
            sound: false,
            album_artist_credits: Vec::new(),
            audio_hash: None,
            content_size: None,
            content_mtime: None,
        }
    }

    fn fixture_album(tracks: Vec<ScannedTrack>) -> ScannedAlbum {
        ScannedAlbum {
            identity_override: None,
            folder_rel: "Feature Test\\A1".to_string(),
            folder_abs: PathBuf::from(r"X:\m\Feature Test\A1"),
            releases: vec![ScannedRelease {
                label: None,
                folder_rel: "Feature Test\\A1".to_string(),
                folder_abs: PathBuf::from(r"X:\m\Feature Test\A1"),
                tracks,
            }],
            default_release: 0,
        }
    }

    /// The path a library rescan takes for an already-imported album: the
    /// reconcile must rewrite credits, album_type, and track_meta from the
    /// fresh tags — against a REAL sqlite database.
    #[tokio::test]
    async fn reconcile_rewrites_credits_and_type() {
        let dir = std::env::temp_dir().join(format!("wr-music-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pool = crate::db::create_app_pool(&dir.join("t.db")).await.unwrap();
        sqlx::query("INSERT INTO library (id, name, format) VALUES ('lib1', 'L', 'music')")
            .execute(&pool)
            .await
            .unwrap();

        let artist = ScannedArtist { title: "Feature Test".to_string(), albums: vec![], loose: vec![] };
        let artist_id = insert_artist_row(&pool, "lib1", &dir, &artist, 0).await.unwrap();

        // Initial import: one track, main credit only.
        let v1 = fixture_album(vec![fixture_track(
            "Feature Test\\A1\\01.flac",
            "Song",
            &["Feature Test"],
            1,
        )]);
        let _ = artist_id;
        let album_id = insert_album(&pool, "lib1", &dir, &v1, 0).await.unwrap();
        let credits: Vec<(String,)> = sqlx::query_as(
            "SELECT tc.name FROM track_credit tc JOIN media_entry me ON me.id = tc.track_id
             WHERE me.parent_id = ? ORDER BY tc.position",
        )
        .bind(album_id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(credits, vec![("Feature Test".to_string(),)]);
        let (track_id_v1,): (i64,) =
            sqlx::query_as("SELECT id FROM media_entry WHERE parent_id = ?")
                .bind(album_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        // "Rescan": same file path, fresh tags now carrying a feature credit.
        let v2 = fixture_album(vec![fixture_track(
            "Feature Test\\A1\\01.flac",
            "Song (feat. Guest One)",
            &["Feature Test", "Guest One"],
            1,
        )]);
        let mut existing: HashMap<String, i64> =
            vec![("Feature Test\\A1\\01.flac".to_string(), track_id_v1)].into_iter().collect();
        reconcile_album(&pool, "lib1", &dir, album_id, &v2, &mut existing).await.unwrap();

        let credits: Vec<(String,)> = sqlx::query_as(
            "SELECT tc.name FROM track_credit tc JOIN media_entry me ON me.id = tc.track_id
             WHERE me.parent_id = ? ORDER BY tc.position",
        )
        .bind(album_id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            credits,
            vec![("Feature Test".to_string(),), ("Guest One".to_string(),)],
            "rescan must rewrite credits for existing tracks"
        );
        // Track entry id (and thus play history) survived.
        let (track_id_v2,): (i64,) =
            sqlx::query_as("SELECT id FROM media_entry WHERE parent_id = ?")
                .bind(album_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(track_id_v1, track_id_v2);
        // album_type recomputed on reconcile (1 track = single).
        let (album_type,): (String,) = sqlx::query_as("SELECT album_type FROM album WHERE id = ?")
            .bind(album_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(album_type, "single");

        // Once MusicBrainz has provided credits, a rescan's tag re-parse must
        // NOT clobber them. MB credits only ever exist where a release is
        // PINNED (release_match, folder-keyed) — that's the per-release guard
        // reconcile reads; the fetch stamp alone protects album title/type.
        sqlx::query("INSERT OR REPLACE INTO mb_credit_fetch (album_id, status) VALUES (?, 'matched')")
            .bind(album_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT OR REPLACE INTO release_match (album_id, folder_path, mb_release_id, tier)
             VALUES (?, 'Feature Test\\A1', 'test-release-mbid', 'mb')",
        )
        .bind(album_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM track_credit WHERE track_id = ?")
            .bind(track_id_v1)
            .execute(&pool)
            .await
            .unwrap();
        for (i, name) in ["Feature Test", "MB Only Guest"].iter().enumerate() {
            sqlx::query("INSERT INTO track_credit (track_id, position, name) VALUES (?, ?, ?)")
                .bind(track_id_v1)
                .bind(i as i64)
                .bind(name)
                .execute(&pool)
                .await
                .unwrap();
        }
        let mut existing: HashMap<String, i64> =
            vec![("Feature Test\\A1\\01.flac".to_string(), track_id_v1)].into_iter().collect();
        reconcile_album(&pool, "lib1", &dir, album_id, &v2, &mut existing).await.unwrap();
        let credits: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM track_credit WHERE track_id = ? ORDER BY position",
        )
        .bind(track_id_v1)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            credits,
            vec![("Feature Test".to_string(),), ("MB Only Guest".to_string(),)],
            "MB-provided credits must survive rescans"
        );

        // A punctuation-variant credit ("Feature. Test" vs the real artist
        // "Feature Test") must NOT spawn a lookalike artist — it becomes a
        // pending merge suggestion, and the raw credit string stays as
        // scanned (the alias layer resolves it once accepted).
        sqlx::query("UPDATE track_credit SET name = 'Feature. Test' WHERE track_id = ? AND position = 0")
            .bind(track_id_v1)
            .execute(&pool)
            .await
            .unwrap();
        ensure_credit_artists(&pool, "lib1").await.unwrap();
        let (raw,): (String,) = sqlx::query_as(
            "SELECT name FROM track_credit WHERE track_id = ? AND position = 0",
        )
        .bind(track_id_v1)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(raw, "Feature. Test", "raw credit strings are never rewritten");
        let (phantoms,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM artist WHERE title LIKE 'Feature%Test'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(phantoms, 1, "no punctuation-variant phantom artist");
        let (suggestion,): (String,) = sqlx::query_as(
            "SELECT status FROM mb_suggestion WHERE kind = 'artist_merge' AND target_key = 'feature. test'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(suggestion, "pending");
        // An alias resolves the variant: accepting the merge links the credit.
        let (artist_id,): (i64,) = sqlx::query_as("SELECT id FROM artist WHERE title = 'Feature Test'")
            .fetch_one(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO artist_alias (artist_id, name) VALUES (?, 'Feature. Test')")
            .bind(artist_id)
            .execute(&pool)
            .await
            .unwrap();
        // With the alias in place the name resolves, so ensure creates nothing
        // and the sweep guard sees the credit as referencing the real artist.
        let created = ensure_credit_artists(&pool, "lib1").await.unwrap();
        assert_eq!(created, 0);

        // ── User-tier overrides survive a rescan ──────────────────────────
        // Edits are stored in field_override and re-stomped after every bulk
        // write: the reconcile's fresh tag parse must not undo them.
        sqlx::query(
            "INSERT INTO field_override (entity_id, field, tier, value) VALUES
             (?, 'title', 'user', 'My Better Title'),
             (?, 'credits', 'user', '[\"Feature Test\",\"Hand-Added Guest\"]'),
             (?, 'title', 'user', 'My Album Name')",
        )
        .bind(track_id_v1)
        .bind(track_id_v1)
        .bind(album_id)
        .execute(&pool)
        .await
        .unwrap();
        // Drop the MB stamp so the reconcile takes the full tag-rewrite path —
        // the strongest clobber the overrides must survive.
        sqlx::query("DELETE FROM mb_credit_fetch WHERE album_id = ?")
            .bind(album_id)
            .execute(&pool)
            .await
            .unwrap();
        let mut existing: HashMap<String, i64> =
            vec![("Feature Test\\A1\\01.flac".to_string(), track_id_v1)].into_iter().collect();
        reconcile_album(&pool, "lib1", &dir, album_id, &v2, &mut existing).await.unwrap();
        let (title, sort_title): (String, String) =
            sqlx::query_as("SELECT title, sort_title FROM track WHERE id = ?")
                .bind(track_id_v1)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "My Better Title", "user title must survive a rescan");
        assert_eq!(sort_title, "my better title");
        let credits: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM track_credit WHERE track_id = ? ORDER BY position",
        )
        .bind(track_id_v1)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            credits,
            vec![("Feature Test".to_string(),), ("Hand-Added Guest".to_string(),)],
            "user credits must survive a rescan"
        );
        let (album_title,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
            .bind(album_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(album_title, "My Album Name", "user album title must survive a rescan");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn credits_parse_mains_then_features() {
        // Feat clause in the artist tag.
        assert_eq!(
            parse_credits("Mac Miller feat. CeeLo Green", &[], "I'm Not Real"),
            vec!["Mac Miller", "CeeLo Green"]
        );
        // Feat clause in the title parenthetical — kept VERBATIM. Nothing
        // splits automatically ("&" is Earth, Wind & Fire's problem, not
        // ours); the user decomposes joint credits via split directives.
        assert_eq!(
            parse_credits("Eminem", &[], "Love The Way You Lie (feat. Rihanna & Dido)"),
            vec!["Eminem", "Rihanna & Dido"]
        );
        // Main credits never split on commas/ampersands (band names).
        assert_eq!(
            parse_credits("Earth, Wind & Fire", &[], "September"),
            vec!["Earth, Wind & Fire"]
        );
        // Multi-value ARTISTS frames merge in, de-duplicated case-insensitively.
        assert_eq!(
            parse_credits("JAY-Z & Kanye West", &["JAY-Z & Kanye West".to_string(), "Frank Ocean".to_string()], "No Church in the Wild (Ft. Frank Ocean)"),
            vec!["JAY-Z & Kanye West", "Frank Ocean"]
        );
        // "ft." variant, bracketed.
        assert_eq!(
            parse_credits("Kendrick Lamar", &[], "Money Trees [ft. Jay Rock]"),
            vec!["Kendrick Lamar", "Jay Rock"]
        );
        // Parenthesized feat clause glued into the ARTIST tag — must split,
        // never become an artist named "Frank Ocean (feat. Beyoncé)".
        assert_eq!(
            parse_credits("Frank Ocean (feat. Beyoncé)", &[], "Pink + White"),
            vec!["Frank Ocean", "Beyoncé"]
        );
        // Punctuation-blind identity keys.
        assert_eq!(credit_name_key("J. Cole"), credit_name_key("J Cole"));
        assert_eq!(credit_name_key("Jay-Z"), credit_name_key("Jay Z"));
        assert_ne!(credit_name_key("J. Cole"), credit_name_key("Jay Cole"));
        // MusicBrainz typographic punctuation folds into its ASCII class:
        // U+2010 hyphen, curly/modifier apostrophes.
        assert_eq!(credit_name_key("Jay\u{2010}Z"), credit_name_key("Jay-Z"));
        assert_eq!(credit_name_key("JAY\u{2010}Z"), credit_name_key("Jay-Z"));
        assert_eq!(
            credit_name_key("Martin O\u{2019}Donnell"),
            credit_name_key("Martin O'Donnell")
        );
        assert_eq!(
            credit_name_key("Martin O\u{02BC}Donnell"),
            credit_name_key("Martin O'Donnell")
        );
        // Joint-credit separator variants collapse together.
        assert_eq!(
            credit_name_key("Martin O'Donnell & Michael Salvatori"),
            credit_name_key("Martin O'Donnell/Michael Salvatori")
        );
        assert_eq!(
            credit_name_key("Martin O'Donnell and Michael Salvatori"),
            credit_name_key("Martin O'Donnell & Michael Salvatori")
        );
        // The clause itself stays whole — no automatic "&" splitting.
        assert_eq!(
            parse_credits("Frank Ocean (feat. Yung Lean & A$AP Rocky)", &[], "RAF"),
            vec!["Frank Ocean", "Yung Lean & A$AP Rocky"]
        );
    }

    /// Feat markers never define grouping identity; real joint names without
    /// a marker pass through verbatim (never auto-split on commas/&).
    #[test]
    fn album_artist_feats_strip_for_identity() {
        assert_eq!(
            strip_feats("XXXTENTACION Feat. Trippie Redd"),
            ("XXXTENTACION".to_string(), vec!["Trippie Redd".to_string()])
        );
        assert_eq!(
            strip_feats("Frank Ocean (feat. Beyoncé)"),
            ("Frank Ocean".to_string(), vec!["Beyoncé".to_string()])
        );
        assert_eq!(strip_feats("Earth, Wind & Fire"), ("Earth, Wind & Fire".to_string(), vec![]));
        assert_eq!(
            strip_feats("Martin O'Donnell & Michael Salvatori"),
            ("Martin O'Donnell & Michael Salvatori".to_string(), vec![])
        );
        assert_eq!(
            strip_feats("2 Chainz, Lil Wayne"),
            ("2 Chainz, Lil Wayne".to_string(), vec![])
        );
    }

    #[test]
    fn disc_folders_recognized() {
        assert_eq!(disc_folder_number("CD1"), Some(1));
        assert_eq!(disc_folder_number("cd 2"), Some(2));
        assert_eq!(disc_folder_number("Disc 03"), Some(3));
        assert_eq!(disc_folder_number("disk_4"), Some(4));
        assert_eq!(disc_folder_number("CD"), None);
        assert_eq!(disc_folder_number("Kid A (2021 Remaster)"), None);
        assert_eq!(disc_folder_number("Deluxe Edition"), None);
        // "CDs and rarities" must not read as disc folders.
        assert_eq!(disc_folder_number("CDs and rarities"), None);
    }

    /// Pure tag grouping: same album tag across two folders = one album with
    /// two releases; two album keys inside one folder = two albums.
    #[test]
    fn assemble_groups_by_tags_not_folders() {
        let mk = |folder: &str, artist: &str, album: &str, title: &str, date: &str| {
            let t = ScannedTrack {
                rel: format!("{folder}\\{title}.flac"),
                abs: PathBuf::from(format!(r"X:\m\{folder}\{title}.flac")),
                title: title.to_string(),
                artist: None,
                album_artist: artist.to_string(),
                album: album.to_string(),
                track_number: Some(1),
                disc_number: 1,
                date: Some(date.to_string()),
                genres: vec![],
                duration_secs: 180,
                codec: "flac".to_string(),
                bitrate_kbps: None,
                sample_rate_hz: None,
                mb_recording_id: None,
                mb_release_id: None,
                mb_release_group_id: None,
                flag_compilation: false,
                credits: vec![],
                sound: false,
                album_artist_credits: Vec::new(),
                audio_hash: None,
                content_size: None,
                content_mtime: None,
            };
            (t, folder.to_string(), PathBuf::from(format!(r"X:\m\{folder}")))
        };

        // Same album tag in two folders (an edition pair, no MBIDs needed) +
        // a second album artist hiding in one of the folders.
        let out = assemble_albums(vec![
            mk("Radiohead\\Kid A", "Radiohead", "Kid A", "Everything", "2000"),
            mk("Radiohead\\Kid A [MFSL]", "Radiohead", "Kid A", "Everything", "2021"),
            mk("Radiohead\\Kid A", "Thom Yorke", "The Eraser", "Analyse", "2006"),
        ]);
        assert!(out.loose.is_empty());
        let albums = out.albums;
        assert_eq!(albums.len(), 2);
        let kid_a = albums
            .iter()
            .find(|a| album_title_of(a) == "Kid A")
            .expect("Kid A album");
        assert_eq!(kid_a.releases.len(), 2, "same tag across folders = editions");
        // Default = earliest date; the other gets a folder-derived label.
        assert!(kid_a.folder_rel.ends_with("Kid A"));
        assert_eq!(kid_a.releases[0].label, None);
        assert_eq!(kid_a.releases[1].label.as_deref(), Some("MFSL"));

        // Artist grouping is by tag, wherever the files live.
        let (artists, orphans) = group_by_artist(albums, vec![]);
        assert_eq!(artists.len(), 2);
        assert_eq!(artists[0].title, "Radiohead");
        assert_eq!(artists[1].title, "Thom Yorke");
        assert!(orphans.albums.is_empty() && orphans.loose.is_empty());
    }

    /// Tag-read + grouping against a real artist folder from the user's
    /// library. Assertions are deliberately loose — the library is being
    /// restructured — but tag-derived identity must hold. Skips silently when
    /// the drive isn't mounted. Override with MUSIC_TEST_DIR.
    #[test]
    fn real_folder_scans_from_tags() {
        let dir = std::env::var("MUSIC_TEST_DIR")
            .unwrap_or_else(|_| r"A:\public\media\music\Eminem".to_string());
        let base = PathBuf::from(&dir);
        if !base.exists() {
            eprintln!("skipping real_folder_scans_from_tags: {dir} not present");
            return;
        }
        let mut issues = Vec::new();
        let out = scan_base(&base, false, &mut issues, None, None, |_, _, _| {}).expect("scan");
        assert!(issues.is_empty(), "well-tagged folder produced issues: {:?}",
            issues.iter().map(|i| format!("{}: {}", i.file_path, i.reason)).collect::<Vec<_>>());
        let albums = out.albums;
        assert!(!albums.is_empty(), "expected at least one album");
        for album in &albums {
            for release in &album.releases {
                assert!(!release.tracks.is_empty());
                for t in &release.tracks {
                    assert!(!t.title.is_empty());
                    assert!(t.track_number.unwrap_or(0) > 0);
                }
            }
        }
        // Artist identity is the tag; every album here should say Eminem.
        let (artists, _orphans) = group_by_artist(albums, out.loose);
        assert_eq!(artists.len(), 1, "one album-artist expected in this folder");
        assert_eq!(artists[0].title, "Eminem");
        // Disc folders (CD1/, disc 2/, …) must land as one multi-disc release.
        let multi_disc = artists[0].albums.iter().any(|a| {
            a.releases
                .iter()
                .any(|r| r.tracks.iter().any(|t| t.disc_number > 1))
        });
        assert!(multi_disc, "expected at least one multi-disc album");
    }
}

#[derive(Debug, Serialize)]
pub struct RecentPlay {
    pub track_id: i64,
    pub track_title: String,
    /// For the untitled-track filename fallback (display-only convention).
    pub file_path: String,
    pub artist_name: Option<String>,
    pub album_id: Option<i64>,
    pub album_title: Option<String>,
    /// Album display cover (cached path), for tile surfaces.
    pub cover: Option<String>,
    /// For cross-library navigation from global surfaces (Home).
    pub library_id: String,
    pub started_at: String,
    pub scrobbled: bool,
}

/// Playback history, newest first — EVERY start counts here, however brief.
/// (Stats surfaces filter on scrobbled=1; this list deliberately doesn't.)
/// library_id None = across all libraries (the global now-playing panel).
/// include_dismissed: the panel's raw-history tab passes true; recency
/// surfaces (Home) omit it so "Remove from Recently listened to" sticks.
#[tauri::command]
pub async fn get_recent_music_plays(
    state: State<'_, AppState>,
    library_id: Option<String>,
    limit: Option<i64>,
    include_dismissed: Option<bool>,
) -> Result<Vec<RecentPlay>, String> {
    let dismiss_filter = if include_dismissed.unwrap_or(false) {
        ""
    } else {
        "AND NOT EXISTS (SELECT 1 FROM music_listen_dismiss d
                         WHERE d.track_id = t.id AND mp.started_at <= d.dismissed_at)"
    };
    let sql = format!(
        "SELECT t.id, t.title, t.file_path, tm.artist_name, me.parent_id, al.title, mp.started_at, mp.scrobbled,
                me.library_id, al.folder_path, al.selected_cover,
                COALESCE((SELECT 1 FROM loose_album la WHERE la.album_id = al.id), 0)
         FROM music_play mp
         JOIN track t ON t.id = mp.track_id
         JOIN media_entry me ON me.id = t.id
         LEFT JOIN track_meta tm ON tm.track_id = t.id
         LEFT JOIN album al ON al.id = me.parent_id
         WHERE (?1 IS NULL OR me.library_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.parent_id)
           {dismiss_filter}
         ORDER BY mp.started_at DESC, mp.id DESC
         LIMIT ?2"
    );
    let rows: Vec<(i64, String, String, Option<String>, Option<i64>, Option<String>, String, i64, String, Option<String>, Option<String>, i64)> =
        sqlx::query_as(&sql)
            .bind(&library_id)
            .bind(limit.unwrap_or(50))
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;

    // Album covers for tile surfaces, cached per library (usually one).
    let mut covers_cache: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for (track_id, track_title, file_path, artist_name, album_id, album_title, started_at, scrobbled, lib, album_folder, album_selected_cover, is_loose) in rows {
        // Loose tracks live under a HIDDEN container album — never surface it
        // (same nulling every other track surface applies).
        let loose = is_loose != 0;
        if !covers_cache.contains_key(&lib) {
            let map = crate::commands::get_all_cached_covers(&state.app_db, &lib)
                .await
                .map_err(|e| e.to_string())?;
            covers_cache.insert(lib.clone(), map);
        }
        let cover = if loose {
            None
        } else {
            album_folder.and_then(|folder| {
                let covers = covers_cache.get(&lib)?.get(&folder)?;
                match &album_selected_cover {
                    Some(sel) if covers.contains(sel) => Some(sel.clone()),
                    _ => covers.first().cloned(),
                }
            })
        };
        out.push(RecentPlay {
            track_id,
            track_title,
            file_path,
            artist_name,
            album_id: if loose { None } else { album_id },
            album_title: if loose { None } else { album_title },
            cover,
            library_id: lib,
            started_at,
            scrobbled: scrobbled != 0,
        });
    }
    Ok(out)
}
