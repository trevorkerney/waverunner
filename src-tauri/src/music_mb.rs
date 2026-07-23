//! MusicBrainz integration — TMDB-style: fill gaps, never fight the tags.
//!
//! The background pass (auto after scan/rescan) applies only what is either a
//! pure gap (missing dates, MBIDs) or waverunner's own derived guesses being
//! replaced by authoritative data (parsed credits, heuristic album types) —
//! every application is written to mb_change_log with before/after values and
//! can be undone (undo also writes mb_suppression so the pass never reapplies).
//! Anything uncertain becomes an mb_suggestion for the Match-to-MusicBrainz
//! modal: mid-confidence album matches, punctuation-lookalike artist merges.
//! Artist identity proven by matching MBIDs auto-merges (logged, undoable);
//! merges write artist_alias rows — raw credit strings are never rewritten.
//!
//! MusicBrainz needs no API key: the rate limit (1 req/s) is per IP and the
//! only requirement is a descriptive User-Agent identifying the app.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

/// Only one pass at a time — overlapping passes must not double the request
/// rate against MusicBrainz.
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Skip-remaining flag: set by music_match_skip (wizard "Skip" / exit). The
/// pass stops fetching, leaves the rest unstamped (they show as never-matched
/// in the metadata center), finishes its local passes, and reports normally.
static CANCEL: AtomicBool = AtomicBool::new(false);

const MB_MIN_SCORE: i64 = 90;
const REQUEST_GAP: std::time::Duration = std::time::Duration::from_millis(1100);

fn mb_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!(
            "waverunner/{} (https://github.com/trevorkerney/waverunner)",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|e| e.to_string())
}

async fn suppressed(pool: &SqlitePool, kind: &str, target_id: i64) -> Result<bool, String> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM mb_suppression WHERE kind = ? AND target_id = ?")
            .bind(kind)
            .bind(target_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(row.is_some())
}

async fn log_change(
    pool: &SqlitePool,
    library_id: &str,
    kind: &str,
    target_id: i64,
    label: &str,
    before: &serde_json::Value,
    after: &serde_json::Value,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO mb_change_log (library_id, kind, target_id, label, before_json, after_json)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(library_id)
    .bind(kind)
    .bind(target_id)
    .bind(label)
    .bind(before.to_string())
    .bind(after.to_string())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Background pass
// ---------------------------------------------------------------------------

/// Spawn the matching pass for a library. The wizard's match step (or the
/// metadata center's re-run) drives this — it is never auto-spawned by
/// scans. Progress streams via `music-enrich-progress`; completion (success,
/// skip, or error) always lands a `music-enrich-done` so the UI never hangs.
pub fn spawn_enrich(app: AppHandle, library_id: String) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return; // a pass is already running
    }
    CANCEL.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let result = enrich(&app, &library_id).await;
        RUNNING.store(false, Ordering::SeqCst);
        match result {
            Ok(outcome) => {
                let _ = app.emit(
                    "music-enrich-done",
                    serde_json::json!({
                        "libraryId": library_id,
                        "updated": outcome.artists_updated,
                        "albumsMatched": outcome.albums_matched,
                        "processed": outcome.albums_processed,
                        "pendingReview": outcome.pending_review,
                        "skipped": outcome.skipped,
                    }),
                );
            }
            Err(e) => {
                eprintln!("musicbrainz enrich: {e}");
                let _ = app.emit(
                    "music-enrich-done",
                    serde_json::json!({
                        "libraryId": library_id,
                        "updated": 0,
                        "albumsMatched": 0,
                        "processed": 0,
                        "pendingReview": 0,
                        "error": e,
                    }),
                );
            }
        }
    });
}

/// Start the matching pass (wizard match step / metadata-center re-run).
#[tauri::command]
pub async fn music_match_begin(app: AppHandle, library_id: String) -> Result<(), String> {
    spawn_enrich(app, library_id);
    Ok(())
}

/// Skip the rest of a running pass. Unprocessed albums stay unstamped and can
/// be matched later from the metadata center.
#[tauri::command]
pub async fn music_match_skip() -> Result<(), String> {
    CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(Serialize)]
pub struct MusicMatchState {
    pub running: bool,
    /// Albums never checked against MusicBrainz (no stamp).
    pub unchecked: i64,
    pub pending_suggestions: i64,
    pub unmatched: i64,
    pub matched: i64,
}

/// Snapshot of a library's matching state, for the wizard's election screen
/// and the metadata center header.
#[tauri::command]
pub async fn music_match_state(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<MusicMatchState, String> {
    let pool = &state.app_db;
    let (unchecked,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM album al
         JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM mb_credit_fetch f WHERE f.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)",
    )
    .bind(&library_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (pending_suggestions,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM mb_suggestion WHERE library_id = ? AND status = 'pending'",
    )
    .bind(&library_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT f.status, COUNT(*) FROM mb_credit_fetch f
         JOIN media_entry me ON me.id = f.album_id
         WHERE me.library_id = ? GROUP BY f.status",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let by = |k: &str| counts.iter().find(|(s, _)| s == k).map(|(_, n)| *n).unwrap_or(0);
    Ok(MusicMatchState {
        running: RUNNING.load(Ordering::SeqCst),
        unchecked,
        pending_suggestions,
        unmatched: by("notfound"),
        matched: by("matched"),
    })
}

pub struct EnrichOutcome {
    pub albums_matched: usize,
    pub albums_processed: usize,
    pub artists_updated: usize,
    /// Pending suggestions + not-found albums — what needs the user's review.
    pub pending_review: i64,
    /// True when the pass ended early via music_match_skip.
    pub skipped: bool,
}

/// The full pass, in dependency order: album matching (credits/type/year gap
/// fills or suggestions), artist rows for newly credited names, artist MBIDs,
/// then MBID-proven identity work (auto-merges + suggestion auto-resolution).
async fn enrich(app: &AppHandle, library_id: &str) -> Result<EnrichOutcome, String> {
    let pool = app.state::<AppState>().app_db.clone();
    let client = mb_client()?;

    let (albums_matched, albums_processed) = enrich_albums(app, &pool, &client, library_id).await?;
    crate::music::ensure_credit_artists(&pool, library_id).await?;
    let artists_updated = enrich_artist_mbids(app, &pool, &client, library_id).await?;
    merge_mbid_duplicates(&pool, library_id).await?;
    resolve_merge_suggestions_via_mbid(&pool, &client, library_id).await?;
    // Credit replacement above can orphan artists that only backed a
    // since-replaced parsed credit string — sweep them so no works-less
    // artist lingers in the grid.
    let cache_base = app
        .state::<AppState>()
        .app_data_dir
        .join("cache")
        .join(library_id);
    crate::music::sweep_orphan_artists(&pool, library_id, &cache_base).await?;

    // Artist images: Wikidata (by the MBIDs just filled) + Deezer fallback —
    // gap-fill only, no MusicBrainz requests involved.
    crate::music_art::fetch_artist_images(app, &pool, library_id, || {
        CANCEL.load(Ordering::SeqCst)
    })
    .await?;

    let (pending_suggestions,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM mb_suggestion WHERE library_id = ? AND status = 'pending'",
    )
    .bind(library_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let (unmatched,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM mb_credit_fetch f
         JOIN media_entry me ON me.id = f.album_id
         WHERE me.library_id = ? AND f.status = 'notfound'",
    )
    .bind(library_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(EnrichOutcome {
        albums_matched,
        albums_processed,
        artists_updated,
        pending_review: pending_suggestions + unmatched,
        skipped: CANCEL.load(Ordering::SeqCst),
    })
}

async fn enrich_albums(
    app: &AppHandle,
    pool: &SqlitePool,
    client: &reqwest::Client,
    library_id: &str,
) -> Result<(usize, usize), String> {
    let albums: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT al.id, al.title, ar.title FROM album al
         JOIN media_entry me ON me.id = al.id
         LEFT JOIN artist ar ON ar.id = me.parent_id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM mb_credit_fetch f WHERE f.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
         ORDER BY al.sort_title COLLATE NOCASE",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if albums.is_empty() {
        return Ok((0, 0));
    }

    let total = albums.len();
    let mut matched = 0usize;
    let mut processed = 0usize;
    for (i, (album_id, title, artist)) in albums.into_iter().enumerate() {
        if CANCEL.load(Ordering::SeqCst) {
            break; // skip-remaining: the rest stay unstamped for later
        }
        processed = i + 1;
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "phase": "albums", "done": i, "total": total, "name": title }),
        );
        let candidates = match search_releases(client, &title, artist.as_deref()).await {
            Ok(c) => c,
            // Transient — unstamped, retried on the next pass.
            Err(e) => {
                eprintln!("musicbrainz release search '{title}': {e}");
                continue;
            }
        };

        // Confident: top candidate clears the score bar AND the title agrees.
        let confident = candidates
            .first()
            .filter(|c| c.score >= MB_MIN_SCORE && titles_match(&normalize(&c.title), &normalize(&title)))
            .map(|c| c.release_id.clone());

        if let Some(release_id) = confident {
            match fetch_release(client, &release_id).await {
                Ok(Some(full)) => {
                    apply_release(pool, library_id, album_id, &title, &full).await?;
                    stamp(pool, album_id, "matched").await?;
                    matched += 1;
                }
                Ok(None) => stamp(pool, album_id, "notfound").await?,
                Err(e) => eprintln!("musicbrainz release fetch '{title}': {e}"),
            }
        } else if !candidates.is_empty() {
            // Mid-confidence → the user picks in the modal. Our album's own
            // year/track count ride along so there's something to compare
            // candidates against.
            let ours: Option<(Option<String>, i64)> = sqlx::query_as(
                "SELECT al.release_date,
                        (SELECT COUNT(*) FROM track_release tr
                         JOIN album_release ar ON ar.id = tr.release_id
                         WHERE ar.album_id = al.id AND ar.is_default = 1)
                 FROM album al WHERE al.id = ?",
            )
            .bind(album_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            let (album_date, album_tracks) = ours.unwrap_or((None, 0));
            let payload = serde_json::json!({
                "album_id": album_id,
                "album_title": title,
                "artist_title": artist,
                "album_date": album_date,
                "album_tracks": album_tracks,
                "candidates": candidates.iter().take(5).collect::<Vec<_>>(),
            });
            sqlx::query(
                "INSERT OR IGNORE INTO mb_suggestion (library_id, kind, target_key, payload)
                 VALUES (?, 'album_match', ?, ?)",
            )
            .bind(library_id)
            .bind(album_id.to_string())
            .bind(payload.to_string())
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            stamp(pool, album_id, "uncertain").await?;
        } else {
            stamp(pool, album_id, "notfound").await?;
        }
    }
    Ok((matched, processed))
}

async fn stamp(pool: &SqlitePool, album_id: i64, status: &str) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO mb_credit_fetch (album_id, status) VALUES (?, ?)")
        .bind(album_id)
        .bind(status)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// MusicBrainz HTTP
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseCandidate {
    pub release_id: String,
    pub title: String,
    pub artist: String,
    pub date: Option<String>,
    pub track_count: Option<i64>,
    pub score: i64,
    /// Differentiators for same-titled releases (albums literally named "?").
    pub country: Option<String>,
    pub format: Option<String>,
    pub label: Option<String>,
    pub status: Option<String>,
    pub disambiguation: Option<String>,
}

async fn search_releases(
    client: &reqwest::Client,
    album_title: &str,
    album_artist: Option<&str>,
) -> Result<Vec<ReleaseCandidate>, String> {
    let mut query = format!("release:\"{}\"", album_title.replace('"', " "));
    if let Some(artist) = album_artist {
        query.push_str(&format!(" AND artist:\"{}\"", artist.replace('"', " ")));
    }
    let url = url::Url::parse_with_params(
        "https://musicbrainz.org/ws/2/release",
        &[("query", query.as_str()), ("fmt", "json"), ("limit", "8")],
    )
    .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    tokio::time::sleep(REQUEST_GAP).await;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    Ok(body["releases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let formats: Vec<String> = r["media"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|m| m["format"].as_str().map(|s| s.to_string()))
                .collect();
            let mut unique_formats: Vec<String> = Vec::new();
            for f in formats {
                if !unique_formats.contains(&f) {
                    unique_formats.push(f);
                }
            }
            let label = r["label-info"].as_array().and_then(|li| {
                li.first().map(|l| {
                    let name = l["label"]["name"].as_str().unwrap_or_default();
                    let catno = l["catalog-number"].as_str().unwrap_or_default();
                    match (name.is_empty(), catno.is_empty()) {
                        (false, false) => format!("{name} {catno}"),
                        (false, true) => name.to_string(),
                        (true, false) => catno.to_string(),
                        (true, true) => String::new(),
                    }
                })
            })
            .filter(|s| !s.is_empty());
            Some(ReleaseCandidate {
                release_id: r["id"].as_str()?.to_string(),
                title: r["title"].as_str().unwrap_or_default().to_string(),
                artist: r["artist-credit"]
                    .as_array()
                    .map(|ac| {
                        ac.iter()
                            .filter_map(|c| c["name"].as_str().or_else(|| c["artist"]["name"].as_str()))
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default(),
                date: r["date"].as_str().map(|s| s.to_string()),
                track_count: r["track-count"].as_i64(),
                score: r["score"].as_i64().unwrap_or(0),
                country: r["country"].as_str().map(|s| s.to_string()),
                format: if unique_formats.is_empty() { None } else { Some(unique_formats.join("+")) },
                label,
                status: r["status"].as_str().map(|s| s.to_string()),
                disambiguation: r["disambiguation"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()),
            })
        })
        .filter(|c| c.score >= 50)
        .collect())
}

/// One MB track's credit list: (disc, position, title, [(credited name, artist mbid)]).
type MbTrack = (i64, i64, String, Vec<(String, Option<String>)>);

struct MbReleaseFull {
    release_id: String,
    release_group_id: Option<String>,
    /// 'album' | 'ep' | 'single' | 'compilation' — from the release group.
    album_type: Option<String>,
    /// Release-group first release date (falls back to the release date).
    date: Option<String>,
    tracks: Vec<MbTrack>,
}

async fn fetch_release(
    client: &reqwest::Client,
    release_id: &str,
) -> Result<Option<MbReleaseFull>, String> {
    let url = url::Url::parse_with_params(
        &format!("https://musicbrainz.org/ws/2/release/{release_id}"),
        &[("inc", "recordings+artist-credits+release-groups"), ("fmt", "json")],
    )
    .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    tokio::time::sleep(REQUEST_GAP).await;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let rg = &body["release-group"];
    let album_type = mb_album_type(rg);
    let date = rg["first-release-date"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| body["date"].as_str().filter(|s| !s.is_empty()))
        .map(|s| s.to_string());

    let mut tracks: Vec<MbTrack> = Vec::new();
    for (mi, medium) in body["media"].as_array().into_iter().flatten().enumerate() {
        for track in medium["tracks"].as_array().into_iter().flatten() {
            let position = track["position"].as_i64().unwrap_or(0);
            let title = track["title"].as_str().unwrap_or_default().to_string();
            let credits: Vec<(String, Option<String>)> = track["artist-credit"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| {
                    let name = c["name"]
                        .as_str()
                        .or_else(|| c["artist"]["name"].as_str())?
                        .trim()
                        .to_string();
                    if name.is_empty() {
                        return None;
                    }
                    Some((name, c["artist"]["id"].as_str().map(|s| s.to_string())))
                })
                .collect();
            if !credits.is_empty() {
                tracks.push(((mi + 1) as i64, position, title, credits));
            }
        }
    }
    Ok(if tracks.is_empty() {
        None
    } else {
        Some(MbReleaseFull {
            release_id: release_id.to_string(),
            release_group_id: rg["id"].as_str().map(|s| s.to_string()),
            album_type,
            date,
            tracks,
        })
    })
}

/// MusicBrainz release-group types → our album_type vocabulary. Secondary
/// types beat the primary (a compilation's primary type is usually Album).
fn mb_album_type(rg: &serde_json::Value) -> Option<String> {
    let secondaries: Vec<String> = rg["secondary-types"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(|s| s.to_lowercase()))
        .collect();
    if secondaries.iter().any(|s| s == "compilation") {
        return Some("compilation".to_string());
    }
    match rg["primary-type"].as_str().map(|s| s.to_lowercase()).as_deref() {
        Some("album") => Some("album".to_string()),
        Some("ep") => Some("ep".to_string()),
        Some("single") => Some("single".to_string()),
        // Broadcast/Other/absent — leave whatever we have alone.
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Applying a matched release (gap fills + derived-data replacement, logged)
// ---------------------------------------------------------------------------

async fn apply_release(
    pool: &SqlitePool,
    library_id: &str,
    album_id: i64,
    album_title: &str,
    full: &MbReleaseFull,
) -> Result<(), String> {
    // Credits: replace our parsed guesses on the default release's tracks.
    if !suppressed(pool, "track_credits", album_id).await? {
        let changes = apply_release_credits(pool, album_id, &full.tracks).await?;
        if !changes.is_empty() {
            let before: HashMap<String, Vec<String>> = changes
                .iter()
                .map(|(id, b, _)| (id.to_string(), b.clone()))
                .collect();
            let after: HashMap<String, Vec<String>> = changes
                .iter()
                .map(|(id, _, a)| (id.to_string(), a.clone()))
                .collect();
            log_change(
                pool,
                library_id,
                "track_credits",
                album_id,
                &format!("{album_title} — credits on {} tracks", changes.len()),
                &serde_json::json!(before),
                &serde_json::json!(after),
            )
            .await?;
        }
    }

    // Album type: MB's release-group type replaces the track-count guess —
    // unless the user set the type themselves (user tier outranks external).
    if let Some(mb_type) = &full.album_type {
        if !suppressed(pool, "album_type", album_id).await?
            && !crate::music_edit::has_override(pool, album_id, "album_type").await?
        {
            let (current,): (String,) = sqlx::query_as("SELECT album_type FROM album WHERE id = ?")
                .bind(album_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            if &current != mb_type {
                sqlx::query("UPDATE album SET album_type = ? WHERE id = ?")
                    .bind(mb_type)
                    .bind(album_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                log_change(
                    pool,
                    library_id,
                    "album_type",
                    album_id,
                    &format!("{album_title} — type {current} → {mb_type}"),
                    &serde_json::json!({ "album_type": current }),
                    &serde_json::json!({ "album_type": mb_type }),
                )
                .await?;
            }
        }
    }

    // Release date: pure gap fill — only when the tags supplied nothing and
    // the user hasn't set (or cleared) the date themselves.
    if let Some(mb_date) = &full.date {
        if !suppressed(pool, "album_year", album_id).await?
            && !crate::music_edit::has_override(pool, album_id, "release_date").await?
        {
            let (current,): (Option<String>,) =
                sqlx::query_as("SELECT release_date FROM album WHERE id = ?")
                    .bind(album_id)
                    .fetch_one(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            if current.is_none() {
                sqlx::query("UPDATE album SET release_date = ? WHERE id = ?")
                    .bind(mb_date)
                    .bind(album_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                log_change(
                    pool,
                    library_id,
                    "album_year",
                    album_id,
                    &format!("{album_title} — date filled: {mb_date}"),
                    &serde_json::json!({ "release_date": null }),
                    &serde_json::json!({ "release_date": mb_date }),
                )
                .await?;
            }
        }
    }

    // Keep the matched ids (feeds edition merging + future art/metadata).
    sqlx::query(
        "UPDATE album_release SET mb_release_id = ? WHERE album_id = ? AND is_default = 1
           AND (mb_release_id IS NULL OR mb_release_id = '')",
    )
    .bind(&full.release_id)
    .bind(album_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(rg) = &full.release_group_id {
        sqlx::query(
            "INSERT INTO album_mb (album_id, mb_release_group_id) VALUES (?, ?)
             ON CONFLICT(album_id) DO UPDATE SET mb_release_group_id = excluded.mb_release_group_id",
        )
        .bind(album_id)
        .bind(rg)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replace the tag-parsed credits of the album's DEFAULT release with MB's,
/// matching tracks by (disc, position) and a loose title check. Returns the
/// per-track (id, before, after) changes for the log. MB-provided artist ids
/// seed the artist-lookup cache so the MBID pass skips them.
async fn apply_release_credits(
    pool: &SqlitePool,
    album_id: i64,
    mb_tracks: &[MbTrack],
) -> Result<Vec<(i64, Vec<String>, Vec<String>)>, String> {
    let ours: Vec<(i64, String, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT t.id, t.title, t.disc_number, t.track_number
         FROM track t
         JOIN track_release tr ON tr.track_id = t.id
         JOIN album_release ar ON ar.id = tr.release_id
         WHERE ar.album_id = ? AND ar.is_default = 1",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut changes = Vec::new();
    for (track_id, our_title, disc, number) in ours {
        // User-edited credits outrank MB's — skip the track entirely.
        if crate::music_edit::has_override(pool, track_id, "credits").await? {
            continue;
        }
        let (disc, number) = (disc.unwrap_or(1), number.unwrap_or(0));
        let Some((_, _, mb_title, credits)) = mb_tracks
            .iter()
            .find(|(d, p, _, _)| *d == disc && *p == number)
        else {
            continue;
        };
        if !titles_match(&normalize(&our_title), &normalize(mb_title)) {
            continue; // positions collide but songs differ — keep tag credits
        }
        let before: Vec<String> = sqlx::query_as::<_, (String,)>(
            "SELECT name FROM track_credit WHERE track_id = ? ORDER BY position",
        )
        .bind(track_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(n,)| n)
        .collect();
        let after: Vec<String> = credits.iter().map(|(n, _)| n.clone()).collect();

        if before != after {
            sqlx::query("DELETE FROM track_credit WHERE track_id = ?")
                .bind(track_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            for (pos, name) in after.iter().enumerate() {
                sqlx::query("INSERT INTO track_credit (track_id, position, name) VALUES (?, ?, ?)")
                    .bind(track_id)
                    .bind(pos as i64)
                    .bind(name)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            changes.push((track_id, before, after));
        }
        for (name, mbid) in credits {
            if let Some(mbid) = mbid {
                sqlx::query(
                    "INSERT OR REPLACE INTO mb_artist_lookup (name, mbid, status) VALUES (?, ?, 'matched')",
                )
                .bind(name.to_lowercase())
                .bind(mbid)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(changes)
}

/// Lowercase alphanumerics only — punctuation-proof title comparison.
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn titles_match(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && (a == b || a.contains(b) || b.contains(a))
}

// ---------------------------------------------------------------------------
// Artist MBIDs
// ---------------------------------------------------------------------------

async fn enrich_artist_mbids(
    app: &AppHandle,
    pool: &SqlitePool,
    client: &reqwest::Client,
    library_id: &str,
) -> Result<usize, String> {
    let artists: Vec<(i64, String)> = sqlx::query_as(
        "SELECT a.id, a.title FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ? AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')
         ORDER BY a.sort_title COLLATE NOCASE",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if artists.is_empty() {
        return Ok(0);
    }

    let total = artists.len();
    let mut updated = 0usize;
    for (i, (artist_id, title)) in artists.into_iter().enumerate() {
        if CANCEL.load(Ordering::SeqCst) {
            break; // skip-remaining: MBIDs fill in on a later pass
        }
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "phase": "artists", "done": i, "total": total, "name": title }),
        );
        if let Some(mbid) = cached_or_lookup_artist(pool, client, &title).await? {
            sqlx::query(
                "UPDATE artist SET musicbrainz_id = ? WHERE id = ? AND (musicbrainz_id IS NULL OR musicbrainz_id = '')",
            )
            .bind(&mbid)
            .bind(artist_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            updated += 1;
        }
    }
    Ok(updated)
}

/// Settled lookups (matched or notfound) come from the cache; anything new
/// hits the API (rate-limited) and settles the cache. Transient failures
/// return None without caching, so they retry next pass.
async fn cached_or_lookup_artist(
    pool: &SqlitePool,
    client: &reqwest::Client,
    name: &str,
) -> Result<Option<String>, String> {
    let key = name.to_lowercase();
    let cached: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT mbid, status FROM mb_artist_lookup WHERE name = ?")
            .bind(&key)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    if let Some((mbid, _)) = cached {
        return Ok(mbid);
    }
    let looked_up = lookup_artist(client, name).await;
    tokio::time::sleep(REQUEST_GAP).await;
    match looked_up {
        Ok(mbid) => {
            sqlx::query("INSERT OR REPLACE INTO mb_artist_lookup (name, mbid, status) VALUES (?, ?, ?)")
                .bind(&key)
                .bind(&mbid)
                .bind(if mbid.is_some() { "matched" } else { "notfound" })
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(mbid)
        }
        Err(e) => {
            eprintln!("musicbrainz artist lookup '{name}': {e}");
            Ok(None)
        }
    }
}

/// Search MusicBrainz for one artist name. Ok(Some(mbid)) on a confident
/// match, Ok(None) for a settled miss, Err for transient failures.
async fn lookup_artist(client: &reqwest::Client, name: &str) -> Result<Option<String>, String> {
    let query = format!("artist:\"{}\"", name.replace('"', " "));
    let url = url::Url::parse_with_params(
        "https://musicbrainz.org/ws/2/artist",
        &[("query", query.as_str()), ("fmt", "json"), ("limit", "5")],
    )
    .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        return Err("rate limited (503)".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let candidates = body["artists"].as_array().cloned().unwrap_or_default();
    for artist in candidates {
        let score = artist["score"].as_i64().unwrap_or(0);
        if score < MB_MIN_SCORE {
            break; // results are score-ordered; nothing below the bar matches
        }
        let mb_name = artist["name"].as_str().unwrap_or_default();
        let name_matches = mb_name.eq_ignore_ascii_case(name)
            || artist["aliases"]
                .as_array()
                .map(|aliases| {
                    aliases.iter().any(|a| {
                        a["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))
                    })
                })
                .unwrap_or(false);
        if name_matches {
            if let Some(id) = artist["id"].as_str() {
                return Ok(Some(id.to_string()));
            }
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Identity: MBID-proven merges
// ---------------------------------------------------------------------------

/// Two artist rows with the SAME MusicBrainz id are provably one person —
/// auto-merge (logged, undoable): the one with albums keeps the page, the
/// other's names become aliases, its albums (if any) move over.
async fn merge_mbid_duplicates(pool: &SqlitePool, library_id: &str) -> Result<(), String> {
    let rows: Vec<(i64, String, String, i64)> = sqlx::query_as(
        "SELECT a.id, a.title, a.musicbrainz_id,
                (SELECT COUNT(*) FROM media_entry c WHERE c.parent_id = a.id)
         FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ? AND a.musicbrainz_id IS NOT NULL AND a.musicbrainz_id != ''
         ORDER BY a.musicbrainz_id, 4 DESC, a.id ASC",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut by_mbid: HashMap<String, Vec<(i64, String)>> = HashMap::new();
    for (id, title, mbid, _) in rows {
        by_mbid.entry(mbid).or_default().push((id, title));
    }
    for (_, group) in by_mbid {
        if group.len() < 2 {
            continue;
        }
        let (keep_id, keep_title) = group[0].clone();
        for (other_id, other_title) in group.into_iter().skip(1) {
            // A rejected/undone merge for this name is a standing "no".
            let veto: Option<(i64,)> = sqlx::query_as(
                "SELECT 1 FROM mb_suggestion
                 WHERE library_id = ? AND kind = 'artist_merge' AND target_key = ? AND status = 'rejected'",
            )
            .bind(library_id)
            .bind(other_title.to_lowercase())
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            if veto.is_some() {
                continue;
            }
            merge_artists(pool, library_id, keep_id, &keep_title, Some(other_id), &other_title)
                .await?;
        }
    }
    Ok(())
}

/// Find an artist by stored-id hint, falling back to an alias-aware name
/// lookup — for resolving references that may have gone stale (the artist was
/// merged, swept, or renamed since the reference was written). Returns the
/// CURRENT id and title.
async fn resolve_artist_by_hint(
    pool: &SqlitePool,
    library_id: &str,
    id_hint: i64,
    name: &str,
) -> Result<Option<(i64, String)>, String> {
    let by_id: Option<(i64, String)> = sqlx::query_as(
        "SELECT a.id, a.title FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE a.id = ? AND me.library_id = ?",
    )
    .bind(id_hint)
    .bind(library_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    if by_id.is_some() {
        return Ok(by_id);
    }
    sqlx::query_as(
        "SELECT a.id, a.title FROM artist_names an
         JOIN artist a ON a.id = an.artist_id
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ? AND LOWER(an.name) = LOWER(?) LIMIT 1",
    )
    .bind(library_id)
    .bind(name)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
}

/// Fold `other` (an artist row and/or a bare credit spelling) into `keep`:
/// aliases carry the name(s), albums reparent, the row goes. Logged with
/// everything needed to undo.
pub async fn merge_artists(
    pool: &SqlitePool,
    library_id: &str,
    keep_id: i64,
    keep_title: &str,
    other_id: Option<i64>,
    other_name: &str,
) -> Result<(), String> {
    let mut aliases_added: Vec<String> = Vec::new();
    let mut other_aliases: Vec<String> = Vec::new();
    let mut albums_moved: Vec<i64> = Vec::new();

    let add_alias = |name: String, aliases_added: &mut Vec<String>| {
        if !name.eq_ignore_ascii_case(keep_title) {
            aliases_added.push(name);
        }
    };
    add_alias(other_name.to_string(), &mut aliases_added);

    if let Some(other_id) = other_id {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM artist_alias WHERE artist_id = ?")
                .bind(other_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
        for (name,) in rows {
            other_aliases.push(name.clone());
            add_alias(name, &mut aliases_added);
        }
        let children: Vec<(i64,)> =
            sqlx::query_as("SELECT id FROM media_entry WHERE parent_id = ?")
                .bind(other_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
        for (child,) in children {
            albums_moved.push(child);
            sqlx::query("UPDATE media_entry SET parent_id = ? WHERE id = ?")
                .bind(keep_id)
                .bind(child)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        sqlx::query("DELETE FROM media_entry WHERE id = ?")
            .bind(other_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    for name in &aliases_added {
        sqlx::query("INSERT OR IGNORE INTO artist_alias (artist_id, name) VALUES (?, ?)")
            .bind(keep_id)
            .bind(name)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    log_change(
        pool,
        library_id,
        "artist_merge",
        keep_id,
        &format!("\u{201c}{other_name}\u{201d} merged into \u{201c}{keep_title}\u{201d}"),
        &serde_json::json!({
            "other_title": other_name,
            "other_existed": other_id.is_some(),
            "other_aliases": other_aliases,
            "albums_moved": albums_moved,
            "aliases_added": aliases_added,
        }),
        &serde_json::json!({ "keep_id": keep_id, "keep_title": keep_title }),
    )
    .await?;

    // Any pending suggestion for this name is now settled.
    sqlx::query(
        "UPDATE mb_suggestion SET status = 'accepted'
         WHERE library_id = ? AND kind = 'artist_merge' AND target_key = ? AND status = 'pending'",
    )
    .bind(library_id)
    .bind(other_name.to_lowercase())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Pending heuristic merge suggestions get auto-accepted when MusicBrainz
/// proves the identity: the lookalike name resolves to the same MBID as the
/// keep-target artist.
async fn resolve_merge_suggestions_via_mbid(
    pool: &SqlitePool,
    client: &reqwest::Client,
    library_id: &str,
) -> Result<(), String> {
    let pending: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, payload FROM mb_suggestion
         WHERE library_id = ? AND kind = 'artist_merge' AND status = 'pending'",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for (suggestion_id, payload) in pending {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&payload) else { continue };
        let (Some(keep_id), Some(keep_title), Some(other_name)) = (
            payload["keep_id"].as_i64(),
            payload["keep_title"].as_str(),
            payload["other_name"].as_str(),
        ) else {
            continue;
        };
        let keeper_mbid: Option<(Option<String>,)> =
            sqlx::query_as("SELECT musicbrainz_id FROM artist WHERE id = ?")
                .bind(keep_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        let Some((Some(keeper_mbid),)) = keeper_mbid else { continue };
        if keeper_mbid.is_empty() {
            continue;
        }
        if let Some(other_mbid) = cached_or_lookup_artist(pool, client, other_name).await? {
            if other_mbid == keeper_mbid {
                merge_artists(pool, library_id, keep_id, keep_title, None, other_name).await?;
                let _ = suggestion_id; // status flipped inside merge_artists
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Review commands (the Match-to-MusicBrainz modal)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct MbSuggestionView {
    pub id: i64,
    pub kind: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct MbUnmatchedAlbum {
    pub album_id: i64,
    pub title: String,
    pub artist_title: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MbChangeView {
    pub id: i64,
    pub kind: String,
    pub label: String,
    pub undone: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct MbReview {
    pub suggestions: Vec<MbSuggestionView>,
    pub unmatched: Vec<MbUnmatchedAlbum>,
    pub changes: Vec<MbChangeView>,
}

#[tauri::command]
pub async fn mb_get_review(state: State<'_, AppState>, library_id: String) -> Result<MbReview, String> {
    let pool = &state.app_db;
    let suggestion_rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, kind, payload FROM mb_suggestion
         WHERE library_id = ? AND status = 'pending' ORDER BY kind, id",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let suggestions = suggestion_rows
        .into_iter()
        .map(|(id, kind, payload)| MbSuggestionView {
            id,
            kind,
            payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        })
        .collect();

    let unmatched_rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT al.id, al.title, ar.title FROM album al
         JOIN media_entry me ON me.id = al.id
         JOIN mb_credit_fetch f ON f.album_id = al.id AND f.status = 'notfound'
         LEFT JOIN artist ar ON ar.id = me.parent_id
         WHERE me.library_id = ?
         ORDER BY al.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let unmatched = unmatched_rows
        .into_iter()
        .map(|(album_id, title, artist_title)| MbUnmatchedAlbum { album_id, title, artist_title })
        .collect();

    let change_rows: Vec<(i64, String, String, i64, String)> = sqlx::query_as(
        "SELECT id, kind, label, undone, created_at FROM mb_change_log
         WHERE library_id = ? ORDER BY id DESC LIMIT 300",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let changes = change_rows
        .into_iter()
        .map(|(id, kind, label, undone, created_at)| MbChangeView {
            id,
            kind,
            label,
            undone: undone != 0,
            created_at,
        })
        .collect();

    Ok(MbReview { suggestions, unmatched, changes })
}

/// Live release search for the modal's manual matching.
#[tauri::command]
pub async fn mb_search_releases(
    query: String,
    artist: Option<String>,
) -> Result<Vec<ReleaseCandidate>, String> {
    let client = mb_client()?;
    search_releases(&client, &query, artist.as_deref()).await
}

/// Apply a chosen release to an album (modal candidate pick or manual search
/// result). Same application path as a confident auto-match.
#[tauri::command]
pub async fn mb_apply_album_match(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    album_id: i64,
    mb_release_id: String,
) -> Result<(), String> {
    let pool = &state.app_db;
    let client = mb_client()?;
    let (album_title,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let full = fetch_release(&client, &mb_release_id)
        .await?
        .ok_or_else(|| "release has no usable track data".to_string())?;
    apply_release(pool, &library_id, album_id, &album_title, &full).await?;
    stamp(pool, album_id, "matched").await?;
    sqlx::query(
        "UPDATE mb_suggestion SET status = 'accepted'
         WHERE library_id = ? AND kind = 'album_match' AND target_key = ?",
    )
    .bind(&library_id)
    .bind(album_id.to_string())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    // Silent refresh (no toast: zero counts).
    let _ = app.emit(
        "music-enrich-done",
        serde_json::json!({ "libraryId": library_id, "updated": 0, "albumsMatched": 0, "processed": 0, "pendingReview": 0 }),
    );
    Ok(())
}

/// Accept or reject a suggestion. Rejections persist (never re-asked) and
/// veto future auto-merges of the same name.
#[tauri::command]
pub async fn mb_resolve_suggestion(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    suggestion_id: i64,
    accept: bool,
) -> Result<(), String> {
    let pool = &state.app_db;
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT kind, payload FROM mb_suggestion WHERE id = ? AND library_id = ?")
            .bind(suggestion_id)
            .bind(&library_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some((kind, payload)) = row else {
        return Err("suggestion not found".to_string());
    };

    if !accept {
        sqlx::query("UPDATE mb_suggestion SET status = 'rejected' WHERE id = ?")
            .bind(suggestion_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    match kind.as_str() {
        "artist_merge" => {
            let payload: serde_json::Value =
                serde_json::from_str(&payload).map_err(|e| e.to_string())?;
            let keep_id_hint = payload["keep_id"].as_i64().ok_or("bad payload")?;
            let keep_title_hint = payload["keep_title"].as_str().ok_or("bad payload")?;
            let other_name = payload["other_name"].as_str().ok_or("bad payload")?;
            // Suggestions can outlive the artist rows they reference (sweeps,
            // auto-merges, rescans, renames) — the stored id is only a hint;
            // re-resolve by name (alias-aware) at accept time so a stale id
            // can't hit the artist_alias foreign key.
            let Some((keep_id, keep_title)) =
                resolve_artist_by_hint(pool, &library_id, keep_id_hint, keep_title_hint).await?
            else {
                sqlx::query("DELETE FROM mb_suggestion WHERE id = ?")
                    .bind(suggestion_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                return Err(format!(
                    "\u{201c}{keep_title_hint}\u{201d} no longer exists (merged or swept since this was suggested) — suggestion dismissed"
                ));
            };
            // The lookalike may exist as a row (created before suggestions) or
            // be a bare credit spelling.
            let other_id: Option<(i64,)> = sqlx::query_as(
                "SELECT a.id FROM artist a JOIN media_entry me ON me.id = a.id
                 WHERE me.library_id = ? AND LOWER(a.title) = LOWER(?) AND a.id != ?",
            )
            .bind(&library_id)
            .bind(other_name)
            .bind(keep_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            merge_artists(pool, &library_id, keep_id, &keep_title, other_id.map(|(id,)| id), other_name)
                .await?;
        }
        // album_match acceptance flows through mb_apply_album_match (the
        // modal sends the chosen candidate there).
        other => return Err(format!("suggestion kind '{other}' has no direct accept")),
    }

    let _ = app.emit(
        "music-enrich-done",
        serde_json::json!({ "libraryId": library_id, "updated": 0, "albumsMatched": 0, "processed": 0, "pendingReview": 0 }),
    );
    Ok(())
}

/// Undo one logged change: restore the before-value and suppress reapplication.
#[tauri::command]
pub async fn mb_undo_change(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    change_id: i64,
) -> Result<(), String> {
    let pool = &state.app_db;
    let row: Option<(String, i64, Option<String>, i64)> = sqlx::query_as(
        "SELECT kind, target_id, before_json, undone FROM mb_change_log WHERE id = ? AND library_id = ?",
    )
    .bind(change_id)
    .bind(&library_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((kind, target_id, before_json, undone)) = row else {
        return Err("change not found".to_string());
    };
    if undone != 0 {
        return Ok(());
    }
    let before: serde_json::Value = before_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(serde_json::Value::Null);

    match kind.as_str() {
        "track_credits" => {
            if let Some(map) = before.as_object() {
                for (track_id, names) in map {
                    let Ok(track_id) = track_id.parse::<i64>() else { continue };
                    // User-edited credits stay put through an MB undo too.
                    if crate::music_edit::has_override(pool, track_id, "credits").await? {
                        continue;
                    }
                    sqlx::query("DELETE FROM track_credit WHERE track_id = ?")
                        .bind(track_id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    for (pos, name) in names.as_array().into_iter().flatten().enumerate() {
                        if let Some(name) = name.as_str() {
                            sqlx::query(
                                "INSERT INTO track_credit (track_id, position, name) VALUES (?, ?, ?)",
                            )
                            .bind(track_id)
                            .bind(pos as i64)
                            .bind(name)
                            .execute(pool)
                            .await
                            .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
        "album_type" => {
            if let Some(t) = before["album_type"].as_str() {
                sqlx::query("UPDATE album SET album_type = ? WHERE id = ?")
                    .bind(t)
                    .bind(target_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        "album_year" => {
            let date = before["release_date"].as_str();
            sqlx::query("UPDATE album SET release_date = ? WHERE id = ?")
                .bind(date)
                .bind(target_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        "artist_merge" => {
            let aliases_added: Vec<String> = before["aliases_added"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            for name in &aliases_added {
                sqlx::query("DELETE FROM artist_alias WHERE artist_id = ? AND name = ?")
                    .bind(target_id)
                    .bind(name)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            let other_title = before["other_title"].as_str().unwrap_or_default();
            if before["other_existed"].as_bool().unwrap_or(false) && !other_title.is_empty() {
                // Recreate the folded-in artist and give it back its albums.
                let artist = crate::music::ScannedArtist {
                    title: other_title.to_string(),
                    albums: Vec::new(),
                    loose: Vec::new(),
                };
                let order = crate::music::next_artist_order(pool, &library_id).await?;
                let new_id = crate::music::insert_artist_row(
                    pool,
                    &library_id,
                    std::path::Path::new(""),
                    &artist,
                    order,
                )
                .await?;
                for name in before["other_aliases"].as_array().into_iter().flatten() {
                    if let Some(name) = name.as_str() {
                        sqlx::query("INSERT OR IGNORE INTO artist_alias (artist_id, name) VALUES (?, ?)")
                            .bind(new_id)
                            .bind(name)
                            .execute(pool)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
                for album in before["albums_moved"].as_array().into_iter().flatten() {
                    if let Some(album_id) = album.as_i64() {
                        sqlx::query("UPDATE media_entry SET parent_id = ? WHERE id = ?")
                            .bind(new_id)
                            .bind(album_id)
                            .execute(pool)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
            // A standing "no" so the auto-merge never redoes it.
            if !other_title.is_empty() {
                sqlx::query(
                    "INSERT INTO mb_suggestion (library_id, kind, target_key, payload, status)
                     VALUES (?, 'artist_merge', ?, '{}', 'rejected')
                     ON CONFLICT(library_id, kind, target_key) DO UPDATE SET status = 'rejected'",
                )
                .bind(&library_id)
                .bind(other_title.to_lowercase())
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        other => return Err(format!("change kind '{other}' cannot be undone")),
    }

    // Merge suppression is handled by the rejected suggestion row above; the
    // rest suppress by (kind, target).
    if kind != "artist_merge" {
        sqlx::query("INSERT OR IGNORE INTO mb_suppression (kind, target_id) VALUES (?, ?)")
            .bind(&kind)
            .bind(target_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    sqlx::query("UPDATE mb_change_log SET undone = 1 WHERE id = ?")
        .bind(change_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit(
        "music-enrich-done",
        serde_json::json!({ "libraryId": library_id, "updated": 0, "albumsMatched": 0, "processed": 0, "pendingReview": 0 }),
    );
    Ok(())
}
