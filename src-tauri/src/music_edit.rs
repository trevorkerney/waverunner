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
        // EVERY name is a credit row — including a solo one. The credit list
        // is the only record of whose album this is (albums carry no artist
        // parent), and because this hook re-runs after every rescan's
        // reconcile, tag grouping can never drag the album back onto a
        // phantom credit ("Soundtrack", "Halo 2"). The first name's page is
        // created if missing (alias-aware) so the album lands somewhere real.
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
        if let Some(first) = names.first() {
            let lib: Option<(String,)> =
                sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
                    .bind(album_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            if let Some((library_id,)) = lib {
                crate::music::resolve_or_create_artist(pool, &library_id, first).await?;
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
        source_names.push(source_name.clone());
    }
    let members_json = serde_json::to_string(&members).map_err(|e| e.to_string())?;
    let mut written: Vec<String> = Vec::new();
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
        written.push(name.clone());
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
    stage_pending_change(
        pool,
        &library_id,
        "artist_split",
        &source_name.to_lowercase(),
        // artist_id: the entity this staging DISSOLVES — the UI locks it
        // (any edit made now would be discarded when the rescan applies).
        &serde_json::json!({ "sources": written, "artist_id": artist_id }),
        &format!("Split \u{201c}{source_name}\u{201d} into {}", members.join(" · ")),
    )
    .await?;
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
        // Exact match only — a split member is a specific artist, and a fuzzy
        // hit here would silently attach albums to the wrong page.
        let row: Option<(i64, String, Option<String>, String, i64)> = sqlx::query_as(
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
    let pool = &state.app_db;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("No credit name given".to_string());
    }
    ensure_not_staged(pool, target_artist_id).await?;
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
    crate::music_mb::merge_artists(pool, &library_id, target_artist_id, &target_title, source_id, &name)
        .await?;
    crate::music_mb::enqueue_pass_recheck(pool, &library_id, target_artist_id, &target_title, &name)
        .await
}

/// Rename one release's label. Stored as a folder-keyed pref (release rows
/// are rebuilt every rescan) and applied live — an in-app preference, instant
/// like the rest of them.
#[tauri::command]
pub async fn set_release_label(
    state: State<'_, AppState>,
    release_id: i64,
    label: String,
) -> Result<(), String> {
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

/// Choose which release is the album's default (the one the page opens on and
/// Play plays). Folder-keyed pref + live flip, rescan-proof.
#[tauri::command]
pub async fn set_default_release(
    state: State<'_, AppState>,
    release_id: i64,
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
        "INSERT INTO album_release_pref (album_id, folder_path, label, is_default)
         VALUES (?, ?, NULL, 1)
         ON CONFLICT(album_id, folder_path) DO UPDATE SET is_default = 1",
    )
    .bind(album_id)
    .bind(&folder)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE album_release_pref SET is_default = 0 WHERE album_id = ? AND folder_path != ?")
        .bind(album_id)
        .bind(&folder)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE album_release SET is_default = (id = ?) WHERE album_id = ?")
        .bind(release_id)
        .bind(album_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
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
    let credits_before = track_credit_names(pool, track_id).await?;
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
        // Actually-different credits on a matched album are fresh evidence a
        // pass can walk — surface that in the queue. (Saving the dialog with
        // the credits untouched arms nothing.)
        if track_credit_names(pool, track_id).await? != credits_before {
            crate::music_mb::enqueue_track_credit_recheck(pool, &library_id, track_id).await?;
        }
    }
    Ok(())
}

/// A track's credit names in order — the before/after probe the edit and
/// reset paths use to tell a real credit change from a no-op save.
async fn track_credit_names(pool: &SqlitePool, track_id: i64) -> Result<Vec<String>, String> {
    Ok(sqlx::query_as::<_, (String,)>(
        "SELECT name FROM track_credit WHERE track_id = ? ORDER BY position",
    )
    .bind(track_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(n,)| n)
    .collect())
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
    let credits_before = track_credit_names(pool, track_id).await?;
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
        // Reverting to tag credits is a credit change like any other — if the
        // tags name someone the album's match evidence could prove, queue it.
        if track_credit_names(pool, track_id).await? != credits_before {
            crate::music_mb::enqueue_track_credit_recheck(pool, &library_id, track_id).await?;
        }
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
        // Credit-less album (no artist tags anywhere): nothing to prefill —
        // every credited album carries its rows, solo included.
        let owner: Option<(String,)> = sqlx::query_as(
            "SELECT ac.name FROM album_artist_credit ac WHERE ac.album_id = ? ORDER BY ac.position LIMIT 1",
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
    ensure_not_staged(pool, album_id).await?;
    // Before-images for the two fields that arm pass work when they actually
    // change — a save with them untouched must enqueue nothing.
    let (title_before,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let credits_before = album_credit_names(pool, album_id).await?;
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
    let library_id: Option<(String,)> =
        sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
            .bind(album_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    if let Some((lib,)) = library_id {
        if fields.contains_key("artist_credits") {
            // Newly credited co-artists get pages (and the album in their
            // discography) immediately.
            crate::music::ensure_credit_artists(pool, &lib).await?;
            if album_credit_names(pool, album_id).await? != credits_before {
                crate::music_mb::enqueue_album_credit_recheck(pool, &lib, album_id).await?;
            }
        }
        if fields.contains_key("title") {
            let (title_after,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
                .bind(album_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            if title_after != title_before {
                crate::music_mb::requeue_renamed_album(pool, &lib, album_id).await?;
            }
        }
    }
    Ok(())
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
    ensure_not_staged(pool, artist_id).await?;
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
            // The tag name lives on as an alias — identity survives the rename.
            sqlx::query(
                "INSERT OR IGNORE INTO artist_alias (artist_id, name, kind) VALUES (?, ?, 'variant')",
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
        // walk a merge gets, and the queue should say a pass has work.
        let library_id: Option<(String,)> =
            sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
                .bind(artist_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((lib,)) = library_id {
            crate::music_mb::requeue_renamed_artist(pool, &lib, artist_id).await?;
        }
    }
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
    ensure_not_staged(&state.app_db, artist_id).await?;
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
    ensure_not_staged(&state.app_db, album_id).await?;
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
            "SELECT al.title,
                    (SELECT ac.name FROM album_artist_credit ac
                     WHERE ac.album_id = al.id ORDER BY ac.position LIMIT 1)
             FROM album al
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
        // Combining into (or out of) an album another staged action will
        // dissolve is contradictory — staged = immutable.
        ensure_not_staged(pool, *id).await?;
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
    let mut staged_source_ids: Vec<i64> = Vec::new();
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
        staged_source_ids.push(*src);
    }
    if directives.is_empty() {
        return Err("These albums are already combined".to_string());
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let mut directive_ids: Vec<i64> = Vec::new();
    for (src_artist, src_title, src_name) in &directives {
        let res = sqlx::query(
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
        directive_ids.push(res.last_insert_rowid());
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    let combined: Vec<String> =
        directives.iter().map(|(_, _, n)| format!("\u{201c}{n}\u{201d}")).collect();
    // A merge rewrites the keeper's track list, so an applied MusicBrainz
    // match stops being proven — the rescan drops it (apply_album_combines)
    // and the album needs rematching against its full track list. Said here,
    // at staging time, so it never comes as a surprise.
    let drops_match = mode == "merge"
        && sqlx::query_scalar::<_, i64>(
            "SELECT EXISTS (SELECT 1 FROM release_match WHERE album_id = ?)",
        )
        .bind(target_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?
            != 0;
    stage_pending_change(
        pool,
        &library_id,
        "album_combine",
        "",
        // source_album_ids: the entries this staging DISSOLVES (they fold
        // into the target on rescan) — the UI locks them.
        &serde_json::json!({ "ids": directive_ids, "source_album_ids": staged_source_ids }),
        &format!(
            "Combine {} into \u{201c}{tgt_name}\u{201d}{}",
            combined.join(", "),
            if drops_match {
                " — clears its MusicBrainz match; rematch after the rescan"
            } else {
                ""
            }
        ),
    )
    .await?;
    Ok(())
}

/// Is this entity frozen by a staged rescan action? True for split-source
/// artists and combine-source albums (both DISSOLVE when the rescan applies),
/// and for albums CREDITED to a staged-split artist — those survive, but
/// their credit spine is about to be rewritten, so edits wait too. The name
/// checks cover legacy rows staged before payloads carried entity ids.
pub(crate) async fn is_staged_for_rescan(
    pool: &SqlitePool,
    entity_id: i64,
) -> Result<bool, String> {
    let lib: Option<(String,)> =
        sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
            .bind(entity_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some((library_id,)) = lib else { return Ok(false) };
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT kind, target, payload FROM pending_change WHERE library_id = ?",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(false);
    }

    // The staged populations, gathered once.
    let mut split_artist_ids: Vec<i64> = Vec::new();
    let mut split_targets: Vec<String> = Vec::new();
    let mut combine_source_ids: Vec<i64> = Vec::new();
    for (kind, target, payload) in rows {
        let p: serde_json::Value =
            serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
        match kind.as_str() {
            "artist_split" => {
                if let Some(id) = p["artist_id"].as_i64() {
                    split_artist_ids.push(id);
                }
                if !target.is_empty() {
                    split_targets.push(target);
                }
            }
            "album_combine" => combine_source_ids.extend(
                p["source_album_ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_i64()),
            ),
            _ => {}
        }
    }
    if split_artist_ids.is_empty() && split_targets.is_empty() && combine_source_ids.is_empty() {
        return Ok(false);
    }

    if combine_source_ids.contains(&entity_id) || split_artist_ids.contains(&entity_id) {
        return Ok(true);
    }
    let title: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT COALESCE(ar.title, al.title) FROM media_entry me
         LEFT JOIN artist ar ON ar.id = me.id
         LEFT JOIN album al ON al.id = me.id
         WHERE me.id = ?",
    )
    .bind(entity_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let title_l = title.and_then(|(t,)| t).map(|t| t.to_lowercase());
    if title_l.as_deref().is_some_and(|t| split_targets.iter().any(|s| s == t)) {
        return Ok(true);
    }

    // Albums credited to a staged-split artist: the split rewrites their
    // credit rows on rescan, so they wait with it.
    let credits: Vec<(String, Option<i64>)> = sqlx::query_as(
        "SELECT ac.name, ac.artist_id FROM album_artist_credit ac WHERE ac.album_id = ?",
    )
    .bind(entity_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (name, artist_id) in credits {
        if artist_id.is_some_and(|id| split_artist_ids.contains(&id))
            || split_targets.iter().any(|s| *s == name.to_lowercase())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// STAGED = IMMUTABLE: edits and matches on an entity a staged action will
/// dissolve would be silently discarded when the rescan applies — refuse
/// them with the way out named.
pub(crate) async fn ensure_not_staged(pool: &SqlitePool, entity_id: i64) -> Result<(), String> {
    if is_staged_for_rescan(pool, entity_id).await? {
        return Err(
            "Staged for rescan — undo the staged change (metadata center banner) or rescan first"
                .to_string(),
        );
    }
    Ok(())
}

/// Record one staged, rescan-applied user action in the library's pending
/// list. The directive itself is already durable and rescan-idempotent; this
/// row only says "written but not applied yet", so decisions batch behind ONE
/// rescan instead of forcing one per action. Any successful rescan clears the
/// list. `kind` + `payload` make the row UNDOABLE (unstage_pending_change
/// reverts the directive); a non-empty `target` dedups — restaging the same
/// action replaces its row instead of stacking duplicates.
pub(crate) async fn stage_pending_change(
    pool: &SqlitePool,
    library_id: &str,
    kind: &str,
    target: &str,
    payload: &serde_json::Value,
    label: &str,
) -> Result<(), String> {
    if !target.is_empty() {
        sqlx::query(
            "DELETE FROM pending_change WHERE library_id = ? AND kind = ? AND target = ?",
        )
        .bind(library_id)
        .bind(kind)
        .bind(target)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    sqlx::query(
        "INSERT INTO pending_change (library_id, label, kind, target, payload) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(library_id)
    .bind(label)
    .bind(kind)
    .bind(target)
    .bind(payload.to_string())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct PendingChange {
    pub id: i64,
    pub label: String,
    /// Directive family ('' = legacy row, revert unavailable).
    pub kind: String,
    /// Dedup key — for splits, the lowercased source name (the UI hides that
    /// artist's row while the split is staged).
    pub target: String,
    /// Entities this staging DISSOLVES on rescan (split-source artists,
    /// combine-source albums) — the UI locks every edit on them, since any
    /// change made now would be discarded when the rescan applies.
    pub locked_ids: Vec<i64>,
}

/// The staged actions a rescan will apply, oldest first.
#[tauri::command]
pub async fn get_pending_changes(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<Vec<PendingChange>, String> {
    let rows: Vec<(i64, String, String, String, String)> = sqlx::query_as(
        "SELECT id, label, kind, target, payload FROM pending_change WHERE library_id = ? ORDER BY id",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, label, kind, target, payload)| {
            let p: serde_json::Value =
                serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
            let locked_ids: Vec<i64> = match kind.as_str() {
                "artist_split" => p["artist_id"].as_i64().into_iter().collect(),
                "album_combine" => p["source_album_ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_i64())
                    .collect(),
                _ => Vec::new(),
            };
            PendingChange { id, label, kind, target, locked_ids }
        })
        .collect())
}

/// Un-stage one pending change: revert the directive it wrote and drop the
/// row — the library returns to exactly how it stood before the action, no
/// rescan needed (nothing had applied yet).
#[tauri::command]
pub async fn unstage_pending_change(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let pool = &state.app_db;
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT library_id, kind, payload FROM pending_change WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some((library_id, kind, payload)) = row else {
        return Ok(()); // already gone
    };
    let p: serde_json::Value = serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
    match kind.as_str() {
        "artist_split" => {
            for s in p["sources"].as_array().into_iter().flatten() {
                if let Some(name) = s.as_str() {
                    sqlx::query(
                        "DELETE FROM artist_split WHERE library_id = ? AND source_name = ?",
                    )
                    .bind(&library_id)
                    .bind(name)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        "album_combine" => {
            for cid in p["ids"].as_array().into_iter().flatten() {
                if let Some(cid) = cid.as_i64() {
                    sqlx::query("DELETE FROM album_combine WHERE id = ?")
                        .bind(cid)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        "combine_removed" => {
            // Un-staging an un-combine (or a separate that removed a combine)
            // puts the deleted directive back.
            let r = &p["row"];
            sqlx::query(
                "INSERT INTO album_combine
                 (library_id, source_artist, source_title, target_artist, target_title, mode,
                  target_folder, source_name, target_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&library_id)
            .bind(r["source_artist"].as_str().unwrap_or_default())
            .bind(r["source_title"].as_str().unwrap_or_default())
            .bind(r["target_artist"].as_str().unwrap_or_default())
            .bind(r["target_title"].as_str().unwrap_or_default())
            .bind(r["mode"].as_str().unwrap_or("versions"))
            .bind(r["target_folder"].as_str())
            .bind(r["source_name"].as_str())
            .bind(r["target_name"].as_str())
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
        "release_split" => {
            if let Some(folder) = p["folder_path"].as_str() {
                sqlx::query(
                    "DELETE FROM album_release_split WHERE library_id = ? AND folder_path = ?",
                )
                .bind(&library_id)
                .bind(folder)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        // Legacy rows (pre-undo staging) carry no revert data — removing the
        // label is all that can be done.
        _ => {}
    }
    sqlx::query("DELETE FROM pending_change WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
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

/// Full copy of a combine directive, taken BEFORE deleting it — what
/// un-staging the deletion needs to put the row back.
async fn combine_row_snapshot(
    pool: &SqlitePool,
    combine_id: i64,
) -> Result<serde_json::Value, String> {
    let row: (String, String, String, String, String, Option<String>, Option<String>, Option<String>) =
        sqlx::query_as(
            "SELECT source_artist, source_title, target_artist, target_title, mode,
                    target_folder, source_name, target_name
             FROM album_combine WHERE id = ?",
        )
        .bind(combine_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "source_artist": row.0, "source_title": row.1, "target_artist": row.2,
        "target_title": row.3, "mode": row.4, "target_folder": row.5,
        "source_name": row.6, "target_name": row.7,
    }))
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
    let (library_id, source_name, source_title): (String, Option<String>, String) =
        sqlx::query_as("SELECT library_id, source_name, source_title FROM album_combine WHERE id = ?")
            .bind(combine_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That combine no longer exists".to_string())?;
    let snapshot = combine_row_snapshot(pool, combine_id).await?;
    sqlx::query("DELETE FROM album_combine WHERE id = ?")
        .bind(combine_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    let name = source_name.unwrap_or(source_title);
    stage_pending_change(
        pool,
        &library_id,
        "combine_removed",
        "",
        &serde_json::json!({ "row": snapshot }),
        &format!("Un-combine \u{201c}{name}\u{201d} back into its own album"),
    )
    .await?;
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
                    let snapshot = combine_row_snapshot(pool, id).await?;
                    sqlx::query("DELETE FROM album_combine WHERE id = ?")
                        .bind(id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    stage_pending_change(
                        pool,
                        &library_id,
                        "combine_removed",
                        "",
                        &serde_json::json!({ "row": snapshot }),
                        &format!("Separate an edition of \u{201c}{}\u{201d}", album_title_for(pool, album_id).await?),
                    )
                    .await?;
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
    stage_pending_change(
        pool,
        &library_id,
        "release_split",
        &folder_path.to_lowercase(),
        &serde_json::json!({ "folder_path": folder_path }),
        &format!("Separate an edition of \u{201c}{}\u{201d}", album_title_for(pool, album_id).await?),
    )
    .await?;
    Ok(library_id)
}

/// Album display title for pending-change labels.
async fn album_title_for(pool: &SqlitePool, album_id: i64) -> Result<String, String> {
    sqlx::query_as::<_, (String,)>("SELECT title FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
        .map(|r| r.map(|(t,)| t).unwrap_or_default())
}
