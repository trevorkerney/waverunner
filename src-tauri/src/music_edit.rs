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

/// The value tiers. field_override is a TIERED VALUE STORE, not just an
/// override list: the scanner writes what the files say at 'tag', matching
/// writes what MusicBrainz says at 'mb', edits write 'user'. A column always
/// shows the highest tier that has a value, so "Clear overrides" is nothing
/// more than "delete the user tier and re-resolve" — no fetch, no rescan.
/// (Tracks keep their tag tier IN the file: a reset re-reads it.)
pub(crate) const TIER_TAG: &str = "tag";

/// "Clear overrides" deletes ONLY the fields its edit dialog owns. The same
/// table, at the same 'user' tier, also holds hand-picked MusicBrainz ids
/// and flags (release group, recording, artist MBID, ignored, partial) —
/// a blanket tier delete silently unmatched hand-matched albums. Field
/// names are compile-time constants, so inlining them is safe.
/// The edit dialog's "overridden" list — only ITS fields, for the same reason
/// as the reset: hand-picked MB ids share the tier, and a freshly matched
/// album must not show a Clear overrides button it has no edits behind.
fn edited_fields(overrides: &HashMap<String, String>, fields: &[&str]) -> Vec<String> {
    overrides.keys().filter(|f| fields.contains(&f.as_str())).cloned().collect()
}

/// Store an entity's TAG tier and invalidate what sat above any field whose
/// tag value CHANGED since the last scan. A retag at the source is the base
/// moving: the MB value and the user edit for that field were answers about
/// the old base, so they go, and the column falls to the new tag value when
/// the reapply hook runs after this. Per field — a changed date tag never
/// touches a title edit. Returns the changed fields. The first write (nothing
/// stored yet) changes nothing: there is no old base to compare against.
pub(crate) async fn store_tag_tier(
    pool: &SqlitePool,
    entity_id: i64,
    values: &[(&str, String)],
) -> Result<Vec<String>, String> {
    let prev = tier_values(pool, entity_id, TIER_TAG).await?;
    let mut changed = Vec::new();
    for (field, value) in values {
        if let Some(old) = prev.get(*field) {
            if old != value {
                invalidate_field(pool, entity_id, field).await?;
                changed.push(field.to_string());
            }
        }
        crate::music_mb::set_mb_id(pool, entity_id, field, value, TIER_TAG).await?;
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

pub(crate) fn track_fields() -> &'static [&'static str] {
    TRACK_FIELDS
}

fn clear_user_edits_sql(fields: &[&str]) -> String {
    let list = fields.iter().map(|f| format!("'{f}'")).collect::<Vec<_>>().join(", ");
    format!("DELETE FROM field_override WHERE entity_id = ? AND tier = 'user' AND field IN ({list})")
}

/// User-tier override values for an entity, keyed by field. Values are stored
/// as raw text; "credits" holds a JSON array of names.
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

/// Per field, the highest tier holding a usable value: user > mb > tag. An
/// EMPTY mb value is MusicBrainz's "has none" marker (a dateless group) and
/// yields to the tag tier; an empty user or tag value is a real "none" (a
/// cleared date). The tag tier is consulted only on request — after a scan
/// the columns already hold it, so the reapply hooks skip the read.
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

/// Re-stomp a track's resolved values (user, else MB credits) over whatever
/// the columns currently hold (fresh tag parse, …). Called after every bulk
/// track write, so rescans can never clobber an edit or a match. No-op when
/// no tier above the tags holds anything.
pub(crate) async fn reapply_track_overrides(
    pool: &SqlitePool,
    track_id: i64,
) -> Result<(), String> {
    let overrides = resolved_values(pool, track_id, TRACK_FIELDS, false).await?;
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

/// Album counterpart of reapply_track_overrides: user, else MB, over the
/// freshly scanned columns.
pub(crate) async fn reapply_album_overrides(
    pool: &SqlitePool,
    album_id: i64,
) -> Result<(), String> {
    resolve_album_fields(pool, album_id, false).await
}

/// Write the album's resolved values to its columns and side tables.
/// `from_tag` = also read the stored tag tier — the reset path, where the
/// columns may hold a just-deleted edit and nothing else is going to
/// rewrite them. A field with no value at any consulted tier is left alone.
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
        // artist_id is stamped here like the scanner's own credit write, so
        // a resolve never drops an album off its artists' pages until the
        // next scan-end re-stamp.
        for (i, name) in names.iter().enumerate() {
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
        // Exact title first; else a punctuation-blind key match — the same
        // identity rule the lookalike/cluster machinery uses, so a tag's
        // straight-apostrophe "O'Donnell" finds the MB-canonical curly
        // "O’Donnell" page instead of offering to create a duplicate. Key
        // hits count only when UNIQUE: a split member is a specific artist,
        // and an ambiguous fuzzy hit would silently attach albums to the
        // wrong page.
        let mut row: Option<(i64, String, Option<String>, String, i64)> = sqlx::query_as(
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

/// Name (or clear the name of) one disc of a release — "Disc 2 — Mars".
/// Folder-keyed pref overlaying the tag-derived subtitle; empty clears back
/// to whatever the tags say. Instant and unlogged, same contract as release
/// labels.
#[tauri::command]
pub async fn set_disc_title(
    state: State<'_, AppState>,
    release_id: i64,
    disc_no: i64,
    title: String,
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
    let title = title.trim().to_string();
    if title.is_empty() {
        sqlx::query(
            "DELETE FROM disc_title_pref WHERE album_id = ? AND folder_path = ? AND disc_no = ?",
        )
        .bind(album_id)
        .bind(&folder)
        .bind(disc_no)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    } else {
        sqlx::query(
            "INSERT INTO disc_title_pref (album_id, folder_path, disc_no, title)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(album_id, folder_path, disc_no) DO UPDATE SET title = excluded.title",
        )
        .bind(album_id)
        .bind(&folder)
        .bind(disc_no)
        .bind(&title)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
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
    let pool = &state.app_db;
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
        overridden: edited_fields(&overrides, TRACK_FIELDS),
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
    sqlx::query(&clear_user_edits_sql(TRACK_FIELDS))
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
}

#[derive(Serialize)]
pub struct TierGroup {
    /// None = the leading group: loose tracks (and credit-less albums)
    /// that belong to no artist page.
    pub artist_id: Option<i64>,
    pub artist_title: Option<String>,
    /// The artist's own name across the tiers ("title" only).
    pub artist_fields: HashMap<String, TierValue>,
    pub albums: Vec<TierRow>,
    pub loose_tracks: Vec<TierRow>,
}

#[derive(Serialize)]
pub struct TierMatrix {
    /// Online metadata is on for this library — the MusicBrainz column exists.
    pub mb_enabled: bool,
    pub groups: Vec<TierGroup>,
}

/// The fields the view shows, across every entity kind.
const TIER_FIELDS: &[&str] = &[
    "title",
    "release_date",
    "album_type",
    "genres",
    "artist_credits",
    "credits",
    "track_number",
    "disc_number",
];

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
    let mut by_entity: HashMap<i64, HashMap<String, TierValue>> = HashMap::new();
    let mut group_matched: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut recording_matched: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for (id, field, tier, value) in rows {
        let present = value.as_deref().is_some_and(|v| !v.is_empty());
        if field == crate::music_mb::MB_RELEASE_GROUP {
            if present {
                group_matched.insert(id);
            }
            continue;
        }
        if field == crate::music_mb::MB_RECORDING {
            if present {
                recording_matched.insert(id);
            }
            continue;
        }
        if !TIER_FIELDS.contains(&field.as_str()) {
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
        releases_by_album.entry(album_id).or_default().push(TierRelease {
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
            albums: Vec::new(),
            loose_tracks: Vec::new(),
        })
        .collect();
    let mut orphan = TierGroup {
        artist_id: None,
        artist_title: None,
        artist_fields: HashMap::new(),
        albums: Vec::new(),
        loose_tracks: Vec::new(),
    };

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
        let row = TierRow {
            id,
            kind: "album".to_string(),
            title,
            matched: group_matched.contains(&id),
            pinned_releases: *pinned.get(&id).unwrap_or(&0),
            fields: by_entity.remove(&id).unwrap_or_default(),
            releases: releases_by_album.remove(&id).unwrap_or_default(),
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
        };
        match artist_id.and_then(|a| index.get(&a)) {
            Some(&i) => groups[i].loose_tracks.push(row),
            None => orphan.loose_tracks.push(row),
        }
    }

    groups.retain(|g| !g.albums.is_empty() || !g.loose_tracks.is_empty());
    // The artist-less group leads the page: loose tracks sit at the top,
    // above the artists (his call), not trailing after them.
    if !orphan.albums.is_empty() || !orphan.loose_tracks.is_empty() {
        groups.insert(0, orphan);
    }
    Ok(TierMatrix { mb_enabled, groups })
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
        overridden: edited_fields(&overrides, ALBUM_FIELDS),
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
    // Before-images so a save that leaves these untouched changes nothing
    // matching-side. Only a credits change enqueues pass work; a rename
    // never does — matching after a rename is the user's call.
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
                crate::music_mb::forget_album_notfound(pool, album_id).await?;
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
        overridden: edited_fields(&overrides, ARTIST_FIELDS),
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
        // walk a merge gets. Nothing is enqueued: the user runs a pass when
        // they want one.
        crate::music_mb::forget_artist_exhaustion(pool, artist_id).await?;
    }
    Ok(())
}

/// Drop an artist's rename. The name falls back to MusicBrainz's when the
/// artist is matched, else the tag spelling — immediately, from the stored
/// tiers (the alias rows are left in place — they're harmless and keep old
/// references resolving).
#[tauri::command]
pub async fn reset_artist_fields(
    state: State<'_, AppState>,
    artist_id: i64,
) -> Result<(), String> {
    let pool = &state.app_db;
    ensure_not_staged(pool, artist_id).await?;
    sqlx::query(&clear_user_edits_sql(ARTIST_FIELDS))
        .bind(artist_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    resolve_artist_fields(pool, artist_id, true).await
}

/// Drop an album's user edits. Every field falls back to the tier below —
/// what the match adopted when the album is matched, else what the files
/// say — immediately, from the stored tiers. A field with nothing stored
/// beneath it (pre-tier data: scanned before the tag tier existed, matched
/// before the MB tier) keeps its current value until a rescan or re-match
/// fills that tier in.
#[tauri::command]
pub async fn reset_album_fields(
    state: State<'_, AppState>,
    album_id: i64,
) -> Result<(), String> {
    let pool = &state.app_db;
    ensure_not_staged(pool, album_id).await?;
    sqlx::query(&clear_user_edits_sql(ALBUM_FIELDS))
        .bind(album_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    resolve_album_fields(pool, album_id, true).await?;
    // Restored credits may name artists whose pages the edit had orphaned.
    let library_id: Option<(String,)> =
        sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
            .bind(album_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    if let Some((lib,)) = library_id {
        crate::music::ensure_credit_artists(pool, &lib).await?;
    }
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
    /// What picking this album as keeper KEEPS: its year, genres, and cover
    /// survive alongside the title — the dialog shows them per option.
    pub year: Option<String>,
    pub genres: Vec<String>,
    /// Display cover (cached path), for the option row's thumbnail.
    pub cover: Option<String>,
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
        let Some((title, artist, library_id, folder_path, selected_cover, release_date)) =
            sqlx::query_as::<_, (String, Option<String>, String, String, Option<String>, Option<String>)>(
                "SELECT al.title,
                        (SELECT GROUP_CONCAT(name, ' · ') FROM (
                             SELECT ac.name FROM album_artist_credit ac
                             WHERE ac.album_id = al.id ORDER BY ac.position)),
                        me.library_id, al.folder_path, al.selected_cover, al.release_date
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
        // sorting first by name (the bug this fixes) must not win.
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
    // Same-identity pairs the scanner would already group, held apart only
    // by a standing release split: "combine" here means "undo the split".
    // (folder, disc-named?) per split row to drop, plus the albums involved.
    let mut unsplit: Vec<(String, bool)> = Vec::new();
    let mut unsplit_source_ids: Vec<i64> = Vec::new();
    for src in &sources {
        let (src_artist, src_title) = album_tag_identity(pool, &library_id, *src).await?;
        let src_name = title_of(*src).await?;
        if src_artist == tgt_artist && src_title == tgt_title {
            // Already one album at scan time — unless a release split is
            // what's keeping them apart, in which case dropping it is the
            // combine. Splits can sit on either side's folders.
            let folders: Vec<(String,)> = sqlx::query_as(
                "SELECT ar.folder_path FROM album_release ar
                 JOIN album_release_split s ON s.library_id = ? AND s.folder_path = ar.folder_path COLLATE NOCASE
                 WHERE ar.album_id IN (?, ?)",
            )
            .bind(&library_id)
            .bind(*src)
            .bind(target_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
            for (folder,) in folders {
                if unsplit.iter().any(|(f, _)| f.eq_ignore_ascii_case(&folder)) {
                    continue;
                }
                let leaf = folder.rsplit(['\\', '/']).next().unwrap_or(&folder);
                let disc_named = crate::music::disc_folder_number(leaf).is_some();
                unsplit.push((folder, disc_named));
            }
            if !unsplit.is_empty() {
                unsplit_source_ids.push(*src);
            }
            continue;
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
        // Chains apply leaf-first at rescan (combine_apply_order): a source
        // with albums combined INTO it, or a target combined into something
        // else, is fine. Only a LOOP can never resolve — refuse the directive
        // when the target already reaches the source through the directives
        // on file.
        {
            let start = (tgt_artist.clone(), tgt_title.clone());
            let mut seen: std::collections::HashSet<(String, String)> =
                std::iter::once(start.clone()).collect();
            let mut frontier = vec![start];
            while let Some(node) = frontier.pop() {
                if node.0 == src_artist && node.1 == src_title {
                    return Err(format!(
                        "Combining \"{src_name}\" into \"{tgt_name}\" would loop the combines on file — undo one of them first"
                    ));
                }
                for (sa, st, ta, tt) in existing.iter() {
                    if *sa == node.0 && *st == node.1 {
                        let next = (ta.clone(), tt.clone());
                        if seen.insert(next.clone()) {
                            frontier.push(next);
                        }
                    }
                }
            }
        }
        directives.push((src_artist, src_title, src_name));
        staged_source_ids.push(*src);
    }
    if directives.is_empty() && unsplit.is_empty() {
        return Err("These albums are already combined".to_string());
    }

    if !unsplit.is_empty() {
        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
        for (folder, _) in &unsplit {
            sqlx::query("DELETE FROM album_release_split WHERE library_id = ? AND folder_path = ? COLLATE NOCASE")
                .bind(&library_id)
                .bind(folder)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        // What the rescan yields is the scanner's call: a disc-named folder
        // ("CD2 - …") rejoins as a disc of the same release; anything else
        // comes back as a separate release, whatever mode was clicked.
        let non_disc = unsplit.iter().any(|(_, disc)| !disc);
        let names: Vec<String> = {
            let mut v = Vec::new();
            for id in &unsplit_source_ids {
                v.push(format!("\u{201c}{}\u{201d}", title_of(*id).await?));
            }
            v
        };
        stage_pending_change(
            pool,
            &library_id,
            "release_split_removed",
            "",
            &serde_json::json!({
                "folder_paths": unsplit.iter().map(|(f, _)| f.clone()).collect::<Vec<_>>(),
                "source_album_ids": unsplit_source_ids,
                "target_album_id": target_id,
            }),
            &format!(
                "Rejoin {} with \u{201c}{tgt_name}\u{201d}{}",
                names.join(", "),
                if mode == "merge" && non_disc {
                    " — its folder isn't named as a disc, so it returns as a separate release"
                } else {
                    ""
                }
            ),
        )
        .await?;
    }
    if directives.is_empty() {
        return Ok(());
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
            "SELECT EXISTS (SELECT 1 FROM release_match WHERE album_id = ? AND mb_release_id <> '')",
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
        // into the target on rescan); target_album_id: the keeper, equally
        // frozen — one album, one pending fate. The UI locks both sides.
        &serde_json::json!({
            "ids": directive_ids,
            "source_album_ids": staged_source_ids,
            "target_album_id": target_id,
        }),
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
/// for combine TARGETS (the keeper's track list is about to be rewritten —
/// letting it join a second combine would stage contradictory fates),
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
            // A rejoin (dropped release split) freezes both sides the same
            // way a combine does — the rescan rewrites both albums.
            "album_combine" | "release_split_removed" => {
                combine_source_ids.extend(
                    p["source_album_ids"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_i64()),
                );
                // The keeper is frozen too — combining it into (or under)
                // anything else would stage a second, contradictory fate.
                combine_source_ids.extend(p["target_album_id"].as_i64());
            }
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
                "album_combine" | "release_split_removed" => p["source_album_ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_i64())
                    // The keeper locks alongside its sources.
                    .chain(p["target_album_id"].as_i64())
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
        "release_split_removed" => {
            // Un-staging a rejoin puts the split rows back.
            for folder in p["folder_paths"].as_array().into_iter().flatten() {
                if let Some(folder) = folder.as_str() {
                    sqlx::query(
                        "INSERT OR IGNORE INTO album_release_split (library_id, folder_path) VALUES (?, ?)",
                    )
                    .bind(&library_id)
                    .bind(folder)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                }
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
