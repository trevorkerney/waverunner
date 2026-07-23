//! In-app metadata editing — the user tier of the per-field provenance model.
//!
//! Edits land in field_override (tier 'user') AND are applied to the regular
//! columns, so every read path stays untouched. Scan/reconcile and the
//! MusicBrainz pass re-stomp (or skip) overridden fields — see the reapply
//! hooks — so a rescan can never clobber a user edit. Media files stay
//! read-only: the only thing that ever writes tags into a file is
//! write_track_tags, which is gated behind the default-off
//! `allow_tag_writeback` setting and an explicit per-save user action.
//!
//! Track fields: title, credits (ordered artist list), track_number,
//! disc_number. Album fields: title, release_date, album_type.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue, TagItem};
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::commands::generate_sort_title;
use crate::AppState;

// ---------------------------------------------------------------------------
// Override storage
// ---------------------------------------------------------------------------

const TRACK_FIELDS: &[&str] = &["title", "credits", "track_number", "disc_number"];
const ALBUM_FIELDS: &[&str] = &["title", "release_date", "album_type", "genres"];
const ARTIST_FIELDS: &[&str] = &["title"];

/// User-tier override values for an entity, keyed by field. Values are stored
/// as raw text; "credits" holds a JSON array of names.
pub(crate) async fn user_overrides(
    pool: &SqlitePool,
    entity_id: i64,
) -> Result<HashMap<String, String>, String> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT field, value FROM field_override WHERE entity_id = ? AND tier = 'user'",
    )
    .bind(entity_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(f, v)| (f, v.unwrap_or_default()))
        .collect())
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

async fn upsert_override(
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

// ---------------------------------------------------------------------------
// Applying overrides to the regular columns (the single application path —
// used by edits AND by the scan/reconcile reapply hooks)
// ---------------------------------------------------------------------------

/// Re-stomp a track's user overrides over whatever the columns currently hold
/// (fresh tag parse, MB credits, …). Called after every bulk track write, so
/// rescans/matches can never clobber an edit. No-op without overrides.
pub(crate) async fn reapply_track_overrides(
    pool: &SqlitePool,
    track_id: i64,
) -> Result<(), String> {
    let overrides = user_overrides(pool, track_id).await?;
    if overrides.is_empty() {
        return Ok(());
    }

    if let Some(title) = overrides.get("title") {
        sqlx::query("UPDATE track SET title = ?, sort_title = ? WHERE id = ?")
            .bind(title)
            .bind(generate_sort_title(title, "en"))
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(v) = overrides.get("track_number") {
        let n: Option<i64> = v.parse().ok();
        sqlx::query("UPDATE track SET track_number = ? WHERE id = ?")
            .bind(n)
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(v) = overrides.get("disc_number") {
        let n: Option<i64> = v.parse().ok();
        sqlx::query("UPDATE track SET disc_number = COALESCE(?, 1) WHERE id = ?")
            .bind(n)
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    if overrides.contains_key("track_number") || overrides.contains_key("disc_number") {
        // Keep list ordering in step with the effective numbers.
        sqlx::query(
            "UPDATE track SET sort_order = COALESCE(disc_number, 1) * 1000000 + COALESCE(track_number, 900) * 1000
             WHERE id = ?",
        )
        .bind(track_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    if let Some(raw) = overrides.get("credits") {
        let credits: Vec<String> = serde_json::from_str(raw).unwrap_or_default();
        sqlx::query("DELETE FROM track_credit WHERE track_id = ?")
            .bind(track_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        for (i, name) in credits.iter().enumerate() {
            sqlx::query("INSERT INTO track_credit (track_id, position, name) VALUES (?, ?, ?)")
                .bind(track_id)
                .bind(i as i64)
                .bind(name)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        if let Some(first) = credits.first() {
            sqlx::query("UPDATE track_meta SET artist_name = ? WHERE track_id = ?")
                .bind(first)
                .bind(track_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Album counterpart of reapply_track_overrides.
pub(crate) async fn reapply_album_overrides(
    pool: &SqlitePool,
    album_id: i64,
) -> Result<(), String> {
    let overrides = user_overrides(pool, album_id).await?;
    if overrides.is_empty() {
        return Ok(());
    }
    if let Some(title) = overrides.get("title") {
        sqlx::query("UPDATE album SET title = ?, sort_title = ? WHERE id = ?")
            .bind(title)
            .bind(generate_sort_title(title, "en"))
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
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
    if let Some(raw) = overrides.get("genres") {
        let genres: Vec<String> = serde_json::from_str(raw).unwrap_or_default();
        sqlx::query("DELETE FROM album_genre WHERE album_id = ?")
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
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
            .bind(album_id)
            .bind(&g)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Artist counterpart — a renamed artist keeps their user-chosen name through
/// rescans (the scan's casing-refresh would otherwise restore the tag name).
pub(crate) async fn reapply_artist_overrides(
    pool: &SqlitePool,
    artist_id: i64,
) -> Result<(), String> {
    let overrides = user_overrides(pool, artist_id).await?;
    if let Some(title) = overrides.get("title") {
        if !title.is_empty() {
            sqlx::query("UPDATE artist SET title = ?, sort_title = ? WHERE id = ?")
                .bind(title)
                .bind(generate_sort_title(title, "en"))
                .bind(artist_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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

async fn resolve_abs(pool: &SqlitePool, library_id: &str, rel: &str) -> Result<PathBuf, String> {
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
            return Ok(abs);
        }
    }
    Err("File not found under the library's music folders".to_string())
}

// ---------------------------------------------------------------------------
// Commands — read
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct FileTagValues {
    pub title: Option<String>,
    pub artists: Vec<String>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
}

#[derive(Serialize)]
pub struct TrackEditView {
    pub id: i64,
    pub title: String,
    pub credits: Vec<String>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    /// Fields with a user override.
    pub overridden: Vec<String>,
    pub file_name: String,
    /// What the file's tags actually say right now (None = unreadable).
    pub file_tags: Option<FileTagValues>,
}

#[tauri::command]
pub async fn get_track_edit(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<TrackEditView, String> {
    let pool = &state.app_db;
    let (library_id, rel) = track_context(pool, track_id).await?;
    let (title, track_number, disc_number): (String, Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT title, track_number, disc_number FROM track WHERE id = ?")
            .bind(track_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let credit_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM track_credit WHERE track_id = ? ORDER BY position",
    )
    .bind(track_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let overrides = user_overrides(pool, track_id).await?;

    let file_name = Path::new(&rel)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| rel.clone());

    // Fresh tag read for the "file says" hints — the tag tier made visible.
    let file_tags = match resolve_abs(pool, &library_id, &rel).await {
        Ok(abs) => tauri::async_runtime::spawn_blocking(move || read_file_tags(&abs))
            .await
            .map_err(|e| e.to_string())?,
        Err(_) => None,
    };

    Ok(TrackEditView {
        id: track_id,
        title,
        credits: credit_rows.into_iter().map(|(n,)| n).collect(),
        track_number,
        disc_number,
        overridden: overrides.into_keys().collect(),
        file_name,
        file_tags,
    })
}

fn read_file_tags(abs: &Path) -> Option<FileTagValues> {
    let tagged = Probe::open(abs).ok()?.read().ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    use lofty::tag::Accessor;
    let artists: Vec<String> = {
        let multi: Vec<String> = tag
            .get_strings(&ItemKey::TrackArtists)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !multi.is_empty() {
            multi
        } else {
            tag.artist()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .into_iter()
                .collect()
        }
    };
    Some(FileTagValues {
        title: tag.title().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        artists,
        track_number: tag.track().map(|t| t as i64).filter(|t| *t > 0),
        disc_number: tag.disk().map(|d| d as i64).filter(|d| *d > 0),
    })
}

// ---------------------------------------------------------------------------
// Commands — write
// ---------------------------------------------------------------------------

/// Apply user edits to a track. `fields` maps field name → new value:
/// "title" (string), "credits" (array of strings, main artist first),
/// "track_number"/"disc_number" (number or null). Only the provided fields
/// change; each becomes a user-tier override that survives rescans and the
/// MusicBrainz pass.
#[tauri::command]
pub async fn set_track_fields(
    state: State<'_, AppState>,
    track_id: i64,
    fields: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let pool = &state.app_db;
    let (library_id, _rel) = track_context(pool, track_id).await?;
    let mut credits_changed = false;
    for (field, value) in &fields {
        if !TRACK_FIELDS.contains(&field.as_str()) {
            return Err(format!("Unknown track field: {field}"));
        }
        let stored = match field.as_str() {
            "credits" => {
                credits_changed = true;
                let names: Vec<String> = value
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                serde_json::to_string(&names).map_err(|e| e.to_string())?
            }
            "track_number" | "disc_number" => match value.as_i64() {
                Some(n) if n > 0 => n.to_string(),
                _ => String::new(),
            },
            _ => value.as_str().unwrap_or_default().trim().to_string(),
        };
        upsert_override(pool, track_id, field, &stored).await?;
    }
    reapply_track_overrides(pool, track_id).await?;
    if credits_changed {
        // Newly credited names get artist pages (appears-on) right away.
        crate::music::ensure_credit_artists(pool, &library_id).await?;
    }
    Ok(())
}

/// Drop a track's user overrides and restore its columns from the file's own
/// tags (a fresh read — the literal "reset to file tags").
#[tauri::command]
pub async fn reset_track_fields(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<(), String> {
    let pool = &state.app_db;
    let (library_id, rel) = track_context(pool, track_id).await?;
    sqlx::query("DELETE FROM field_override WHERE entity_id = ? AND tier = 'user'")
        .bind(track_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    let abs = resolve_abs(pool, &library_id, &rel).await?;
    let rel_clone = rel.clone();
    let scanned = tauri::async_runtime::spawn_blocking(move || {
        crate::music::read_track_at(&abs, &rel_clone)
    })
    .await
    .map_err(|e| e.to_string())??;

    sqlx::query(
        "UPDATE track SET title = ?, sort_title = ?, track_number = ?, disc_number = ?,
                sort_order = COALESCE(?, 1) * 1000000 + COALESCE(?, 900) * 1000
         WHERE id = ?",
    )
    .bind(&scanned.title)
    .bind(generate_sort_title(&scanned.title, "en"))
    .bind(scanned.track_number)
    .bind(scanned.disc_number)
    .bind(scanned.disc_number)
    .bind(scanned.track_number)
    .bind(track_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Rebuild credits + track_meta from the fresh parse.
    let release_id: Option<(i64,)> =
        sqlx::query_as("SELECT release_id FROM track_release WHERE track_id = ?")
            .bind(track_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    if let Some((release_id,)) = release_id {
        crate::music::write_track_side_tables(pool, track_id, release_id, &scanned, true).await?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct AlbumEditView {
    pub id: i64,
    pub title: String,
    pub release_date: Option<String>,
    pub album_type: String,
    pub genres: Vec<String>,
    pub overridden: Vec<String>,
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
    let overrides = user_overrides(pool, album_id).await?;
    Ok(AlbumEditView {
        id: album_id,
        title,
        release_date,
        album_type,
        genres: genres.into_iter().map(|(g,)| g).collect(),
        overridden: overrides.into_keys().collect(),
    })
}

/// Apply user edits to an album: "title" (string), "release_date" (string or
/// null), "album_type" (album|ep|single|compilation), "genres" (array).
#[tauri::command]
pub async fn set_album_fields(
    state: State<'_, AppState>,
    album_id: i64,
    fields: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let pool = &state.app_db;
    for (field, value) in &fields {
        if !ALBUM_FIELDS.contains(&field.as_str()) {
            return Err(format!("Unknown album field: {field}"));
        }
        let stored = if field == "genres" {
            let names: Vec<String> = value
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            serde_json::to_string(&names).map_err(|e| e.to_string())?
        } else {
            let s = value.as_str().unwrap_or_default().trim().to_string();
            if field == "album_type"
                && !["album", "ep", "single", "compilation"].contains(&s.as_str())
            {
                return Err(format!("Invalid album type: {s}"));
            }
            s
        };
        upsert_override(pool, album_id, field, &stored).await?;
    }
    reapply_album_overrides(pool, album_id).await?;
    Ok(())
}

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
        overridden: overrides.into_keys().collect(),
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
    let pool = &state.app_db;
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
            // The tag name lives on as an alias — identity survives the rename.
            sqlx::query("INSERT OR IGNORE INTO artist_alias (artist_id, name) VALUES (?, ?)")
                .bind(artist_id)
                .bind(&old_name)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        upsert_override(pool, artist_id, "title", &new_name).await?;
    }
    reapply_artist_overrides(pool, artist_id).await?;
    Ok(())
}

/// Drop an artist's rename override. The tag-cased name returns on the next
/// rescan (the alias rows are left in place — they're harmless and keep old
/// references resolving).
#[tauri::command]
pub async fn reset_artist_fields(
    state: State<'_, AppState>,
    artist_id: i64,
) -> Result<(), String> {
    sqlx::query("DELETE FROM field_override WHERE entity_id = ? AND tier = 'user'")
        .bind(artist_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Drop an album's user overrides. Columns keep their current values until the
/// next rescan/matching pass re-derives them (album fields aren't stored in
/// any single file, so there is nothing to re-read on the spot).
#[tauri::command]
pub async fn reset_album_fields(
    state: State<'_, AppState>,
    album_id: i64,
) -> Result<(), String> {
    sqlx::query("DELETE FROM field_override WHERE entity_id = ? AND tier = 'user'")
        .bind(album_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Album combining
// ---------------------------------------------------------------------------

/// Tag-level identity of an album — what the scanner actually groups by
/// (majority album_artist + album tags, approximated here by one file's
/// tags). Directives must be keyed on THIS, not DB titles, which MusicBrainz
/// or user renames may have rewritten.
async fn album_tag_identity(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    album_id: i64,
) -> Result<(String, String), String> {
    let (rel,): (String,) = sqlx::query_as(
        "SELECT t.file_path FROM track t JOIN media_entry me ON me.id = t.id
         WHERE me.parent_id = ? LIMIT 1",
    )
    .bind(album_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Album has no tracks".to_string())?;
    let abs = crate::music::resolve_music_path(pool, library_id, &rel).await?;
    let scanned = crate::music::read_track_at(std::path::Path::new(&abs), &rel)?;
    Ok((scanned.album_artist.to_lowercase(), scanned.album.to_lowercase()))
}

/// Combine two albums: record a scan-time directive (so the combine survives
/// every future rescan — scans group by tags and would re-split a one-shot DB
/// merge), then the caller rescans to apply it. mode 'merge' folds the
/// source's tracks into the target's default release (disc numbers kept —
/// inline Disc N sections); 'versions' adds the source as a version in the
/// release picker. Merge validates that no (disc, track) slot is claimed by
/// both albums — colliding albums are alternate cuts and must combine as
/// versions.
#[tauri::command]
pub async fn combine_albums(
    state: State<'_, AppState>,
    library_id: String,
    source_id: i64,
    target_id: i64,
    mode: String,
) -> Result<(), String> {
    let pool = &state.app_db;
    if !matches!(mode.as_str(), "merge" | "versions") {
        return Err(format!("Invalid combine mode: {mode}"));
    }
    if source_id == target_id {
        return Err("An album can't be combined with itself".to_string());
    }
    for id in [source_id, target_id] {
        let ok: Option<(i64,)> = sqlx::query_as(
            "SELECT al.id FROM album al JOIN media_entry me ON me.id = al.id
             WHERE al.id = ? AND me.library_id = ?
               AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)",
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

    if mode == "merge" {
        // (disc, track) slots must not collide — that shape is a versions case.
        let slots = |album_id: i64| async move {
            let rows: Vec<(Option<i64>, Option<i64>)> = sqlx::query_as(
                "SELECT t.disc_number, t.track_number FROM track t
                 JOIN media_entry me ON me.id = t.id WHERE me.parent_id = ?",
            )
            .bind(album_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
            Ok::<_, String>(
                rows.into_iter()
                    .filter_map(|(d, n)| n.map(|n| (d.unwrap_or(1), n)))
                    .collect::<std::collections::HashSet<(i64, i64)>>(),
            )
        };
        let a = slots(source_id).await?;
        let b = slots(target_id).await?;
        if let Some((d, n)) = a.intersection(&b).next() {
            return Err(format!(
                "These albums both have a Disc {d}, Track {n} — combine them as versions instead"
            ));
        }
    }

    let (src_artist, src_title) = album_tag_identity(pool, &library_id, source_id).await?;
    let (tgt_artist, tgt_title) = album_tag_identity(pool, &library_id, target_id).await?;
    if src_artist == tgt_artist && src_title == tgt_title {
        return Err("These albums already share the same tag identity".to_string());
    }

    sqlx::query(
        "INSERT INTO album_combine (library_id, source_artist, source_title, target_artist, target_title, mode)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&library_id)
    .bind(&src_artist)
    .bind(&src_title)
    .bind(&tgt_artist)
    .bind(&tgt_title)
    .bind(&mode)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tag write-back (explicit, gated, atomic)
// ---------------------------------------------------------------------------

/// Write a track's current effective metadata into the audio file's tags.
/// Only runs when the `allow_tag_writeback` setting is "true" AND the user
/// explicitly asked (the editor's "also write to file" option). The write is
/// atomic: edit a temp copy, then swap it in with a backup of the original.
/// Overrides are kept — the user tier stays authoritative either way.
#[tauri::command]
pub async fn write_track_tags(state: State<'_, AppState>, track_id: i64) -> Result<(), String> {
    let pool = &state.app_db;
    let enabled: Option<(String,)> =
        sqlx::query_as("SELECT value FROM settings WHERE key = 'allow_tag_writeback'")
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    if enabled.map(|(v,)| v) != Some("true".to_string()) {
        return Err("Writing tags to files is disabled (Settings → Audio Player)".to_string());
    }

    let (library_id, rel) = track_context(pool, track_id).await?;
    let (title, track_number, disc_number): (String, Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT title, track_number, disc_number FROM track WHERE id = ?")
            .bind(track_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let credits: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM track_credit WHERE track_id = ? ORDER BY position")
            .bind(track_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    let credits: Vec<String> = credits.into_iter().map(|(n,)| n).collect();

    let abs = resolve_abs(pool, &library_id, &rel).await?;
    tauri::async_runtime::spawn_blocking(move || {
        write_tags_atomically(&abs, &title, &credits, track_number, disc_number)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn write_tags_atomically(
    abs: &Path,
    title: &str,
    credits: &[String],
    track_number: Option<i64>,
    disc_number: Option<i64>,
) -> Result<(), String> {
    use lofty::tag::Accessor;

    let dir = abs.parent().ok_or_else(|| "Invalid file path".to_string())?;
    let name = abs
        .file_name()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string_lossy()
        .to_string();
    let tmp = dir.join(format!(".wr-tmp-{name}"));
    let bak = dir.join(format!(".wr-bak-{name}"));

    // Work on a copy; the original is untouched until the final swap.
    std::fs::copy(abs, &tmp).map_err(|e| format!("copy failed: {e}"))?;
    let result = (|| -> Result<(), String> {
        let mut tagged = Probe::open(&tmp)
            .map_err(|e| e.to_string())?
            .read()
            .map_err(|e| e.to_string())?;
        if tagged.primary_tag_mut().is_none() {
            let tt = tagged.primary_tag_type();
            tagged.insert_tag(lofty::tag::Tag::new(tt));
        }
        let tag = tagged.primary_tag_mut().expect("tag just ensured");

        if title.is_empty() {
            tag.remove_key(&ItemKey::TrackTitle);
        } else {
            tag.set_title(title.to_string());
        }
        match track_number {
            Some(n) => tag.set_track(n as u32),
            None => tag.remove_track(),
        }
        match disc_number {
            Some(n) => tag.set_disk(n as u32),
            None => tag.remove_disk(),
        }
        if !credits.is_empty() {
            // Display string + multi-value ARTISTS frames (the Picard shape
            // the scanner's credit parser prefers).
            tag.set_artist(credits.join(", "));
            tag.remove_key(&ItemKey::TrackArtists);
            for c in credits {
                tag.push(TagItem::new(
                    ItemKey::TrackArtists,
                    ItemValue::Text(c.clone()),
                ));
            }
        }

        tagged
            .save_to_path(&tmp, WriteOptions::default())
            .map_err(|e| format!("tag write failed: {e}"))
    })();

    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    // Swap: original → backup, temp → original, drop backup. On any failure,
    // put the original back.
    std::fs::rename(abs, &bak).map_err(|e| format!("backup failed: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, abs) {
        let _ = std::fs::rename(&bak, abs);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("swap failed (original restored): {e}"));
    }
    let _ = std::fs::remove_file(&bak);
    Ok(())
}
