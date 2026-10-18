//! Editing — the user's tier of tags.
//!
//! Every edit lands in `field_override` at the 'user' tier and then runs a
//! SCOPED RESCAN of the albums it touched (music::rescan_music_library with
//! a scope): the scanner reads those folders again with the layer on top
//! and re-derives everything — titles, numbers, credits, which album and
//! release a track belongs to. One derivation, one writer of the cached
//! columns; nothing is stamped after the fact. Structural actions (combine,
//! merge, separate, split an artist) are edits of the layer's app-only
//! fields (identity_key, release_key) or a standing rule (artist_split),
//! applied the same way, on the spot. Every edit is a History batch
//! ("layer_edit") and undoes by restoring the previous layer values.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{Manager, State};

use crate::commands::generate_sort_title;
use crate::tag_fields;
use crate::AppState;

// ---------------------------------------------------------------------------
// The tiered store
// ---------------------------------------------------------------------------

/// Album-level fields with tiers of their own: the card's (release-group)
/// title, the album's date and type. Everything else an album shows derives
/// from its tracks' effective tags (credits from album_artists, genres).
const ALBUM_FIELDS: &[&str] = &["title", "release_date", "album_type"];
const ARTIST_FIELDS: &[&str] = &["title"];

/// The value tiers. field_override is a TIERED VALUE STORE: the scanner
/// writes what the files say at 'tag', matching writes what MusicBrainz says
/// at 'mb', edits write 'user'. The effective value is user, else a
/// non-empty mb, else tag — resolved by the overlay before grouping for
/// tracks, and by resolve_album_fields for the album-level fields.
pub(crate) const TIER_TAG: &str = "tag";

pub(crate) fn album_fields() -> &'static [&'static str] {
    ALBUM_FIELDS
}

/// Store an entity's TAG tier and invalidate what sat above any field whose
/// tag value CHANGED since the last scan. A retag at the source is the base
/// moving: the MB value and the user edit for that field were answers about
/// the old base, so they go. Per field — a changed date tag never touches a
/// title edit. Empty values are not stored (absence = ""), except `title`,
/// whose row doubles as the "scanned before" stamp: the first write of an
/// entity changes nothing, since there is no old base to compare against.
/// Returns the changed fields.
pub(crate) async fn store_tag_tier(
    pool: &SqlitePool,
    entity_id: i64,
    values: &[(&str, String)],
) -> Result<Vec<String>, String> {
    let prev = tier_values(pool, entity_id, TIER_TAG).await?;
    let stamped = prev.contains_key("title");
    let mut changed = Vec::new();
    for (field, value) in values {
        if stamped {
            let old = prev.get(*field).cloned().unwrap_or_default();
            if old != *value {
                invalidate_field(pool, entity_id, field).await?;
                changed.push(field.to_string());
            }
        }
        if value.is_empty() && *field != "title" {
            if prev.contains_key(*field) {
                sqlx::query("DELETE FROM field_override WHERE entity_id = ? AND field = ? AND tier = 'tag'")
                    .bind(entity_id)
                    .bind(field)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        } else if prev.get(*field) != Some(value) {
            crate::music_mb::set_mb_id(pool, entity_id, field, value, TIER_TAG).await?;
        }
    }
    Ok(changed)
}

/// Drop one field's MB and user tiers — the base beneath them moved.
pub(crate) async fn invalidate_field(
    pool: &SqlitePool,
    entity_id: i64,
    field: &str,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM field_override WHERE entity_id = ? AND field = ? AND tier IN ('mb', 'user')",
    )
    .bind(entity_id)
    .bind(field)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Store TAG-tier values WITHOUT the retag invalidation — the tag writer's
/// half of the internal/external distinction. A write waverunner made
/// itself is not the base moving under the upper tiers: the tag tier is
/// brought in step with the file right here, so the next rescan finds the
/// two equal and store_tag_tier changes nothing. An external editor leaves
/// the file disagreeing with this row, which is exactly what fires there.
pub(crate) async fn set_tag_tier_quiet(
    pool: &SqlitePool,
    entity_id: i64,
    values: &[(&str, String)],
) -> Result<(), String> {
    for (field, value) in values {
        if value.is_empty() && *field != "title" {
            sqlx::query("DELETE FROM field_override WHERE entity_id = ? AND field = ? AND tier = 'tag'")
                .bind(entity_id)
                .bind(field)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        } else {
            crate::music_mb::set_mb_id(pool, entity_id, field, value, TIER_TAG).await?;
        }
    }
    Ok(())
}

/// After a tag write, drop the user edits the file now carries — but ONLY
/// where MusicBrainz doesn't disagree. mb outranks tag, so an edit that
/// differs from the MB value has to stay or MB would paint over the value
/// that's now in the file. An edit is redundant when the tag tier equals
/// it and the MB tier is absent, empty, or the same. Returns the fields
/// dropped.
pub(crate) async fn drop_redundant_user_edits(
    pool: &SqlitePool,
    entity_id: i64,
    fields: &[&str],
) -> Result<Vec<String>, String> {
    let user = tier_values(pool, entity_id, crate::music_mb::TIER_USER).await?;
    let mb = tier_values(pool, entity_id, crate::music_mb::TIER_MB).await?;
    let tag = tier_values(pool, entity_id, TIER_TAG).await?;
    let mut dropped = Vec::new();
    for field in fields {
        let Some(u) = user.get(*field) else { continue };
        let tag_value = tag.get(*field).cloned().unwrap_or_default();
        if tag_value != *u {
            continue;
        }
        let mb_agrees = mb.get(*field).map(|m| m.is_empty() || m == u).unwrap_or(true);
        if !mb_agrees {
            continue;
        }
        sqlx::query("DELETE FROM field_override WHERE entity_id = ? AND field = ? AND tier = 'user'")
            .bind(entity_id)
            .bind(field)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        dropped.push(field.to_string());
    }
    Ok(dropped)
}

/// User-tier override values for an entity, keyed by field. Values are the
/// stored form (lists as JSON arrays).
pub(crate) async fn user_overrides(
    pool: &SqlitePool,
    entity_id: i64,
) -> Result<HashMap<String, String>, String> {
    tier_values(pool, entity_id, crate::music_mb::TIER_USER).await
}

/// One tier's stored values for an entity, keyed by field.
pub(crate) async fn tier_values(
    pool: &SqlitePool,
    entity_id: i64,
    tier: &str,
) -> Result<HashMap<String, String>, String> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT field, value FROM field_override WHERE entity_id = ? AND tier = ?",
    )
    .bind(entity_id)
    .bind(tier)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(f, v)| (f, v.unwrap_or_default()))
        .collect())
}

/// Every tier of an entity at once: field → (tag, mb, user).
pub(crate) async fn all_tiers(
    pool: &SqlitePool,
    entity_id: i64,
) -> Result<HashMap<String, (Option<String>, Option<String>, Option<String>)>, String> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT field, tier, value FROM field_override WHERE entity_id = ?",
    )
    .bind(entity_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut out: HashMap<String, (Option<String>, Option<String>, Option<String>)> = HashMap::new();
    for (field, tier, value) in rows {
        let slot = out.entry(field).or_default();
        let v = Some(value.unwrap_or_default());
        match tier.as_str() {
            "tag" => slot.0 = v,
            "mb" => slot.1 = v,
            "user" => slot.2 = v,
            _ => {}
        }
    }
    Ok(out)
}

/// The effective value of a field from its tiers: user, else a non-empty
/// mb, else tag, else "".
pub(crate) fn effective(tiers: &(Option<String>, Option<String>, Option<String>)) -> String {
    tiers
        .2
        .clone()
        .or_else(|| tiers.1.clone().filter(|v| !v.is_empty()))
        .or_else(|| tiers.0.clone())
        .unwrap_or_default()
}

pub(crate) async fn has_override(
    pool: &SqlitePool,
    entity_id: i64,
    field: &str,
) -> Result<bool, String> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM field_override WHERE entity_id = ? AND field = ? AND tier = 'user'",
    )
    .bind(entity_id)
    .bind(field)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.is_some())
}

pub(crate) async fn upsert_override(
    pool: &SqlitePool,
    entity_id: i64,
    field: &str,
    value: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO field_override (entity_id, field, tier, value) VALUES (?, ?, 'user', ?)
         ON CONFLICT(entity_id, field, tier) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(entity_id)
    .bind(field)
    .bind(value)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) async fn delete_override(
    pool: &SqlitePool,
    entity_id: i64,
    field: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM field_override WHERE entity_id = ? AND field = ? AND tier = 'user'")
        .bind(entity_id)
        .bind(field)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Per field, the highest tier holding a usable value: user > mb > tag. An
/// EMPTY mb value is MusicBrainz's "has none" marker (a dateless group) and
/// yields to the tag tier; an empty user or tag value is a real "none" (a
/// cleared date). The tag tier is consulted only on request.
async fn resolved_values(
    pool: &SqlitePool,
    entity_id: i64,
    fields: &[&str],
    from_tag: bool,
) -> Result<HashMap<String, String>, String> {
    let user = tier_values(pool, entity_id, crate::music_mb::TIER_USER).await?;
    let mb = tier_values(pool, entity_id, crate::music_mb::TIER_MB).await?;
    let tag = if from_tag { tier_values(pool, entity_id, TIER_TAG).await? } else { HashMap::new() };
    let mut out = HashMap::new();
    for field in fields {
        let v = user
            .get(*field)
            .cloned()
            .or_else(|| mb.get(*field).filter(|v| !v.is_empty()).cloned())
            .or_else(|| tag.get(*field).cloned());
        if let Some(v) = v {
            out.insert(field.to_string(), v);
        }
    }
    Ok(out)
}

/// Write the album's resolved album-level values (title, date, type) to its
/// columns. `from_tag` = also read the stored tag tier — the scanner's
/// tail and the reset path, where the columns may hold a just-deleted edit.
/// A field with no value at any consulted tier is left alone.
pub(crate) async fn resolve_album_fields(
    pool: &SqlitePool,
    album_id: i64,
    from_tag: bool,
) -> Result<(), String> {
    let overrides = resolved_values(pool, album_id, ALBUM_FIELDS, from_tag).await?;
    if overrides.is_empty() {
        return Ok(());
    }
    if let Some(title) = overrides.get("title") {
        if !title.is_empty() {
            sqlx::query("UPDATE album SET title = ?, sort_title = ? WHERE id = ?")
                .bind(title)
                .bind(generate_sort_title(title, "en"))
                .bind(album_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    if let Some(date) = overrides.get("release_date") {
        let val = if date.is_empty() { None } else { Some(date.as_str()) };
        sqlx::query("UPDATE album SET release_date = ? WHERE id = ?")
            .bind(val)
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(t) = overrides.get("album_type") {
        if !t.is_empty() {
            sqlx::query("UPDATE album SET album_type = ? WHERE id = ?")
                .bind(t)
                .bind(album_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Artist counterpart — a renamed (or MB-named) artist keeps that name
/// through rescans (the scan's casing-refresh would otherwise restore the
/// tag spelling).
pub(crate) async fn reapply_artist_overrides(
    pool: &SqlitePool,
    artist_id: i64,
) -> Result<(), String> {
    resolve_artist_fields(pool, artist_id, false).await
}

pub(crate) async fn resolve_artist_fields(
    pool: &SqlitePool,
    artist_id: i64,
    from_tag: bool,
) -> Result<(), String> {
    let overrides = resolved_values(pool, artist_id, ARTIST_FIELDS, from_tag).await?;
    if let Some(title) = overrides.get("title") {
        if !title.is_empty() {
            sqlx::query("UPDATE artist SET title = ?, sort_title = ? WHERE id = ?")
                .bind(title)
                .bind(generate_sort_title(title, "en"))
                .bind(artist_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            drop_self_alias(pool, artist_id).await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Scoped rescans — how every edit lands
// ---------------------------------------------------------------------------

/// One scan at a time per library: a full rescan and the scoped runs edits
/// start wait on each other instead of interleaving their writes.
static SCAN_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();

pub(crate) fn scan_lock(library_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = SCAN_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(library_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// The library's music bases, (path, is_sounds), as the rescan wants them.
pub(crate) async fn library_bases(pool: &SqlitePool, library_id: &str) -> Result<Vec<(PathBuf, bool)>, String> {
    let paths: Vec<(String,)> = sqlx::query_as(
        "SELECT path FROM library_path WHERE library_id = ? AND kind = 'music' ORDER BY sort_order, id",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let sounds: HashSet<String> = sqlx::query_as::<_, (String,)>(
        "SELECT path FROM sound_path WHERE library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(p,)| p)
    .collect();
    Ok(paths.into_iter().map(|(p,)| (PathBuf::from(&p), sounds.contains(&p))).collect())
}

/// Re-derive the albums an edit touched (and whatever they could regroup
/// with) through the scanner, right now. Quiet: no progress beacons; the
/// caller's page refetches when the command returns.
pub(crate) async fn rescan_albums(
    pool: &SqlitePool,
    library_id: &str,
    album_ids: &[i64],
) -> Result<(), String> {
    if album_ids.is_empty() {
        return Ok(());
    }
    let app = crate::music_mb::app_handle().ok_or_else(|| "App not running".to_string())?;
    let cache_base = app.state::<AppState>().app_data_dir.join("cache").join(library_id);
    std::fs::create_dir_all(&cache_base).map_err(|e| e.to_string())?;
    let bases = library_bases(pool, library_id).await?;
    let scope = crate::music::rescan_scope_for_albums(pool, library_id, album_ids).await?;
    let lock = scan_lock(library_id);
    let _guard = lock.lock().await;
    let cancel = AtomicBool::new(false);
    crate::music::rescan_music_library(None, pool, library_id, &bases, &cache_base, &cancel, Some(&scope))
        .await
}

/// The album (or loose container) each track lives in — the scope seed.
pub(crate) async fn albums_of_tracks(pool: &SqlitePool, track_ids: &[i64]) -> Result<Vec<i64>, String> {
    let mut out: Vec<i64> = Vec::new();
    for id in track_ids {
        let parent: Option<(Option<i64>,)> =
            sqlx::query_as("SELECT parent_id FROM media_entry WHERE id = ?")
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((Some(p),)) = parent {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Layer edits — the one write path for the user's tier on tracks
// ---------------------------------------------------------------------------

/// One track's changes: field → new stored value, or None to drop the
/// user's value (fall back to what MusicBrainz or the file says).
pub(crate) type LayerEdit = (i64, Vec<(String, Option<String>)>);

/// Write the user tier for a set of tracks, log ONE History batch for it,
/// and regroup the albums it touched. The change set is taken as-is (the
/// commands validate against the registry before calling).
pub(crate) async fn apply_layer_edits(
    pool: &SqlitePool,
    library_id: &str,
    edits: &[LayerEdit],
    label: &str,
) -> Result<(), String> {
    let edits: Vec<&LayerEdit> = edits.iter().filter(|(_, f)| !f.is_empty()).collect();
    if edits.is_empty() {
        return Ok(());
    }
    let track_ids: Vec<i64> = edits.iter().map(|(id, _)| *id).collect();
    // The albums before the write: an edit that moves tracks must regroup
    // where they came FROM as much as where they go.
    let mut albums = albums_of_tracks(pool, &track_ids).await?;

    let mut before: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut after: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut changed_any = false;
    for (track_id, fields) in &edits {
        let current = user_overrides(pool, *track_id).await?;
        let mut b = serde_json::Map::new();
        let mut a = serde_json::Map::new();
        for (field, value) in fields {
            let old = current.get(field).cloned();
            if old == *value {
                continue;
            }
            changed_any = true;
            b.insert(field.clone(), old.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
            a.insert(
                field.clone(),
                value.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
            );
            match value {
                Some(v) => upsert_override(pool, *track_id, field, v).await?,
                None => delete_override(pool, *track_id, field).await?,
            }
        }
        if !b.is_empty() {
            before.insert(track_id.to_string(), serde_json::Value::Object(b));
            after.insert(track_id.to_string(), serde_json::Value::Object(a));
        }
    }
    if !changed_any {
        return Ok(());
    }
    let target = albums.first().copied().or(track_ids.first().copied()).unwrap_or(0);
    let batch = crate::music_mb::next_batch(pool).await?;
    crate::music_mb::log_change(
        pool,
        library_id,
        "layer_edit",
        target,
        label,
        &serde_json::Value::Object(before),
        &serde_json::Value::Object(after),
        batch,
    )
    .await?;
    // A moved track's new home is found by the closure through its
    // release_key / identity / tag key; the old home is the seed.
    for id in albums_of_tracks(pool, &track_ids).await? {
        if !albums.contains(&id) {
            albums.push(id);
        }
    }
    rescan_albums(pool, library_id, &albums).await
}

/// Undo of a "layer_edit" History row: put every (track, field) back to its
/// previous user value and regroup. Called from music_mb's undo walk.
pub(crate) async fn undo_layer_edit(
    pool: &SqlitePool,
    library_id: &str,
    before: &serde_json::Value,
) -> Result<(), String> {
    let Some(map) = before.as_object() else { return Ok(()) };
    let mut edits: Vec<LayerEdit> = Vec::new();
    for (track_id, fields) in map {
        let Ok(track_id) = track_id.parse::<i64>() else { continue };
        let Some(fields) = fields.as_object() else { continue };
        let list: Vec<(String, Option<String>)> = fields
            .iter()
            .map(|(f, v)| (f.clone(), v.as_str().map(|s| s.to_string())))
            .collect();
        edits.push((track_id, list));
    }
    let track_ids: Vec<i64> = edits.iter().map(|(id, _)| *id).collect();
    let mut albums = albums_of_tracks(pool, &track_ids).await?;
    for (track_id, fields) in &edits {
        for (field, value) in fields {
            match value {
                Some(v) => upsert_override(pool, *track_id, field, v).await?,
                None => delete_override(pool, *track_id, field).await?,
            }
        }
    }
    for id in albums_of_tracks(pool, &track_ids).await? {
        if !albums.contains(&id) {
            albums.push(id);
        }
    }
    rescan_albums(pool, library_id, &albums).await
}

/// A fresh identity token — what sets an album apart (or binds a combine).
fn new_identity_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

/// The track ids of an album, in list order.
async fn album_track_ids(pool: &SqlitePool, album_id: i64) -> Result<Vec<i64>, String> {
    Ok(sqlx::query_as::<_, (i64,)>(
        "SELECT t.id FROM track t JOIN media_entry me ON me.id = t.id
         WHERE me.parent_id = ? ORDER BY t.sort_order, t.id",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(id,)| id)
    .collect())
}

/// The track ids of one release, in list order.
async fn release_track_ids(pool: &SqlitePool, release_id: i64) -> Result<Vec<i64>, String> {
    Ok(sqlx::query_as::<_, (i64,)>(
        "SELECT t.id FROM track t JOIN track_release tr ON tr.track_id = t.id
         WHERE tr.release_id = ? ORDER BY t.sort_order, t.id",
    )
    .bind(release_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(id,)| id)
    .collect())
}

/// The same value on every one of these tracks, as one layer edit.
fn same_on_all(track_ids: &[i64], fields: Vec<(String, Option<String>)>) -> Vec<LayerEdit> {
    track_ids.iter().map(|id| (*id, fields.clone())).collect()
}

// ---------------------------------------------------------------------------
// Track context helpers
// ---------------------------------------------------------------------------

async fn track_context(pool: &SqlitePool, track_id: i64) -> Result<(String, String), String> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT me.library_id, t.file_path FROM track t
         JOIN media_entry me ON me.id = t.id WHERE t.id = ?",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    row.ok_or_else(|| "Track not found".to_string())
}

async fn library_of(pool: &SqlitePool, entity_id: i64) -> Result<String, String> {
    sqlx::query_as::<_, (String,)>("SELECT library_id FROM media_entry WHERE id = ?")
        .bind(entity_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .map(|(l,)| l)
        .ok_or_else(|| "Not found".to_string())
}

async fn resolve_abs(pool: &SqlitePool, library_id: &str, rel: &str) -> Result<PathBuf, String> {
    // Sounds bases included: sound tracks resolve through here too.
    let bases: Vec<(String,)> = sqlx::query_as(
        "SELECT path FROM library_path WHERE library_id = ? AND kind IN ('music', 'sounds')
         ORDER BY sort_order, id",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (base,) in &bases {
        let abs = Path::new(base).join(rel);
        if abs.exists() {
            return Ok(abs);
        }
    }
    Err("File not found under the library's music folders".to_string())
}

/// Open Explorer with the track's file selected.
#[tauri::command]
pub async fn reveal_track_file(state: State<'_, AppState>, track_id: i64) -> Result<(), String> {
    let pool = &state.app_db;
    let (library_id, rel) = track_context(pool, track_id).await?;
    let abs = resolve_abs(pool, &library_id, &rel).await?;
    tauri_plugin_opener::reveal_item_in_dir(&abs).map_err(|e| e.to_string())
}

/// Open a release's source folder in Explorer.
#[tauri::command]
pub async fn open_release_folder(state: State<'_, AppState>, release_id: i64) -> Result<(), String> {
    let pool = &state.app_db;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT me.library_id, ar.folder_path FROM album_release ar
         JOIN media_entry me ON me.id = ar.album_id WHERE ar.id = ?",
    )
    .bind(release_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (library_id, rel) = row.ok_or_else(|| "Release not found".to_string())?;
    let abs = resolve_abs(pool, &library_id, &rel).await?;
    tauri_plugin_opener::open_path(abs.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// The registry, for the frontend
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_tag_fields() -> Result<Vec<tag_fields::FieldInfo>, String> {
    Ok(tag_fields::infos())
}

// ---------------------------------------------------------------------------
// Commands — read
// ---------------------------------------------------------------------------

/// A track as the editor sees it: every registry field's effective value,
/// what the file says (the tag tier), and which fields carry an edit.
#[derive(Serialize)]
pub struct TrackEditView {
    pub id: i64,
    pub file_name: String,
    /// field → effective value (stored form: lists as JSON, numbers as text).
    pub values: HashMap<String, String>,
    /// field → what the file says (absent = nothing).
    pub file_values: HashMap<String, String>,
    /// field → what MusicBrainz said (absent = nothing).
    pub mb_values: HashMap<String, String>,
    /// Fields with a user override.
    pub overridden: Vec<String>,
    pub album_id: Option<i64>,
    pub release_id: Option<i64>,
    /// The owning library — what the editor's write is scoped to.
    pub library_id: String,
}

#[tauri::command]
pub async fn get_track_edit(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<TrackEditView, String> {
    let pool = &state.app_db;
    let (library_id, rel) = track_context(pool, track_id).await?;
    let tiers = all_tiers(pool, track_id).await?;
    let mut values = HashMap::new();
    let mut file_values = HashMap::new();
    let mut mb_values = HashMap::new();
    let mut overridden = Vec::new();
    for key in tag_fields::keys() {
        let t = tiers.get(key).cloned().unwrap_or_default();
        let eff = effective(&t);
        if !eff.is_empty() {
            values.insert(key.to_string(), eff);
        }
        if let Some(v) = t.0.filter(|v| !v.is_empty()) {
            file_values.insert(key.to_string(), v);
        }
        if let Some(v) = t.1.filter(|v| !v.is_empty()) {
            mb_values.insert(key.to_string(), v);
        }
        if t.2.is_some() {
            overridden.push(key.to_string());
        }
    }
    let parent: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT parent_id FROM media_entry WHERE id = ?")
            .bind(track_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let album_id = parent.and_then(|(p,)| p);
    let release_id: Option<(i64,)> =
        sqlx::query_as("SELECT release_id FROM track_release WHERE track_id = ?")
            .bind(track_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(TrackEditView {
        id: track_id,
        file_name: Path::new(&rel)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rel.clone()),
        values,
        file_values,
        mb_values,
        overridden,
        album_id,
        release_id: release_id.map(|(r,)| r),
        library_id,
    })
}

// ---------------------------------------------------------------------------
// Commands — write (tracks)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct TrackEdit {
    pub track_id: i64,
    /// field → value: a string (text), array (list), number, or null to
    /// drop the user's value and fall back.
    pub fields: HashMap<String, serde_json::Value>,
}

/// Apply user edits to any number of tracks — the one write for the track
/// editor, the bulk editor, and every structural action's field writes.
/// Each track's fields become user-tier overrides; the albums they touch
/// regroup on the spot.
#[tauri::command]
pub async fn apply_track_edits(
    state: State<'_, AppState>,
    library_id: String,
    edits: Vec<TrackEdit>,
    label: Option<String>,
) -> Result<(), String> {
    crate::music_mb::ensure_not_matching(&state.app_db, &library_id).await?;
    let pool = &state.app_db;
    let mut list: Vec<LayerEdit> = Vec::new();
    let mut touched: HashSet<String> = HashSet::new();
    for e in &edits {
        let mut fields: Vec<(String, Option<String>)> = Vec::new();
        for (key, value) in &e.fields {
            let def = tag_fields::field(key).ok_or_else(|| format!("Unknown track field: {key}"))?;
            // release_key is the one structural field a person sets by hand:
            // the bulk editor's "Move to release" (another folder of the same
            // album). Ids and the identity token stay the app's.
            if !def.editable && key != "release_key" {
                return Err(format!("{} can't be edited directly", def.label));
            }
            touched.insert(def.label.to_string());
            if value.is_null() {
                fields.push((key.clone(), None));
            } else {
                fields.push((key.clone(), Some(tag_fields::stored_from_json(key, value)?)));
            }
        }
        list.push((e.track_id, fields));
    }
    let label = label.unwrap_or_else(|| {
        let mut names: Vec<String> = touched.into_iter().collect();
        names.sort();
        let n = edits.len();
        format!(
            "Edited {} on {n} {}",
            if names.is_empty() { "tags".to_string() } else { names.join(", ").to_lowercase() },
            if n == 1 { "track" } else { "tracks" }
        )
    });
    apply_layer_edits(pool, &library_id, &list, &label).await
}

/// Drop a track's user edits on every editable field: the track goes back to
/// what MusicBrainz or the file says. Structural fields (release membership,
/// identity) are left — those are undone through History or Separate.
#[tauri::command]
pub async fn reset_track_fields(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<(), String> {
    crate::music_mb::ensure_entity_not_matching(&state.app_db, track_id).await?;
    let pool = &state.app_db;
    let library_id = library_of(pool, track_id).await?;
    let fields: Vec<(String, Option<String>)> =
        tag_fields::editable_keys().map(|k| (k.to_string(), None)).collect();
    apply_layer_edits(pool, &library_id, &[(track_id, fields)], "Reset a track to its file tags").await
}

// ---------------------------------------------------------------------------
// Artist splits — a standing rule, applied on the spot
// ---------------------------------------------------------------------------

/// Record an artist-split directive: this artist's NAME is really several
/// artists ("JAY-Z & Kanye West" → [JAY-Z, Kanye West]). The directive is a
/// RULE the scanner applies on every scan — members[0] becomes the canonical
/// owner of the joint albums, the full list becomes their album-level
/// credit, and matching track credits split the same way — and it applies
/// right now to everything credited to the joint name. Returns the library.
#[tauri::command]
pub async fn split_artist(
    state: State<'_, AppState>,
    artist_id: i64,
    members: Vec<String>,
) -> Result<String, String> {
    crate::music_mb::ensure_entity_not_matching(&state.app_db, artist_id).await?;
    split_artist_inner(&state.app_db, artist_id, members).await
}

/// The split itself, without the command wrapper — also driven by an accepted
/// MusicBrainz split suggestion, which has a pool but no State.
pub(crate) async fn split_artist_inner(
    pool: &SqlitePool,
    artist_id: i64,
    members: Vec<String>,
) -> Result<String, String> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT me.library_id, a.title FROM artist a JOIN media_entry me ON me.id = a.id WHERE a.id = ?",
    )
    .bind(artist_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (library_id, source_name) = row.ok_or("Artist not found")?;

    let members: Vec<String> = members
        .into_iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect();
    if members.len() < 2 {
        return Err("A split needs at least two artists".to_string());
    }
    if members.iter().any(|m| m.eq_ignore_ascii_case(&source_name)) {
        return Err("A split member can't be the artist being split".to_string());
    }

    // The joint entry may answer to several names (title + tag-variant
    // aliases like "A/B" next to "A & B") — a directive per name, or the
    // variant-tagged albums resurrect the joint artist on rescan.
    let mut source_names: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT name FROM artist_names WHERE artist_id = ?",
    )
    .bind(artist_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(n,)| n)
    .collect();
    if !source_names.iter().any(|n| n.eq_ignore_ascii_case(&source_name)) {
        source_names.push(source_name.clone());
    }
    // Everything the joint page holds or is credited on regroups.
    let mut albums: Vec<i64> = sqlx::query_as::<_, (i64,)>(
        "SELECT DISTINCT ac.album_id FROM album_artist_credit ac WHERE ac.artist_id = ?
         UNION
         SELECT DISTINCT me.parent_id FROM track_credit tc
         JOIN media_entry me ON me.id = tc.track_id
         WHERE tc.artist_id = ? AND me.parent_id IS NOT NULL
         UNION
         SELECT me.id FROM media_entry me JOIN loose_album la ON la.album_id = me.id
         WHERE me.parent_id = ?",
    )
    .bind(artist_id)
    .bind(artist_id)
    .bind(artist_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(id,)| id)
    .collect();
    albums.sort();
    albums.dedup();

    let members_json = serde_json::to_string(&members).map_err(|e| e.to_string())?;
    let mut written: Vec<String> = Vec::new();
    let mut previous: Vec<(String, Option<String>)> = Vec::new();
    for name in &source_names {
        if members.iter().any(|m| m.eq_ignore_ascii_case(name)) {
            continue; // never map a member's own name onto the split
        }
        let old: Option<(String,)> = sqlx::query_as(
            "SELECT members FROM artist_split WHERE library_id = ? AND source_name = ?",
        )
        .bind(&library_id)
        .bind(name)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        previous.push((name.clone(), old.map(|(m,)| m)));
        sqlx::query(
            "INSERT INTO artist_split (library_id, source_name, members) VALUES (?, ?, ?)
             ON CONFLICT(library_id, source_name) DO UPDATE SET members = excluded.members",
        )
        .bind(&library_id)
        .bind(name)
        .bind(&members_json)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        written.push(name.clone());
    }
    let batch = crate::music_mb::next_batch(pool).await?;
    crate::music_mb::log_change(
        pool,
        &library_id,
        "artist_split",
        artist_id,
        &format!("Split \u{201c}{source_name}\u{201d} into {}", members.join(" · ")),
        &serde_json::json!({ "rules": previous.iter().map(|(n, m)| serde_json::json!({ "name": n, "members": m })).collect::<Vec<_>>() }),
        &serde_json::json!({ "names": written, "members": members }),
        batch,
    )
    .await?;
    rescan_albums(pool, &library_id, &albums).await?;
    Ok(library_id)
}

/// Undo of an "artist_split" History row: the rules go back to what they
/// were (removed, or the earlier member list) and the credits regroup.
pub(crate) async fn undo_artist_split(
    pool: &SqlitePool,
    library_id: &str,
    before: &serde_json::Value,
    after: &serde_json::Value,
) -> Result<(), String> {
    // The albums the split moved: everything credited to any member now.
    let members: Vec<String> = after["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m.as_str().map(|s| s.to_string()))
        .collect();
    let mut albums: Vec<i64> = Vec::new();
    for m in &members {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT ac.album_id FROM album_artist_credit ac
             JOIN media_entry me ON me.id = ac.album_id
             WHERE me.library_id = ? AND LOWER(ac.name) = LOWER(?)
             UNION
             SELECT DISTINCT me.parent_id FROM track_credit tc
             JOIN media_entry me ON me.id = tc.track_id
             WHERE me.library_id = ? AND LOWER(tc.name) = LOWER(?) AND me.parent_id IS NOT NULL",
        )
        .bind(library_id)
        .bind(m)
        .bind(library_id)
        .bind(m)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        for (id,) in rows {
            if !albums.contains(&id) {
                albums.push(id);
            }
        }
    }
    for rule in before["rules"].as_array().into_iter().flatten() {
        let Some(name) = rule["name"].as_str() else { continue };
        match rule["members"].as_str() {
            Some(m) => {
                sqlx::query(
                    "INSERT INTO artist_split (library_id, source_name, members) VALUES (?, ?, ?)
                     ON CONFLICT(library_id, source_name) DO UPDATE SET members = excluded.members",
                )
                .bind(library_id)
                .bind(name)
                .bind(m)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
            None => {
                sqlx::query("DELETE FROM artist_split WHERE library_id = ? AND source_name = ?")
                    .bind(library_id)
                    .bind(name)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    rescan_albums(pool, library_id, &albums).await
}

/// Existing-artist suggestions scoped by an ARTIST's library (the split
/// dialog's member rows). Excludes the artist being split.
#[tauri::command]
pub async fn search_artist_options(
    state: State<'_, AppState>,
    artist_id: i64,
    query: String,
) -> Result<Vec<String>, String> {
    let pool = &state.app_db;
    let library_id: Option<(String,)> =
        sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
            .bind(artist_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let (library_id,) = library_id.ok_or("Artist not found")?;
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let substr = format!("%{escaped}%");
    let prefix = format!("{escaped}%");
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT a.title FROM artist a \
         JOIN media_entry me ON me.id = a.id \
         WHERE me.library_id = ?1 AND a.id != ?2 AND a.title LIKE ?3 ESCAPE '\\' \
         ORDER BY CASE WHEN a.title LIKE ?4 ESCAPE '\\' THEN 0 ELSE 1 END, \
                  a.title COLLATE NOCASE \
         LIMIT 8",
    )
    .bind(&library_id)
    .bind(artist_id)
    .bind(&substr)
    .bind(&prefix)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(t,)| t).collect())
}

/// One pickable artist, with enough to draw a profile row.
#[derive(Debug, Serialize)]
pub struct ArtistChoice {
    pub id: i64,
    pub name: String,
    /// Cached image path, resolved the same way the artist page picks one:
    /// the chosen cover if it's still there, else the first available.
    pub image: Option<String>,
    pub release_count: i64,
}

/// Artist picker options for the split dialog — richer than the plain-name
/// suggestion lists, because the picker draws each option as a profile.
#[tauri::command]
pub async fn search_artist_choices(
    state: State<'_, AppState>,
    artist_id: i64,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<ArtistChoice>, String> {
    let pool = &state.app_db;
    let (library_id,): (String,) =
        sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
            .bind(artist_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Artist not found")?;
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let substr = format!("%{escaped}%");
    let prefix = format!("{escaped}%");
    let rows: Vec<(i64, String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT a.id, a.title, a.selected_cover, a.folder_path,
                (SELECT COUNT(*) FROM album_artist_credit c WHERE c.artist_id = a.id)
         FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?1 AND a.id != ?2 AND a.title LIKE ?3 ESCAPE '\\'
         ORDER BY CASE WHEN a.title LIKE ?4 ESCAPE '\\' THEN 0 ELSE 1 END,
                  a.title COLLATE NOCASE
         LIMIT ?5",
    )
    .bind(&library_id)
    .bind(artist_id)
    .bind(&substr)
    .bind(&prefix)
    .bind(limit.unwrap_or(8).clamp(1, 25))
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(rows.len());
    for (id, name, selected, folder, release_count) in rows {
        let mut covers = covers_for_folder(pool, &library_id, &folder).await?;
        covers.extend(
            covers_for_folder(pool, &library_id, &crate::music_art::artist_fetch_rel(id)).await?,
        );
        let image = selected
            .filter(|s| covers.iter().any(|c| c == s))
            .or_else(|| covers.into_iter().next());
        out.push(ArtistChoice { id, name, image, release_count });
    }
    Ok(out)
}

/// Resolve exact names to existing artists, in the order given.
///
/// The split dialog guesses member names by cutting the joint name apart, and
/// those guesses are usually real artists already in the library — offering to
/// "create" a 2 Chainz that already exists would spawn a duplicate. `None` for
/// a name means nothing in this library answers to it.
#[tauri::command]
pub async fn resolve_artist_choices(
    state: State<'_, AppState>,
    artist_id: i64,
    names: Vec<String>,
) -> Result<Vec<Option<ArtistChoice>>, String> {
    let pool = &state.app_db;
    let (library_id,): (String,) =
        sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
            .bind(artist_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Artist not found")?;

    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            out.push(None);
            continue;
        }
        // A credit the CONTEXT already links comes first: the album edit
        // dialog prefills from the album's own credit rows, and those carry
        // the artist id a pass or an apply stamped — the answer is that
        // artist, whatever its page is called. MusicBrainz's "credited as"
        // names make the two differ routinely (Highwayman, 1985: the artist
        // The Highwaymen credited as "Waylon Jennings, Willie Nelson, Johnny
        // Cash & Kris Kristofferson"), and re-resolving that string by title
        // found nothing and offered to create it (2026-09-27). An artist
        // context (the split dialog) has no credit rows under its id.
        let mut row: Option<(i64, String, Option<String>, String, i64)> = sqlx::query_as(
            "SELECT a.id, a.title, a.selected_cover, a.folder_path,
                    (SELECT COUNT(*) FROM album_artist_credit c2 WHERE c2.artist_id = a.id)
             FROM album_artist_credit c
             JOIN artist a ON a.id = c.artist_id
             WHERE c.album_id = ?1 AND c.name = ?2 COLLATE NOCASE
             LIMIT 1",
        )
        .bind(artist_id)
        .bind(trimmed)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        // Then a name the library records as an alias of exactly ONE artist
        // (merges and credited-as names both leave one); two claimants is
        // an ambiguity, not an answer.
        if row.is_none() {
            let aliased: Vec<(i64, String, Option<String>, String, i64)> = sqlx::query_as(
                "SELECT a.id, a.title, a.selected_cover, a.folder_path,
                        (SELECT COUNT(*) FROM album_artist_credit c WHERE c.artist_id = a.id)
                 FROM artist_alias aa
                 JOIN artist a ON a.id = aa.artist_id
                 JOIN media_entry me ON me.id = a.id
                 WHERE me.library_id = ?1 AND a.id != ?2 AND aa.name = ?3 COLLATE NOCASE
                 LIMIT 2",
            )
            .bind(&library_id)
            .bind(artist_id)
            .bind(trimmed)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
            if aliased.len() == 1 {
                row = aliased.into_iter().next();
            }
        }
        // Exact title next; else a punctuation-blind key match — the same
        // identity rule the lookalike/cluster machinery uses, so a tag's
        // straight-apostrophe "O'Donnell" finds the MB-canonical curly
        // "O’Donnell" page instead of offering to create a duplicate. Key
        // hits count only when UNIQUE: a split member is a specific artist,
        // and an ambiguous fuzzy hit would silently attach albums to the
        // wrong page.
        if row.is_none() {
            row = sqlx::query_as(
                "SELECT a.id, a.title, a.selected_cover, a.folder_path,
                        (SELECT COUNT(*) FROM album_artist_credit c WHERE c.artist_id = a.id)
                 FROM artist a
                 JOIN media_entry me ON me.id = a.id
                 WHERE me.library_id = ?1 AND a.id != ?2 AND a.title = ?3 COLLATE NOCASE
                 LIMIT 1",
            )
            .bind(&library_id)
            .bind(artist_id)
            .bind(trimmed)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
        if row.is_none() {
            let key = crate::music::credit_name_key(trimmed);
            if !key.is_empty() {
                let all: Vec<(i64, String, Option<String>, String, i64)> = sqlx::query_as(
                    "SELECT a.id, a.title, a.selected_cover, a.folder_path,
                            (SELECT COUNT(*) FROM album_artist_credit c WHERE c.artist_id = a.id)
                     FROM artist a
                     JOIN media_entry me ON me.id = a.id
                     WHERE me.library_id = ?1 AND a.id != ?2",
                )
                .bind(&library_id)
                .bind(artist_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
                let mut hits = all
                    .into_iter()
                    .filter(|(_, title, _, _, _)| crate::music::credit_name_key(title) == key);
                let first = hits.next();
                if hits.next().is_none() {
                    row = first;
                }
            }
        }

        match row {
            Some((id, title, selected, folder, release_count)) => {
                let mut covers = covers_for_folder(pool, &library_id, &folder).await?;
                covers.extend(
                    covers_for_folder(pool, &library_id, &crate::music_art::artist_fetch_rel(id))
                        .await?,
                );
                let image = selected
                    .filter(|s| covers.iter().any(|c| c == s))
                    .or_else(|| covers.into_iter().next());
                out.push(Some(ArtistChoice { id, name: title, image, release_count }));
            }
            None => out.push(None),
        }
    }
    Ok(out)
}

/// Artist picker options scoped by LIBRARY — for surfaces acting on a bare
/// credit name, where there's no artist entity to anchor the search on (the
/// unlinked-credits list). Same rows as search_artist_choices.
#[tauri::command]
pub async fn search_credit_link_choices(
    state: State<'_, AppState>,
    library_id: String,
    query: String,
    limit: Option<i64>,
    exclude_artist_id: Option<i64>,
) -> Result<Vec<ArtistChoice>, String> {
    let pool = &state.app_db;
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let substr = format!("%{escaped}%");
    let prefix = format!("{escaped}%");
    let rows: Vec<(i64, String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT a.id, a.title, a.selected_cover, a.folder_path,
                (SELECT COUNT(*) FROM album_artist_credit c WHERE c.artist_id = a.id)
         FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?1 AND a.id != ?2 AND a.title LIKE ?3 ESCAPE '\\'
         ORDER BY CASE WHEN a.title LIKE ?4 ESCAPE '\\' THEN 0 ELSE 1 END,
                  a.title COLLATE NOCASE
         LIMIT ?5",
    )
    .bind(&library_id)
    .bind(exclude_artist_id.unwrap_or(-1))
    .bind(&substr)
    .bind(&prefix)
    .bind(limit.unwrap_or(8).clamp(1, 25))
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(rows.len());
    for (id, name, selected, folder, release_count) in rows {
        let mut covers = covers_for_folder(pool, &library_id, &folder).await?;
        covers.extend(
            covers_for_folder(pool, &library_id, &crate::music_art::artist_fetch_rel(id)).await?,
        );
        let image = selected
            .filter(|s| covers.iter().any(|c| c == s))
            .or_else(|| covers.into_iter().next());
        out.push(ArtistChoice { id, name, image, release_count });
    }
    Ok(out)
}

/// "This credit name is really that artist" — the manual identity decision
/// (\u{201c}God\u{201d} on Yeezus → Kanye West). Implemented as a merge, because that IS
/// the shipped machinery for exactly this: the name (and its auto-created
/// page, when the scan spawned one — albums included) folds into the chosen
/// artist, the name becomes a redirect, every credit row stamped with it
/// re-points, the action lands in the change log undoable, and rescans keep
/// honouring it because artist grouping resolves through redirects.
#[tauri::command]
pub async fn link_credit_name(
    state: State<'_, AppState>,
    library_id: String,
    name: String,
    target_artist_id: i64,
) -> Result<(), String> {
    crate::music_mb::ensure_not_matching(&state.app_db, &library_id).await?;
    let pool = &state.app_db;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("No credit name given".to_string());
    }
    let target: Option<(String,)> = sqlx::query_as(
        "SELECT a.title FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE a.id = ? AND me.library_id = ?",
    )
    .bind(target_artist_id)
    .bind(&library_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (target_title,) = target.ok_or("Target artist not found")?;

    // The name's own page, if the scan created one — merged in full.
    let source: Option<(i64,)> = sqlx::query_as(
        "SELECT an.artist_id FROM artist_names an
         JOIN media_entry me ON me.id = an.artist_id
         WHERE me.library_id = ?1 AND LOWER(an.name) = LOWER(?2) LIMIT 1",
    )
    .bind(&library_id)
    .bind(&name)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let source_id = source.map(|(id,)| id);
    if source_id == Some(target_artist_id) {
        return Err(format!("\u{201c}{name}\u{201d} already resolves to {target_title}"));
    }
    crate::music_mb::merge_artists(pool, &library_id, target_artist_id, &target_title, source_id, &name, "user")
        .await?;
    crate::music_mb::enqueue_pass_recheck(pool, &library_id, target_artist_id, &target_title, &name, true)
        .await
}

// ---------------------------------------------------------------------------
// Release preferences (folder-keyed, instant)
// ---------------------------------------------------------------------------

/// Rename one release's label. Stored as a folder-keyed pref (release rows
/// are rebuilt every rescan) and applied live — an in-app preference, instant
/// like the rest of them.
#[tauri::command]
pub async fn set_release_label(
    state: State<'_, AppState>,
    release_id: i64,
    label: String,
) -> Result<(), String> {
    crate::music_mb::ensure_release_not_matching(&state.app_db, release_id).await?;
    let pool = &state.app_db;
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("Label cannot be empty".to_string());
    }
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT album_id, folder_path FROM album_release WHERE id = ?")
            .bind(release_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some((album_id, folder)) = row else {
        return Err("Release not found".to_string());
    };
    sqlx::query(
        "INSERT INTO album_release_pref (album_id, folder_path, label, is_default)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(album_id, folder_path) DO UPDATE SET label = excluded.label",
    )
    .bind(album_id)
    .bind(&folder)
    .bind(&label)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE album_release SET label = ? WHERE id = ?")
        .bind(&label)
        .bind(release_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The user's word on a release's CD pre-emphasis: Some(true) = play through
/// the de-emphasis filter, Some(false) = play as is, None = go by the cue
/// sheet. Folder-keyed pref like labels — survives the release-row rebuild.
#[tauri::command]
pub async fn set_release_pre_emphasis(
    state: State<'_, AppState>,
    release_id: i64,
    value: Option<bool>,
) -> Result<(), String> {
    let pool = &state.app_db;
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT album_id, folder_path FROM album_release WHERE id = ?")
            .bind(release_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some((album_id, folder)) = row else {
        return Err("Release not found".to_string());
    };
    sqlx::query(
        "INSERT INTO album_release_pref (album_id, folder_path, pre_emphasis)
         VALUES (?, ?, ?)
         ON CONFLICT(album_id, folder_path) DO UPDATE SET pre_emphasis = excluded.pre_emphasis",
    )
    .bind(album_id)
    .bind(&folder)
    .bind(value.map(|v| v as i64))
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Name (or clear the name of) one disc of a release — "Disc 2 — Mars". The
/// disc_subtitle field on every track of that disc: a name sets the user
/// tier, empty drops it (back to the pressing's medium title or the tag).
#[tauri::command]
pub async fn set_disc_title(
    state: State<'_, AppState>,
    release_id: i64,
    disc_no: i64,
    title: String,
) -> Result<(), String> {
    crate::music_mb::ensure_release_not_matching(&state.app_db, release_id).await?;
    let pool = &state.app_db;
    let row: Option<(i64,)> = sqlx::query_as("SELECT album_id FROM album_release WHERE id = ?")
        .bind(release_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let Some((album_id,)) = row else {
        return Err("Release not found".to_string());
    };
    let library_id = library_of(pool, album_id).await?;
    let tracks: Vec<(i64,)> = sqlx::query_as(
        "SELECT t.id FROM track t JOIN track_release tr ON tr.track_id = t.id
         WHERE tr.release_id = ? AND COALESCE(t.disc_number, 1) = ?",
    )
    .bind(release_id)
    .bind(disc_no)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let ids: Vec<i64> = tracks.into_iter().map(|(id,)| id).collect();
    let title = title.trim().to_string();
    let value = if title.is_empty() { None } else { Some(title.clone()) };
    let edits = same_on_all(&ids, vec![("disc_subtitle".to_string(), value)]);
    let label = if title.is_empty() {
        format!("Cleared the name of disc {disc_no}")
    } else {
        format!("Named disc {disc_no} \u{201c}{title}\u{201d}")
    };
    apply_layer_edits(pool, &library_id, &edits, &label).await
}

/// Choose which release is the album's default (the one the page opens on and
/// Play plays). Folder-keyed pref + live flip; the scanner honours it too.
#[tauri::command]
pub async fn set_default_release(
    state: State<'_, AppState>,
    release_id: i64,
) -> Result<(), String> {
    crate::music_mb::ensure_release_not_matching(&state.app_db, release_id).await?;
    let pool = &state.app_db;
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT album_id, folder_path FROM album_release WHERE id = ?")
            .bind(release_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some((album_id, folder)) = row else {
        return Err("Release not found".to_string());
    };
    set_default_release_pref(pool, album_id, &folder).await?;
    sqlx::query("UPDATE album_release SET is_default = (id = ?) WHERE album_id = ?")
        .bind(release_id)
        .bind(album_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    // The album card's cover follows the default release: the new default's
    // own pick, or NULL so the grid falls back to the pool's first cover.
    sqlx::query(
        "UPDATE album SET selected_cover = (
            SELECT p.cover FROM album_release_pref p
            WHERE p.album_id = ? AND p.folder_path = ? COLLATE NOCASE
              AND p.cover IS NOT NULL AND p.cover <> '')
         WHERE id = ?",
    )
    .bind(album_id)
    .bind(&folder)
    .bind(album_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn set_default_release_pref(pool: &SqlitePool, album_id: i64, folder: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO album_release_pref (album_id, folder_path, label, is_default)
         VALUES (?, ?, NULL, 1)
         ON CONFLICT(album_id, folder_path) DO UPDATE SET is_default = 1",
    )
    .bind(album_id)
    .bind(folder)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE album_release_pref SET is_default = 0 WHERE album_id = ? AND folder_path != ?")
        .bind(album_id)
        .bind(folder)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The user's cover pick for ONE release of a multi-release album (the album
/// page's picker while a release is active). Folder-keyed — survives the
/// release-row rebuild. Picking on the DEFAULT release also moves the album
/// card, which by rule shows the default release's cover.
#[tauri::command]
pub async fn set_release_cover(
    state: State<'_, AppState>,
    release_id: i64,
    cover: Option<String>,
) -> Result<(), String> {
    crate::music_mb::ensure_release_not_matching(&state.app_db, release_id).await?;
    write_release_cover(&state.app_db, release_id, cover).await
}

/// The pick itself, for callers inside the app (add_cover pins the cover
/// already showing before a new file can take its place).
pub(crate) async fn write_release_cover(
    pool: &SqlitePool,
    release_id: i64,
    cover: Option<String>,
) -> Result<(), String> {
    let row: Option<(i64, String, i64)> =
        sqlx::query_as("SELECT album_id, folder_path, is_default FROM album_release WHERE id = ?")
            .bind(release_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some((album_id, folder, is_default)) = row else {
        return Err("Release not found".to_string());
    };
    sqlx::query(
        "INSERT INTO album_release_pref (album_id, folder_path, cover)
         VALUES (?, ?, ?)
         ON CONFLICT(album_id, folder_path) DO UPDATE SET cover = excluded.cover",
    )
    .bind(album_id)
    .bind(&folder)
    .bind(&cover)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    if is_default != 0 {
        sqlx::query("UPDATE album SET selected_cover = ? WHERE id = ?")
            .bind(&cover)
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn covers_for_folder(
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

/// Existing-artist suggestions for the track editor's artist rows — canonical
/// artist titles in the track's own library, prefix matches first. Picking one
/// means the credit resolves to that artist page instead of typo-spawning a twin.
#[tauri::command]
pub async fn search_track_artist_options(
    state: State<'_, AppState>,
    track_id: i64,
    query: String,
) -> Result<Vec<String>, String> {
    let pool = &state.app_db;
    let (library_id, _rel) = track_context(pool, track_id).await?;
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let substr = format!("%{escaped}%");
    let prefix = format!("{escaped}%");
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT a.title FROM artist a \
         JOIN media_entry me ON me.id = a.id \
         WHERE me.library_id = ?1 AND a.title LIKE ?2 ESCAPE '\\' \
         ORDER BY CASE WHEN a.title LIKE ?3 ESCAPE '\\' THEN 0 ELSE 1 END, \
                  a.title COLLATE NOCASE \
         LIMIT 8",
    )
    .bind(&library_id)
    .bind(&substr)
    .bind(&prefix)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(t,)| t).collect())
}

/// Album titles in a library, for the bulk editor's "move to album" picker.
#[derive(Serialize)]
pub struct AlbumOption {
    pub id: i64,
    pub title: String,
    pub artist: Option<String>,
    /// The album's effective tag identity: what a track must carry to land
    /// in it (its default release's album tag and album artists).
    pub album_tag: String,
    pub album_artists: Vec<String>,
}

#[tauri::command]
pub async fn search_album_options(
    state: State<'_, AppState>,
    library_id: String,
    query: String,
) -> Result<Vec<AlbumOption>, String> {
    let pool = &state.app_db;
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let substr = format!("%{escaped}%");
    let rows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT al.id, al.title,
                (SELECT GROUP_CONCAT(name, ' · ') FROM (
                     SELECT ac.name FROM album_artist_credit ac
                     WHERE ac.album_id = al.id ORDER BY ac.position)),
                (SELECT ar.title FROM album_release ar WHERE ar.album_id = al.id AND ar.is_default = 1)
         FROM album al JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ?1 AND al.title LIKE ?2 ESCAPE '\\'
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
         ORDER BY al.title COLLATE NOCASE LIMIT 12",
    )
    .bind(&library_id)
    .bind(&substr)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, title, artist, release_title) in rows {
        let album_artists: Vec<String> = sqlx::query_as::<_, (String,)>(
            "SELECT name FROM album_artist_credit WHERE album_id = ? ORDER BY position",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(n,)| n)
        .collect();
        out.push(AlbumOption {
            id,
            album_tag: release_title.filter(|t| !t.is_empty()).unwrap_or_else(|| title.clone()),
            title,
            artist,
            album_artists,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Per-tier view (the Sources page): every album and loose track, grouped by
// artist, with what each tier holds — a straight read of the tiered store.
// ---------------------------------------------------------------------------

#[derive(Serialize, Default, Clone)]
pub struct TierValue {
    pub tag: Option<String>,
    pub mb: Option<String>,
    pub user: Option<String>,
}

/// One release (version) of an album on the view: its own tag title and
/// date, the release id the files carry vs. the pressing pinned, and the
/// user's label rename.
#[derive(Serialize)]
pub struct TierRelease {
    pub id: i64,
    /// Effective label ("1", "2", or the user's rename).
    pub label: Option<String>,
    /// Folder leaf — the differentiator when labels collide.
    pub folder: String,
    pub is_default: bool,
    /// The user declared this release has no MusicBrainz counterpart.
    pub declared_none: bool,
    pub fields: HashMap<String, TierValue>,
    /// The release's tracks in disc/track order — every registry field
    /// across the tiers.
    pub tracks: Vec<TierTrack>,
}

#[derive(Serialize)]
pub struct TierTrack {
    pub id: i64,
    pub title: String,
    pub disc: i64,
    pub number: Option<i64>,
    /// Matched to a MusicBrainz recording.
    pub matched: bool,
    pub fields: HashMap<String, TierValue>,
}

#[derive(Serialize)]
pub struct TierRow {
    pub id: i64,
    /// "album" | "track"
    pub kind: String,
    /// The resolved title — what the library shows right now.
    pub title: String,
    /// Albums: matched to a release group. Tracks: matched to a recording.
    pub matched: bool,
    /// Albums: releases holding a pinned pressing.
    pub pinned_releases: i64,
    /// field → what each tier holds. JSON arrays for credits and genres.
    pub fields: HashMap<String, TierValue>,
    /// Albums: every release, default first. Tracks: empty.
    pub releases: Vec<TierRelease>,
    /// Albums: the album tags its files carry that differ from the album's
    /// title — the folders a combine or a retag brought under this card.
    pub combined_from: Vec<String>,
}

/// An alias (a spelling that resolves to this page) and who wrote it:
/// 'mb' (a match adopted the canonical name) or 'user' (rename/merge/link).
#[derive(Serialize)]
pub struct TierAlias {
    pub name: String,
    pub source: String,
}

#[derive(Serialize)]
pub struct NamedArtist {
    pub artist_id: i64,
    pub title: String,
}

/// An artist split rule this page is party to: `source` = the joint name
/// being split, `members` = who it splits into, `role` = this page's side
/// of it ("source" or "member").
#[derive(Serialize)]
pub struct TierSplit {
    pub source: String,
    pub members: Vec<String>,
    pub role: String,
}

/// Everything the library knows about WHO an artist is, beyond the name:
/// the identity facts the merge/link/persona/split flows write. All of it
/// is the user's or MusicBrainz's, never the tags' — the Sources view's
/// "Edits"/"MusicBrainz" columns.
#[derive(Serialize, Default)]
pub struct ArtistIdentity {
    pub aliases: Vec<TierAlias>,
    pub persona_of: Option<NamedArtist>,
    pub personas: Vec<NamedArtist>,
    pub splits: Vec<TierSplit>,
    /// Names the user declined to merge into this page (a standing "no").
    pub kept_separate: Vec<String>,
}

impl ArtistIdentity {
    fn is_empty(&self) -> bool {
        self.aliases.is_empty()
            && self.persona_of.is_none()
            && self.personas.is_empty()
            && self.splits.is_empty()
            && self.kept_separate.is_empty()
    }
}

#[derive(Serialize)]
pub struct TierGroup {
    /// None = the leading group: loose tracks (and credit-less albums)
    /// that belong to no artist page.
    pub artist_id: Option<i64>,
    pub artist_title: Option<String>,
    /// The artist's own name across the tiers ("title" only).
    pub artist_fields: HashMap<String, TierValue>,
    pub identity: ArtistIdentity,
    pub albums: Vec<TierRow>,
    pub loose_tracks: Vec<TierRow>,
}

#[derive(Serialize)]
pub struct TierMatrix {
    /// Online metadata is on for this library — the MusicBrainz column exists.
    pub mb_enabled: bool,
    pub groups: Vec<TierGroup>,
}

/// Album-level fields the view shows (the tracks show the whole registry).
const ALBUM_TIER_FIELDS: &[&str] = &["title", "release_date", "album_type", "genres", "artist_credits"];

#[tauri::command]
pub async fn get_tier_matrix(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<TierMatrix, String> {
    let pool = &state.app_db;
    let mb_enabled = crate::commands::library_online_metadata(pool, &library_id).await?;

    // Every stored value in the library, bucketed per entity. The MB id
    // fields ride along as the "matched" flags.
    let rows: Vec<(i64, String, String, Option<String>)> = sqlx::query_as(
        "SELECT f.entity_id, f.field, f.tier, f.value FROM field_override f
         JOIN media_entry me ON me.id = f.entity_id
         WHERE me.library_id = ? AND f.tier IN ('tag', 'mb', 'user')",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let track_keys: HashSet<&str> = tag_fields::keys().collect();
    let mut by_entity: HashMap<i64, HashMap<String, TierValue>> = HashMap::new();
    let mut group_matched: HashSet<i64> = HashSet::new();
    let mut recording_matched: HashSet<i64> = HashSet::new();
    for (id, field, tier, value) in rows {
        let present = value.as_deref().is_some_and(|v| !v.is_empty());
        if field == crate::music_mb::MB_RELEASE_GROUP && tier != "tag" {
            if present {
                group_matched.insert(id);
            }
            continue;
        }
        if field == crate::music_mb::MB_RECORDING && tier != "tag" {
            if present {
                recording_matched.insert(id);
            }
        }
        if !track_keys.contains(field.as_str()) && !ALBUM_TIER_FIELDS.contains(&field.as_str()) {
            continue;
        }
        let slot = by_entity.entry(id).or_default().entry(field).or_default();
        let v = value.unwrap_or_default();
        match tier.as_str() {
            "tag" => slot.tag = Some(v),
            "mb" => slot.mb = Some(v),
            "user" => slot.user = Some(v),
            _ => {}
        }
    }

    let pins: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT rm.album_id, COUNT(*) FROM release_match rm
         JOIN media_entry me ON me.id = rm.album_id
         WHERE me.library_id = ? AND rm.mb_release_id <> ''
         GROUP BY rm.album_id",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let pinned: HashMap<i64, i64> = pins.into_iter().collect();

    // Every album track, bucketed per release in disc/track order, carrying
    // its own tiers.
    let track_rows: Vec<(i64, i64, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT tr.release_id, t.id, t.title, COALESCE(t.disc_number, 1), t.track_number
         FROM track t
         JOIN track_release tr ON tr.track_id = t.id
         JOIN album_release ar ON ar.id = tr.release_id
         JOIN media_entry me ON me.id = t.id
         WHERE me.library_id = ?
           -- Real albums only: loose containers list their tracks as loose
           -- rows below (their tiers must stay in by_entity for that pass).
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = ar.album_id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = ar.album_id)
         ORDER BY tr.release_id, COALESCE(t.disc_number, 1), COALESCE(t.track_number, 999999),
                  t.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut tracks_by_release: HashMap<i64, Vec<TierTrack>> = HashMap::new();
    // The album tags the files carry, per release — for combined_from.
    let mut file_albums_by_release: HashMap<i64, Vec<String>> = HashMap::new();
    for (release_id, id, title, disc, number) in track_rows {
        let fields = by_entity.remove(&id).unwrap_or_default();
        if let Some(tag_album) = fields.get("album").and_then(|v| v.tag.clone()) {
            let list = file_albums_by_release.entry(release_id).or_default();
            if !tag_album.is_empty() && !list.iter().any(|a| a.eq_ignore_ascii_case(&tag_album)) {
                list.push(tag_album);
            }
        }
        tracks_by_release.entry(release_id).or_default().push(TierTrack {
            id,
            title,
            disc,
            number,
            matched: recording_matched.contains(&id),
            fields,
        });
    }

    // Every release in the library with its pin and label pref, bucketed
    // per album. Tag tier = what the scanner stamped on the release row;
    // MB tier = the pinned pressing; user tier = the label rename.
    type ReleaseRow = (
        i64,
        i64,
        Option<String>,
        String,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let release_rows: Vec<ReleaseRow> = sqlx::query_as(
        "SELECT ar.album_id, ar.id, ar.label, ar.folder_path, ar.is_default, ar.release_date,
                ar.title, ar.mb_release_id, rm.mb_release_id, rm.tier, rm.title, p.label
         FROM album_release ar
         JOIN media_entry me ON me.id = ar.album_id
         LEFT JOIN release_match rm ON rm.album_id = ar.album_id AND rm.folder_path = ar.folder_path
         LEFT JOIN album_release_pref p ON p.album_id = ar.album_id AND p.folder_path = ar.folder_path
         WHERE me.library_id = ?
         ORDER BY ar.is_default DESC, ar.label",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut releases_by_album: HashMap<i64, Vec<TierRelease>> = HashMap::new();
    let mut file_albums_by_album: HashMap<i64, Vec<String>> = HashMap::new();
    for (album_id, id, label, folder, is_default, date, tag_title, tag_mbid, pin_mbid, pin_tier, pin_title, pref_label) in
        release_rows
    {
        let mut fields: HashMap<String, TierValue> = HashMap::new();
        let non_empty = |s: Option<String>| s.filter(|v| !v.is_empty());
        let declared_none = pin_tier.as_deref() == Some(crate::music_mb::TIER_NONE);
        fields.insert(
            "title".into(),
            TierValue { tag: non_empty(tag_title), mb: non_empty(pin_title), user: None },
        );
        fields.insert(
            "release_date".into(),
            TierValue { tag: non_empty(date), mb: None, user: None },
        );
        fields.insert(
            "mb_release_id".into(),
            TierValue {
                tag: non_empty(tag_mbid),
                mb: if declared_none { None } else { non_empty(pin_mbid) },
                user: None,
            },
        );
        fields.insert(
            "label".into(),
            TierValue { tag: None, mb: None, user: non_empty(pref_label) },
        );
        fields.retain(|_, v| v.tag.is_some() || v.mb.is_some() || v.user.is_some());
        let leaf = folder.rsplit(['\\', '/']).next().unwrap_or(&folder).to_string();
        if let Some(list) = file_albums_by_release.remove(&id) {
            file_albums_by_album.entry(album_id).or_default().extend(list);
        }
        releases_by_album.entry(album_id).or_default().push(TierRelease {
            tracks: tracks_by_release.remove(&id).unwrap_or_default(),
            id,
            label,
            folder: leaf,
            is_default: is_default != 0,
            declared_none,
            fields,
        });
    }

    let artists: Vec<(i64, String)> = sqlx::query_as(
        "SELECT a.id, a.title FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ? ORDER BY a.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let index: HashMap<i64, usize> =
        artists.iter().enumerate().map(|(i, (id, _))| (*id, i)).collect();
    let mut groups: Vec<TierGroup> = artists
        .iter()
        .map(|(id, title)| TierGroup {
            artist_id: Some(*id),
            artist_title: Some(title.clone()),
            artist_fields: by_entity.remove(id).unwrap_or_default(),
            identity: ArtistIdentity::default(),
            albums: Vec::new(),
            loose_tracks: Vec::new(),
        })
        .collect();
    let mut orphan = TierGroup {
        artist_id: None,
        artist_title: None,
        artist_fields: HashMap::new(),
        identity: ArtistIdentity::default(),
        albums: Vec::new(),
        loose_tracks: Vec::new(),
    };

    // ── Identity facts per artist ──────────────────────────────────────
    // Aliases: every spelling that resolves here, with who wrote it.
    let alias_rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT al.artist_id, al.name, al.source FROM artist_alias al
         JOIN media_entry me ON me.id = al.artist_id
         WHERE me.library_id = ? ORDER BY al.name COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (artist_id, name, source) in alias_rows {
        if let Some(&i) = index.get(&artist_id) {
            groups[i].identity.aliases.push(TierAlias { name, source });
        }
    }
    // Personas, seen from both ends.
    let persona_rows: Vec<(i64, i64, String, String)> = sqlx::query_as(
        "SELECT p.persona_id, p.parent_id, pa.title, pr.title FROM artist_persona p
         JOIN artist pa ON pa.id = p.persona_id
         JOIN artist pr ON pr.id = p.parent_id
         JOIN media_entry me ON me.id = p.persona_id
         WHERE me.library_id = ?",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (persona_id, parent_id, persona_title, parent_title) in persona_rows {
        if let Some(&i) = index.get(&persona_id) {
            groups[i].identity.persona_of = Some(NamedArtist { artist_id: parent_id, title: parent_title });
        }
        if let Some(&i) = index.get(&parent_id) {
            groups[i].identity.personas.push(NamedArtist { artist_id: persona_id, title: persona_title });
        }
    }
    // Splits: the rule is keyed by the joint name; it shows under the joint
    // page (if it still exists) and under each member page.
    let split_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT source_name, members FROM artist_split WHERE library_id = ?")
            .bind(&library_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    if !split_rows.is_empty() {
        // name (lowercased) → artist id, over titles and aliases.
        let name_rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT an.artist_id, an.name FROM artist_names an
             JOIN media_entry me ON me.id = an.artist_id WHERE me.library_id = ?",
        )
        .bind(&library_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        let by_name: HashMap<String, i64> =
            name_rows.into_iter().map(|(id, n)| (n.to_lowercase(), id)).collect();
        for (source, members_json) in split_rows {
            let members: Vec<String> = serde_json::from_str(&members_json).unwrap_or_default();
            let mut seen: HashSet<usize> = HashSet::new();
            if let Some(&i) = by_name.get(&source.to_lowercase()).and_then(|id| index.get(id)) {
                seen.insert(i);
                groups[i].identity.splits.push(TierSplit {
                    source: source.clone(),
                    members: members.clone(),
                    role: "source".into(),
                });
            }
            for m in &members {
                if let Some(&i) = by_name.get(&m.to_lowercase()).and_then(|id| index.get(id)) {
                    if seen.insert(i) {
                        groups[i].identity.splits.push(TierSplit {
                            source: source.clone(),
                            members: members.clone(),
                            role: "member".into(),
                        });
                    }
                }
            }
        }
    }
    // Kept separate: rejected merge suggestions that name their keeper.
    let rejected: Vec<(String,)> = sqlx::query_as(
        "SELECT payload FROM mb_suggestion
         WHERE library_id = ? AND kind = 'artist_merge' AND status = 'rejected'",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (payload,) in rejected {
        let Ok(p) = serde_json::from_str::<serde_json::Value>(&payload) else { continue };
        let (Some(keep_id), Some(other)) = (p["keep_id"].as_i64(), p["other_name"].as_str()) else {
            continue;
        };
        if let Some(&i) = index.get(&keep_id) {
            groups[i].identity.kept_separate.push(other.to_string());
        }
    }

    // Real albums (not loose containers, not sound collections), filed under
    // their first credit's artist — the same rule the artist pages use.
    let albums: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT al.id, al.title,
                (SELECT ac.artist_id FROM album_artist_credit ac
                 WHERE ac.album_id = al.id ORDER BY ac.position LIMIT 1)
         FROM album al JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
         ORDER BY al.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for (id, title, artist_id) in albums {
        let fields = by_entity.remove(&id).unwrap_or_default();
        let combined_from: Vec<String> = file_albums_by_album
            .remove(&id)
            .unwrap_or_default()
            .into_iter()
            .filter(|a| !a.eq_ignore_ascii_case(&title))
            .collect();
        let row = TierRow {
            id,
            kind: "album".to_string(),
            title,
            matched: group_matched.contains(&id),
            pinned_releases: *pinned.get(&id).unwrap_or(&0),
            fields,
            releases: releases_by_album.remove(&id).unwrap_or_default(),
            combined_from,
        };
        match artist_id.and_then(|a| index.get(&a)) {
            Some(&i) => groups[i].albums.push(row),
            None => orphan.albums.push(row),
        }
    }

    // Loose tracks: a loose container's parent is its artist (NULL at the
    // library root). Sound containers are the sounds domain's, not here.
    let loose: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT t.id, t.title, cme.parent_id
         FROM track t JOIN media_entry me ON me.id = t.id
         JOIN loose_album la ON la.album_id = me.parent_id
         JOIN media_entry cme ON cme.id = la.album_id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = la.album_id)
         ORDER BY t.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (id, title, artist_id) in loose {
        let row = TierRow {
            id,
            kind: "track".to_string(),
            title,
            matched: recording_matched.contains(&id),
            pinned_releases: 0,
            fields: by_entity.remove(&id).unwrap_or_default(),
            releases: Vec::new(),
            combined_from: Vec::new(),
        };
        match artist_id.and_then(|a| index.get(&a)) {
            Some(&i) => groups[i].loose_tracks.push(row),
            None => orphan.loose_tracks.push(row),
        }
    }

    // A page with nothing under it still earns a row when it carries
    // information beyond "the tag said X": an identity fact, or a name
    // MusicBrainz / the user chose (a feature-only artist identified through
    // a credit shows its tag spelling next to its MusicBrainz name here).
    groups.retain(|g| {
        !g.albums.is_empty()
            || !g.loose_tracks.is_empty()
            || !g.identity.is_empty()
            || g.artist_fields
                .get("title")
                .is_some_and(|t| t.mb.as_deref().is_some_and(|v| !v.is_empty()) || t.user.is_some())
    });
    // The artist-less group leads the page: loose tracks sit at the top,
    // above the artists (his call), not trailing after them.
    if !orphan.albums.is_empty() || !orphan.loose_tracks.is_empty() {
        groups.insert(0, orphan);
    }
    Ok(TierMatrix { mb_enabled, groups })
}

// ---------------------------------------------------------------------------
// Album editor
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct AlbumEditView {
    pub id: i64,
    pub title: String,
    pub release_date: Option<String>,
    pub album_type: String,
    pub genres: Vec<String>,
    /// Current artist credit: the album_artist_credit rows.
    pub artist_credits: Vec<String>,
    /// Fields with a user override: the album-level ones, plus "genres" and
    /// "artist_credits" when any track carries the corresponding edit.
    pub overridden: Vec<String>,
    /// Every release, for the per-release pre-emphasis switch.
    pub releases: Vec<ReleaseEditRow>,
}

#[derive(Debug, Serialize)]
pub struct ReleaseEditRow {
    pub id: i64,
    pub label: Option<String>,
    /// Folder leaf — tells copies apart when labels don't.
    pub folder: String,
    pub is_default: bool,
    /// The scanner's finding: a cue sheet with FLAGS PRE.
    pub cue_pre_emphasis: bool,
    /// The user's override; None = defer to the cue.
    pub pre_emphasis_pref: Option<bool>,
}

#[tauri::command]
pub async fn get_album_edit(
    state: State<'_, AppState>,
    album_id: i64,
) -> Result<AlbumEditView, String> {
    let pool = &state.app_db;
    let (title, release_date, album_type): (String, Option<String>, String) =
        sqlx::query_as("SELECT title, release_date, album_type FROM album WHERE id = ?")
            .bind(album_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let genres: Vec<(String,)> = sqlx::query_as(
        "SELECT g.name FROM album_genre ag JOIN genre g ON g.id = ag.genre_id
         WHERE ag.album_id = ? ORDER BY g.name",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let artist_credits: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT name FROM album_artist_credit WHERE album_id = ? ORDER BY position",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(n,)| n)
    .collect();
    let overrides = user_overrides(pool, album_id).await?;
    let mut overridden: Vec<String> =
        overrides.keys().filter(|f| ALBUM_FIELDS.contains(&f.as_str())).cloned().collect();
    let track_edited: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT f.field FROM field_override f
         JOIN media_entry me ON me.id = f.entity_id
         WHERE me.parent_id = ? AND f.tier = 'user' AND f.field IN ('genres', 'album_artists')",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (f,) in track_edited {
        overridden.push(if f == "album_artists" { "artist_credits".to_string() } else { f });
    }
    let release_rows: Vec<(i64, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT id, label, folder_path, is_default FROM album_release WHERE album_id = ? ORDER BY is_default DESC, id",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut releases = Vec::with_capacity(release_rows.len());
    for (id, label, folder_path, is_default) in release_rows {
        let (cue_pre_emphasis, pre_emphasis_pref) =
            crate::music::release_pre_emphasis_facts(pool, id).await?;
        releases.push(ReleaseEditRow {
            id,
            label,
            folder: folder_path.rsplit(['\\', '/']).next().unwrap_or(&folder_path).to_string(),
            is_default: is_default != 0,
            cue_pre_emphasis,
            pre_emphasis_pref,
        });
    }
    Ok(AlbumEditView {
        id: album_id,
        title,
        release_date,
        album_type,
        genres: genres.into_iter().map(|(g,)| g).collect(),
        artist_credits,
        overridden,
        releases,
    })
}

/// Apply user edits to an album: "title" (the card's title), "release_date",
/// "album_type" (album|ep|single|compilation) live on the album; "genres"
/// (array) and "artist_credits" (array) fan out to every track's genres /
/// album_artists — a changed album artist regroups the album under its new
/// owners.
#[tauri::command]
pub async fn set_album_fields(
    state: State<'_, AppState>,
    album_id: i64,
    fields: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    crate::music_mb::ensure_entity_not_matching(&state.app_db, album_id).await?;
    let pool = &state.app_db;
    let library_id = library_of(pool, album_id).await?;
    let (title_before,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let credits_before = album_credit_names(pool, album_id).await?;

    let mut album_before = serde_json::Map::new();
    let mut album_after = serde_json::Map::new();
    let current = user_overrides(pool, album_id).await?;
    let mut track_fields: Vec<(String, Option<String>)> = Vec::new();
    for (field, value) in &fields {
        match field.as_str() {
            "genres" => {
                let stored = tag_fields::stored_from_json("genres", value)?;
                track_fields.push(("genres".to_string(), Some(stored)));
            }
            "artist_credits" => {
                let stored = tag_fields::stored_from_json("album_artists", value)?;
                track_fields.push(("album_artists".to_string(), Some(stored)));
            }
            f if ALBUM_FIELDS.contains(&f) => {
                let s = value.as_str().unwrap_or_default().trim().to_string();
                if f == "album_type" && !["album", "ep", "single", "compilation"].contains(&s.as_str()) {
                    return Err(format!("Invalid album type: {s}"));
                }
                if f == "title" && s.is_empty() {
                    return Err("Title cannot be empty".to_string());
                }
                let old = current.get(f).cloned();
                if old.as_deref() == Some(s.as_str()) {
                    continue;
                }
                album_before.insert(f.to_string(), old.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
                album_after.insert(f.to_string(), serde_json::Value::String(s.clone()));
                upsert_override(pool, album_id, f, &s).await?;
            }
            other => return Err(format!("Unknown album field: {other}")),
        }
    }
    if !album_before.is_empty() {
        resolve_album_fields(pool, album_id, true).await?;
        let batch = crate::music_mb::next_batch(pool).await?;
        crate::music_mb::log_change(
            pool,
            &library_id,
            "album_fields",
            album_id,
            &format!("Edited \u{201c}{title_before}\u{201d}"),
            &serde_json::Value::Object(album_before),
            &serde_json::Value::Object(album_after),
            batch,
        )
        .await?;
    }
    if !track_fields.is_empty() {
        let ids = album_track_ids(pool, album_id).await?;
        let edits = same_on_all(&ids, track_fields);
        apply_layer_edits(pool, &library_id, &edits, &format!("Edited \u{201c}{title_before}\u{201d}")).await?;
    }
    if fields.contains_key("artist_credits") {
        let names_after = album_credit_names(pool, album_id).await?;
        if names_after != credits_before {
            crate::music_mb::enqueue_album_credit_recheck(pool, &library_id, album_id).await?;
        }
    }
    if fields.contains_key("title") {
        let (title_after,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
            .bind(album_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
        if title_after != title_before {
            crate::music_mb::forget_album_notfound(pool, album_id).await?;
        }
    }
    Ok(())
}

/// Undo of an "album_fields" History row: the album-level user tiers go
/// back and the columns re-resolve.
pub(crate) async fn undo_album_fields(
    pool: &SqlitePool,
    album_id: i64,
    before: &serde_json::Value,
) -> Result<(), String> {
    if let Some(map) = before.as_object() {
        for (field, value) in map {
            match value.as_str() {
                Some(v) => upsert_override(pool, album_id, field, v).await?,
                None => delete_override(pool, album_id, field).await?,
            }
        }
    }
    resolve_album_fields(pool, album_id, true).await
}

/// An album's credit names in order — before/after probe for real changes.
async fn album_credit_names(pool: &SqlitePool, album_id: i64) -> Result<Vec<String>, String> {
    Ok(sqlx::query_as::<_, (String,)>(
        "SELECT name FROM album_artist_credit WHERE album_id = ? ORDER BY position",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(n,)| n)
    .collect())
}

/// Drop an album's user edits: the album-level fields fall back to what the
/// match adopted or what the files say, and the tracks' genres and album
/// artists edits go — the album regroups from what's left.
#[tauri::command]
pub async fn reset_album_fields(
    state: State<'_, AppState>,
    album_id: i64,
) -> Result<(), String> {
    crate::music_mb::ensure_entity_not_matching(&state.app_db, album_id).await?;
    let pool = &state.app_db;
    let library_id = library_of(pool, album_id).await?;
    let (title,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let current = user_overrides(pool, album_id).await?;
    let mut before = serde_json::Map::new();
    let mut after = serde_json::Map::new();
    for f in ALBUM_FIELDS {
        if let Some(v) = current.get(*f) {
            before.insert(f.to_string(), serde_json::Value::String(v.clone()));
            after.insert(f.to_string(), serde_json::Value::Null);
            delete_override(pool, album_id, f).await?;
        }
    }
    if !before.is_empty() {
        resolve_album_fields(pool, album_id, true).await?;
        let batch = crate::music_mb::next_batch(pool).await?;
        crate::music_mb::log_change(
            pool,
            &library_id,
            "album_fields",
            album_id,
            &format!("Cleared the edits on \u{201c}{title}\u{201d}"),
            &serde_json::Value::Object(before),
            &serde_json::Value::Object(after),
            batch,
        )
        .await?;
    }
    let ids = album_track_ids(pool, album_id).await?;
    let edits = same_on_all(
        &ids,
        vec![("genres".to_string(), None), ("album_artists".to_string(), None)],
    );
    apply_layer_edits(pool, &library_id, &edits, &format!("Cleared the edits on \u{201c}{title}\u{201d}")).await
}

// ---------------------------------------------------------------------------
// Artist editor
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ArtistEditView {
    pub id: i64,
    pub title: String,
    pub biography: Option<String>,
    pub overridden: Vec<String>,
}

#[tauri::command]
pub async fn get_artist_edit(
    state: State<'_, AppState>,
    artist_id: i64,
) -> Result<ArtistEditView, String> {
    let pool = &state.app_db;
    let (title, biography): (String, Option<String>) =
        sqlx::query_as("SELECT title, biography FROM artist WHERE id = ?")
            .bind(artist_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let overrides = user_overrides(pool, artist_id).await?;
    Ok(ArtistEditView {
        id: artist_id,
        title,
        biography,
        overridden: overrides.keys().filter(|f| ARTIST_FIELDS.contains(&f.as_str())).cloned().collect(),
    })
}

/// Apply user edits to an artist. "title" renames — the previous name is
/// recorded as an alias so tag identity keeps resolving to this artist
/// (credits, appears-on, and the rescan's artist matching are all
/// alias-aware; without the alias a rescan would re-create the tag-named
/// artist and strand this one). "biography" writes directly — nothing else
/// ever touches it, so it needs no override row.
#[tauri::command]
pub async fn set_artist_fields(
    state: State<'_, AppState>,
    artist_id: i64,
    fields: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    crate::music_mb::ensure_entity_not_matching(&state.app_db, artist_id).await?;
    let pool = &state.app_db;
    let mut renamed = false;
    for (field, value) in &fields {
        if field == "biography" {
            let bio = value.as_str().unwrap_or_default().trim().to_string();
            sqlx::query("UPDATE artist SET biography = ? WHERE id = ?")
                .bind(if bio.is_empty() { None } else { Some(bio) })
                .bind(artist_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            continue;
        }
        if !ARTIST_FIELDS.contains(&field.as_str()) {
            return Err(format!("Unknown artist field: {field}"));
        }
        let new_name = value.as_str().unwrap_or_default().trim().to_string();
        if new_name.is_empty() {
            return Err("Artist name cannot be empty".to_string());
        }
        let (old_name,): (String,) = sqlx::query_as("SELECT title FROM artist WHERE id = ?")
            .bind(artist_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
        if !old_name.eq_ignore_ascii_case(&new_name) {
            renamed = true;
            // The old name lives on as a user alias — identity survives the
            // rename (credits still carrying it keep resolving here).
            sqlx::query(
                "INSERT OR IGNORE INTO artist_alias (artist_id, name, source) VALUES (?, ?, 'user')",
            )
            .bind(artist_id)
            .bind(&old_name)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
        upsert_override(pool, artist_id, "title", &new_name).await?;
    }
    reapply_artist_overrides(pool, artist_id).await?;
    if renamed {
        // The walks compare names — a corrected spelling deserves the fresh
        // walk a merge gets. Nothing is enqueued: the user runs a pass when
        // they want one.
        crate::music_mb::forget_artist_exhaustion(pool, artist_id).await?;
    }
    Ok(())
}

/// An alias equal to the artist's current title says nothing — drop it. Runs
/// after every title change (rename, reset, MB adoption, undo) so a name
/// that came back never lingers as a redirect to itself.
pub(crate) async fn drop_self_alias(pool: &SqlitePool, artist_id: i64) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM artist_alias
         WHERE artist_id = ?1
           AND LOWER(name) = (SELECT LOWER(title) FROM artist WHERE id = ?1)",
    )
    .bind(artist_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Drop an artist's rename. The name falls back to MusicBrainz's when the
/// artist is matched, else the tag spelling — immediately, from the stored
/// tiers. The alias the rename created (the name coming back) is dropped by
/// resolve_artist_fields; other aliases stay and keep old references
/// resolving.
#[tauri::command]
pub async fn reset_artist_fields(
    state: State<'_, AppState>,
    artist_id: i64,
) -> Result<(), String> {
    crate::music_mb::ensure_entity_not_matching(&state.app_db, artist_id).await?;
    let pool = &state.app_db;
    for f in ARTIST_FIELDS {
        delete_override(pool, artist_id, f).await?;
    }
    resolve_artist_fields(pool, artist_id, true).await
}

// ---------------------------------------------------------------------------
// Album combining — edits of the layer's app-only fields
// ---------------------------------------------------------------------------

/// One album in a combine selection: what the dialog shows, plus the
/// editions it holds (the keeper's are pickable merge targets; a non-keeper
/// with several is refused by merge).
/// One disc of an edition: what a merge's per-disc name fields are built
/// from — the number, and the name it already carries (tag subtitle or an
/// earlier rename), if any.
#[derive(Serialize)]
pub struct CombineDisc {
    pub disc_no: i64,
    pub track_count: i64,
    pub title: Option<String>,
}

#[derive(Serialize)]
pub struct CombineEdition {
    pub release_id: i64,
    pub label: Option<String>,
    pub folder_path: String,
    pub is_default: bool,
    pub track_count: i64,
    pub discs: Vec<CombineDisc>,
}

#[derive(Serialize)]
pub struct CombineAlbumInfo {
    pub id: i64,
    pub title: String,
    /// Owning artist — two same-titled albums are otherwise indistinguishable.
    pub artist: Option<String>,
    pub track_count: i64,
    /// What picking this album as keeper KEEPS: its year, genres, and cover
    /// survive alongside the title — the dialog shows them per option.
    pub year: Option<String>,
    pub genres: Vec<String>,
    /// Display cover (cached path), for the option row's thumbnail.
    pub cover: Option<String>,
    pub editions: Vec<CombineEdition>,
    /// Matched to MusicBrainz: its credits are MB's — the album-artist
    /// choice isn't offered on such a keeper.
    pub mb_matched: bool,
    /// The user has set its credits by hand (a user-tier album_artists
    /// edit on its tracks) — likewise not offered; the edit stands.
    pub credits_edited: bool,
}

#[tauri::command]
pub async fn get_combine_info(
    state: State<'_, AppState>,
    album_ids: Vec<i64>,
) -> Result<Vec<CombineAlbumInfo>, String> {
    let pool = &state.app_db;
    let mut out = Vec::with_capacity(album_ids.len());
    for id in album_ids {
        let Some((title, artist, library_id, folder_path, selected_cover, release_date, mb_matched, credits_edited)) =
            sqlx::query_as::<_, (String, Option<String>, String, String, Option<String>, Option<String>, i64, i64)>(
                "SELECT al.title,
                        (SELECT GROUP_CONCAT(name, ' · ') FROM (
                             SELECT ac.name FROM album_artist_credit ac
                             WHERE ac.album_id = al.id ORDER BY ac.position)),
                        me.library_id, al.folder_path, al.selected_cover, al.release_date,
                        EXISTS (SELECT 1 FROM mb_credit_fetch f
                                WHERE f.album_id = al.id AND f.status = 'matched'),
                        EXISTS (SELECT 1 FROM field_override fo
                                JOIN media_entry tme ON tme.id = fo.entity_id
                                WHERE tme.parent_id = al.id AND fo.field = 'album_artists' AND fo.tier = 'user')
                 FROM album al
                 JOIN media_entry me ON me.id = al.id
                 WHERE al.id = ?",
            )
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
        else {
            continue; // vanished mid-selection (rescan) — just drop it
        };
        let genres: Vec<String> = sqlx::query_as::<_, (String,)>(
            "SELECT g.name FROM genre g JOIN album_genre ag ON ag.genre_id = g.id
             WHERE ag.album_id = ? ORDER BY g.name",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(n,)| n)
        .collect();
        let rows: Vec<(i64, Option<String>, String, i64, i64)> = sqlx::query_as(
            "SELECT r.id, r.label, r.folder_path, r.is_default,
                    (SELECT COUNT(*) FROM track_release tr WHERE tr.release_id = r.id)
             FROM album_release r WHERE r.album_id = ?
             ORDER BY r.is_default DESC, r.id",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        // Display cover = what the grid card shows: the DEFAULT release's
        // art. Its pick first, then the album's selected cover, then the
        // first BARE-named cached file — non-default releases' art is pooled
        // under a "{leaf}_" prefix and belongs to them, so a prefixed file
        // sorting first by name must not win.
        let covers: Vec<(String, String)> = sqlx::query_as(
            "SELECT source_filename, cached_path FROM cached_images
             WHERE library_id = ? AND entry_folder_path = ? AND image_type = 'cover'
             ORDER BY source_filename",
        )
        .bind(&library_id)
        .bind(&folder_path)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        let default_pick: Option<String> = sqlx::query_scalar(
            "SELECT p.cover FROM album_release_pref p
             JOIN album_release ar ON ar.album_id = p.album_id
                  AND ar.folder_path = p.folder_path COLLATE NOCASE
             WHERE p.album_id = ? AND ar.is_default = 1
               AND p.cover IS NOT NULL AND p.cover <> ''",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        let leaf = |p: &str| p.rsplit(['\\', '/']).next().unwrap_or(p).to_lowercase();
        let other_leaves: Vec<String> =
            rows.iter().filter(|r| r.3 == 0).map(|r| leaf(&r.2)).collect();
        let is_prefixed = |name: &str| {
            let n = name.to_lowercase();
            other_leaves
                .iter()
                .any(|l| n.len() > l.len() + 1 && n.starts_with(l.as_str()) && n.as_bytes()[l.len()] == b'_')
        };
        let in_pool = |s: &str| covers.iter().any(|(_, c)| c == s);
        let cover = default_pick
            .filter(|s| in_pool(s))
            .or_else(|| selected_cover.filter(|s| in_pool(s)))
            .or_else(|| covers.iter().find(|(n, _)| !is_prefixed(n)).map(|(_, c)| c.clone()))
            .or_else(|| covers.first().map(|(_, c)| c.clone()));
        let (track_count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM media_entry WHERE parent_id = ?")
                .bind(id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
        let mut editions = Vec::with_capacity(rows.len());
        for (release_id, label, folder_path, is_default, track_count) in rows {
            // The edition's discs, as the merge will see them (untagged
            // disc numbers count as disc 1, like the slot check), with the
            // name each already carries.
            let disc_rows: Vec<(i64, i64)> = sqlx::query_as(
                "SELECT COALESCE(t.disc_number, 1), COUNT(*) FROM track t
                 JOIN track_release tr ON tr.track_id = t.id
                 WHERE tr.release_id = ?
                 GROUP BY 1 ORDER BY 1",
            )
            .bind(release_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
            let names = crate::music::resolved_disc_titles(pool, release_id).await?;
            let discs = disc_rows
                .into_iter()
                .map(|(disc_no, track_count)| CombineDisc {
                    disc_no,
                    track_count,
                    title: names.iter().find(|(d, _)| *d == disc_no).map(|(_, t)| t.clone()),
                })
                .collect();
            editions.push(CombineEdition {
                release_id,
                label,
                folder_path,
                is_default: is_default != 0,
                track_count,
                discs,
            });
        }
        out.push(CombineAlbumInfo {
            id,
            title,
            artist,
            track_count,
            year: release_date
                .map(|d| d.chars().take(4).collect::<String>())
                .filter(|s| !s.is_empty()),
            genres,
            cover,
            editions,
            mb_matched: mb_matched != 0,
            credits_edited: credits_edited != 0,
        });
    }
    Ok(out)
}

/// The (disc, track) slots one release occupies — the merge gate's input.
async fn slots_of_release(pool: &SqlitePool, release_id: i64) -> Result<HashSet<(i64, i64)>, String> {
    let rows: Vec<(Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT t.disc_number, t.track_number FROM track t
         JOIN track_release tr ON tr.track_id = t.id
         WHERE tr.release_id = ?",
    )
    .bind(release_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter_map(|(d, n)| n.map(|n| (d.unwrap_or(1), n)))
        .collect())
}

/// One disc name the combine dialog asks for (mode 'merge').
#[derive(Deserialize)]
pub struct DiscNameArg {
    pub disc_no: i64,
    pub title: String,
}

/// Effective disc numbers (the cache column) of the given tracks; absent
/// rows read as disc 1, like everywhere else.
async fn track_disc_numbers(pool: &SqlitePool, ids: &[i64]) -> Result<HashMap<i64, i64>, String> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT id, disc_number FROM track WHERE id IN ({marks})");
        let mut q = sqlx::query_as::<_, (i64, Option<i64>)>(&sql);
        for id in chunk {
            q = q.bind(id);
        }
        for (id, disc) in q.fetch_all(pool).await.map_err(|e| e.to_string())? {
            out.insert(id, disc.unwrap_or(1));
        }
    }
    Ok(out)
}

/// Re-key one edition's folder-keyed rows (release pin, label/cover/default
/// prefs, note, match gaps) from one album to another. A row the target
/// already holds for that folder (mixed-tag folders) stays the target's;
/// the carried edition never arrives as the default — the keeper's default
/// pref was set before this runs.
async fn carry_release_rows(pool: &SqlitePool, from_album: i64, folder: &str, into_album: i64) -> Result<(), String> {
    for table in ["release_match", "album_release_pref", "album_release_note", "album_match_gap"] {
        sqlx::query(&format!(
            "UPDATE OR IGNORE {table} SET album_id = ? WHERE album_id = ? AND folder_path = ?"
        ))
        .bind(into_album)
        .bind(from_album)
        .bind(folder)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    sqlx::query("UPDATE album_release_pref SET is_default = 0 WHERE album_id = ? AND folder_path = ?")
        .bind(into_album)
        .bind(folder)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The album's identity token: the one its tracks already carry (majority),
/// or a fresh one stamped onto all of them.
async fn ensure_album_token(pool: &SqlitePool, album_id: i64) -> Result<(String, Vec<LayerEdit>), String> {
    let ids = album_track_ids(pool, album_id).await?;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for id in &ids {
        if let Some(tok) = user_overrides(pool, *id).await?.get("identity_key").filter(|v| !v.is_empty()) {
            *counts.entry(tok.clone()).or_insert(0) += 1;
        }
    }
    let token = counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
        .map(|(t, _)| t)
        .unwrap_or_else(new_identity_token);
    let edits = same_on_all(&ids, vec![("identity_key".to_string(), Some(token.clone()))]);
    Ok((token, edits))
}

/// Combine albums: every non-keeper folds into the keeper (whose title,
/// metadata, edits and identity survive). The combine is a write of the tag
/// layer's app-only fields — an identity token shared by every track binds
/// them into one album, and (mode 'merge') a release_key pours the others'
/// tracks into ONE release of the keeper — applied on the spot, undone from
/// History. Files keep their own tags; a bulk edit can align those too.
///
/// mode 'merge' rules, all refusals rather than guesses:
///   - no two albums may claim the same (disc, track) slot — renumber in the
///     bulk editor first, or combine as separate releases;
///   - a non-keeper with several editions is refused (pouring a set of
///     alternate cuts into one track list has no honest meaning) — separate
///     its editions first.
/// mode 'versions' appends the others' editions to the keeper's picker, so
/// multi-edition sources are fine and no slots are compared.
#[tauri::command]
pub async fn combine_albums_multi(
    state: State<'_, AppState>,
    library_id: String,
    source_ids: Vec<i64>,
    target_id: i64,
    mode: String,
    // Which keeper edition a merge lands in (its folder). None = default.
    target_release_folder: Option<String>,
    // The combined album's artist credit, when the dialog's Album-artist
    // choice differs from the keeper's own ("Various Artists" for a
    // compilation split across one-artist albums). None = the keeper's.
    album_artist: Option<String>,
    // mode 'merge': names for the merged track list's discs, written as the
    // disc_subtitle of every track landing on that disc number — the
    // keeper's target edition and the poured-in albums alike, in the same
    // write as the combine (the tracks arrive together, so a name for a
    // disc another album brings can't be set on the keeper beforehand).
    disc_names: Option<Vec<DiscNameArg>>,
) -> Result<(), String> {
    crate::music_mb::ensure_not_matching(&state.app_db, &library_id).await?;
    let pool = &state.app_db;
    if !matches!(mode.as_str(), "merge" | "versions") {
        return Err(format!("Invalid combine mode: {mode}"));
    }
    let mut seen_ids = HashSet::new();
    let sources: Vec<i64> = source_ids
        .into_iter()
        .filter(|id| *id != target_id && seen_ids.insert(*id))
        .collect();
    if sources.is_empty() {
        return Err("Pick at least two albums to combine".to_string());
    }

    let title_of = |id: i64| async move {
        sqlx::query_as::<_, (String,)>("SELECT title FROM album WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())
            .map(|r| r.map(|(t,)| t).unwrap_or_else(|| format!("#{id}")))
    };

    // Real albums only: loose containers and the sounds domain (virtual
    // collections) have no tag identity to bind on.
    for id in sources.iter().chain(std::iter::once(&target_id)) {
        let ok: Option<(i64,)> = sqlx::query_as(
            "SELECT al.id FROM album al JOIN media_entry me ON me.id = al.id
             WHERE al.id = ? AND me.library_id = ?
               AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
               AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)",
        )
        .bind(id)
        .bind(&library_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if ok.is_none() {
            return Err("Album not found in this library".to_string());
        }
    }

    let editions_of = |album_id: i64| async move {
        sqlx::query_as::<_, (i64, String, i64)>(
            "SELECT id, folder_path, is_default FROM album_release WHERE album_id = ?",
        )
        .bind(album_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())
    };

    let keeper_editions = editions_of(target_id).await?;
    let keeper_release = match &target_release_folder {
        Some(folder) => keeper_editions
            .iter()
            .find(|(_, f, _)| f.eq_ignore_ascii_case(folder))
            .ok_or_else(|| "That edition is no longer part of the album".to_string())?,
        None => keeper_editions
            .iter()
            .find(|(_, _, d)| *d != 0)
            .or_else(|| keeper_editions.first())
            .ok_or_else(|| "The album has no editions".to_string())?,
    };
    let keeper_folder = keeper_release.1.clone();
    let keeper_default_folder = keeper_editions
        .iter()
        .find(|(_, _, d)| *d != 0)
        .map(|(_, f, _)| f.clone())
        .unwrap_or_else(|| keeper_folder.clone());

    if mode == "merge" {
        let mut claimed: HashMap<(i64, i64), i64> = slots_of_release(pool, keeper_release.0)
            .await?
            .into_iter()
            .map(|slot| (slot, target_id))
            .collect();
        for src in &sources {
            let src_editions = editions_of(*src).await?;
            if src_editions.len() > 1 {
                return Err(format!(
                    "\"{}\" has {} editions — separate them first, then merge the one you want",
                    title_of(*src).await?,
                    src_editions.len(),
                ));
            }
            for (release_id, _, _) in &src_editions {
                for slot in slots_of_release(pool, *release_id).await? {
                    if let Some(other) = claimed.insert(slot, *src) {
                        let (d, n) = slot;
                        return Err(format!(
                            "\"{}\" and \"{}\" both have a Disc {d}, Track {n} — renumber one of them first, or combine as separate releases",
                            title_of(other).await?,
                            title_of(*src).await?,
                        ));
                    }
                }
            }
        }
    }

    let tgt_name = title_of(target_id).await?;
    // The keeper's token binds everyone; its own album_identity key is set
    // to it FIRST so the rescan's claim hands the combined album the
    // keeper's row (edits, matches, history and all).
    let (token, mut edits) = ensure_album_token(pool, target_id).await?;
    sqlx::query("UPDATE album_identity SET key = ? WHERE album_id = ?")
        .bind(format!("id:{token}"))
        .bind(target_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    set_default_release_pref(pool, target_id, &keeper_default_folder).await?;
    let mut names: Vec<String> = Vec::new();
    for src in &sources {
        names.push(format!("\u{201c}{}\u{201d}", title_of(*src).await?));
        // Folder-keyed state of the source's editions follows them: as
        // versions, the rows re-key to the keeper (pins, label and cover
        // prefs, notes, match gaps); poured into one track list, only the
        // note carries (it joins the keeper release's) — the rest were
        // claims about a track list that no longer exists.
        for (_, folder, _) in editions_of(*src).await? {
            if mode == "merge" {
                crate::notes::append_release_note(pool, *src, &folder, target_id, &keeper_folder).await?;
            } else {
                carry_release_rows(pool, *src, &folder, target_id).await?;
            }
        }
        let ids = album_track_ids(pool, *src).await?;
        let mut fields: Vec<(String, Option<String>)> =
            vec![("identity_key".to_string(), Some(token.clone()))];
        if mode == "merge" {
            fields.push(("release_key".to_string(), Some(keeper_folder.clone())));
        }
        edits.extend(same_on_all(&ids, fields));
        // The source's note joins the keeper's (its row goes with the sweep).
        crate::notes::append_note(pool, "entry", *src, target_id).await?;
    }
    // The album-artist answer: on every track of the combined album.
    if let Some(name) = album_artist.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let value = tag_fields::list_to_stored(&[name.to_string()]);
        for e in edits.iter_mut() {
            e.1.push(("album_artists".to_string(), Some(value.clone())));
        }
    }
    // Disc names for the merged track list: the tracks that land in the
    // keeper's target edition (its own, plus every source's), by their
    // effective disc number. "" clears an earlier name — an explicit empty.
    if mode == "merge" {
        let names: HashMap<i64, String> = disc_names
            .unwrap_or_default()
            .into_iter()
            .map(|d| (d.disc_no, d.title.trim().to_string()))
            .collect();
        if !names.is_empty() {
            let mut landing: HashSet<i64> = release_track_ids(pool, keeper_release.0).await?.into_iter().collect();
            for src in &sources {
                landing.extend(album_track_ids(pool, *src).await?);
            }
            let ids: Vec<i64> = landing.iter().copied().collect();
            let discs = track_disc_numbers(pool, &ids).await?;
            for e in edits.iter_mut() {
                if !landing.contains(&e.0) {
                    continue;
                }
                let disc = discs.get(&e.0).copied().unwrap_or(1);
                if let Some(title) = names.get(&disc) {
                    e.1.push(("disc_subtitle".to_string(), Some(title.clone())));
                }
            }
        }
    }
    let label = format!(
        "Combine {} into \u{201c}{tgt_name}\u{201d}{}",
        names.join(", "),
        if mode == "merge" { " — one track list" } else { " as separate releases" }
    );
    apply_layer_edits(pool, &library_id, &edits, &label).await?;
    if mode == "merge" {
        // The keeper's pin on the poured-into release was a claim about the
        // old track list.
        crate::music_mb::drop_release_pin(pool, target_id, &keeper_folder).await?;
        crate::music_mb::enqueue_pass_work(pool, &library_id, target_id).await?;
    }
    Ok(())
}

/// Separate one edition into an album of its own: its tracks take a fresh
/// identity token, so the scanner files them apart from their same-tag (or
/// same-group) siblings. Applied now; undone from History.
#[tauri::command]
pub async fn split_album_release(
    state: State<'_, AppState>,
    release_id: i64,
) -> Result<String, String> {
    crate::music_mb::ensure_release_not_matching(&state.app_db, release_id).await?;
    let pool = &state.app_db;
    let (album_id, folder_path): (i64, String) =
        sqlx::query_as("SELECT album_id, folder_path FROM album_release WHERE id = ?")
            .bind(release_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That edition no longer exists".to_string())?;
    let library_id = library_of(pool, album_id).await?;
    let (edition_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM album_release WHERE album_id = ?")
            .bind(album_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    if edition_count < 2 {
        return Err("This album has only one edition".to_string());
    }
    let ids = release_track_ids(pool, release_id).await?;
    let token = new_identity_token();
    let edits = same_on_all(&ids, vec![("identity_key".to_string(), Some(token))]);
    let leaf = folder_path.rsplit(['\\', '/']).next().unwrap_or(&folder_path);
    apply_layer_edits(
        pool,
        &library_id,
        &edits,
        &format!("Separate \u{201c}{leaf}\u{201d} out of \u{201c}{}\u{201d}", album_title_for(pool, album_id).await?),
    )
    .await?;
    Ok(library_id)
}

/// Merge one edition of an album into another of the same album — the
/// versions menu's "Merge into this release": the edition's tracks take the
/// other release's folder as their release_key, one track list. Applied now.
#[tauri::command]
pub async fn merge_album_release(
    state: State<'_, AppState>,
    release_id: i64,
    into_release_id: i64,
) -> Result<String, String> {
    crate::music_mb::ensure_release_not_matching(&state.app_db, release_id).await?;
    let pool = &state.app_db;
    if release_id == into_release_id {
        return Err("Pick a different release to merge into".to_string());
    }
    let edition = |id: i64| async move {
        sqlx::query_as::<_, (i64, String)>(
            "SELECT album_id, folder_path FROM album_release WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That edition no longer exists".to_string())
    };
    let (album_id, folder_path) = edition(release_id).await?;
    let (into_album, into_folder) = edition(into_release_id).await?;
    if album_id != into_album {
        return Err("Both editions must belong to the same album".to_string());
    }
    let library_id = library_of(pool, album_id).await?;

    // Same gate as the combine dialog's merge: one track list can't hold two
    // tracks at the same disc & track number.
    let keeper_slots = slots_of_release(pool, into_release_id).await?;
    if let Some((d, n)) = slots_of_release(pool, release_id).await?.into_iter().find(|s| keeper_slots.contains(s)) {
        return Err(format!(
            "Both releases have a Disc {d}, Track {n} — renumber one of them first"
        ));
    }
    let ids = release_track_ids(pool, release_id).await?;
    let edits = same_on_all(&ids, vec![("release_key".to_string(), Some(into_folder.clone()))]);
    // The poured-in edition's note joins the other's (its row would go
    // with the release).
    crate::notes::append_release_note(pool, album_id, &folder_path, into_album, &into_folder).await?;
    let leaf = folder_path.rsplit(['\\', '/']).next().unwrap_or(&folder_path);
    apply_layer_edits(
        pool,
        &library_id,
        &edits,
        &format!(
            "Merge \u{201c}{leaf}\u{201d} into \u{201c}{}\u{201d} — one track list",
            album_title_for(pool, album_id).await?
        ),
    )
    .await?;
    // The poured-into pin was a claim about the old track list.
    crate::music_mb::drop_release_pin(pool, album_id, &into_folder).await?;
    crate::music_mb::enqueue_pass_work(pool, &library_id, album_id).await?;
    Ok(library_id)
}

/// Undo an applied merge: the tracks poured into this release from other
/// folders drop their release_key and come back as editions of their own.
#[tauri::command]
pub async fn separate_merged_folders(
    state: State<'_, AppState>,
    release_id: i64,
) -> Result<String, String> {
    crate::music_mb::ensure_release_not_matching(&state.app_db, release_id).await?;
    let pool = &state.app_db;
    let (album_id, _folder_path): (i64, String) =
        sqlx::query_as("SELECT album_id, folder_path FROM album_release WHERE id = ?")
            .bind(release_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That edition no longer exists".to_string())?;
    let library_id = library_of(pool, album_id).await?;
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT t.id FROM track t
         JOIN track_release tr ON tr.track_id = t.id
         JOIN field_override f ON f.entity_id = t.id AND f.field = 'release_key' AND f.tier = 'user'
         WHERE tr.release_id = ? AND f.value IS NOT NULL AND f.value <> ''",
    )
    .bind(release_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Err("Nothing is merged into this release".to_string());
    }
    let ids: Vec<i64> = rows.into_iter().map(|(id,)| id).collect();
    let edits = same_on_all(&ids, vec![("release_key".to_string(), None)]);
    apply_layer_edits(
        pool,
        &library_id,
        &edits,
        &format!(
            "Separate the merged folders out of \u{201c}{}\u{201d}",
            album_title_for(pool, album_id).await?
        ),
    )
    .await?;
    Ok(library_id)
}

/// Album display title for History labels.
async fn album_title_for(pool: &SqlitePool, album_id: i64) -> Result<String, String> {
    sqlx::query_as::<_, (String,)>("SELECT title FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
        .map(|r| r.map(|(t,)| t).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Duplicate albums (File problems)
// ---------------------------------------------------------------------------

/// One album of a duplicate set, as the File-problems card shows it.
#[derive(Serialize)]
pub struct DuplicateAlbum {
    pub id: i64,
    pub title: String,
    /// The credit line as the album carries it (" / " between names).
    pub credit: String,
    pub folder_path: String,
    pub track_count: i64,
}

/// Albums whose files are the same media: every track's content hash
/// (the media region, so retagging doesn't change it) matches one for one.
#[derive(Serialize)]
pub struct DuplicateGroup {
    /// Digest of the sorted hashes — what "Keep both" is keyed on.
    pub key: String,
    pub albums: Vec<DuplicateAlbum>,
}

/// Sets of albums that are byte-for-byte the same recordings (user's ask,
/// 2026-10-03): a copy left behind, flagged and never touched — the fix is
/// deleting a folder at the source and rescanning. Hash identity only, no
/// metadata test: the same files under different tags are the more
/// interesting duplicate, not a different case. Albums with any unhashed
/// track can't be judged and are skipped.
#[tauri::command]
pub async fn get_duplicate_albums(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<Vec<DuplicateGroup>, String> {
    let pool = &state.app_db;
    let rows: Vec<(i64, Option<String>)> = sqlx::query_as(
        "SELECT me.parent_id, t.audio_hash FROM track t
         JOIN media_entry me ON me.id = t.id
         WHERE me.library_id = ? AND me.parent_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = me.parent_id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = me.parent_id)",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut hashes: HashMap<i64, Option<Vec<String>>> = HashMap::new();
    for (album_id, hash) in rows {
        let slot = hashes.entry(album_id).or_insert_with(|| Some(Vec::new()));
        match (slot.as_mut(), hash.filter(|h| !h.is_empty())) {
            (Some(v), Some(h)) => v.push(h),
            _ => *slot = None, // one unhashed track: the album can't be judged
        }
    }
    let mut by_key: HashMap<String, Vec<i64>> = HashMap::new();
    for (album_id, list) in hashes {
        let Some(mut list) = list else { continue };
        if list.is_empty() {
            continue;
        }
        list.sort();
        let key = format!("{:016x}", xxhash_rust::xxh3::xxh3_64(list.join("\n").as_bytes()));
        by_key.entry(key).or_default().push(album_id);
    }
    let dismissed: HashSet<String> = sqlx::query_as::<_, (String,)>(
        "SELECT key FROM album_duplicate_dismiss WHERE library_id = ?",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(k,)| k)
    .collect();

    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for (key, mut ids) in by_key {
        if ids.len() < 2 || dismissed.contains(&key) {
            continue;
        }
        ids.sort();
        let mut albums = Vec::new();
        for id in ids {
            let row: Option<(String, String, i64)> = sqlx::query_as(
                "SELECT al.title, al.folder_path,
                        (SELECT COUNT(*) FROM media_entry t WHERE t.parent_id = al.id)
                 FROM album al WHERE al.id = ?",
            )
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            let Some((title, folder_path, track_count)) = row else { continue };
            let credit: Vec<(String,)> = sqlx::query_as(
                "SELECT name FROM album_artist_credit WHERE album_id = ? ORDER BY position",
            )
            .bind(id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
            albums.push(DuplicateAlbum {
                id,
                title,
                credit: credit.into_iter().map(|(n,)| n).collect::<Vec<_>>().join(" / "),
                folder_path,
                track_count,
            });
        }
        if albums.len() >= 2 {
            groups.push(DuplicateGroup { key, albums });
        }
    }
    groups.sort_by(|a, b| {
        a.albums[0]
            .title
            .to_lowercase()
            .cmp(&b.albums[0].title.to_lowercase())
            .then(a.key.cmp(&b.key))
    });
    Ok(groups)
}

/// "Keep both": the duplicate set is intentional; the card never returns
/// for these same files (the key is their hashes, not their rows).
#[tauri::command]
pub async fn dismiss_duplicate_albums(
    state: State<'_, AppState>,
    library_id: String,
    key: String,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO album_duplicate_dismiss (library_id, key) VALUES (?, ?)
         ON CONFLICT(library_id, key) DO UPDATE SET dismissed_at = datetime('now')",
    )
    .bind(&library_id)
    .bind(&key)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
