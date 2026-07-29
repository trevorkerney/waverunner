//! In-app metadata editing — the user tier of the per-field provenance model.
//!
//! Edits land in field_override (tier 'user') AND are applied to the regular
//! columns, so every read path stays untouched. Scan/reconcile and the
//! MusicBrainz pass re-stomp (or skip) overridden fields — see the reapply
//! hooks — so a rescan can never clobber a user edit. Media files stay
//! read-only: metadata is fully virtual and audio files are never modified
//! (tag write-back existed briefly and was removed by design).
//!
//! Track fields: title, credits (ordered artist list), track_number,
//! disc_number. Album fields: title, release_date, album_type.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use lofty::file::TaggedFileExt;
use lofty::probe::Probe;
use lofty::tag::ItemKey;
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::commands::generate_sort_title;
use crate::AppState;

// ---------------------------------------------------------------------------
// Override storage
// ---------------------------------------------------------------------------

const TRACK_FIELDS: &[&str] = &["title", "credits", "track_number", "disc_number"];
const ALBUM_FIELDS: &[&str] = &["title", "release_date", "album_type", "genres", "artist_credits"];
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
    if let Some(raw) = overrides.get("artist_credits") {
        let names: Vec<String> = serde_json::from_str(raw).unwrap_or_default();
        sqlx::query("DELETE FROM album_artist_credit WHERE album_id = ?")
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        // A single name means "one owner" — no credit rows, parent displays.
        if names.len() >= 2 {
            for (i, name) in names.iter().enumerate() {
                sqlx::query(
                    "INSERT INTO album_artist_credit (album_id, position, name) VALUES (?, ?, ?)",
                )
                .bind(album_id)
                .bind(i as i64)
                .bind(name)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        // OWNERSHIP rides the credit: the album reparents onto the first
        // name (resolved alias-aware, page created if missing). An explicit
        // user credit beats the tag-derived parent — and because this hook
        // re-runs after every rescan's reconcile, tag grouping can never
        // drag the album back under a phantom ("Soundtrack", "Halo 2").
        if let Some(first) = names.first() {
            let lib: Option<(String,)> =
                sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
                    .bind(album_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            if let Some((library_id,)) = lib {
                let owner =
                    crate::music::resolve_or_create_artist(pool, &library_id, first).await?;
                sqlx::query("UPDATE media_entry SET parent_id = ? WHERE id = ?")
                    .bind(owner)
                    .bind(album_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
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

/// Record an artist-split directive: this artist's NAME is really several
/// artists ("JAY-Z & Kanye West" → [JAY-Z, Kanye West]). The directive is
/// applied on every scan — members[0] becomes the canonical owner of the
/// joint albums, the full list becomes their album-level credit, and matching
/// track credits split the same way. The caller follows up with a rescan,
/// which performs the actual migration (reparenting, credit rewrite, sweeping
/// the now-empty joint entry). Returns the library id for that rescan call.
#[tauri::command]
pub async fn split_artist(
    state: State<'_, AppState>,
    artist_id: i64,
    members: Vec<String>,
) -> Result<String, String> {
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
        source_names.push(source_name);
    }
    let members_json = serde_json::to_string(&members).map_err(|e| e.to_string())?;
    for name in &source_names {
        if members.iter().any(|m| m.eq_ignore_ascii_case(name)) {
            continue; // never map a member's own name onto the split
        }
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
    }

    // Album-combine directives are keyed by SCAN-TIME tag identity (artist +
    // title), and the split rewrites those scanned artists to members[0]
    // before combines apply — so any combine keyed to a name being split
    // would go dormant and its albums fall back apart. Migrate the keys.
    let new_key = members[0].to_lowercase();
    for name in &source_names {
        let old_key = name.to_lowercase();
        for col in ["source_artist", "target_artist"] {
            sqlx::query(&format!(
                "UPDATE album_combine SET {col} = ? WHERE library_id = ? AND {col} = ?",
            ))
            .bind(&new_key)
            .bind(&library_id)
            .bind(&old_key)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(library_id)
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
    /// Current artist credit: the album_artist_credit rows when multi-artist,
    /// else the owning artist alone. The editor's artist rows start here.
    pub artist_credits: Vec<String>,
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
    let mut artist_credits: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT name FROM album_artist_credit WHERE album_id = ? ORDER BY position",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(n,)| n)
    .collect();
    if artist_credits.is_empty() {
        // Single-owner album: prefill with the parent artist so adding a
        // co-artist is one row away.
        let owner: Option<(String,)> = sqlx::query_as(
            "SELECT a.title FROM artist a JOIN media_entry me ON me.parent_id = a.id WHERE me.id = ?",
        )
        .bind(album_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if let Some((t,)) = owner {
            artist_credits.push(t);
        }
    }
    let overrides = user_overrides(pool, album_id).await?;
    Ok(AlbumEditView {
        id: album_id,
        title,
        release_date,
        album_type,
        genres: genres.into_iter().map(|(g,)| g).collect(),
        artist_credits,
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
        let stored = if field == "genres" || field == "artist_credits" {
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
    if fields.contains_key("artist_credits") {
        // Newly credited co-artists get pages (and the album in their
        // discography) immediately.
        let library_id: Option<(String,)> =
            sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
                .bind(album_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((lib,)) = library_id {
            crate::music::ensure_credit_artists(pool, &lib).await?;
        }
    }
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
/// or user renames may have rewritten. The raw tag artist is mapped through
/// the library's split directives (and the ';' convention) — scans rewrite
/// split names to members[0] BEFORE combines apply, so a directive keyed to
/// the raw pre-split tag would never match anything.
async fn tag_identity_of_file(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    rel: &str,
) -> Result<(String, String), String> {
    let abs = crate::music::resolve_music_path(pool, library_id, rel).await?;
    let scanned = crate::music::read_track_at(std::path::Path::new(&abs), rel)?;
    let splits = crate::music::load_artist_splits(pool, library_id).await?;
    let artist = match crate::music::split_members(&splits, &scanned.album_artist) {
        Some(members) if !members.is_empty() => members[0].clone(),
        _ => scanned.album_artist.clone(),
    };
    Ok((artist.to_lowercase(), scanned.album.to_lowercase()))
}

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
    tag_identity_of_file(pool, library_id, &rel).await
}

/// Tag identity of ONE edition (its own folder's files) — an album's editions
/// share the identity, but a combine-folded edition carries the identity of
/// the album it came from, which is how the split action tells the two kinds
/// of edition apart.
async fn release_tag_identity(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    release_id: i64,
) -> Result<(String, String), String> {
    let (rel,): (String,) = sqlx::query_as(
        "SELECT t.file_path FROM track t
         JOIN track_release tr ON tr.track_id = t.id
         WHERE tr.release_id = ? LIMIT 1",
    )
    .bind(release_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Edition has no tracks".to_string())?;
    tag_identity_of_file(pool, library_id, &rel).await
}

/// One album in a combine selection: what the dialog shows, plus the
/// editions it holds (the keeper's are pickable merge targets; a non-keeper
/// with several is refused by merge).
#[derive(Serialize)]
pub struct CombineEdition {
    pub release_id: i64,
    pub label: Option<String>,
    pub folder_path: String,
    pub is_default: bool,
    pub track_count: i64,
}

#[derive(Serialize)]
pub struct CombineAlbumInfo {
    pub id: i64,
    pub title: String,
    /// Owning artist — two same-titled albums are otherwise indistinguishable.
    pub artist: Option<String>,
    pub track_count: i64,
    pub editions: Vec<CombineEdition>,
}

#[tauri::command]
pub async fn get_combine_info(
    state: State<'_, AppState>,
    album_ids: Vec<i64>,
) -> Result<Vec<CombineAlbumInfo>, String> {
    let pool = &state.app_db;
    let mut out = Vec::with_capacity(album_ids.len());
    for id in album_ids {
        let Some((title, artist)) = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT al.title, ar.title FROM album al
             JOIN media_entry me ON me.id = al.id
             LEFT JOIN artist ar ON ar.id = me.parent_id
             WHERE al.id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        else {
            continue; // vanished mid-selection (rescan) — just drop it
        };
        let (track_count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM media_entry WHERE parent_id = ?")
                .bind(id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
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
        out.push(CombineAlbumInfo {
            id,
            title,
            artist,
            track_count,
            editions: rows
                .into_iter()
                .map(|(release_id, label, folder_path, is_default, track_count)| CombineEdition {
                    release_id,
                    label,
                    folder_path,
                    is_default: is_default != 0,
                    track_count,
                })
                .collect(),
        });
    }
    Ok(out)
}

/// Combine albums: every non-keeper folds into the keeper (whose title,
/// metadata, overrides and identity survive), recorded as scan-time
/// directives so the result survives every future rescan.
///
/// mode 'merge' pours the others' tracks into ONE edition of the keeper
/// (`target_release_folder`, else its default). Rules, all refusals rather
/// than guesses:
///   - no two albums may claim the same (disc, track) slot — the user retags
///     the files themselves; the app never renumbers;
///   - a non-keeper with several editions is refused (pouring a set of
///     alternate cuts into one track list has no honest meaning) — split its
///     editions first.
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
) -> Result<(), String> {
    let pool = &state.app_db;
    if !matches!(mode.as_str(), "merge" | "versions") {
        return Err(format!("Invalid combine mode: {mode}"));
    }
    let mut seen_ids = std::collections::HashSet::new();
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
    // collections) have no tag identity to key a directive on.
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

    // Slots of ONE edition. Per-edition (not per-album) so an album's own
    // editions — which are SUPPOSED to share track numbers — never collide
    // with each other.
    let slots_of_release = |release_id: i64| async move {
        let rows: Vec<(Option<i64>, Option<i64>)> = sqlx::query_as(
            "SELECT t.disc_number, t.track_number FROM track t
             JOIN track_release tr ON tr.track_id = t.id
             WHERE tr.release_id = ?",
        )
        .bind(release_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok::<_, String>(
            rows.into_iter()
                .filter_map(|(d, n)| n.map(|n| (d.unwrap_or(1), n)))
                .collect::<std::collections::HashSet<(i64, i64)>>(),
        )
    };

    let mut merge_target_folder: Option<String> = None;
    if mode == "merge" {
        // The keeper edition the tracks land in — the only one merge touches,
        // so it's the only one worth comparing against.
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
        if keeper_editions.len() > 1 {
            merge_target_folder = Some(keeper_release.1.clone());
        }

        let mut claimed: std::collections::HashMap<(i64, i64), i64> =
            slots_of_release(keeper_release.0)
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
                for slot in slots_of_release(*release_id).await? {
                    if let Some(other) = claimed.insert(slot, *src) {
                        let (d, n) = slot;
                        return Err(format!(
                            "\"{}\" and \"{}\" both have a Disc {d}, Track {n} — retag one of them, or combine as separate releases",
                            title_of(other).await?,
                            title_of(*src).await?,
                        ));
                    }
                }
            }
        }
    }

    let (tgt_artist, tgt_title) = album_tag_identity(pool, &library_id, target_id).await?;
    let tgt_name = title_of(target_id).await?;
    // Directives already on file — a duplicate would apply twice, and a
    // REVERSE one makes both albums each other's missing target, so neither
    // combine applies and they silently stay apart.
    let existing: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT source_artist, source_title, target_artist, target_title
         FROM album_combine WHERE library_id = ?",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut directives: Vec<(String, String, String)> = Vec::new();
    for src in &sources {
        let (src_artist, src_title) = album_tag_identity(pool, &library_id, *src).await?;
        let src_name = title_of(*src).await?;
        if src_artist == tgt_artist && src_title == tgt_title {
            continue; // same tag identity — already one album at scan time
        }
        if existing
            .iter()
            .any(|(sa, st, ta, tt)| *sa == src_artist && *st == src_title && *ta == tgt_artist && *tt == tgt_title)
        {
            continue; // already combined this way — nothing to add
        }
        if existing
            .iter()
            .any(|(sa, st, ta, tt)| *sa == tgt_artist && *st == tgt_title && *ta == src_artist && *tt == src_title)
        {
            return Err(format!(
                "\"{tgt_name}\" is already combined into \"{src_name}\" — undo that first"
            ));
        }
        // Chains don't resolve (every source is pulled out before any fold, so
        // a middle album is never there to receive), so refuse them outright.
        if existing.iter().any(|(sa, st, _, _)| *sa == tgt_artist && *st == tgt_title) {
            return Err(format!(
                "\"{tgt_name}\" is itself combined into another album — undo that first, or keep that album instead"
            ));
        }
        if existing.iter().any(|(_, _, ta, tt)| *ta == src_artist && *tt == src_title) {
            return Err(format!(
                "\"{src_name}\" has other albums combined into it — undo those first"
            ));
        }
        directives.push((src_artist, src_title, src_name));
    }
    if directives.is_empty() {
        return Err("These albums are already combined".to_string());
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for (src_artist, src_title, src_name) in &directives {
        sqlx::query(
            "INSERT INTO album_combine
             (library_id, source_artist, source_title, target_artist, target_title, mode,
              target_folder, source_name, target_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&library_id)
        .bind(src_artist)
        .bind(src_title)
        .bind(&tgt_artist)
        .bind(&tgt_title)
        .bind(&mode)
        .bind(&merge_target_folder)
        .bind(src_name)
        .bind(&tgt_name)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// An album folded into this one by a user combine — the undo list.
#[derive(Serialize)]
pub struct AbsorbedAlbum {
    pub combine_id: i64,
    pub name: String,
    pub mode: String,
}

#[tauri::command]
pub async fn get_album_absorbed(
    state: State<'_, AppState>,
    album_id: i64,
) -> Result<Vec<AbsorbedAlbum>, String> {
    let pool = &state.app_db;
    let Some((library_id,)) =
        sqlx::query_as::<_, (String,)>("SELECT library_id FROM media_entry WHERE id = ?")
            .bind(album_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
    else {
        return Ok(Vec::new());
    };
    // Tag identity is what directives key on; an album with no tracks (or
    // unreadable files) simply has nothing folded into it.
    let Ok((artist, title)) = album_tag_identity(pool, &library_id, album_id).await else {
        return Ok(Vec::new());
    };
    let rows: Vec<(i64, String, String, Option<String>)> = sqlx::query_as(
        "SELECT c.id, c.source_title, c.mode, c.source_name
         FROM album_combine c
         WHERE c.library_id = ? AND c.target_artist = ? AND c.target_title = ?
         ORDER BY c.id",
    )
    .bind(&library_id)
    .bind(&artist)
    .bind(&title)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(combine_id, source_title, mode, source_name)| AbsorbedAlbum {
            combine_id,
            // Directives store lowercased tag keys; the display name is only
            // recorded for combines made after that table existed.
            name: source_name.unwrap_or(source_title),
            mode,
        })
        .collect())
}

/// Undo one combine: the folded-in album returns as its own album on the next
/// scan (nothing on disk moves, and the tracks keep their ids/history).
/// Returns the library to rescan.
#[tauri::command]
pub async fn undo_album_combine(
    state: State<'_, AppState>,
    combine_id: i64,
) -> Result<String, String> {
    let pool = &state.app_db;
    let (library_id,): (String,) =
        sqlx::query_as("SELECT library_id FROM album_combine WHERE id = ?")
            .bind(combine_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That combine no longer exists".to_string())?;
    sqlx::query("DELETE FROM album_combine WHERE id = ?")
        .bind(combine_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(library_id)
}

/// Separate one edition into an album of its own. Two kinds of edition need
/// two mechanisms: a COMBINED-in edition is undone by dropping its directive,
/// while a SCANNER-grouped one (another folder with identical album tags)
/// needs a standing directive telling the scanner to keep it apart.
/// Returns the library to rescan.
#[tauri::command]
pub async fn split_album_release(
    state: State<'_, AppState>,
    release_id: i64,
) -> Result<String, String> {
    let pool = &state.app_db;
    let (album_id, folder_path): (i64, String) =
        sqlx::query_as("SELECT album_id, folder_path FROM album_release WHERE id = ?")
            .bind(release_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That edition no longer exists".to_string())?;
    let (library_id,): (String,) =
        sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
            .bind(album_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Album not found".to_string())?;
    let (edition_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM album_release WHERE album_id = ?")
            .bind(album_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    if edition_count < 2 {
        return Err("This album has only one edition".to_string());
    }

    // Combine-made edition? Its files carry the folded-in album's tag
    // identity, so a matching directive is what put it here.
    if let Ok(edition_id) = release_tag_identity(pool, &library_id, release_id).await {
        if let Ok(album_ident) = album_tag_identity(pool, &library_id, album_id).await {
            if edition_id != album_ident {
                let existing: Option<(i64,)> = sqlx::query_as(
                    "SELECT id FROM album_combine
                     WHERE library_id = ? AND source_artist = ? AND source_title = ?
                       AND target_artist = ? AND target_title = ?",
                )
                .bind(&library_id)
                .bind(&edition_id.0)
                .bind(&edition_id.1)
                .bind(&album_ident.0)
                .bind(&album_ident.1)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
                if let Some((id,)) = existing {
                    sqlx::query("DELETE FROM album_combine WHERE id = ?")
                        .bind(id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(library_id);
                }
            }
        }
    }

    // Scanner-grouped edition: standing directive, applied every scan.
    sqlx::query(
        "INSERT OR IGNORE INTO album_release_split (library_id, folder_path) VALUES (?, ?)",
    )
    .bind(&library_id)
    .bind(&folder_path)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(library_id)
}
