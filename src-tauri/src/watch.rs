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
    continue_for_show(&state.app_db, show_id).await
}

/// get_show_continue's body, callable per show by aggregates (the Home hub's
/// continue-watching rail).
pub(crate) async fn continue_for_show(
    pool: &SqlitePool,
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
    .fetch_optional(pool)
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
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    // Skip the degenerate case: nothing watched at all → plain Play, no label.
    if first_unwatched.is_some() {
        let any_watched: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM episode_watch ew JOIN episode e ON e.id = ew.episode_id
             JOIN season s ON s.id = e.season_id WHERE s.show_id = ? AND ew.watched = 1 LIMIT 1",
        )
        .bind(show_id)
        .fetch_optional(pool)
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

/// One card on the Home hub's continue-watching rail.
#[derive(Debug, Serialize)]
pub struct ContinueWatchingItem {
    /// "movie" | "show"
    pub kind: String,
    /// Movie entry or show entry.
    pub entry_id: i64,
    pub library_id: String,
    pub title: String,
    /// Resolved cached cover path (grid convention), when any.
    pub cover: Option<String>,
    /// The frame the user left at (captured on player close), when any.
    /// Preferred card art; falls back to backdrop, then a cover treatment.
    pub frame: Option<String>,
    /// Selected/first cached backdrop for the entry, when any.
    pub backdrop: Option<String>,
    pub last_played_at: String,
    pub position_secs: Option<f64>,
    pub duration_secs: Option<f64>,
    // Show-only: the continue target episode.
    pub episode_id: Option<i64>,
    pub season_number: Option<i64>,
    pub episode_number: Option<i64>,
    pub episode_title: Option<String>,
}

/// The Home hub's "where you left off" rail, across ALL video libraries:
/// in-progress movies plus shows with a continue target, most recent activity
/// first. Interactive titles are skipped — their resume goes through the
/// branch-graph driver, and a linear resume would be wrong.
#[tauri::command]
pub async fn get_continue_watching(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<ContinueWatchingItem>, String> {
    let pool = &state.app_db;
    let cap = limit.unwrap_or(20).max(1);
    let mut items: Vec<ContinueWatchingItem> = Vec::new();

    // The frame captured at player close, keyed the same way it was written.
    let frames_dir = state.app_data_dir.join("cache").join("resume_frames");
    let frame_for = |kind: &str, id: i64| -> Option<String> {
        let p = frames_dir.join(format!("{kind}_{id}.jpg"));
        p.exists().then(|| p.to_string_lossy().to_string())
    };

    // Per-library cover maps, fetched lazily (the rail usually spans one).
    let mut covers_cache: std::collections::HashMap<String, std::collections::HashMap<String, Vec<String>>> =
        std::collections::HashMap::new();

    let movie_rows: Vec<(i64, String, String, String, Option<String>, Option<f64>, Option<f64>, String)> =
        sqlx::query_as(
            "SELECT me.id, me.library_id, m.title, m.folder_path, m.selected_cover,
                    mw.position_secs, mw.duration_secs, mw.last_played_at
             FROM movie_watch mw
             JOIN movie m ON m.id = mw.entry_id
             JOIN media_entry me ON me.id = mw.entry_id
             WHERE mw.watched = 0 AND mw.position_secs IS NOT NULL
               AND mw.last_played_at IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM interactive_resume ir WHERE ir.entry_id = mw.entry_id)
             ORDER BY mw.last_played_at DESC
             LIMIT ?",
        )
        .bind(cap)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    for (entry_id, library_id, title, folder_path, selected_cover, position_secs, duration_secs, last_played_at) in movie_rows {
        if !covers_cache.contains_key(&library_id) {
            let map = crate::commands::get_all_cached_covers(pool, &library_id)
                .await
                .map_err(|e| e.to_string())?;
            covers_cache.insert(library_id.clone(), map);
        }
        let cover = covers_cache.get(&library_id).and_then(|m| {
            let covers = m.get(&folder_path)?;
            match &selected_cover {
                Some(sel) if covers.contains(sel) => Some(sel.clone()),
                _ => covers.first().cloned(),
            }
        });
        let backdrop = crate::commands::entry_backdrop(pool, entry_id).await?;
        items.push(ContinueWatchingItem {
            kind: "movie".into(),
            entry_id,
            library_id,
            title,
            cover,
            frame: frame_for("movie", entry_id),
            backdrop,
            last_played_at,
            position_secs,
            duration_secs,
            episode_id: None,
            season_number: None,
            episode_number: None,
            episode_title: None,
        });
    }

    // Shows with any episode activity, most recent first; each resolves its
    // continue target the same way the show page does (fully-watched and
    // never-started shows resolve to None and drop out).
    let show_rows: Vec<(i64, String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT sh.id, me.library_id, sh.title, sh.folder_path, sh.selected_cover,
                MAX(ew.last_played_at) as last
         FROM episode_watch ew
         JOIN episode e ON e.id = ew.episode_id
         JOIN season se ON se.id = e.season_id
         JOIN show sh ON sh.id = se.show_id
         JOIN media_entry me ON me.id = sh.id
         WHERE ew.last_played_at IS NOT NULL
         GROUP BY sh.id
         ORDER BY last DESC
         LIMIT ?",
    )
    .bind(cap)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for (show_id, library_id, title, folder_path, selected_cover, last_played_at) in show_rows {
        let Some(target) = continue_for_show(pool, show_id).await? else {
            continue;
        };
        if !covers_cache.contains_key(&library_id) {
            let map = crate::commands::get_all_cached_covers(pool, &library_id)
                .await
                .map_err(|e| e.to_string())?;
            covers_cache.insert(library_id.clone(), map);
        }
        let cover = covers_cache.get(&library_id).and_then(|m| {
            let covers = m.get(&folder_path)?;
            match &selected_cover {
                Some(sel) if covers.contains(sel) => Some(sel.clone()),
                _ => covers.first().cloned(),
            }
        });
        let ep: Option<(Option<String>, Option<f64>)> = sqlx::query_as(
            "SELECT e.title, ew.duration_secs FROM episode e
             LEFT JOIN episode_watch ew ON ew.episode_id = e.id
             WHERE e.id = ?",
        )
        .bind(target.episode_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        let (episode_title, duration_secs) = ep.unwrap_or((None, None));
        let backdrop = crate::commands::entry_backdrop(pool, show_id).await?;
        items.push(ContinueWatchingItem {
            kind: "show".into(),
            entry_id: show_id,
            library_id,
            title,
            cover,
            // Frames are per-EPISODE — only present when the continue target
            // is the episode that was actually playing at close.
            frame: frame_for("episode", target.episode_id),
            backdrop,
            last_played_at,
            position_secs: target.position_secs,
            duration_secs,
            episode_id: Some(target.episode_id),
            season_number: target.season_number,
            episode_number: target.episode_number,
            episode_title: episode_title.filter(|t| !t.is_empty()),
        });
    }

    // SQLite datetimes sort correctly as strings.
    items.sort_by(|a, b| b.last_played_at.cmp(&a.last_played_at));
    items.truncate(cap as usize);
    Ok(items)
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

#[derive(Debug, Serialize)]
pub struct EntryWatchFlags {
    pub id: i64,
    pub watched: bool,
    pub watch_progress: Option<f64>,
    pub unwatched: bool,
    pub has_progress: bool,
}

/// Recompute the per-entry watch flags for a batch of ids — the grid bakes
/// these into cached entry lists, so the frontend refreshes them after
/// playback instead of re-fetching whole views. Mirrors the listing-time
/// flag pass in commands.rs (movies join movie_watch; shows roll up their
/// episodes; shows keep watched=false for parity with that pass).
#[tauri::command]
pub async fn get_watch_flags(
    state: State<'_, AppState>,
    entry_ids: Vec<i64>,
) -> Result<Vec<EntryWatchFlags>, String> {
    let pool = &state.app_db;
    let mut out: Vec<EntryWatchFlags> = Vec::new();
    for chunk in entry_ids.chunks(900) {
        let placeholders = vec!["?"; chunk.len()].join(",");

        let movie_query = format!(
            "SELECT me.id,
                    COALESCE(mw.watched, 0),
                    CASE WHEN mw.position_secs IS NOT NULL AND mw.duration_secs > 0
                         THEN mw.position_secs / mw.duration_secs ELSE NULL END,
                    (mw.entry_id IS NOT NULL AND mw.watched = 0 AND mw.position_secs IS NULL),
                    (mw.position_secs IS NOT NULL)
             FROM media_entry me
             JOIN media_entry_type met ON met.id = me.entry_type_id AND met.name = 'movie'
             LEFT JOIN movie_watch mw ON mw.entry_id = me.id
             WHERE me.id IN ({placeholders})"
        );
        let mut q = sqlx::query_as::<_, (i64, i64, Option<f64>, bool, bool)>(&movie_query);
        for id in chunk {
            q = q.bind(id);
        }
        for (id, watched, watch_progress, unwatched, has_progress) in
            q.fetch_all(pool).await.map_err(|e| e.to_string())?
        {
            out.push(EntryWatchFlags { id, watched: watched != 0, watch_progress, unwatched, has_progress });
        }

        let show_query = format!(
            "SELECT me.id,
                    COUNT(e.id),
                    COALESCE(SUM(CASE WHEN ew.watched = 1 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN ew.position_secs IS NOT NULL THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN ew.episode_id IS NOT NULL
                                       AND ew.watched = 0
                                       AND ew.position_secs IS NULL
                                      THEN 1 ELSE 0 END), 0)
             FROM media_entry me
             JOIN media_entry_type met ON met.id = me.entry_type_id AND met.name = 'show'
             JOIN season s ON s.show_id = me.id
             JOIN episode e ON e.season_id = s.id
             LEFT JOIN episode_watch ew ON ew.episode_id = e.id
             WHERE me.id IN ({placeholders})
             GROUP BY me.id"
        );
        let mut q = sqlx::query_as::<_, (i64, i64, i64, i64, i64)>(&show_query);
        for id in chunk {
            q = q.bind(id);
        }
        for (id, total, watched, in_progress, explicit) in
            q.fetch_all(pool).await.map_err(|e| e.to_string())?
        {
            out.push(EntryWatchFlags {
                id,
                watched: false,
                watch_progress: None,
                unwatched: total > 0 && explicit == total,
                has_progress: (watched > 0 || in_progress > 0) && watched < total,
            });
        }
    }
    Ok(out)
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

