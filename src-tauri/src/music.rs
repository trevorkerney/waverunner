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
use tauri::{Emitter, State};

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
}

pub struct ScanIssue {
    pub file_path: String,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Artist-credit parsing
// ---------------------------------------------------------------------------

/// Split a feature LIST ("A, B & C") into names. Deliberately not applied to
/// the main artist credit — commas and ampersands are part of many band names
/// ("Earth, Wind & Fire"); feature clauses are safe to split aggressively.
fn split_feat_list(s: &str) -> Vec<String> {
    s.split([',', ';'])
        .flat_map(|p| p.split(" & "))
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect()
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
fn read_track(abs: &Path, rel: &str, disc_folder_no: Option<i64>) -> Result<ScannedTrack, String> {
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
/// slow part of a scan, so progress is reported per folder as it goes and the
/// cancel flag (when given) is honored mid-read.
pub fn scan_base(
    base: &Path,
    // Base is sounds-typed — every track scanned here carries the flag.
    sound: bool,
    issues: &mut Vec<ScanIssue>,
    cancel: Option<&AtomicBool>,
    mut on_progress: impl FnMut(&str),
) -> Result<ScanOutput, String> {
    let mut files = Vec::new();
    walk_audio(base, base, &mut files);
    let mut tagged = Vec::new();
    let mut last_folder: Option<String> = None;
    for (abs, folder_rel, disc_no) in files {
        if let Some(cancel) = cancel {
            if cancel.load(Ordering::SeqCst) {
                return Err("Library creation cancelled".to_string());
            }
        }
        if last_folder.as_deref() != Some(folder_rel.as_str()) {
            let shown = if folder_rel.is_empty() {
                base.to_string_lossy().into_owned()
            } else {
                folder_rel.clone()
            };
            on_progress(&shown);
            last_folder = Some(folder_rel.clone());
        }
        let rel = rel_of(&abs, base);
        match read_track(&abs, &rel, disc_no) {
            Ok(mut t) => {
                t.sound = sound;
                // Sounds bases: folders are truth (tags-as-truth is a MUSIC
                // principle; ambient packs are routinely untagged). An
                // album-less sound file adopts its folder name as the album so
                // every sounds folder surfaces as a browsable sound album
                // instead of vanishing into loose tracks.
                if sound && t.album.trim().is_empty() && !folder_rel.is_empty() {
                    let leaf = folder_rel
                        .replace('\\', "/")
                        .rsplit('/')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    if !leaf.is_empty() {
                        t.album = leaf;
                    }
                }
                let folder_abs = if folder_rel.is_empty() {
                    base.to_path_buf()
                } else {
                    base.join(&folder_rel)
                };
                tagged.push((t, folder_rel, folder_abs));
            }
            Err(reason) => issues.push(ScanIssue { file_path: rel, reason }),
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
        out.push(ScannedAlbum { folder_rel, folder_abs, releases, default_release: 0 });
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
    if out.is_empty() {
        if let Some(album) = album {
            let def = &album.releases[album.default_release];
            // The default release's folder next (editions keep their own art).
            out = folder_cover_files(&def.folder_abs);
            if out.is_empty() {
                // Disc subfolders (CD1/Disc 2/…) — rips often keep a
                // folder.jpg per disc with nothing at the album root. Names
                // are prefixed with the disc folder so CD1/CD2 art coexists
                // (selectable via Change cover) instead of deduping away.
                let mut disc_dirs: Vec<PathBuf> = std::fs::read_dir(&def.folder_abs)
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| {
                        p.is_dir()
                            && p.file_name()
                                .map(|n| disc_folder_number(&n.to_string_lossy()).is_some())
                                .unwrap_or(false)
                    })
                    .collect();
                disc_dirs.sort();
                for dir in disc_dirs {
                    let dir_name = dir
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    for p in image_files_in(&dir) {
                        if let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) {
                            let keyed = format!("{dir_name}_{name}");
                            if !out.iter().any(|(existing, _)| *existing == keyed) {
                                out.push((keyed, CoverSource::File(p)));
                            }
                        }
                    }
                }
            }
            if out.is_empty() {
                if let Some(first) = def.tracks.first() {
                    out.push(("embedded.jpg".to_string(), CoverSource::Embedded(first.abs.clone())));
                }
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
        "INSERT INTO track (id, title, sort_title, file_path, sort_order, track_number, disc_number, runtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(&t.title)
    .bind(generate_sort_title(&t.title, "en"))
    .bind(&t.rel)
    .bind(sort_order)
    .bind(t.track_number)
    .bind(t.disc_number)
    .bind(t.duration_secs)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    write_track_side_tables(pool, id, release_id, t, true).await?;
    Ok(id)
}

/// One-file tag read for the editor's reset/hints paths (no disc-folder
/// context — the tag's own disc number, else 1).
pub(crate) fn read_track_at(abs: &Path, rel: &str) -> Result<ScannedTrack, String> {
    read_track(abs, rel, None)
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
async fn insert_album(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
    parent: Option<i64>,
    album: &ScannedAlbum,
    sort_order: i64,
) -> Result<i64, String> {
    let album_type = entry_type_id(pool, "album").await?;
    let track_type = entry_type_id(pool, "track").await?;

    let title = album_title_of(album);
    let res = sqlx::query(
        "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
    )
    .bind(library_id)
    .bind(parent)
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
            "INSERT INTO album_mb (album_id, mb_release_group_id) VALUES (?, ?)
             ON CONFLICT(album_id) DO UPDATE SET mb_release_group_id = excluded.mb_release_group_id",
        )
        .bind(album_entry_id)
        .bind(rg)
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
    Ok(album_entry_id)
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
            "INSERT INTO album_mb (album_id, mb_release_group_id) VALUES (?, ?)
             ON CONFLICT(album_id) DO UPDATE SET mb_release_group_id = excluded.mb_release_group_id",
        )
        .bind(album_entry_id)
        .bind(rg)
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

        for (ti, t) in release.tracks.iter().enumerate() {
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
                // Reparent — the track may have belonged to a sibling album
                // that just merged into this one.
                sqlx::query("UPDATE media_entry SET parent_id = ? WHERE id = ?")
                    .bind(album_entry_id)
                    .bind(track_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                write_track_side_tables(pool, track_id, release_id, t, write_credits).await?;
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
    Ok(())
}


// ---------------------------------------------------------------------------
// Loose-track containers
// ---------------------------------------------------------------------------

/// Find or create the hidden container album holding loose tracks under
/// `parent` (an artist entry id, or None for the library-root container that
/// takes artist-less tracks). Containers are flagged in loose_album and
/// excluded from every album-facing surface. Returns (album_id, release_id).
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

async fn write_issues(
    pool: &SqlitePool,
    library_id: &str,
    issues: &[ScanIssue],
) -> Result<(), String> {
    for issue in issues {
        sqlx::query("INSERT INTO music_scan_issue (library_id, file_path, reason) VALUES (?, ?, ?)")
            .bind(library_id)
            .bind(&issue.file_path)
            .bind(&issue.reason)
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
fn credit_name_key(s: &str) -> String {
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
         WHERE me.library_id = ?
           AND NOT EXISTS (
               SELECT 1 FROM artist_names an JOIN media_entry ame ON ame.id = an.artist_id
               WHERE ame.library_id = me.library_id AND LOWER(an.name) = LOWER(tc.name)
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
    // so the real "J. Cole" is the suggested keep-target over any lookalike.
    let existing: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT a.id, a.title, an.name FROM artist a
         JOIN media_entry me ON me.id = a.id
         JOIN artist_names an ON an.artist_id = a.id
         WHERE me.library_id = ?
         ORDER BY (SELECT COUNT(*) FROM media_entry c WHERE c.parent_id = a.id) DESC, a.id ASC",
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
    Ok(created)
}

// ---------------------------------------------------------------------------
// Full scan (library creation) & rescan
// ---------------------------------------------------------------------------

/// Fresh scan of one music base folder (library creation). Grouping is pure
/// tags; a second base folder contributing albums for an artist the first
/// already created appends to the same artist row.
/// Fold one scanned album into another per a combine directive.
fn fold_album(target: &mut ScannedAlbum, mut src: ScannedAlbum, mode: &str) {
    if mode == "merge" {
        let di = target.default_release;
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
            // its version label so the picker can tell the editions apart.
            if rel.label.is_none() {
                rel.label = Some(src_title.clone());
            }
            target.releases.push(rel);
        }
    }
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
    let directives: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT source_artist, source_title, target_artist, target_title, mode
         FROM album_combine WHERE library_id = ?",
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
        match found {
            Some((Some(ai), bi)) => fold_album(&mut artists[ai].albums[bi], src, &d.4),
            Some((None, bi)) => fold_album(&mut orphans.albums[bi], src, &d.4),
            None => match origin {
                // Target absent this scan — put the source back untouched.
                Origin::Artist(ai) => artists[ai].albums.push(src),
                Origin::Orphan => orphans.albums.push(src),
            },
        }
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
    let ScanOutput { albums, loose } = scan_base(base_path, sound, &mut issues, Some(cancel), |folder| {
        let _ = app.emit("scan-progress", folder);
    })?;
    write_issues(pool, library_id, &issues).await?;
    let albums = group_sibling_albums(albums);
    let (mut artists, mut orphans) = group_by_artist(albums, loose);
    apply_album_combines(pool, library_id, &mut artists, &mut orphans).await?;

    let mut next_order = next_artist_order(pool, library_id).await?;
    for artist in artists {
        if cancel.load(Ordering::SeqCst) {
            return Err("Library creation cancelled".to_string());
        }
        let _ = app.emit("scan-progress", &artist.title);
        let artist_id = match find_artist_by_title(pool, library_id, &artist.title).await? {
            Some(id) => id,
            None => {
                let id = insert_artist_row(pool, library_id, cache_base, &artist, next_order).await?;
                next_order += 1;
                id
            }
        };
        let start: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media_entry WHERE parent_id = ?")
            .bind(artist_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
        let mut sorted = artist.albums;
        sorted.sort_by_key(album_sort_key);
        for (j, album) in sorted.iter().enumerate() {
            // Inserting is the other slow half (cover decode + thumbnailing),
            // so it reports per album too.
            let _ = app.emit(
                "scan-progress",
                format!("{} — {}", artist.title, album_title_of(album)),
            );
            insert_album(pool, library_id, cache_base, Some(artist_id), album, start.0 + j as i64)
                .await?;
        }
        if !artist.loose.is_empty() {
            let _ = app.emit("scan-progress", format!("{} — loose tracks", artist.title));
            let (container_id, release_id) =
                ensure_loose_container(pool, library_id, Some(artist_id), sound).await?;
            let mut none = HashMap::new();
            reconcile_loose_tracks(pool, library_id, container_id, release_id, &artist.loose, &mut none)
                .await?;
        }
    }

    // Material naming no artist at all: albums at the root, artist-less loose
    // tracks under the library-root container.
    for (j, album) in orphans.albums.iter().enumerate() {
        let _ = app.emit("scan-progress", album_title_of(album));
        insert_album(pool, library_id, cache_base, None, album, j as i64).await?;
    }
    if !orphans.loose.is_empty() {
        let _ = app.emit("scan-progress", "loose tracks");
        let (container_id, release_id) = ensure_loose_container(pool, library_id, None, sound).await?;
        let mut none = HashMap::new();
        reconcile_loose_tracks(pool, library_id, container_id, release_id, &orphans.loose, &mut none)
            .await?;
    }

    // Featured names without a page of their own become artists too.
    ensure_credit_artists(pool, library_id).await?;
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
) -> Result<(), String> {
    clear_issues(pool, library_id).await?;

    let mut all_albums = Vec::new();
    let mut all_loose = Vec::new();
    for (base_path, sound) in base_paths {
        let mut issues = Vec::new();
        let out = scan_base(base_path, *sound, &mut issues, None, |folder| {
            let _ = app.emit("scan-progress", folder);
        })?;
        all_albums.extend(out.albums);
        all_loose.extend(out.loose);
        write_issues(pool, library_id, &issues).await?;
    }
    let albums = group_sibling_albums(all_albums);
    let (mut artists, mut orphans) = group_by_artist(albums, all_loose);
    apply_album_combines(pool, library_id, &mut artists, &mut orphans).await?;

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
    let db_albums: Vec<(i64, String)> = sqlx::query_as(
        "SELECT al.id, al.folder_path FROM album al
         JOIN media_entry me ON me.id = al.id WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let db_release_folders: Vec<(i64, String)> = sqlx::query_as(
        "SELECT ar.album_id, ar.folder_path FROM album_release ar
         JOIN media_entry me ON me.id = ar.album_id WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = ar.album_id)",
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
        let _ = app.emit("scan-progress", &artist.title);
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
            let _ = app.emit(
                "scan-progress",
                format!("{} — {}", artist.title, album_title_of(album)),
            );
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
                    // Reparent — the album-artist tag may have changed.
                    sqlx::query("UPDATE media_entry SET parent_id = ? WHERE id = ?")
                        .bind(artist_id)
                        .bind(album_id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    reconcile_album(pool, library_id, cache_base, album_id, album, &mut existing_tracks)
                        .await?;
                }
                None => {
                    // Fresh entries; any old same-path entries left in
                    // existing_tracks are stale and belong to the sweep.
                    let id =
                        insert_album(pool, library_id, cache_base, Some(artist_id), album, j as i64)
                            .await?;
                    seen_album_ids.insert(id);
                }
            }
        }

        if !artist.loose.is_empty() {
            let _ = app.emit("scan-progress", format!("{} — loose tracks", artist.title));
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
        let _ = app.emit("scan-progress", album_title_of(album));
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
                sqlx::query("UPDATE media_entry SET parent_id = NULL WHERE id = ?")
                    .bind(album_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                reconcile_album(pool, library_id, cache_base, album_id, album, &mut existing_tracks)
                    .await?;
            }
            None => {
                let id = insert_album(pool, library_id, cache_base, None, album, j as i64).await?;
                seen_album_ids.insert(id);
            }
        }
    }
    if !orphans.loose.is_empty() {
        let _ = app.emit("scan-progress", "loose tracks");
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
    // 1. Tracks whose files are gone (or are now unreadable).
    for (_, track_id) in existing_tracks {
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
    // 3. Artists left childless (tag renamed away, or everything under them
    //    vanished) — UNLESS they're still credited somewhere.
    sweep_orphan_artists(pool, library_id, cache_base).await?;

    // Featured names without a page of their own become artists too (runs
    // after the sweeps so it sees the final credit set).
    ensure_credit_artists(pool, library_id).await?;

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

/// A display credit: linked to its artist when the name resolves, and shown
/// under the artist's current title (renames propagate; unresolved names keep
/// their stored spelling).
fn credit_view(
    name: String,
    by_lower: &HashMap<String, i64>,
    titles: &HashMap<i64, String>,
) -> CreditView {
    let artist_id = by_lower.get(&name.to_lowercase()).copied();
    let name = artist_id
        .and_then(|id| titles.get(&id).cloned())
        .unwrap_or(name);
    CreditView { name, artist_id }
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

    let credit_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT tc.track_id, tc.name FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id
         WHERE me.parent_id = ?
         ORDER BY tc.track_id, tc.position",
    )
    .bind(container_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credits_by_track: HashMap<i64, Vec<CreditView>> = HashMap::new();
    for (track_id, name) in credit_rows {
        credits_by_track
            .entry(track_id)
            .or_default()
            .push(credit_view(name, &artist_by_lower, &artist_titles));
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
             WHERE me.parent_id = ?
               AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
               AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
             ORDER BY al.sort_order, al.release_date, al.sort_title COLLATE NOCASE",
        )
        .bind(entry_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut albums = Vec::new();
    let mut track_count = 0;
    for (id, title, release_date, folder, sel, tracks, releases, runtime) in album_rows {
        track_count += tracks;
        albums.push(AlbumCard {
            id,
            title,
            year: release_date.as_ref().map(|d| d.chars().take(4).collect()),
            release_date,
            covers: covers_for(pool, &library_id, &folder).await?,
            selected_cover: sel,
            track_count: tracks,
            release_count: releases,
            runtime_secs: runtime,
            artist_title: None,
        });
    }

    // Other artists' albums where this artist appears in a track credit —
    // the whole page for feature-only artists, a bonus section for the rest.
    let appears_rows: Vec<(i64, String, Option<String>, String, Option<String>, Option<String>, i64)> =
        sqlx::query_as(
            "SELECT DISTINCT al.id, al.title, al.release_date, al.folder_path, al.selected_cover, ar2.title,
                    (SELECT COUNT(DISTINCT tc2.track_id) FROM track_credit tc2
                     JOIN media_entry tme2 ON tme2.id = tc2.track_id
                     WHERE tme2.parent_id = al.id
                       AND LOWER(tc2.name) IN (SELECT LOWER(name) FROM artist_names WHERE artist_id = ?1))
             FROM track_credit tc
             JOIN media_entry tme ON tme.id = tc.track_id
             JOIN album al ON al.id = tme.parent_id
             JOIN media_entry ame ON ame.id = al.id
             LEFT JOIN artist ar2 ON ar2.id = ame.parent_id
             WHERE ame.library_id = ?2
               AND LOWER(tc.name) IN (SELECT LOWER(name) FROM artist_names WHERE artist_id = ?1)
               AND (ame.parent_id IS NULL OR ame.parent_id != ?1)
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
    pub covers: Vec<String>,
    pub selected_cover: Option<String>,
    pub genres: Vec<String>,
    pub releases: Vec<ReleaseView>,
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
    let (library_id, parent_id, title, release_date, folder_path, selected_cover, album_type): (
        String,
        Option<i64>,
        String,
        Option<String>,
        String,
        Option<String>,
        String,
    ) = sqlx::query_as(
        "SELECT me.library_id, me.parent_id, al.title, al.release_date, al.folder_path, al.selected_cover, al.album_type
         FROM album al JOIN media_entry me ON me.id = al.id WHERE al.id = ?",
    )
    .bind(entry_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Artist-less albums (no artist tags anywhere) live at the library root.
    let artist_title: Option<String> = match parent_id {
        Some(pid) => sqlx::query_as::<_, (String,)>("SELECT title FROM artist WHERE id = ?")
            .bind(pid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .map(|(t,)| t),
        None => None,
    };

    let genres: Vec<(String,)> = sqlx::query_as(
        "SELECT g.name FROM album_genre ag JOIN genre g ON g.id = ag.genre_id
         WHERE ag.album_id = ? ORDER BY g.name",
    )
    .bind(entry_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let release_rows: Vec<(i64, Option<String>, i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT id, label, is_default, disc_count, release_date
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

    // All credits for the album's tracks, grouped per track in order.
    let credit_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT tc.track_id, tc.name FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id
         WHERE me.parent_id = ?
         ORDER BY tc.track_id, tc.position",
    )
    .bind(entry_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credits_by_track: HashMap<i64, Vec<CreditView>> = HashMap::new();
    for (track_id, name) in credit_rows {
        credits_by_track
            .entry(track_id)
            .or_default()
            .push(credit_view(name, &artist_by_lower, &artist_titles));
    }

    let mut releases = Vec::new();
    for (rid, label, is_default, disc_count, rdate) in release_rows {
        let track_rows: Vec<(i64, String, Option<i64>, Option<i64>, Option<i64>, Option<String>, String, i64, i64)> =
            sqlx::query_as(
                "SELECT t.id, t.title, t.track_number, t.disc_number, t.runtime, tm.artist_name, t.file_path,
                        (SELECT COUNT(*) FROM music_play mp WHERE mp.track_id = t.id AND mp.scrobbled = 1),
                        EXISTS(SELECT 1 FROM track_loved tl WHERE tl.track_id = t.id)
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
        for (id, title, track_number, disc_number, runtime, artist_name, rel, play_count, loved) in track_rows {
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
            tracks,
        });
    }

    Ok(AlbumDetail {
        id: entry_id,
        title,
        album_type,
        year: release_date.map(|d| d.chars().take(4).collect()),
        artist_id: parent_id,
        artist_title,
        covers: covers_for(pool, &library_id, &folder_path).await?,
        selected_cover,
        genres: genres.into_iter().map(|(g,)| g).collect(),
        releases,
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
    // Sound-marked content lives on its own node: the sounds count, excluded
    // from artists/albums/tracks (an all-sounds artist hides from the grid).
    let (artists, albums, tracks, sounds): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
            COALESCE(SUM(CASE WHEN met.name = 'artist'
                AND (NOT EXISTS (SELECT 1 FROM media_entry ch WHERE ch.parent_id = me.id)
                     OR EXISTS (SELECT 1 FROM media_entry ch WHERE ch.parent_id = me.id
                                AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = ch.id)))
                THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN met.name = 'album'
                AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = me.id)
                AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.id)
                THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN met.name = 'track'
                AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.parent_id)
                THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN met.name = 'album'
                AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = me.id)
                AND EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.id)
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

    let credit_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT tc.track_id, tc.name FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id
         WHERE me.library_id = ?
         ORDER BY tc.track_id, tc.position",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credits_by_track: HashMap<i64, Vec<CreditView>> = HashMap::new();
    for (track_id, name) in credit_rows {
        credits_by_track
            .entry(track_id)
            .or_default()
            .push(credit_view(name, &artist_by_lower, &artist_titles));
    }

    // Album cover art for the now-playing bar, keyed by album folder.
    let covers_map = crate::commands::get_all_cached_covers(pool, &library_id)
        .await
        .map_err(|e| e.to_string())?;

    let rows: Vec<(i64, String, String, Option<i64>, Option<String>, Option<i64>, Option<String>, i64, Option<i64>, i64, i64, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT t.id, t.title, t.file_path, t.runtime, tm.artist_name,
                    al.id, al.title, COALESCE((SELECT 1 FROM loose_album la WHERE la.album_id = al.id), 0),
                    alme.parent_id,
                    (SELECT COUNT(*) FROM music_play mp WHERE mp.track_id = t.id AND mp.scrobbled = 1),
                    EXISTS(SELECT 1 FROM track_loved tl WHERE tl.track_id = t.id),
                    al.folder_path, al.selected_cover
             FROM track t
             JOIN media_entry me ON me.id = t.id
             LEFT JOIN track_meta tm ON tm.track_id = t.id
             LEFT JOIN media_entry alme ON alme.id = me.parent_id
             LEFT JOIN album al ON al.id = alme.id
             WHERE me.library_id = ?
               AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.parent_id)
             ORDER BY t.sort_title = '', t.sort_title COLLATE NOCASE, t.file_path COLLATE NOCASE",
        )
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
                        al.title, al.id, alme.parent_id,
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
        let credit_names: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM track_credit WHERE track_id = ? ORDER BY position")
                .bind(id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
        let artists: Vec<CreditView> = credit_names
            .into_iter()
            .map(|(name,)| credit_view(name, by_lower, titles))
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
    let rows: Vec<(i64, String, String, Option<i64>, i64, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT t.id, t.title, t.file_path, t.track_number,
                COALESCE((SELECT 1 FROM loose_album la WHERE la.album_id = me.parent_id), 0),
                alme.parent_id, tm.artist_name
         FROM track t
         JOIN media_entry me ON me.id = t.id
         LEFT JOIN media_entry alme ON alme.id = me.parent_id
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
    for (id, title, file_path, track_number, is_loose, album_parent, artist_name) in rows {
        let mut missing = Vec::new();
        if title.is_empty() {
            missing.push("title".to_string());
        }
        let _ = album_parent;
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
        "SELECT file_path, reason FROM music_scan_issue WHERE library_id = ? ORDER BY file_path",
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
        };
        ScannedAlbum {
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
        }
    }

    fn fixture_album(tracks: Vec<ScannedTrack>) -> ScannedAlbum {
        ScannedAlbum {
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
        let album_id = insert_album(&pool, "lib1", &dir, Some(artist_id), &v1, 0).await.unwrap();
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

        // Once MusicBrainz has provided credits (stamp 'matched'), a rescan's
        // tag re-parse must NOT clobber them.
        sqlx::query("INSERT OR REPLACE INTO mb_credit_fetch (album_id, status) VALUES (?, 'matched')")
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
        // Feat clause in the title parenthetical; aggressive list splitting.
        assert_eq!(
            parse_credits("Eminem", &[], "Love The Way You Lie (feat. Rihanna & Dido)"),
            vec!["Eminem", "Rihanna", "Dido"]
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
        assert_eq!(
            parse_credits("Frank Ocean (feat. Yung Lean & A$AP Rocky)", &[], "RAF"),
            vec!["Frank Ocean", "Yung Lean", "A$AP Rocky"]
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
        let out = scan_base(&base, false, &mut issues, None, |_| {}).expect("scan");
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
