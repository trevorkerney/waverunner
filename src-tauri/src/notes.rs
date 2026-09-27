//! Free-text notes on the things that have pages of their own: artists,
//! albums, movies, shows and video collections (media entries), people,
//! playlists and the collections inside playlists — plus ONE version of an
//! album (a release note: the pressing, the rip, what's different about
//! this copy). A playlist calls its note a description; it is the same
//! thing under the name playlists use.
//!
//! App data only (user's call, 2026-09-27): never written to files, never
//! seeded from a COMMENT tag, not searched (search is due a rework), shown
//! on the entity's page and nowhere else. Never locked by a matching pass
//! or a staged change either — a note is the user's remark, not library
//! data. Plain text with line breaks kept; Markdown maybe later.
//!
//! One table per id space, each keyed to its owner with ON DELETE CASCADE,
//! so a note lives exactly as long as what it is about. Rescans keep entity
//! ids — paths, and hash-rescued moves and renames — so notes ride along;
//! a merge carries the absorbed side's note onto the survivor
//! (`append_note`) before the absorbed row goes. Release notes key on the
//! album + the version's folder (album_release_note), the same key as the
//! release pin and disc names, and travel with the version through
//! combines and folder moves the same way.

use sqlx::SqlitePool;
use tauri::State;

use crate::AppState;

/// (table, owner-id column) for a note kind keyed on one id.
fn table_for(kind: &str) -> Result<(&'static str, &'static str), String> {
    Ok(match kind {
        "entry" => ("entry_note", "entry_id"),
        "person" => ("person_note", "person_id"),
        "playlist" => ("playlist_note", "playlist_id"),
        "playlist_collection" => ("playlist_collection_note", "collection_id"),
        other => return Err(format!("Unknown note kind: {other}")),
    })
}

/// A release note's key — the album row and the version's folder — from
/// the album_release row id the page holds. Release rows are rebuilt by
/// every rescan; the folder is what persists, so it is what the note keys
/// on. None when the row is gone (the page is stale).
async fn release_key(pool: &SqlitePool, release_db_id: i64) -> Result<Option<(i64, String)>, String> {
    sqlx::query_as("SELECT album_id, folder_path FROM album_release WHERE id = ?")
        .bind(release_db_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
}

async fn read_release_note(
    pool: &SqlitePool,
    album_id: i64,
    folder: &str,
) -> Result<Option<String>, String> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT text FROM album_release_note WHERE album_id = ? AND folder_path = ?",
    )
    .bind(album_id)
    .bind(folder)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|(t,)| t))
}

async fn write_release_note(
    pool: &SqlitePool,
    album_id: i64,
    folder: &str,
    text: &str,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        sqlx::query("DELETE FROM album_release_note WHERE album_id = ? AND folder_path = ?")
            .bind(album_id)
            .bind(folder)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO album_release_note (album_id, folder_path, text, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(album_id, folder_path) DO UPDATE SET
           text = excluded.text, updated_at = excluded.updated_at",
    )
    .bind(album_id)
    .bind(folder)
    .bind(text)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) async fn read_note(
    pool: &SqlitePool,
    kind: &str,
    subject_id: i64,
) -> Result<Option<String>, String> {
    if kind == "release" {
        return match release_key(pool, subject_id).await? {
            Some((album_id, folder)) => read_release_note(pool, album_id, &folder).await,
            None => Ok(None),
        };
    }
    let (table, col) = table_for(kind)?;
    let row: Option<(String,)> =
        sqlx::query_as(&format!("SELECT text FROM {table} WHERE {col} = ?"))
            .bind(subject_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(row.map(|(t,)| t))
}

/// Store the note; a blank one deletes the row (no note, not an empty note).
pub(crate) async fn write_note(
    pool: &SqlitePool,
    kind: &str,
    subject_id: i64,
    text: &str,
) -> Result<(), String> {
    if kind == "release" {
        let Some((album_id, folder)) = release_key(pool, subject_id).await? else {
            return Err("This version is no longer in the library — reopen the album.".to_string());
        };
        return write_release_note(pool, album_id, &folder, text).await;
    }
    let (table, col) = table_for(kind)?;
    let text = text.trim();
    if text.is_empty() {
        sqlx::query(&format!("DELETE FROM {table} WHERE {col} = ?"))
            .bind(subject_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    sqlx::query(&format!(
        "INSERT INTO {table} ({col}, text, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT({col}) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at"
    ))
    .bind(subject_id)
    .bind(text)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// `kind`: entry | person | playlist | playlist_collection, keyed on that
/// row's id — or release, keyed on the album_release row id the album page
/// holds for the version on show.
#[tauri::command]
pub async fn get_note(
    state: State<'_, AppState>,
    kind: String,
    subject_id: i64,
) -> Result<Option<String>, String> {
    read_note(&state.app_db, &kind, subject_id).await
}

#[tauri::command]
pub async fn set_note(
    state: State<'_, AppState>,
    kind: String,
    subject_id: i64,
    text: String,
) -> Result<(), String> {
    write_note(&state.app_db, &kind, subject_id, &text).await
}

/// Two notes become one: `into` first, a blank line, then `from`. An
/// empty `into` just takes `from`.
fn joined(into: Option<String>, from: String) -> String {
    match into {
        Some(into) if !into.trim().is_empty() => format!("{}\n\n{}", into.trim_end(), from),
        _ => from,
    }
}

/// A merge: `from`'s note joins `into`'s — after it, a blank line between —
/// and `from`'s row goes. Nothing to carry means nothing is touched.
/// Concatenation is the whole policy for now (user's call, 2026-09-27;
/// options maybe later). Undoing the merge afterwards leaves the joined
/// note on the survivor.
pub(crate) async fn append_note(
    pool: &SqlitePool,
    kind: &str,
    from_id: i64,
    into_id: i64,
) -> Result<(), String> {
    if from_id == into_id {
        return Ok(());
    }
    let Some(from) = read_note(pool, kind, from_id).await? else {
        return Ok(());
    };
    let merged = joined(read_note(pool, kind, into_id).await?, from);
    write_note(pool, kind, into_id, &merged).await?;
    let (table, col) = table_for(kind)?;
    sqlx::query(&format!("DELETE FROM {table} WHERE {col} = ?"))
        .bind(from_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The release-note cousin of `append_note`, for a merge-mode combine: the
/// poured-in edition's note joins the poured-into release's, then goes.
pub(crate) async fn append_release_note(
    pool: &SqlitePool,
    from_album: i64,
    from_folder: &str,
    into_album: i64,
    into_folder: &str,
) -> Result<(), String> {
    if from_album == into_album && from_folder == into_folder {
        return Ok(());
    }
    let Some(from) = read_release_note(pool, from_album, from_folder).await? else {
        return Ok(());
    };
    let merged = joined(read_release_note(pool, into_album, into_folder).await?, from);
    write_release_note(pool, into_album, into_folder, &merged).await?;
    sqlx::query("DELETE FROM album_release_note WHERE album_id = ? AND folder_path = ?")
        .bind(from_album)
        .bind(from_folder)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
