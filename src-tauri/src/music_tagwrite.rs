//! Tag writing — pushing waverunner's RESOLVED values (user > MusicBrainz >
//! tags) down into the audio files, Picard-style. Never automatic: a
//! per-library opt-in (library_setting 'tag_writing' = "on"), an explicit
//! action per album / track / artist, and a preview of every per-file
//! change before a byte is touched.
//!
//! The fields are the registry's (tag_fields): every file-backed field a
//! track carries in the tag layer is written from its effective value, the
//! file's own frames named by the registry. App-only fields (release
//! membership, identity tokens) have no frame and are never written.
//!
//! The tiered store is what tells a waverunner write apart from an external
//! retag. Every written file is re-read, and what it NOW says is stored at
//! the tag tier without the retag invalidation (set_tag_tier_quiet), so the
//! next rescan finds file and tier equal and leaves the upper tiers alone.
//! An external editor leaves them unequal — that still fires the usual
//! per-field invalidation. Edits the file now carries are dropped only where
//! MusicBrainz doesn't disagree (drop_redundant_user_edits): mb outranks
//! tag, so an edit that differs from MB must survive or MB would paint over
//! the value that's now in the file.
//!
//! The album's own title (the card's — a rename, or MusicBrainz's group
//! title) goes to the DEFAULT release's files only, and only when a tier
//! above the tags disagrees with them (other releases keep their own —
//! that's what makes them releases); the release-group id likewise to every
//! release, the pinned release id to its own folder. Stacked ID3v2 files are
//! refused — editors and the reader see different blocks, and which one
//! lofty rewrites is untested.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, ItemValue, Tag, TagItem};
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::music::{ScannedAlbum, ScannedRelease, ScannedTrack};
use crate::tag_fields::{self, Shape};
use crate::AppState;

/// Whether the user has opted this library into tag writing. Absent = off:
/// touching files is the choice that has to be recorded.
pub(crate) async fn library_tag_writing(pool: &SqlitePool, library_id: &str) -> Result<bool, String> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM library_setting WHERE library_id = ? AND key = 'tag_writing'",
    )
    .bind(library_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|(v,)| v == "on").unwrap_or(false))
}

// ---------------------------------------------------------------------------
// Plan shapes (what the dialog shows)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct TagChange {
    pub field: String,
    pub label: String,
    /// What the file says now ("" = nothing).
    pub from: String,
    /// What it will say.
    pub to: String,
}

#[derive(Serialize)]
pub struct TagFilePlan {
    pub track_id: i64,
    pub file_name: String,
    /// Release folder leaf — groups the list for multi-release albums.
    pub folder: String,
    pub changes: Vec<TagChange>,
    /// Set = this file won't be written, and why.
    pub refused: Option<String>,
}

#[derive(Serialize)]
pub struct TagWritePlan {
    pub title: String,
    pub files: Vec<TagFilePlan>,
    pub notes: Vec<String>,
    pub writable: usize,
    pub unchanged: usize,
    pub refused: usize,
}

#[derive(Serialize)]
pub struct TagWriteOutcome {
    pub written: usize,
    pub unchanged: usize,
    /// "file — reason"
    pub failed: Vec<String>,
    /// "file: field" — written, but the file reads back differently (the
    /// reader parses it another way). Stored as read back, edit kept.
    pub mismatched: Vec<String>,
    /// User edits that became redundant (the file now says the same and
    /// MusicBrainz doesn't disagree) and were dropped.
    pub edits_dropped: usize,
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Val {
    Text(Option<String>),
    List(Vec<String>),
}

impl Val {
    fn text(s: &str) -> Val {
        let s = s.trim();
        Val::Text(if s.is_empty() { None } else { Some(s.to_string()) })
    }
    fn opt(s: Option<&str>) -> Val {
        Val::text(s.unwrap_or_default())
    }
    /// From a field's stored form, by its registry shape.
    fn from_stored(key: &str, stored: &str) -> Val {
        match tag_fields::field(key).map(|d| d.shape) {
            Some(Shape::List) => Val::List(tag_fields::stored_to_list(stored)),
            _ => Val::text(stored),
        }
    }
    fn display(&self) -> String {
        match self {
            Val::Text(t) => t.clone().unwrap_or_default(),
            Val::List(l) => l.join("; "),
        }
    }
}

fn same(key: &str, a: &Val, b: &Val) -> bool {
    match (a, b) {
        (Val::Text(x), Val::Text(y)) => x == y,
        (Val::List(x), Val::List(y)) => {
            if key == "genres" {
                let norm = |v: &Vec<String>| {
                    let mut s: Vec<String> = v.iter().map(|g| g.trim().to_lowercase()).collect();
                    s.sort();
                    s.dedup();
                    s
                };
                norm(x) == norm(y)
            } else {
                x.len() == y.len()
                    && x.iter().zip(y).all(|(p, q)| p.trim().to_lowercase() == q.trim().to_lowercase())
            }
        }
        _ => false,
    }
}

/// The writer's two extra keys beside the registry: artist ids the scanner
/// doesn't carry on ScannedTrack.
const MB_ARTIST_KEY: &str = "mb_artist";
const MB_ALBUM_ARTIST_KEY: &str = "mb_album_artist";

fn label(key: &str) -> String {
    match key {
        MB_ARTIST_KEY => "MusicBrainz artist id".to_string(),
        MB_ALBUM_ARTIST_KEY => "MusicBrainz album artist id".to_string(),
        other => tag_fields::field(other).map(|d| d.label.to_string()).unwrap_or_else(|| "Field".to_string()),
    }
}

/// The two ids the scanner doesn't carry on ScannedTrack.
type ExtraIds = (Option<String>, Option<String>);

struct FileRead {
    track: ScannedTrack,
    extra: ExtraIds,
}

fn read_one(abs: &Path, rel: &str) -> Result<FileRead, String> {
    let track = crate::music::read_track_in_place(abs, rel)?;
    let extra = (|| {
        let tagged = Probe::open(abs).ok()?.read().ok()?;
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
        let grab = |k: &ItemKey| {
            tag.get_string(k).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
        };
        Some((grab(&ItemKey::MusicBrainzArtistId), grab(&ItemKey::MusicBrainzReleaseArtistId)))
    })()
    .unwrap_or((None, None));
    Ok(FileRead { track, extra })
}

/// What the file currently says for one of the writer's fields, from the
/// SPLIT-APPLIED read (directives and the ';' convention applied, exactly
/// as the scanner sees it).
fn current(key: &str, t: &ScannedTrack, extra: &ExtraIds) -> Val {
    match key {
        MB_ARTIST_KEY => Val::opt(extra.0.as_deref()),
        MB_ALBUM_ARTIST_KEY => Val::opt(extra.1.as_deref()),
        other => Val::from_stored(other, &tag_fields::get(t, other)),
    }
}

// ---------------------------------------------------------------------------
// Preparation: what to write, per file
// ---------------------------------------------------------------------------

struct ReleaseMeta {
    label: Option<String>,
    folder_rel: String,
    folder_abs: PathBuf,
    /// Pinned MusicBrainz release id, when the release has one.
    pin: Option<String>,
}

struct AlbumMeta {
    album_id: i64,
    folder_rel: String,
    folder_abs: PathBuf,
    releases: Vec<ReleaseMeta>,
    default_release: usize,
}

struct PreparedFile {
    track_id: i64,
    rel: String,
    abs: PathBuf,
    file_name: String,
    folder_leaf: String,
    release_idx: usize,
    intents: Vec<(&'static str, Val)>,
    changes: Vec<TagChange>,
    refused: Option<String>,
}

struct Job {
    /// None = loose tracks (no album-level fields, no album tier to sync).
    meta: Option<AlbumMeta>,
    /// Album-level fields are in play (album/artist scope; not a lone track).
    album_fields: bool,
    files: Vec<PreparedFile>,
    /// Raw reads (pre-split), by track id. Refreshed after each write.
    reads: HashMap<i64, ScannedTrack>,
    extras: HashMap<i64, ExtraIds>,
    notes: Vec<String>,
}

async fn library_of(pool: &SqlitePool, entity_id: i64) -> Result<String, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
        .bind(entity_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    row.map(|(l,)| l).ok_or_else(|| "Not found".to_string())
}

/// Library bases (music and sounds), for resolving relative paths.
async fn library_bases(pool: &SqlitePool, library_id: &str) -> Result<Vec<PathBuf>, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT path FROM library_path WHERE library_id = ? AND kind IN ('music', 'sounds')
         ORDER BY sort_order, id",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(p,)| PathBuf::from(p)).collect())
}

fn resolve_in(bases: &[PathBuf], rel: &str) -> PathBuf {
    for b in bases {
        let abs = b.join(rel);
        if abs.exists() {
            return abs;
        }
    }
    bases.first().map(|b| b.join(rel)).unwrap_or_else(|| PathBuf::from(rel))
}

fn leaf(rel: &str) -> String {
    Path::new(rel)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| rel.to_string())
}

/// A credit row's display name: the artist's current title when the row is
/// stamped with a live artist (renames propagate), else as credited.
fn credit_name(name: String, artist_id: Option<i64>, titles: &HashMap<i64, String>) -> String {
    artist_id.and_then(|id| titles.get(&id).cloned()).unwrap_or(name)
}

async fn mb_artist_of(pool: &SqlitePool, artist_id: Option<i64>) -> Result<Option<String>, String> {
    let Some(id) = artist_id else { return Ok(None) };
    Ok(crate::music_mb::mb_id(pool, id, crate::music_mb::MB_ARTIST).await?.map(|(v, _)| v))
}

struct Ctx {
    library_id: String,
    bases: Vec<PathBuf>,
    splits: crate::music::ArtistSplits,
    titles: HashMap<i64, String>,
}

async fn context(pool: &SqlitePool, library_id: &str) -> Result<Ctx, String> {
    let (_, titles) = crate::music::artist_resolution_maps(pool, library_id).await?;
    Ok(Ctx {
        library_id: library_id.to_string(),
        bases: library_bases(pool, library_id).await?,
        splits: crate::music::load_artist_splits(pool, library_id).await?,
        titles,
    })
}

/// Read a batch of files off the async runtime.
async fn read_batch(paths: Vec<(i64, PathBuf, String)>) -> Result<Vec<(i64, Result<FileRead, String>)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|(id, abs, rel)| (id, read_one(&abs, &rel)))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

fn refusal(abs: &Path, read: &Result<FileRead, String>) -> Option<String> {
    match read {
        Err(e) => Some(format!("Unreadable: {e}")),
        Ok(r) if r.track.stacked_tags => Some(
            "Two stacked ID3v2 tags — editors and waverunner read different blocks. Rewrite the tag at the source first.".to_string(),
        ),
        Ok(_) => match std::fs::metadata(abs) {
            Ok(m) if m.permissions().readonly() => Some("File is read-only".to_string()),
            Err(e) => Some(format!("Unreadable: {e}")),
            _ => None,
        },
    }
}

/// Rebuild the scanner's album shape from the reads, then run the split
/// directives over it — the view every comparison and every tier sync uses.
fn assemble(meta: &AlbumMeta, files: &[PreparedFile], reads: &HashMap<i64, ScannedTrack>, splits: &crate::music::ArtistSplits) -> ScannedAlbum {
    let mut releases: Vec<ScannedRelease> = meta
        .releases
        .iter()
        .map(|r| ScannedRelease {
            label: r.label.clone(),
            folder_rel: r.folder_rel.clone(),
            folder_abs: r.folder_abs.clone(),
            tracks: Vec::new(),
            // Tag writing never touches cue sheets or the flag.
            cue_pre_emphasis: false,
        })
        .collect();
    for f in files {
        if let Some(t) = reads.get(&f.track_id) {
            releases[f.release_idx].tracks.push(t.clone());
        }
    }
    let album = ScannedAlbum {
        folder_rel: meta.folder_rel.clone(),
        folder_abs: meta.folder_abs.clone(),
        releases,
        default_release: meta.default_release,
        key: String::new(),
    };
    let mut out = crate::music::apply_artist_splits(splits, vec![album], &mut []);
    out.pop().expect("one album in, one out")
}

fn tracks_by_rel(album: &ScannedAlbum) -> HashMap<String, &ScannedTrack> {
    album
        .releases
        .iter()
        .flat_map(|r| r.tracks.iter())
        .map(|t| (t.rel.clone(), t))
        .collect()
}

/// The album-level intents that apply to a file, given the album's resolved
/// values and where they're written.
struct AlbumIntents {
    default_only: Vec<(&'static str, Val)>,
    all: Vec<(&'static str, Val)>,
}

async fn album_intents(pool: &SqlitePool, ctx: &Ctx, album_id: i64, notes: &mut Vec<String>) -> Result<AlbumIntents, String> {
    let (title,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let first_artist: Option<i64> = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT artist_id FROM album_artist_credit WHERE album_id = ? ORDER BY position LIMIT 1",
    )
    .bind(album_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .flatten();

    // The gate: the album's title is pushed only when a tier above the tags
    // holds something different (a rename, MusicBrainz's group title).
    // Missing tag tier = unknown = push, and the per-file diff decides.
    let tag = crate::music_edit::tier_values(pool, album_id, crate::music_edit::TIER_TAG).await?;
    let user = crate::music_edit::tier_values(pool, album_id, crate::music_mb::TIER_USER).await?;
    let differs = |field: &str, resolved: &str| tag.get(field).map(|t| t != resolved).unwrap_or(true);

    let mut default_only = Vec::new();
    let mut all = Vec::new();
    if differs("title", &title) {
        default_only.push(("album", Val::text(&title)));
    }
    if user.contains_key("album_type") {
        notes.push("Album type has no tag — it stays in waverunner.".to_string());
    }

    // Ids: written whenever waverunner holds one, never removed.
    if let Some((group, _)) = crate::music_mb::mb_id(pool, album_id, crate::music_mb::MB_RELEASE_GROUP).await? {
        let (shared,): (i64,) = sqlx::query_as(
            "SELECT COUNT(DISTINCT fo.entity_id) FROM field_override fo
             JOIN media_entry me ON me.id = fo.entity_id
             JOIN album al ON al.id = fo.entity_id
             WHERE me.library_id = ? AND fo.field = 'mb_release_group_id' AND fo.value = ?
               AND fo.tier IN ('user', 'mb') AND fo.entity_id <> ?",
        )
        .bind(&ctx.library_id)
        .bind(&group)
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        if shared > 0 {
            notes.push(
                "Release-group id not written: another album in this library is matched to the same group, and a rescan folds albums whose files share one.".to_string(),
            );
        } else {
            all.push(("mb_release_group_id", Val::text(&group)));
        }
    }
    if let Some(id) = mb_artist_of(pool, first_artist).await? {
        all.push((MB_ALBUM_ARTIST_KEY, Val::text(&id)));
    }
    Ok(AlbumIntents { default_only, all })
}

/// A track's own intents: every file-backed registry field's effective
/// value (user > mb > tag, from the stored tiers), credits and album
/// artists spelled with their artists' CURRENT names (renames propagate),
/// plus the recording and artist ids.
async fn track_intents(pool: &SqlitePool, ctx: &Ctx, track_id: i64) -> Result<Vec<(&'static str, Val)>, String> {
    let tiers = crate::music_edit::all_tiers(pool, track_id).await?;
    let mut out: Vec<(&'static str, Val)> = Vec::new();
    for def in tag_fields::FIELDS {
        if def.app_only || matches!(def.key, "mb_release_group_id" | "mb_release_id") {
            continue; // the album-level intents carry the ids with their guards
        }
        let t = tiers.get(def.key).cloned().unwrap_or_default();
        // A field no tier says anything about is left alone — only an
        // explicit value (even an explicit "") is an intent.
        if t.0.is_none() && t.1.is_none() && t.2.is_none() {
            continue;
        }
        let eff = crate::music_edit::effective(&t);
        out.push((def.key, Val::from_stored(def.key, &eff)));
    }
    // Credits and album artists: the stamped rows, through the artists'
    // current titles.
    let credit_rows: Vec<(String, Option<i64>)> = sqlx::query_as(
        "SELECT name, artist_id FROM track_credit WHERE track_id = ? ORDER BY position",
    )
    .bind(track_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let first_artist = credit_rows.first().and_then(|(_, id)| *id);
    let credits: Vec<String> = credit_rows
        .into_iter()
        .map(|(n, id)| credit_name(n, id, &ctx.titles))
        .collect();
    if let Some(slot) = out.iter_mut().find(|(k, _)| *k == "credits") {
        slot.1 = Val::List(credits);
    } else if !credits.is_empty() {
        out.push(("credits", Val::List(credits)));
    }
    if let Some(slot) = out.iter_mut().find(|(k, _)| *k == "album_artists") {
        if let Val::List(names) = &slot.1 {
            // Resolve each name to its page's current title, alias-aware.
            let (by_lower, _) = crate::music::artist_resolution_maps(pool, &ctx.library_id).await?;
            let mapped: Vec<String> = names
                .iter()
                .map(|n| {
                    by_lower
                        .get(&n.to_lowercase())
                        .and_then(|id| ctx.titles.get(id).cloned())
                        .unwrap_or_else(|| n.clone())
                })
                .collect();
            slot.1 = Val::List(mapped);
        }
    }
    if let Some(id) = mb_artist_of(pool, first_artist).await? {
        out.push((MB_ARTIST_KEY, Val::text(&id)));
    }
    Ok(out)
}

fn diff(intents: &[(&'static str, Val)], t: &ScannedTrack, extra: &ExtraIds) -> Vec<TagChange> {
    intents
        .iter()
        .filter_map(|(key, to)| {
            let from = current(key, t, extra);
            (!same(key, &from, to)).then(|| TagChange {
                field: key.to_string(),
                label: label(key),
                from: from.display(),
                to: to.display(),
            })
        })
        .collect()
}

async fn prepare_album(pool: &SqlitePool, ctx: &Ctx, album_id: i64, only_track: Option<i64>) -> Result<Job, String> {
    let mut notes = Vec::new();
    let (folder_rel,): (String,) = sqlx::query_as("SELECT folder_path FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let release_rows: Vec<(i64, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT id, label, folder_path, is_default FROM album_release WHERE album_id = ?
         ORDER BY is_default DESC, id",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if release_rows.is_empty() {
        return Err("Album has no releases".to_string());
    }
    let pins: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT folder_path, mb_release_id FROM release_match WHERE album_id = ? AND mb_release_id <> ''",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .collect();
    let default_release = release_rows.iter().position(|r| r.3 != 0).unwrap_or(0);
    let meta = AlbumMeta {
        album_id,
        folder_abs: resolve_in(&ctx.bases, &folder_rel),
        folder_rel,
        releases: release_rows
            .iter()
            .map(|(_, label, folder, _)| ReleaseMeta {
                label: label.clone(),
                folder_abs: resolve_in(&ctx.bases, folder),
                pin: pins.get(folder).cloned(),
                folder_rel: folder.clone(),
            })
            .collect(),
        default_release,
    };

    // Files, in list order, with the release each belongs to.
    let mut track_rows: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT t.id, t.file_path, tr.release_id FROM track t
         JOIN track_release tr ON tr.track_id = t.id
         JOIN media_entry me ON me.id = t.id
         WHERE me.parent_id = ? ORDER BY t.sort_order, t.id",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(tid) = only_track {
        track_rows.retain(|(id, _, _)| *id == tid);
        if track_rows.is_empty() {
            return Err("Track not found".to_string());
        }
    }
    let release_idx_of: HashMap<i64, usize> =
        release_rows.iter().enumerate().map(|(i, r)| (r.0, i)).collect();

    let paths: Vec<(i64, PathBuf, String)> = track_rows
        .iter()
        .map(|(id, rel, _)| (*id, resolve_in(&ctx.bases, rel), rel.clone()))
        .collect();
    let reads = read_batch(paths.clone()).await?;

    let mut files = Vec::new();
    let mut raw: HashMap<i64, ScannedTrack> = HashMap::new();
    let mut extras: HashMap<i64, ExtraIds> = HashMap::new();
    for ((id, rel, release_id), (_, read)) in track_rows.iter().zip(reads) {
        let abs = resolve_in(&ctx.bases, rel);
        let refused = refusal(&abs, &read);
        if let Ok(r) = read {
            raw.insert(*id, r.track);
            extras.insert(*id, r.extra);
        }
        let release_idx = release_idx_of.get(release_id).copied().unwrap_or(0);
        files.push(PreparedFile {
            track_id: *id,
            file_name: leaf(rel),
            folder_leaf: leaf(&meta.releases[release_idx].folder_rel),
            rel: rel.clone(),
            abs,
            release_idx,
            intents: Vec::new(),
            changes: Vec::new(),
            refused,
        });
    }

    let album_fields = only_track.is_none();
    let album = assemble(&meta, &files, &raw, &ctx.splits);
    let by_rel = tracks_by_rel(&album);
    let album_int = if album_fields {
        Some(album_intents(pool, ctx, album_id, &mut notes).await?)
    } else {
        None
    };

    for f in files.iter_mut() {
        let mut intents = track_intents(pool, ctx, f.track_id).await?;
        if let Some(ai) = &album_int {
            if f.release_idx == meta.default_release {
                intents.extend(ai.default_only.iter().cloned());
            }
            intents.extend(ai.all.iter().cloned());
            if let Some(pin) = &meta.releases[f.release_idx].pin {
                intents.push(("mb_release_id", Val::text(pin)));
            }
        }
        if let (Some(t), Some(extra)) = (by_rel.get(&f.rel), extras.get(&f.track_id)) {
            f.changes = diff(&intents, t, extra);
        }
        f.intents = intents;
    }

    Ok(Job {
        meta: Some(meta),
        album_fields,
        files,
        reads: raw,
        extras,
        notes,
    })
}

async fn prepare_loose(pool: &SqlitePool, ctx: &Ctx, track_ids: &[i64]) -> Result<Job, String> {
    let mut rows: Vec<(i64, String)> = Vec::new();
    for id in track_ids {
        let (rel,): (String,) = sqlx::query_as("SELECT file_path FROM track WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
        rows.push((*id, rel));
    }
    let paths: Vec<(i64, PathBuf, String)> = rows
        .iter()
        .map(|(id, rel)| (*id, resolve_in(&ctx.bases, rel), rel.clone()))
        .collect();
    let reads = read_batch(paths).await?;
    let mut files = Vec::new();
    let mut raw = HashMap::new();
    let mut extras = HashMap::new();
    for ((id, rel), (_, read)) in rows.iter().zip(reads) {
        let abs = resolve_in(&ctx.bases, rel);
        let refused = refusal(&abs, &read);
        if let Ok(r) = read {
            raw.insert(*id, r.track);
            extras.insert(*id, r.extra);
        }
        files.push(PreparedFile {
            track_id: *id,
            file_name: leaf(rel),
            folder_leaf: Path::new(rel)
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            rel: rel.clone(),
            abs,
            release_idx: 0,
            intents: Vec::new(),
            changes: Vec::new(),
            refused,
        });
    }
    // Split-apply the loose reads the way the scanner does.
    let mut loose: Vec<ScannedTrack> = files.iter().filter_map(|f| raw.get(&f.track_id).cloned()).collect();
    crate::music::apply_artist_splits(&ctx.splits, Vec::new(), &mut loose);
    let by_rel: HashMap<String, ScannedTrack> = loose.into_iter().map(|t| (t.rel.clone(), t)).collect();
    for f in files.iter_mut() {
        let intents = track_intents(pool, ctx, f.track_id).await?;
        if let (Some(t), Some(extra)) = (by_rel.get(&f.rel), extras.get(&f.track_id)) {
            f.changes = diff(&intents, t, extra);
        }
        f.intents = intents;
    }
    Ok(Job {
        meta: None,
        album_fields: false,
        files,
        reads: raw,
        extras,
        notes: Vec::new(),
    })
}

async fn is_loose_container(pool: &SqlitePool, album_id: i64) -> Result<bool, String> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM loose_album WHERE album_id = ?")
        .bind(album_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.is_some())
}

/// Resolve a scope to its jobs.
async fn prepare(pool: &SqlitePool, scope: &str, id: i64) -> Result<(String, Vec<Job>, Vec<String>), String> {
    let library_id = library_of(pool, id).await?;
    if !library_tag_writing(pool, &library_id).await? {
        return Err("Tag writing is off for this library — turn it on in the library's settings.".to_string());
    }
    let ctx = context(pool, &library_id).await?;
    let notes = Vec::new();
    match scope {
        "album" => {
            let (title,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
                .bind(id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok((title, vec![prepare_album(pool, &ctx, id, None).await?], notes))
        }
        "track" => {
            let (title, parent): (String, Option<i64>) = sqlx::query_as(
                "SELECT t.title, me.parent_id FROM track t JOIN media_entry me ON me.id = t.id WHERE t.id = ?",
            )
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
            let parent = parent.ok_or_else(|| "Track has no container".to_string())?;
            let job = if is_loose_container(pool, parent).await? {
                prepare_loose(pool, &ctx, &[id]).await?
            } else {
                prepare_album(pool, &ctx, parent, Some(id)).await?
            };
            let title = if title.is_empty() { job.files.first().map(|f| f.file_name.clone()).unwrap_or_default() } else { title };
            Ok((title, vec![job], notes))
        }
        "artist" => {
            let (title,): (String,) = sqlx::query_as("SELECT title FROM artist WHERE id = ?")
                .bind(id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            let album_ids: Vec<(i64, String)> = sqlx::query_as(
                "SELECT DISTINCT a.id, a.title FROM album_artist_credit aac
                 JOIN album a ON a.id = aac.album_id
                 JOIN media_entry me ON me.id = a.id
                 WHERE aac.artist_id = ? AND me.library_id = ?
                   AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = a.id)
                 ORDER BY a.sort_title, a.id",
            )
            .bind(id)
            .bind(&library_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
            let mut jobs = Vec::new();
            for (album_id, _album_title) in album_ids {
                jobs.push(prepare_album(pool, &ctx, album_id, None).await?);
            }
            let loose: Vec<i64> = sqlx::query_as::<_, (i64,)>(
                "SELECT t.id FROM track t
                 JOIN media_entry me ON me.id = t.id
                 JOIN loose_album la ON la.album_id = me.parent_id
                 JOIN media_entry pm ON pm.id = la.album_id
                 WHERE pm.parent_id = ? ORDER BY t.sort_order, t.id",
            )
            .bind(id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(t,)| t)
            .collect();
            if !loose.is_empty() {
                jobs.push(prepare_loose(pool, &ctx, &loose).await?);
            }
            Ok((title, jobs, notes))
        }
        other => Err(format!("Unknown scope {other}")),
    }
}

fn plan_of(title: String, jobs: &[Job], mut notes: Vec<String>) -> TagWritePlan {
    let mut files = Vec::new();
    let (mut writable, mut unchanged, mut refused) = (0, 0, 0);
    for job in jobs {
        notes.extend(job.notes.iter().cloned());
        for f in &job.files {
            if f.refused.is_some() {
                refused += 1;
            } else if f.changes.is_empty() {
                unchanged += 1;
            } else {
                writable += 1;
            }
            files.push(TagFilePlan {
                track_id: f.track_id,
                file_name: f.file_name.clone(),
                folder: f.folder_leaf.clone(),
                changes: f.changes.clone(),
                refused: f.refused.clone(),
            });
        }
    }
    notes.dedup();
    TagWritePlan { title, files, notes, writable, unchanged, refused }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

fn apply_intents(tag: &mut Tag, intents: &[(&'static str, Val)]) {
    for (key, val) in intents {
        match (*key, val) {
            ("title", Val::Text(t)) => match t {
                Some(s) => tag.set_title(s.clone()),
                None => tag.remove_key(&ItemKey::TrackTitle),
            },
            ("album", Val::Text(t)) => match t {
                Some(s) => tag.set_album(s.clone()),
                None => tag.remove_key(&ItemKey::AlbumTitle),
            },
            ("track_number", Val::Text(t)) => match t.as_deref().and_then(|s| s.parse::<u32>().ok()) {
                Some(n) => tag.set_track(n),
                None => tag.remove_key(&ItemKey::TrackNumber),
            },
            ("disc_number", Val::Text(t)) => match t.as_deref().and_then(|s| s.parse::<u32>().ok()) {
                Some(n) => tag.set_disk(n),
                None => tag.remove_key(&ItemKey::DiscNumber),
            },
            // Display string in the ';' multi-value convention the reader
            // splits on, plus the per-artist ARTISTS frames Picard writes.
            ("credits", Val::List(names)) => {
                tag.remove_key(&ItemKey::TrackArtists);
                if names.is_empty() {
                    tag.remove_key(&ItemKey::TrackArtist);
                } else {
                    tag.set_artist(names.join("; "));
                    for n in names {
                        tag.push(TagItem::new(ItemKey::TrackArtists, ItemValue::Text(n.clone())));
                    }
                }
            }
            (MB_ARTIST_KEY, Val::Text(t)) => write_text(tag, ItemKey::MusicBrainzArtistId, t.as_deref()),
            (MB_ALBUM_ARTIST_KEY, Val::Text(t)) => {
                write_text(tag, ItemKey::MusicBrainzReleaseArtistId, t.as_deref())
            }
            (k, v) => {
                let Some(def) = tag_fields::field(k) else { continue };
                match (&def.write, v) {
                    (tag_fields::Write::Text(ik), Val::Text(t)) => write_text(tag, ik.clone(), t.as_deref()),
                    (tag_fields::Write::Int(ik), Val::Text(t)) => write_text(tag, ik.clone(), t.as_deref()),
                    (tag_fields::Write::List(ik), Val::List(items)) => {
                        tag.remove_key(ik);
                        if !items.is_empty() {
                            tag.insert_text(ik.clone(), items.join("; "));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

fn write_text(tag: &mut Tag, key: ItemKey, value: Option<&str>) {
    match value {
        Some(s) => {
            tag.insert_text(key, s.to_string());
        }
        None => tag.remove_key(&key),
    }
}

/// Write on a copy, then swap it in: the original is never open for
/// writing, so a crash or a failed save leaves it exactly as it was.
fn write_file(abs: &Path, intents: &[(&'static str, Val)]) -> Result<(), String> {
    let dir = abs.parent().ok_or_else(|| "Invalid file path".to_string())?;
    let name = abs
        .file_name()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string_lossy()
        .to_string();
    let tmp = dir.join(format!(".wr-tmp-{name}"));
    let bak = dir.join(format!(".wr-bak-{name}"));

    std::fs::copy(abs, &tmp).map_err(|e| format!("copy failed: {e}"))?;
    let result = (|| -> Result<(), String> {
        let mut tagged = Probe::open(&tmp)
            .map_err(|e| e.to_string())?
            .read()
            .map_err(|e| e.to_string())?;
        if tagged.primary_tag_mut().is_none() {
            let tt = tagged.primary_tag_type();
            tagged.insert_tag(Tag::new(tt));
        }
        let tag = tagged.primary_tag_mut().expect("tag just ensured");
        apply_intents(tag, intents);
        tagged
            .save_to_path(&tmp, WriteOptions::default())
            .map_err(|e| format!("tag write failed: {e}"))
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    // Swap: original → backup, temp → original, drop backup. Any failure
    // puts the original back.
    std::fs::rename(abs, &bak).map_err(|e| format!("backup failed: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, abs) {
        let _ = std::fs::rename(&bak, abs);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("swap failed (original restored): {e}"));
    }
    let _ = std::fs::remove_file(&bak);
    Ok(())
}

/// Store what the file now says at the track's tag tier (no invalidation),
/// drop edits it made redundant, and mirror the tag-side recording id.
async fn sync_track_tier(pool: &SqlitePool, track_id: i64, t: &ScannedTrack) -> Result<usize, String> {
    crate::music_edit::set_tag_tier_quiet(pool, track_id, &t.tag_tier).await?;
    let keys: Vec<&str> = tag_fields::tag_keys().collect();
    let dropped = crate::music_edit::drop_redundant_user_edits(pool, track_id, &keys).await?;
    sqlx::query("UPDATE track_meta SET mb_recording_id = ? WHERE track_id = ?")
        .bind(&t.mb_recording_id)
        .bind(track_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(dropped.len())
}

async fn execute(pool: &SqlitePool, ctx: &Ctx, job: &mut Job, out: &mut TagWriteOutcome) -> Result<(), String> {
    let mut written: HashSet<i64> = HashSet::new();
    for f in job.files.iter_mut() {
        if f.refused.is_some() {
            continue;
        }
        if f.changes.is_empty() {
            out.unchanged += 1;
            continue;
        }
        let abs = f.abs.clone();
        let rel = f.rel.clone();
        let intents = f.intents.clone();
        let res = tauri::async_runtime::spawn_blocking(move || {
            write_file(&abs, &intents)?;
            read_one(&abs, &rel)
        })
        .await
        .map_err(|e| e.to_string())?;
        match res {
            Ok(read) => {
                job.reads.insert(f.track_id, read.track);
                job.extras.insert(f.track_id, read.extra);
                written.insert(f.track_id);
                out.written += 1;
            }
            Err(e) => out.failed.push(format!("{} — {e}", f.file_name)),
        }
    }
    if written.is_empty() {
        return Ok(());
    }

    // What the files say now, through the scanner's eyes.
    let (post, by_rel): (Option<ScannedAlbum>, HashMap<String, ScannedTrack>) = match &job.meta {
        Some(meta) => {
            let album = assemble(meta, &job.files, &job.reads, &ctx.splits);
            let map = tracks_by_rel(&album).into_iter().map(|(k, v)| (k, v.clone())).collect();
            (Some(album), map)
        }
        None => {
            let mut loose: Vec<ScannedTrack> = job.files.iter().filter_map(|f| job.reads.get(&f.track_id).cloned()).collect();
            crate::music::apply_artist_splits(&ctx.splits, Vec::new(), &mut loose);
            (None, loose.into_iter().map(|t| (t.rel.clone(), t)).collect())
        }
    };
    for f in &job.files {
        if !written.contains(&f.track_id) {
            continue;
        }
        let Some(t) = by_rel.get(&f.rel) else { continue };
        // Read-back check: a field the reader parses differently from what
        // was written is reported; the stored tag tier is the read-back.
        if let Some(extra) = job.extras.get(&f.track_id) {
            for (key, to) in &f.intents {
                if !same(key, &current(key, t, extra), to) {
                    out.mismatched.push(format!("{}: {}", f.file_name, label(key)));
                }
            }
        }
        out.edits_dropped += sync_track_tier(pool, f.track_id, t).await?;
    }

    if let (Some(meta), Some(album), true) = (&job.meta, &post, job.album_fields) {
        // Album tier only from a complete picture: an unread file would
        // skew the majority votes the derivation makes.
        let complete = job.files.iter().all(|f| job.reads.contains_key(&f.track_id));
        if complete {
            let values = crate::music::album_tag_values(album)?;
            crate::music_edit::set_tag_tier_quiet(pool, meta.album_id, &values).await?;
            out.edits_dropped += crate::music_edit::drop_redundant_user_edits(pool, meta.album_id, crate::music_edit::album_fields())
                .await?
                .len();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Preview: every file the scope covers, with the exact per-field changes a
/// write would make. Nothing is touched.
#[tauri::command]
pub async fn get_tag_write_plan(state: State<'_, AppState>, scope: String, id: i64) -> Result<TagWritePlan, String> {
    let pool = &state.app_db;
    let (title, jobs, notes) = prepare(pool, &scope, id).await?;
    Ok(plan_of(title, &jobs, notes))
}

/// Write. The plan is rebuilt from the files as they are right now (the
/// preview may be stale), then every file with changes is written, re-read,
/// and its tiers brought in step.
#[tauri::command]
pub async fn apply_tag_write(state: State<'_, AppState>, scope: String, id: i64) -> Result<TagWriteOutcome, String> {
    crate::music_mb::ensure_entity_not_matching(&state.app_db, id).await?;
    let pool = &state.app_db;
    let library_id = library_of(pool, id).await?;
    let (_, mut jobs, _) = prepare(pool, &scope, id).await?;
    let ctx = context(pool, &library_id).await?;
    let mut out = TagWriteOutcome { written: 0, unchanged: 0, failed: Vec::new(), mismatched: Vec::new(), edits_dropped: 0 };
    for job in jobs.iter_mut() {
        execute(pool, &ctx, job, &mut out).await?;
    }
    if scope == "artist" && out.failed.is_empty() && out.written > 0 {
        // Every file naming this artist now carries the resolved name.
        let (title,): (String,) = sqlx::query_as("SELECT title FROM artist WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
        crate::music_edit::set_tag_tier_quiet(pool, id, &[("title", title)]).await?;
        out.edits_dropped += crate::music_edit::drop_redundant_user_edits(pool, id, &["title"]).await?.len();
    }
    Ok(out)
}
