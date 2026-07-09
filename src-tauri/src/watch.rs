//! Watch history — progress recording and watched-state queries.
//!
//! Recording rides the existing mpv event loop: the frontend declares what is
//! playing (`set_watch_target`) and the loop calls `record_progress` every ~5s
//! of actual playback (pause stops time-pos events, so pauses write nothing).
//! Interactive titles bypass this — their driver records its own resume
//! payload and flips `movie_watch.watched` when an ending is reached.

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::AppState;

/// Watched when ≥95% through or ≤60s remain (credits tolerance).
const WATCHED_RATIO: f64 = 0.95;
const WATCHED_TAIL_SECS: f64 = 60.0;
/// No resume point until this far in — avoids "Resume at 0:12" noise.
const RESUME_FLOOR_SECS: f64 = 30.0;

/// What the player is currently playing, for progress attribution.
#[derive(Debug, Clone, Copy)]
pub enum WatchTarget {
    Movie { entry_id: i64 },
    Episode { episode_id: i64 },
}

impl WatchTarget {
    fn table_and_id(&self) -> (&'static str, &'static str, i64) {
        match self {
            WatchTarget::Movie { entry_id } => ("movie_watch", "entry_id", *entry_id),
            WatchTarget::Episode { episode_id } => ("episode_watch", "episode_id", *episode_id),
        }
    }
}

/// Upsert one progress sample. Crossing the watched threshold marks the row
/// watched (sticky) and clears the resume point; below the floor nothing is
/// created, so brushing past a title leaves no trace.
pub async fn record_progress(pool: &SqlitePool, target: WatchTarget, position_secs: f64, duration_secs: f64) {
    if duration_secs <= 0.0 || position_secs < 0.0 {
        return;
    }
    let (table, key, id) = target.table_and_id();
    let watched =
        position_secs / duration_secs >= WATCHED_RATIO || duration_secs - position_secs <= WATCHED_TAIL_SECS;
    let query = if watched {
        format!(
            "INSERT INTO {table} ({key}, position_secs, duration_secs, watched, watched_at, last_played_at)
             VALUES (?, NULL, ?, 1, datetime('now'), datetime('now'))
             ON CONFLICT({key}) DO UPDATE SET
                position_secs = NULL,
                duration_secs = excluded.duration_secs,
                watched = 1,
                watched_at = COALESCE({table}.watched_at, excluded.watched_at),
                last_played_at = excluded.last_played_at"
        )
    } else if position_secs >= RESUME_FLOOR_SECS {
        format!(
            "INSERT INTO {table} ({key}, position_secs, duration_secs, watched, last_played_at)
             VALUES (?1, ?2, ?3, 0, datetime('now'))
             ON CONFLICT({key}) DO UPDATE SET
                position_secs = excluded.position_secs,
                duration_secs = excluded.duration_secs,
                last_played_at = excluded.last_played_at"
        )
    } else {
        // Below the floor: refresh recency on an existing row, never create one.
        format!("UPDATE {table} SET last_played_at = datetime('now') WHERE {key} = ?")
    };
    let mut q = sqlx::query(&query).bind(id);
    if watched {
        q = q.bind(duration_secs);
    } else if position_secs >= RESUME_FLOOR_SECS {
        q = q.bind(position_secs).bind(duration_secs);
    }
    if let Err(e) = q.execute(pool).await {
        eprintln!("watch: progress write failed: {e}");
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Declare what the player is about to play (or None for untracked files like
/// extras). Called by the frontend just before each loadfile.
#[tauri::command]
pub async fn set_watch_target(
    state: State<'_, AppState>,
    kind: Option<String>,
    id: Option<i64>,
) -> Result<(), String> {
    let target = match (kind.as_deref(), id) {
        (Some("movie"), Some(id)) => Some(WatchTarget::Movie { entry_id: id }),
        (Some("episode"), Some(id)) => Some(WatchTarget::Episode { episode_id: id }),
        _ => None,
    };
    let guard = state.player.lock().map_err(|e| e.to_string())?;
    if let Some(inner) = guard.as_ref() {
        *inner.watch.lock().map_err(|e| e.to_string())? = target;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct WatchState {
    pub position_secs: Option<f64>,
    pub duration_secs: Option<f64>,
    pub watched: bool,
    /// Deliberately marked unwatched (explicit row; watched is the default
    /// state of a personal library, so this is what gets surfaced).
    pub unwatched: bool,
    /// Interactive titles: a mid-story resume exists (Play → "Resume").
    pub interactive_resume: bool,
}

/// Watch state for a movie detail page (also covers interactive titles).
#[tauri::command]
pub async fn get_watch_state(state: State<'_, AppState>, entry_id: i64) -> Result<WatchState, String> {
    let row: Option<(Option<f64>, Option<f64>, i64)> = sqlx::query_as(
        "SELECT position_secs, duration_secs, watched FROM movie_watch WHERE entry_id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let resume: Option<(i64,)> =
        sqlx::query_as("SELECT entry_id FROM interactive_resume WHERE entry_id = ?")
            .bind(entry_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    let unwatched = matches!(&row, Some((p, _, w)) if *w == 0 && p.is_none());
    let (position_secs, duration_secs, watched) = row.map_or((None, None, false), |(p, d, w)| (p, d, w != 0));
    Ok(WatchState { position_secs, duration_secs, watched, unwatched, interactive_resume: resume.is_some() })
}

#[derive(Debug, Serialize)]
pub struct EpisodeWatch {
    pub episode_id: i64,
    pub position_secs: Option<f64>,
    pub duration_secs: Option<f64>,
    pub watched: bool,
}

/// All watch rows for a show's episodes (indicators on the episode list).
#[tauri::command]
pub async fn get_show_watch(state: State<'_, AppState>, show_id: i64) -> Result<Vec<EpisodeWatch>, String> {
    let rows: Vec<(i64, Option<f64>, Option<f64>, i64)> = sqlx::query_as(
        "SELECT ew.episode_id, ew.position_secs, ew.duration_secs, ew.watched
         FROM episode_watch ew
         JOIN episode e ON e.id = ew.episode_id
         JOIN season s ON s.id = e.season_id
         WHERE s.show_id = ?",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(episode_id, position_secs, duration_secs, watched)| EpisodeWatch {
            episode_id,
            position_secs,
            duration_secs,
            watched: watched != 0,
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct ContinueTarget {
    pub episode_id: i64,
    pub season_number: Option<i64>,
    pub episode_number: Option<i64>,
    pub position_secs: Option<f64>,
}

/// Where the show's Play button should land: the most recently played
/// unfinished episode, else the first unwatched episode in show order, else
/// None (everything watched → caller plays from the top).
#[tauri::command]
pub async fn get_show_continue(
    state: State<'_, AppState>,
    show_id: i64,
) -> Result<Option<ContinueTarget>, String> {
    // A resume point is in-progress regardless of the sticky watched flag —
    // a rewatch of a finished episode still deserves Continue.
    let in_progress: Option<(i64, Option<i64>, Option<i64>, Option<f64>)> = sqlx::query_as(
        "SELECT e.id, s.season_number, e.episode_number, ew.position_secs
         FROM episode_watch ew
         JOIN episode e ON e.id = ew.episode_id
         JOIN season s ON s.id = e.season_id
         WHERE s.show_id = ? AND ew.position_secs IS NOT NULL
         ORDER BY ew.last_played_at DESC
         LIMIT 1",
    )
    .bind(show_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    if let Some((episode_id, season_number, episode_number, position_secs)) = in_progress {
        return Ok(Some(ContinueTarget { episode_id, season_number, episode_number, position_secs }));
    }

    // First unwatched, in the same order the episode list plays: season order,
    // then episode order within it.
    let first_unwatched: Option<(i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT e.id, s.season_number, e.episode_number
         FROM episode e
         JOIN season s ON s.id = e.season_id
         WHERE s.show_id = ?
           AND NOT EXISTS (SELECT 1 FROM episode_watch ew WHERE ew.episode_id = e.id AND ew.watched = 1)
         ORDER BY s.sort_order, s.season_number, e.sort_order, e.episode_number
         LIMIT 1",
    )
    .bind(show_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    // Skip the degenerate case: nothing watched at all → plain Play, no label.
    if first_unwatched.is_some() {
        let any_watched: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM episode_watch ew JOIN episode e ON e.id = ew.episode_id
             JOIN season s ON s.id = e.season_id WHERE s.show_id = ? AND ew.watched = 1 LIMIT 1",
        )
        .bind(show_id)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
        if any_watched.is_none() {
            return Ok(None);
        }
    }
    Ok(first_unwatched.map(|(episode_id, season_number, episode_number)| ContinueTarget {
        episode_id,
        season_number,
        episode_number,
        position_secs: None,
    }))
}

/// Manually flip watched state. Marking watched clears the resume point;
/// marking unwatched writes an EXPLICIT unwatched row (watched=0, no resume)
/// — distinct from never-tracked, so the grid can badge deliberately
/// unwatched titles without badging the whole library.
#[tauri::command]
pub async fn mark_watched(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
    watched: bool,
) -> Result<(), String> {
    let target = match kind.as_str() {
        "movie" => WatchTarget::Movie { entry_id: id },
        "episode" => WatchTarget::Episode { episode_id: id },
        _ => return Err(format!("unknown watch kind '{kind}'")),
    };
    let (table, key, id) = target.table_and_id();
    let query = if watched {
        format!(
            "INSERT INTO {table} ({key}, position_secs, watched, watched_at, last_played_at)
             VALUES (?, NULL, 1, datetime('now'), datetime('now'))
             ON CONFLICT({key}) DO UPDATE SET
                position_secs = NULL, watched = 1,
                watched_at = COALESCE({table}.watched_at, datetime('now'))"
        )
    } else {
        format!(
            "INSERT INTO {table} ({key}, position_secs, watched, watched_at)
             VALUES (?, NULL, 0, NULL)
             ON CONFLICT({key}) DO UPDATE SET
                position_secs = NULL, watched = 0, watched_at = NULL"
        )
    };
    sqlx::query(&query)
        .bind(id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    // Unwatching an interactive title also forgets its mid-story resume.
    if !watched {
        if let WatchTarget::Movie { entry_id } = target {
            let _ = sqlx::query("DELETE FROM interactive_resume WHERE entry_id = ?")
                .bind(entry_id)
                .execute(&state.app_db)
                .await;
        }
    }
    Ok(())
}

/// Mark every episode of a show watched/unwatched at once (same explicit
/// semantics as mark_watched).
#[tauri::command]
pub async fn mark_show_watched(
    state: State<'_, AppState>,
    show_id: i64,
    watched: bool,
) -> Result<(), String> {
    let query = if watched {
        "INSERT INTO episode_watch (episode_id, position_secs, watched, watched_at, last_played_at)
         SELECT e.id, NULL, 1, datetime('now'), datetime('now')
         FROM episode e JOIN season s ON s.id = e.season_id WHERE s.show_id = ?1
         ON CONFLICT(episode_id) DO UPDATE SET
            position_secs = NULL, watched = 1,
            watched_at = COALESCE(episode_watch.watched_at, datetime('now'))"
    } else {
        "INSERT INTO episode_watch (episode_id, position_secs, watched, watched_at)
         SELECT e.id, NULL, 0, NULL
         FROM episode e JOIN season s ON s.id = e.season_id WHERE s.show_id = ?1
         ON CONFLICT(episode_id) DO UPDATE SET
            position_secs = NULL, watched = 0, watched_at = NULL"
    };
    sqlx::query(query)
        .bind(show_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

