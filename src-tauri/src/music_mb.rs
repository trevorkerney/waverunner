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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
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

/// Is a matching pass running right now? Heavy background work that shares
/// the DB and CPU (waveform preload) polls this and yields.
pub(crate) fn pass_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// How many user-initiated commands are waiting on MusicBrainz right now
/// (a match apply, a dialog search). The background prefetch loops share the
/// one request gate and would otherwise queue a click behind their own
/// fetches; they poll this between requests and hold off while it's nonzero.
static USER_WAITING: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn user_waiting() -> bool {
    USER_WAITING.load(Ordering::SeqCst) > 0
}

/// RAII marker for a user-facing command's lifetime: held from entry to
/// return (including early returns and errors), so the prefetch loops stand
/// aside for exactly as long as the click is being served.
pub(crate) struct UserPriority;

impl UserPriority {
    pub(crate) fn hold() -> Self {
        USER_WAITING.fetch_add(1, Ordering::SeqCst);
        UserPriority
    }
}

impl Drop for UserPriority {
    fn drop(&mut self) {
        USER_WAITING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Which library the running pass is working on (None = no pass).
static PASS_LIBRARY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub(crate) fn pass_library() -> Option<String> {
    PASS_LIBRARY.lock().ok().and_then(|g| g.clone())
}

fn set_pass_library(library_id: Option<&str>) {
    if let Ok(mut g) = PASS_LIBRARY.lock() {
        *g = library_id.map(|s| s.to_string());
    }
}

/// The pass rewrites albums, artists and credits as it runs; a user edit
/// racing it has no defined outcome. The library stays browsable and
/// playable while a pass runs (2026-09-22, replacing the frontend lock that
/// bounced the user out) — every WRITE command checks here instead and
/// reports why it did nothing. Three keys: the library, an entity in it, or
/// a release (album_release row) of an album in it.
pub(crate) async fn ensure_not_matching(pool: &SqlitePool, library_id: &str) -> Result<(), String> {
    if pass_library().as_deref() != Some(library_id) {
        return Ok(());
    }
    let name: Option<(String,)> = sqlx::query_as("SELECT name FROM library WHERE id = ?")
        .bind(library_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let name = name.map(|(n,)| n).unwrap_or_else(|| "This library".to_string());
    Err(format!(
        "\u{201c}{name}\u{201d} is being matched \u{2014} edits are available again when the pass finishes"
    ))
}

pub(crate) async fn ensure_entity_not_matching(pool: &SqlitePool, entity_id: i64) -> Result<(), String> {
    let Some(lib) = pass_library() else { return Ok(()) };
    let row: Option<(String,)> = sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
        .bind(entity_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    match row {
        Some((l,)) if l == lib => ensure_not_matching(pool, &l).await,
        _ => Ok(()),
    }
}

pub(crate) async fn ensure_release_not_matching(pool: &SqlitePool, release_id: i64) -> Result<(), String> {
    if pass_library().is_none() {
        return Ok(());
    }
    let row: Option<(i64,)> = sqlx::query_as("SELECT album_id FROM album_release WHERE id = ?")
        .bind(release_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    match row {
        Some((album_id,)) => ensure_entity_not_matching(pool, album_id).await,
        None => Ok(()),
    }
}

const MB_MIN_SCORE: i64 = 90;
const REQUEST_GAP: std::time::Duration = std::time::Duration::from_millis(1100);

/// One process-wide pacing gate. MusicBrainz's rate limit (1 req/s per IP)
/// doesn't care whether a request came from the background pass or a dialog
/// search — pacing each caller in isolation let a pass + a manual search
/// combine to ~2 req/s and 503 everything. Every request now waits its turn
/// here: REQUEST_GAP since the previous send, whoever sent it. The lock is
/// held through the send, so requests are also strictly serial.
static GATE: std::sync::OnceLock<tokio::sync::Mutex<Option<std::time::Instant>>> =
    std::sync::OnceLock::new();

/// App handle for the `mb-busy` beacon, set once at startup — lets open
/// dialogs say a long spinner is MusicBrainz shedding load, not a hang.
static MB_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn set_mb_app(app: AppHandle) {
    let _ = MB_APP.set(app);
}

/// GET with 503 patience: MusicBrainz sheds load in waves of Service
/// Unavailable, so wait it out (5s, then 15s) before giving the item up as a
/// transient failure — each backoff emits `mb-busy` so open dialogs can say
/// why their spinner is slow. Cancellation (skip-remaining) aborts the waits.
/// Pacing lives HERE (the gate above), pre-send — callers add no sleeps.
async fn mb_get(
    client: &reqwest::Client,
    url: url::Url,
) -> Result<reqwest::Response, String> {
    let gate = GATE.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut delay = std::time::Duration::from_secs(5);
    for attempt in 0..3 {
        let resp = {
            let mut last = gate.lock().await;
            if let Some(prev) = *last {
                let elapsed = prev.elapsed();
                if elapsed < REQUEST_GAP {
                    tokio::time::sleep(REQUEST_GAP - elapsed).await;
                }
            }
            *last = Some(std::time::Instant::now());
            client.get(url.clone()).send().await.map_err(|e| e.to_string())?
        };
        if resp.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE
            && attempt < 2
            && !CANCEL.load(Ordering::SeqCst)
        {
            if let Some(app) = MB_APP.get() {
                let _ = app.emit(
                    "mb-busy",
                    serde_json::json!({ "retryInMs": delay.as_millis() as u64 }),
                );
            }
            tokio::time::sleep(delay).await;
            delay *= 3;
            continue;
        }
        return Ok(resp);
    }
    unreachable!("loop always returns by the last attempt")
}

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

/// Claim a batch for one action about to be logged. Called once where the
/// action starts, then handed to each log_change it makes.
async fn next_batch(pool: &SqlitePool) -> Result<i64, String> {
    let (max,): (i64,) = sqlx::query_as("SELECT COALESCE(MAX(batch_id), 0) FROM mb_change_log")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(max + 1)
}

async fn log_change(
    pool: &SqlitePool,
    library_id: &str,
    kind: &str,
    target_id: i64,
    label: &str,
    before: &serde_json::Value,
    after: &serde_json::Value,
    // The action this row belongs to — matching an album logs credits, type
    // and date as separate rows but they undo together. Passed in rather than
    // inferred from the previous row: inference can't tell a continuing action
    // from a new one on the same album, so re-matching an album that had just
    // been unmatched silently joined the reverted action's batch.
    batch_id: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO mb_change_log (library_id, kind, target_id, label, before_json, after_json, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(library_id)
    .bind(kind)
    .bind(target_id)
    .bind(label)
    .bind(before.to_string())
    .bind(after.to_string())
    .bind(batch_id)
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
    set_pass_library(Some(&library_id));
    CANCEL.store(false, Ordering::SeqCst);
    // Fresh pass, fresh cache — see the pass-wide fetch cache block.
    clear_pass_caches();
    tauri::async_runtime::spawn(async move {
        // A pass ends only when re-running it immediately would do nothing.
        // One sweep's output is the next sweep's input — matches identify
        // artists, identified artists unlock their discographies — so sweep
        // until a run makes no progress (0 new matches, 0 new artists). The
        // cap is a backstop so a limping MusicBrainz can't stretch the
        // session; whatever it strands lands in the pending_pass queue.
        let result = async {
            let mut total = EnrichOutcome {
                albums_matched: 0,
                albums_processed: 0,
                artists_updated: 0,
                pending_review: 0,
                skipped: false,
            };
            for iteration in 1..=3u32 {
                let _ = app.emit(
                    "music-enrich-iteration",
                    serde_json::json!({ "libraryId": library_id, "iteration": iteration }),
                );
                let outcome = enrich(&app, &library_id).await?;
                total.albums_matched += outcome.albums_matched;
                total.albums_processed += outcome.albums_processed;
                total.artists_updated += outcome.artists_updated;
                total.pending_review = outcome.pending_review;
                total.skipped = outcome.skipped;
                if outcome.skipped
                    || (outcome.albums_matched == 0 && outcome.artists_updated == 0)
                {
                    break;
                }
            }
            Ok::<EnrichOutcome, String>(total)
        }
        .await;
        set_pass_library(None);
        RUNNING.store(false, Ordering::SeqCst);
        match result {
            Ok(outcome) => {
                // A completed loop EMPTIES the queue — no residue re-listing.
                // The loop only ends when a sweep made no progress, so
                // whatever is still unidentified is work a pass can't do
                // (pick a release, answer a card, fix a tag) and it already
                // shows in the center's red/amber sections. Re-listing it
                // here would dangle a "run a pass" invitation the invariant
                // promises is never needed. A skipped pass keeps the queue.
                if !outcome.skipped {
                    let pool = app.state::<AppState>().app_db.clone();
                    let _ = sqlx::query("DELETE FROM pending_pass WHERE library_id = ?")
                        .bind(&library_id)
                        .execute(&pool)
                        .await;
                }
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
        // Albums the pass just matched free their artists' cached
        // discographies.
        let pool = app.state::<AppState>().app_db.clone();
        let _ = evict_artist_group_caches(&pool).await;
        // Artist images ride in the background from here (a skipped pass
        // too — the wizard is done either way; the library stays usable).
        let _ = crate::music_art::start_artist_images_job(&app, &pool, &library_id).await;
    });
}

/// Start the matching pass (wizard match step / metadata-center re-run).
#[tauri::command]
pub async fn music_match_begin(app: AppHandle, library_id: String) -> Result<(), String> {
    // Backstop for the per-library opt-out — the UI hides every entry point,
    // but no pass should ever reach MusicBrainz against a recorded "off".
    let pool = app.state::<AppState>().app_db.clone();
    if !crate::commands::library_online_metadata(&pool, &library_id).await? {
        return Err("Online metadata is turned off for this library".to_string());
    }
    // Staged changes first: the pass would burn rate-limited requests against
    // a library the pending rescan is about to reshape (splits dissolve
    // artists, combines fold albums) — settle the shape, then identify it.
    let (staged,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pending_change WHERE library_id = ?")
            .bind(&library_id)
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
    if staged > 0 {
        return Err(format!(
            "{staged} staged change{} waiting for a rescan — rescan first, then run the pass",
            if staged == 1 { " is" } else { "s are" }
        ));
    }
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
    /// Albums never checked against MusicBrainz (no stamp). ONLY those —
    /// the artist-scoped retries below are a separate number, because each
    /// of them is already announced by its own re-check row in the pass
    /// queue; folding them in here counted every retry twice.
    pub unchecked: i64,
    /// Searched-and-not-found albums the next pass will retry under their
    /// now-identified artist's id (the arid tier).
    pub retry_albums: i64,
    /// Artists whose identity the pass can DERIVE: no MBID yet, but credited
    /// on a matched album (whose MB credit names them by id). Artists with no
    /// matched evidence aren't counted — the pass won't touch them. Albums
    /// and artists are separate counts because either can be zero while the
    /// other has work.
    pub unchecked_artists: i64,
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
    // Retry-eligible notfound / uncertain albums count too — the pass WILL
    // search them (arid tier), so the estimate must say so. Exhausted
    // retries don't.
    let (retry_albums,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM album al
         JOIN media_entry me ON me.id = al.id
         LEFT JOIN album_artist_credit ac0
                ON ac0.album_id = al.id
               AND ac0.position = (SELECT MIN(position) FROM album_artist_credit
                                   WHERE album_id = al.id)
         LEFT JOIN artist ar ON ar.id = ac0.artist_id
         WHERE me.library_id = ?
           AND EXISTS (SELECT 1 FROM mb_credit_fetch f
                       WHERE f.album_id = al.id AND f.status IN ('notfound', 'uncertain'))
           AND ar.musicbrainz_id IS NOT NULL AND ar.musicbrainz_id <> ''
           AND NOT EXISTS (SELECT 1 FROM mb_derive_exhausted x
                           WHERE x.entity_id = al.id
                             AND x.evidence_key = 'arid:' || ar.musicbrainz_id)
           AND NOT EXISTS (SELECT 1 FROM mb_suppression s
                           WHERE s.kind = 'album_match' AND s.target_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored')
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)",
    )
    .bind(&library_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (unchecked_artists,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?1 AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')
           AND (EXISTS (SELECT 1 FROM album_artist_credit ac
                        JOIN field_override f ON f.entity_id = ac.album_id
                           AND f.field = 'mb_release_group_id'
                        WHERE ac.artist_id = a.id
                          AND NOT EXISTS (SELECT 1 FROM mb_derive_exhausted x
                                          WHERE x.entity_id = a.id AND x.evidence_key = f.value))
             OR EXISTS (SELECT 1 FROM track_credit tc
                        JOIN media_entry tme ON tme.id = tc.track_id
                        JOIN release_match rm ON rm.album_id = tme.parent_id
                                             AND rm.mb_release_id <> ''
                        WHERE tc.artist_id = a.id
                          AND NOT EXISTS (SELECT 1 FROM mb_derive_exhausted x
                                          WHERE x.entity_id = a.id AND x.evidence_key = rm.mb_release_id))
             OR NOT EXISTS (SELECT 1 FROM mb_suggestion s
                            WHERE s.library_id = ?1 AND s.kind = 'artist_match'
                              AND s.target_key = CAST(a.id AS TEXT)))",
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
        retry_albums,
        unchecked_artists,
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
    // Pins made before title adoption existed: re-apply their per-track
    // data once — self-emptying like the date backfill. Runs BEFORE the
    // artist phases so the credits it writes are walked for ids in this
    // same pass, not the next one.
    backfill_pin_tracks(app, &pool, &client, library_id).await?;
    crate::music::ensure_credit_artists(&pool, library_id).await?;
    let (artists_updated, fetch_failed) =
        enrich_artist_mbids(app, &pool, &client, library_id).await?;
    // Features on group-matched albums: dig one level deeper (the group's
    // pressings) for track-credit MBIDs before falling back to asking.
    let (harvested, harvest_failed) =
        harvest_group_credits(app, &pool, &client, library_id).await?;
    let artists_updated = artists_updated + harvested;
    let fetch_failed: std::collections::HashSet<i64> =
        fetch_failed.union(&harvest_failed).copied().collect();
    // Original-date backfill for albums matched before adoption existed —
    // empties itself out after one full pass over old matches.
    backfill_group_dates(app, &pool, &client, library_id).await?;
    merge_mbid_duplicates(&pool, library_id).await?;
    suggest_artist_matches(app, &pool, &client, library_id, &fetch_failed).await?;
    // Credit replacement above can orphan artists that only backed a
    // since-replaced parsed credit string — sweep them so no works-less
    // artist lingers in the grid.
    let cache_base = app
        .state::<AppState>()
        .app_data_dir
        .join("cache")
        .join(library_id);
    crate::music::sweep_orphan_artists(&pool, library_id, &cache_base).await?;
    // The sweep deletes artists whose ids may still be stamped on surviving
    // credit rows (artist_id is a soft reference) — re-stamp so nothing
    // dangles.
    crate::music::resolve_credit_ids(&pool, library_id).await?;
    // (Artist images are no longer a pass phase — spawn_enrich hands them
    // to a background job when the pass ends.)

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
    // Unchecked albums, plus NOT-FOUND albums whose artist has since been
    // identified: an arid-scoped search is strictly stronger evidence than
    // the name search that failed, so those earn a re-try each pass.
    // The album's search artist is its FIRST credit row (albums carry no
    // artist parent) — the credit NAME as the text hint, the linked artist's
    // MBID for arid scoping. A joint album's first credit is as good a scope
    // as any: one proven member pins the discography.
    let albums: Vec<(i64, String, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT al.id, al.title, ac0.name, ar.musicbrainz_id,
                COALESCE((SELECT f.status FROM mb_credit_fetch f WHERE f.album_id = al.id), '')
         FROM album al
         JOIN media_entry me ON me.id = al.id
         LEFT JOIN album_artist_credit ac0
                ON ac0.album_id = al.id
               AND ac0.position = (SELECT MIN(position) FROM album_artist_credit
                                   WHERE album_id = al.id)
         LEFT JOIN artist ar ON ar.id = ac0.artist_id
         WHERE me.library_id = ?
           AND (NOT EXISTS (SELECT 1 FROM mb_credit_fetch f WHERE f.album_id = al.id)
                -- Not-found AND uncertain albums get the arid tier once the
                -- first credit carries an MBID: a search scoped to the artist
                -- finds what a name search missed, and narrows a pile of
                -- same-named candidates to the one that's theirs.
                OR (EXISTS (SELECT 1 FROM mb_credit_fetch f
                            WHERE f.album_id = al.id AND f.status IN ('notfound', 'uncertain'))
                    AND ar.musicbrainz_id IS NOT NULL AND ar.musicbrainz_id <> ''
                    -- ...but only ONCE per artist identity: an arid-scoped
                    -- search that already ran is exhausted until the album's
                    -- first-credit artist CHANGES.
                    AND NOT EXISTS (SELECT 1 FROM mb_derive_exhausted x
                                    WHERE x.entity_id = al.id
                                      AND x.evidence_key = 'arid:' || ar.musicbrainz_id)))
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
           -- An undone match is a standing 'not this' — the pass must not
           -- re-conclude it. Unmatch clears the suppression for a start-over.
           AND NOT EXISTS (SELECT 1 FROM mb_suppression s
                           WHERE s.kind = 'album_match' AND s.target_id = al.id)
           -- Ignored albums have left the matching machinery entirely.
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored')
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
    for (i, (album_id, title, artist, artist_mbid, prior_stamp)) in albums.into_iter().enumerate() {
        if CANCEL.load(Ordering::SeqCst) {
            break; // skip-remaining: the rest stay unstamped for later
        }
        processed = i + 1;
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "libraryId": library_id, "phase": "albums", "done": i, "total": total, "name": title }),
        );
        // A release id in the FILES is the only certainty about which pressing
        // a copy is, so it wins outright and brings track credits with it.
        // Per release: EVERY release whose files carry an id pins itself (a
        // card holding four pressings gets four matches), skipping releases
        // already matched so re-passes cost nothing.
        let tagged_releases: Vec<(String, String)> = sqlx::query_as(
            "SELECT ar.folder_path, ar.mb_release_id FROM album_release ar
             WHERE ar.album_id = ?
               AND ar.mb_release_id IS NOT NULL AND ar.mb_release_id <> ''
               AND NOT EXISTS (SELECT 1 FROM release_match rm
                               WHERE rm.album_id = ar.album_id
                                 AND rm.folder_path = ar.folder_path)",
        )
        .bind(album_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        if !tagged_releases.is_empty() {
            let mut applied_any = false;
            let mut transient = false;
            for (folder, release_id) in tagged_releases {
                match fetch_release(client, &release_id).await {
                    Ok(Some(full)) => {
                        apply_release(pool, library_id, album_id, &title, &full, TIER_MB, &folder)
                            .await?;
                        applied_any = true;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("musicbrainz tagged release '{title}': {e}");
                        transient = true; // unstamped, retried next pass
                    }
                }
            }
            if applied_any {
                stamp(pool, album_id, "matched").await?;
                matched += 1;
                continue;
            }
            if transient {
                continue;
            }
        }
        // Files tagged but every release already matched: the album is settled
        // — don't fall through to a pointless search.
        let already_matched: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM release_match WHERE album_id = ? LIMIT 1",
        )
        .bind(album_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if already_matched.is_some() && prior_stamp == "matched" {
            continue;
        }

        // Otherwise identify the ALBUM only. Attempts run strongest-evidence
        // first: an identified artist scopes the search to their discography
        // (arid:), which is near-deterministic; the name-text scope is the
        // fallback so a differently-credited group (compilations, joint
        // credits filed under one member) is still findable. Each tier tries
        // the title as tagged, then with store/ripper decorations stripped —
        // `[88.2/24 Tidal]` is the most common reason a search finds nothing.
        // Re-tried not-founds and uncertains run ONLY the arid tier: the
        // name tier is exactly what already ran, and repeating it would bill
        // two pointless requests per album every pass.
        let arid = artist_mbid.as_deref().filter(|s| !s.is_empty());
        let retry = prior_stamp == "notfound" || prior_stamp == "uncertain";
        let stripped = strip_title_decorations(&title);
        let mut attempts: Vec<(&str, bool)> = Vec::new();
        if arid.is_some() {
            attempts.push((title.as_str(), true));
            if stripped != title && !stripped.is_empty() {
                attempts.push((stripped.as_str(), true));
            }
        }
        if !retry {
            attempts.push((title.as_str(), false));
            if stripped != title && !stripped.is_empty() {
                attempts.push((stripped.as_str(), false));
            }
        }
        let mut groups = Vec::new();
        let mut search_failed = false;
        for (t, use_arid) in attempts {
            let found = if use_arid {
                search_release_groups(client, t, None, arid).await
            } else {
                search_release_groups(client, t, artist.as_deref(), None).await
            };
            match found {
                Ok(g) if !g.is_empty() => {
                    groups = g;
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("musicbrainz release-group search '{t}': {e}");
                    search_failed = true;
                    break;
                }
            }
        }
        if search_failed {
            continue; // transient — unstamped (or still notfound), retried next pass
        }

        // Confident means UNAMBIGUOUS: exactly one credible group. Two albums
        // sharing a name is precisely when a machine should not choose.
        // Exact after normalisation — NOT the containment rule used for track
        // titles. An album title is the whole title, and containment makes
        // "Savage Mode" match "SAVAGE MODE II", which is a different album.
        let mut credible: Vec<&GroupCandidate> = groups
            .iter()
            .filter(|g| {
                let t = normalize(&g.title);
                g.score >= MB_MIN_SCORE && (t == normalize(&title) || t == normalize(&stripped))
            })
            .collect();

        // Narrow on what we can prove from our own copy. Both rules only ever
        // REMOVE candidates, so they can turn an ambiguous set into a certain
        // one but never invent a match.
        if credible.len() > 1 {
            let (our_tracks,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM track_release tr
                 JOIN album_release ar ON ar.id = tr.release_id
                 WHERE ar.album_id = ? AND ar.is_default = 1",
            )
            .bind(album_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;

            // A title-track single shares its name with the album constantly,
            // and something with several tracks plainly isn't the single.
            if our_tracks > 1 {
                let without_singles: Vec<&GroupCandidate> = credible
                    .iter()
                    .copied()
                    .filter(|g| g.album_type.as_deref() != Some("single"))
                    .collect();
                if !without_singles.is_empty() {
                    credible = without_singles;
                }
            }

            // Documentaries and other video release groups have no audio type.
            // They answer to the album's name but are not the album.
            if credible.iter().any(|g| g.album_type.is_some()) {
                credible.retain(|g| g.album_type.is_some());
            }
        }

        if credible.len() == 1 {
            apply_group(pool, library_id, album_id, &title, credible[0], TIER_MB).await?;
            stamp(pool, album_id, "matched").await?;
            matched += 1;
            // An uncertain album re-searched by artist and now settled: its
            // open "which of these?" card asks a question the pass just
            // answered — settle it as obsolete so it leaves review.
            if prior_stamp == "uncertain" {
                sqlx::query(
                    "UPDATE mb_suggestion SET status = 'obsolete'
                     WHERE library_id = ? AND kind = 'album_match' AND target_key = ? AND status = 'pending'",
                )
                .bind(library_id)
                .bind(album_id.to_string())
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        } else if !credible.is_empty() {
            let payload = serde_json::json!({
                "album_id": album_id,
                "album_title": title,
                "artist_title": artist,
                "groups": credible.iter().take(5).collect::<Vec<_>>(),
            });
            // A re-search replaces the card's candidates (the arid tier
            // narrowed them — that's the point); a first search keeps an
            // existing card untouched (OR IGNORE on the unique key).
            if prior_stamp == "uncertain" {
                sqlx::query(
                    "UPDATE mb_suggestion SET payload = ?
                     WHERE library_id = ? AND kind = 'album_match' AND target_key = ? AND status = 'pending'",
                )
                .bind(payload.to_string())
                .bind(library_id)
                .bind(album_id.to_string())
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
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
            // Still several even scoped to the artist: that search is spent
            // for this artist identity, same as a not-found — the card
            // holds the question until the user answers or the first
            // credit changes.
            if let Some(arid) = arid {
                sqlx::query(
                    "INSERT OR IGNORE INTO mb_derive_exhausted (entity_id, evidence_key)
                     VALUES (?, 'arid:' || ?)",
                )
                .bind(album_id)
                .bind(arid)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        } else {
            // A re-searched uncertain album whose artist-scoped search found
            // nothing credible keeps its card (and stamp): the name-search
            // candidates are still the user's to judge — the artist match
            // might be the thing that's wrong.
            stamp(pool, album_id, if prior_stamp == "uncertain" { "uncertain" } else { "notfound" }).await?;
            // The arid tier ran and found nothing — remember it, so this
            // album isn't re-searched every pass until the artist identity
            // it searched under changes. (search_failed already bailed out
            // above, so reaching here means the searches genuinely ran.)
            if let Some(arid) = arid {
                sqlx::query(
                    "INSERT OR IGNORE INTO mb_derive_exhausted (entity_id, evidence_key)
                     VALUES (?, 'arid:' || ?)",
                )
                .bind(album_id)
                .bind(arid)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
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
// MusicBrainz identity
// ---------------------------------------------------------------------------
//
// Which MusicBrainz entity one of ours IS. Kept in `field_override`, NOT on the
// entity's own row, because the scanner owns those rows: `album_release` is
// deleted and rebuilt on every rescan, and `track_meta` is upserted from tags,
// so anything written there that isn't in the files is gone by the next scan.
// `field_override` is the app-owned side of that line — the scanner never
// writes it, and tracks, albums and artists are all `media_entry` rows, so one
// table serves all three.
//
// Tier is provenance, same ladder the rest of the app uses: 'user' (you picked
// it) outranks 'mb' (the automatic pass resolved it), and both outrank
// whatever id happened to be in the file's tags.

pub const MB_RELEASE: &str = "mb_release_id";
pub const MB_RELEASE_GROUP: &str = "mb_release_group_id";
pub const MB_RECORDING: &str = "mb_recording_id";
pub const MB_ARTIST: &str = "mb_artist_id";
/// Not an id: a user directive. "Don't match this and stop counting it" —
/// the entity leaves every pass, every warning count, and the guide; the
/// library map paints it gray instead of red. Cleared by un-ignoring.
pub const MB_IGNORED: &str = "mb_ignored";
/// Not an id: a user declaration. "This album is DELIBERATELY partial" — the
/// tracks the matched release has and the library doesn't are expected, so
/// mb-side gap rows stop surfacing (Track lists differ, gap counts). Extra
/// or mistitled tracks on OUR side still warn: those are real disagreements.
/// Unlike Dismiss (which deletes gap rows until the next recompute walks
/// them back in), this survives re-checks, re-applies, and rescans.
pub const MB_PARTIAL: &str = "mb_partial";

/// Forget an album's MusicBrainz match wholesale, from inside the scanner:
/// the album's tag identity (title / artist credits) changed at the source,
/// so the group, every release pin, the gaps, the fetch stamp, the queue
/// rows, and every MB-tier value — the album's own and the per-track credits
/// the pins wrote — were claims about a different album. No History replay
/// (the user didn't act; the files did) and no suppression: a re-match is
/// a fresh start.
pub(crate) async fn forget_album_match(
    pool: &SqlitePool,
    library_id: &str,
    album_id: i64,
) -> Result<(), String> {
    clear_mb_id(pool, album_id, MB_RELEASE_GROUP).await?;
    sqlx::query("UPDATE album SET mb_release_group_id = NULL WHERE id = ?")
        .bind(album_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    for table in ["release_match", "album_match_gap", "mb_credit_fetch"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE album_id = ?"))
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    sqlx::query("DELETE FROM pending_pass WHERE library_id = ? AND target IN (?, ?)")
        .bind(library_id)
        .bind(album_id.to_string())
        .bind(format!("album:{album_id}:credits"))
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    for field in ["title", "album_type", "artist_credits", "release_date"] {
        clear_mb_tier(pool, album_id, field).await?;
    }
    sqlx::query(
        "DELETE FROM field_override WHERE tier = 'mb' AND field = 'credits'
           AND entity_id IN (SELECT id FROM media_entry WHERE parent_id = ?)",
    )
    .bind(album_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// End-of-rescan sweep of match-side rows that outlive their entity: the
/// tables keyed by entity id WITHOUT a foreign key (suppressions, queue
/// rows, id-keyed suggestion cards). Inert on their own — ids are never
/// reused — but stray data all the same.
pub(crate) async fn sweep_dead_match_rows(pool: &SqlitePool, library_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM mb_suppression WHERE target_id NOT IN (SELECT id FROM media_entry)")
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    let live = |id: i64| async move {
        sqlx::query_as::<_, (i64,)>("SELECT EXISTS(SELECT 1 FROM media_entry WHERE id = ?)")
            .bind(id)
            .fetch_one(pool)
            .await
            .map(|(n,)| n != 0)
            .map_err(|e| e.to_string())
    };
    // Queue targets: a bare id, or "<kind>:<id>[:cause]".
    let targets: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, target FROM pending_pass WHERE library_id = ?")
            .bind(library_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    for (row_id, target) in targets {
        let id_part = if target.contains(':') {
            target.split(':').nth(1).unwrap_or("")
        } else {
            target.as_str()
        };
        let Ok(id) = id_part.parse::<i64>() else { continue };
        if !live(id).await? {
            sqlx::query("DELETE FROM pending_pass WHERE id = ?")
                .bind(row_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    // Id-keyed suggestion cards (album/artist matches); name-keyed kinds
    // (merges) are left alone.
    let cards: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, target_key FROM mb_suggestion
         WHERE library_id = ? AND kind IN ('album_match', 'artist_match')",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (row_id, key) in cards {
        let Ok(id) = key.parse::<i64>() else { continue };
        if !live(id).await? {
            sqlx::query("DELETE FROM mb_suggestion WHERE id = ?")
                .bind(row_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Drop one field's MB-tier value (an undo retracting what a match adopted).
/// Field-and-tier precise: the user tier of the same field must survive.
pub(crate) async fn clear_mb_tier(pool: &SqlitePool, entity_id: i64, field: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM field_override WHERE entity_id = ? AND field = ? AND tier = 'mb'")
        .bind(entity_id)
        .bind(field)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Releases of an album holding a REAL pinned pressing — the declared-none
/// sentinel (mb_release_id = '') is a resolution, not a pin.
pub(crate) async fn pinned_release_count(pool: &SqlitePool, album_id: i64) -> Result<i64, String> {
    sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM release_match WHERE album_id = ? AND mb_release_id <> ''",
    )
    .bind(album_id)
    .fetch_one(pool)
    .await
    .map(|(n,)| n)
    .map_err(|e| e.to_string())
}

pub const TIER_USER: &str = "user";
pub const TIER_MB: &str = "mb";
/// release_match sentinel tier: the row declares "no MB counterpart exists"
/// (mb_release_id = '') rather than recording a match.
pub const TIER_NONE: &str = "none";

pub async fn set_mb_id(
    pool: &SqlitePool,
    entity_id: i64,
    field: &str,
    value: &str,
    tier: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO field_override (entity_id, field, tier, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(entity_id, field, tier)
         DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(entity_id)
    .bind(field)
    .bind(tier)
    .bind(value)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The winning id and the tier it came from — user beats mb.
pub async fn mb_id(
    pool: &SqlitePool,
    entity_id: i64,
    field: &str,
) -> Result<Option<(String, String)>, String> {
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT value, tier FROM field_override
         WHERE entity_id = ? AND field = ? AND value IS NOT NULL AND value <> ''
         ORDER BY CASE tier WHEN 'user' THEN 0 WHEN 'mb' THEN 1 ELSE 2 END
         LIMIT 1",
    )
    .bind(entity_id)
    .bind(field)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(v, t)| v.map(|v| (v, t))))
}

/// Mark an album or artist as ignored (or clear it): excluded from the
/// passes and the unmatched counts, gray on the library map. Stored in
/// field_override like the ids — per entity, rescan-proof. Logged: ignoring
/// is a decision, and history holds every decision (undo flips it back).
#[tauri::command]
pub async fn mb_set_ignored(
    state: State<'_, AppState>,
    entity_id: i64,
    ignored: bool,
) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, entity_id).await?;
    let pool = &state.app_db;
    crate::music_edit::ensure_not_staged(pool, entity_id).await?;
    let library_id = library_of(pool, entity_id).await?;
    let prev = mb_id(pool, entity_id, MB_IGNORED).await?.is_some();
    if prev == ignored {
        return Ok(()); // nothing changes, nothing logs
    }
    if ignored {
        set_mb_id(pool, entity_id, MB_IGNORED, "1", TIER_USER).await?;
    } else {
        clear_mb_id(pool, entity_id, MB_IGNORED).await?;
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
    let title = title.and_then(|(t,)| t).unwrap_or_else(|| "entry".to_string());
    let batch = next_batch(pool).await?;
    log_change(
        pool,
        &library_id,
        "mb_ignored",
        entity_id,
        &format!("{title} — {}", if ignored { "ignored" } else { "un-ignored" }),
        &serde_json::json!({ "ignored": prev }),
        &serde_json::json!({ "ignored": ignored }),
        batch,
    )
    .await?;
    // Ignoring an album can leave its artists with nothing left to match.
    evict_artist_group_caches(pool).await
}

/// Declare (or undeclare) an album deliberately partial. A human decision, so
/// it logs and undoes; durable across re-checks and rescans, unlike Dismiss.
#[tauri::command]
pub async fn mb_set_partial(
    state: State<'_, AppState>,
    entity_id: i64,
    partial: bool,
) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, entity_id).await?;
    let pool = &state.app_db;
    crate::music_edit::ensure_not_staged(pool, entity_id).await?;
    let library_id = library_of(pool, entity_id).await?;
    let prev = mb_id(pool, entity_id, MB_PARTIAL).await?.is_some();
    if prev == partial {
        return Ok(()); // nothing changes, nothing logs
    }
    if partial {
        set_mb_id(pool, entity_id, MB_PARTIAL, "1", TIER_USER).await?;
    } else {
        clear_mb_id(pool, entity_id, MB_PARTIAL).await?;
    }
    let title: Option<(String,)> = sqlx::query_as("SELECT title FROM album WHERE id = ?")
        .bind(entity_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let title = title.map(|(t,)| t).unwrap_or_else(|| "album".to_string());
    let batch = next_batch(pool).await?;
    log_change(
        pool,
        &library_id,
        "album_partial",
        entity_id,
        &format!(
            "{title} — {}",
            if partial {
                "marked deliberately partial"
            } else {
                "no longer partial"
            }
        ),
        &serde_json::json!({ "partial": prev }),
        &serde_json::json!({ "partial": partial }),
        batch,
    )
    .await
}

/// Declare (or retract) that one release of an album has no MusicBrainz
/// counterpart — unofficial pressings that will never match. Stored as a
/// sentinel release_match row (empty mb id, tier 'none'): folder-keyed like a
/// real pin so it survives rescans, blocks the pass from surfacing the
/// release as unmatched, and counts as resolved. A human decision, so it
/// logs and undoes.
#[tauri::command]
pub async fn mb_set_release_no_mb(
    state: State<'_, AppState>,
    entity_id: i64,
    release_db_id: Option<i64>,
    declared: bool,
) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, entity_id).await?;
    let pool = &state.app_db;
    crate::music_edit::ensure_not_staged(pool, entity_id).await?;
    let library_id = library_of(pool, entity_id).await?;
    let folder: Option<String> = match release_db_id {
        Some(rid) => sqlx::query_as::<_, (String,)>(
            "SELECT folder_path FROM album_release WHERE id = ? AND album_id = ?",
        )
        .bind(rid)
        .bind(entity_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .map(|(f,)| f),
        None => default_release_folder(pool, entity_id).await?,
    };
    let Some(folder) = folder else {
        return Err("Release not found".to_string());
    };
    let prev = release_match_of(pool, entity_id, &folder).await?;
    let prev_declared = prev.as_ref().is_some_and(|(v, _)| v.is_empty());
    if declared {
        if prev.as_ref().is_some_and(|(v, _)| !v.is_empty()) {
            return Err("This release is matched — unmatch it first.".to_string());
        }
        if prev_declared {
            return Ok(()); // nothing changes, nothing logs
        }
        set_release_match(pool, entity_id, &folder, "", TIER_NONE).await?;
    } else {
        if !prev_declared {
            return Ok(());
        }
        sqlx::query(
            "DELETE FROM release_match WHERE album_id = ? AND folder_path = ? AND mb_release_id = ''",
        )
        .bind(entity_id)
        .bind(&folder)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    let title: Option<(String,)> = sqlx::query_as("SELECT title FROM album WHERE id = ?")
        .bind(entity_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let title = title.map(|(t,)| t).unwrap_or_else(|| "album".to_string());
    let batch = next_batch(pool).await?;
    log_change(
        pool,
        &library_id,
        "release_no_mb",
        entity_id,
        &format!(
            "{title} — {}",
            if declared {
                "release declared as having no MusicBrainz counterpart"
            } else {
                "no-MusicBrainz declaration retracted"
            }
        ),
        &serde_json::json!({ "declared": prev_declared, "folder": folder }),
        &serde_json::json!({ "declared": declared, "folder": folder }),
        batch,
    )
    .await
}

// ── Per-release match store ─────────────────────────────────────────────
// WHICH pressing each release of an album is. Folder-keyed (release rows are
// rebuilt every rescan); the group id stays album-level in field_override.

pub(crate) async fn release_match_of(
    pool: &SqlitePool,
    album_id: i64,
    folder: &str,
) -> Result<Option<(String, String)>, String> {
    sqlx::query_as(
        "SELECT mb_release_id, tier FROM release_match WHERE album_id = ? AND folder_path = ?",
    )
    .bind(album_id)
    .bind(folder)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
}

pub(crate) async fn set_release_match(
    pool: &SqlitePool,
    album_id: i64,
    folder: &str,
    mbid: &str,
    tier: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO release_match (album_id, folder_path, mb_release_id, tier)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(album_id, folder_path) DO UPDATE
            SET mb_release_id = excluded.mb_release_id, tier = excluded.tier",
    )
    .bind(album_id)
    .bind(folder)
    .bind(mbid)
    .bind(tier)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The album's default release's folder — the target when no release is
/// named (center-launched dialogs, legacy undo payloads).
pub(crate) async fn default_release_folder(
    pool: &SqlitePool,
    album_id: i64,
) -> Result<Option<String>, String> {
    Ok(sqlx::query_as::<_, (String,)>(
        "SELECT folder_path FROM album_release WHERE album_id = ? AND is_default = 1",
    )
    .bind(album_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .map(|(f,)| f))
}

/// Forget an id at every tier — what Unmatch means.
pub async fn clear_mb_id(pool: &SqlitePool, entity_id: i64, field: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM field_override WHERE entity_id = ? AND field = ?")
        .bind(entity_id)
        .bind(field)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// MusicBrainz HTTP
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseCandidate {
    pub release_id: String,
    pub title: String,
    pub artist: String,
    pub date: Option<String>,
    pub track_count: Option<i64>,
    pub score: i64,
    /// Differentiators for same-titled releases (albums literally named "?").
    pub country: Option<String>,
    /// EVERY release event's country (a release can come out in several
    /// regions at once — MB shows XE + DE + GB rows for one pressing).
    /// Ordered, deduped; `country` above stays as the first for old callers.
    pub countries: Vec<String>,
    pub format: Option<String>,
    pub label: Option<String>,
    pub status: Option<String>,
    pub disambiguation: Option<String>,
}

/// One release JSON object → a candidate row. Shared by the search (which
/// carries a relevance `score`) and by direct id lookups (which have none, and
/// pass `default_score`).
fn candidate_of(r: &serde_json::Value, default_score: i64) -> Option<ReleaseCandidate> {
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
    let label = r["label-info"]
        .as_array()
        .and_then(|li| {
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
    // Search results carry a top-level count; lookups only have per-medium ones.
    let track_count = r["track-count"].as_i64().or_else(|| {
        let per_medium: Vec<i64> = r["media"]
            .as_array()?
            .iter()
            .filter_map(|m| m["track-count"].as_i64())
            .collect();
        (!per_medium.is_empty()).then(|| per_medium.iter().sum())
    });
    // Every release event's country — the top-level `country` is only the
    // first event, and multi-region pressings (XE + DE + GB) lose the rest.
    let mut countries: Vec<String> = Vec::new();
    for ev in r["release-events"].as_array().into_iter().flatten() {
        for code in ev["area"]["iso-3166-1-codes"].as_array().into_iter().flatten() {
            if let Some(c) = code.as_str() {
                if !countries.iter().any(|x| x == c) {
                    countries.push(c.to_string());
                }
            }
        }
    }
    if countries.is_empty() {
        if let Some(c) = r["country"].as_str() {
            countries.push(c.to_string());
        }
    }
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
        track_count,
        score: r["score"].as_i64().unwrap_or(default_score),
        country: countries.first().cloned(),
        countries,
        format: if unique_formats.is_empty() { None } else { Some(unique_formats.join("+")) },
        label,
        status: r["status"].as_str().map(|s| s.to_string()),
        disambiguation: r["disambiguation"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
    })
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
    let resp = mb_get(client, url).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    Ok(body["releases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| candidate_of(r, 0))
        .filter(|c| c.score >= 50)
        .collect())
}

/// What a pasted MusicBrainz reference points at. A bare id doesn't say which
/// entity it is, so `Bare` is tried as a release and then as a release group.
enum MbRef {
    Release(String),
    ReleaseGroup(String),
    Bare(String),
}

fn is_mbid(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Pull an entity reference out of whatever the user pasted: a full
/// musicbrainz.org URL (release or release-group, query string and all) or a
/// bare id. Anything else is a normal text search.
fn parse_mb_ref(text: &str) -> Option<MbRef> {
    let t = text.trim();
    let head = |rest: &str| -> Option<String> {
        let id: String = rest
            .chars()
            .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
            .collect();
        is_mbid(&id).then_some(id)
    };
    if let Some(rest) = t.split("/release-group/").nth(1) {
        return head(rest).map(MbRef::ReleaseGroup);
    }
    if let Some(rest) = t.split("/release/").nth(1) {
        return head(rest).map(MbRef::Release);
    }
    is_mbid(t).then(|| MbRef::Bare(t.to_string()))
}

/// One release by id. `Ok(None)` when MusicBrainz says it isn't a release —
/// the caller may still try the id as a release group.
async fn lookup_release(
    client: &reqwest::Client,
    id: &str,
) -> Result<Option<ReleaseCandidate>, String> {
    let url = url::Url::parse_with_params(
        &format!("https://musicbrainz.org/ws/2/release/{id}"),
        &[("inc", "artist-credits+labels+media"), ("fmt", "json")],
    )
    .map_err(|e| e.to_string())?;
    let resp = mb_get(client, url).await?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND
        || resp.status() == reqwest::StatusCode::BAD_REQUEST
    {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(candidate_of(&body, 100))
}

/// Every release in a release group — what you get for pasting the URL of an
/// album page, which names the work rather than one pressing of it.
async fn releases_in_group(
    client: &reqwest::Client,
    id: &str,
) -> Result<Vec<ReleaseCandidate>, String> {
    // 100 is MusicBrainz's per-request maximum — one page covers almost every
    // real group (Brothers in Arms: 77). Bigger groups page onward, capped at
    // 4 pages / 400 releases: each page is a rate-gapped request, and a group
    // deeper than that is compilation-noise territory (the dialog's pasted-id
    // path still reaches any pressing directly).
    let mut out: Vec<ReleaseCandidate> = Vec::new();
    for page in 0..4 {
        let offset = (page * 100).to_string();
        let url = url::Url::parse_with_params(
            "https://musicbrainz.org/ws/2/release",
            &[
                ("release-group", id),
                ("inc", "artist-credits+labels+media"),
                ("fmt", "json"),
                ("limit", "100"),
                ("offset", offset.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
        let resp = mb_get(client, url).await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND
            || resp.status() == reqwest::StatusCode::BAD_REQUEST
        {
            return Ok(out);
        }
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let total = body["release-count"].as_i64().unwrap_or(0);
        out.extend(
            body["releases"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| candidate_of(r, 100)),
        );
        if out.len() as i64 >= total || body["releases"].as_array().is_none_or(|a| a.is_empty()) {
            break;
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct GroupArtRelease {
    pub release_id: String,
    pub date: Option<String>,
    pub countries: Vec<String>,
    pub format: Option<String>,
    /// "Label CATNO" merged, candidate_of's convention.
    pub label: Option<String>,
    pub status: Option<String>,
    pub disambiguation: Option<String>,
    /// Cover Art Archive piece count for this release.
    pub art_count: i64,
    /// CAA has a designated FRONT image (a release can carry only
    /// back/booklet scans — its /front URL would 404).
    pub has_front: bool,
}

/// Releases in the album's group that HAVE Cover Art Archive artwork — the
/// CAA browser's "other releases" roster. One gated MB browse (paged like
/// releases_in_group); the currently pinned release is excluded (its art is
/// the browser's main view). Front thumbnails then cost NO further API calls
/// (/release/<id>/front-250 is a direct redirect URL); only expanding a
/// row's full scan set does one CAA fetch.
#[tauri::command]
pub async fn mb_group_release_art(
    state: State<'_, AppState>,
    album_id: i64,
    release_id: Option<i64>,
) -> Result<Vec<GroupArtRelease>, String> {
    let _priority = UserPriority::hold();
    let pool = &state.app_db;
    let group_id = mb_id(pool, album_id, MB_RELEASE_GROUP)
        .await?
        .map(|(v, _)| v)
        .ok_or("Match this album to MusicBrainz first")?;
    let mut pinned: Option<String> = None;
    if let Some(rid) = release_id {
        let folder: Option<(String,)> =
            sqlx::query_as("SELECT folder_path FROM album_release WHERE id = ? AND album_id = ?")
                .bind(rid)
                .bind(album_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((folder,)) = folder {
            pinned = release_match_of(pool, album_id, &folder)
                .await?
                .map(|(v, _)| v)
                .filter(|v| !v.is_empty());
        }
    }

    let client = mb_client()?;
    let mut out: Vec<GroupArtRelease> = Vec::new();
    let mut seen = 0i64;
    for page in 0..4 {
        let offset = (page * 100).to_string();
        let url = url::Url::parse_with_params(
            "https://musicbrainz.org/ws/2/release",
            &[
                ("release-group", group_id.as_str()),
                ("inc", "labels+media"),
                ("fmt", "json"),
                ("limit", "100"),
                ("offset", offset.as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
        let resp = mb_get(&client, url).await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND
            || resp.status() == reqwest::StatusCode::BAD_REQUEST
        {
            break;
        }
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let total = body["release-count"].as_i64().unwrap_or(0);
        let page_rows = body["releases"].as_array().map(|a| a.len()).unwrap_or(0);
        seen += page_rows as i64;
        for r in body["releases"].as_array().into_iter().flatten() {
            let caa = &r["cover-art-archive"];
            let count = caa["count"].as_i64().unwrap_or(0);
            if !caa["artwork"].as_bool().unwrap_or(false) || count == 0 {
                continue;
            }
            let Some(c) = candidate_of(r, 0) else { continue };
            if pinned.as_deref() == Some(c.release_id.as_str()) {
                continue;
            }
            out.push(GroupArtRelease {
                release_id: c.release_id,
                date: c.date,
                countries: c.countries,
                format: c.format,
                label: c.label,
                status: c.status,
                disambiguation: c.disambiguation,
                art_count: count,
                has_front: caa["front"].as_bool().unwrap_or(false),
            });
        }
        if seen >= total || page_rows == 0 {
            break;
        }
    }
    // Official pressings first, then oldest → newest (mirror of the release
    // picker's ordering).
    out.sort_by(|a, b| {
        let official = |r: &GroupArtRelease| r.status.as_deref() != Some("Official");
        official(a)
            .cmp(&official(b))
            .then_with(|| match (&a.date, &b.date) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
    });
    Ok(out)
}

/// One track of a MusicBrainz release, as the pairing and the applies use it.
#[derive(Clone, Debug)]
struct MbTrack {
    disc: i64,
    position: i64,
    title: String,
    /// [(credited name, artist mbid)]
    credits: Vec<(String, Option<String>)>,
    /// MB's length, when it has one — a pairing WITNESS only. Never shown:
    /// the file's own runtime is the duration (user rule — what's inherent
    /// to the audio is always right; an external length a few seconds off
    /// would only look wrong).
    length_ms: Option<i64>,
}

/// The length witness, two bounds:
///  - AGREES within five seconds. Honest rips sit a constant 2–3s off MB
///    per album (pregaps, trailing silence, disc-ID lengths), so a tighter
///    window flagged whole albums whose titles matched exactly.
///  - VETOES past fifteen seconds: even a matching title doesn't pair then
///    (a radio edit at the album cut's slot), and the track lands on the
///    differ page for a person to Accept.
/// Between the two, the title decides alone. With the title also off the
/// differ page calls it "probably a different song" only when the lengths
/// don't agree — nothing to accept there.
const LENGTH_WINDOW_MS: i64 = 5000;
const LENGTH_VETO_MS: i64 = 15000;

fn length_delta_ms(runtime_secs: Option<i64>, length_ms: Option<i64>) -> Option<i64> {
    match (runtime_secs, length_ms) {
        (Some(r), Some(l)) => Some((r * 1000 - l).abs()),
        _ => None, // no witness available — the title decides alone
    }
}

fn length_agrees(runtime_secs: Option<i64>, length_ms: Option<i64>) -> bool {
    length_delta_ms(runtime_secs, length_ms).is_none_or(|d| d <= LENGTH_WINDOW_MS)
}

fn length_vetoes(runtime_secs: Option<i64>, length_ms: Option<i64>) -> bool {
    length_delta_ms(runtime_secs, length_ms).is_some_and(|d| d > LENGTH_VETO_MS)
}

#[derive(Clone)]
struct MbReleaseFull {
    release_id: String,
    /// The pressing's own title ("… (Deluxe Edition)") — stored on the pin
    /// for the per-tier view; never the album's title.
    title: Option<String>,
    release_group_id: Option<String>,
    /// The release GROUP's title — the album's MB-tier title even when a
    /// pressing is what got matched (release titles carry edition junk).
    group_title: Option<String>,
    /// 'album' | 'ep' | 'single' | 'compilation' — from the release group.
    album_type: Option<String>,
    /// Release-group first release date (falls back to the release date).
    date: Option<String>,
    /// RELEASE-level artist credit ("Drake & Future" → [Drake, Future]),
    /// each name with its MB artist id. Two or more names = a joint album;
    /// the pass writes album_artist_credit.
    album_artists: Vec<(String, Option<String>)>,
    tracks: Vec<MbTrack>,
    /// mbid → the artist entity's CANONICAL name, for every artist credited
    /// anywhere on the release (album line or any track). The credits above
    /// carry the as-credited spelling; identified pages take this one.
    artist_names: HashMap<String, String>,
}

async fn fetch_release_uncached(
    client: &reqwest::Client,
    release_id: &str,
) -> Result<Option<MbReleaseFull>, String> {
    let url = url::Url::parse_with_params(
        &format!("https://musicbrainz.org/ws/2/release/{release_id}"),
        &[("inc", "recordings+artist-credits+release-groups"), ("fmt", "json")],
    )
    .map_err(|e| e.to_string())?;
    let resp = mb_get(client, url).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let rg = &body["release-group"];
    let album_type = mb_album_type(rg);
    let group_title = rg["title"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
    let date = rg["first-release-date"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| body["date"].as_str().filter(|s| !s.is_empty()))
        .map(|s| s.to_string());

    let mut artist_names: HashMap<String, String> = HashMap::new();
    let mut note_canonical = |c: &serde_json::Value| {
        if let (Some(id), Some(name)) = (c["artist"]["id"].as_str(), c["artist"]["name"].as_str()) {
            if !name.is_empty() {
                artist_names.entry(id.to_string()).or_insert_with(|| name.to_string());
            }
        }
    };
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
                    note_canonical(c);
                    Some((name, c["artist"]["id"].as_str().map(|s| s.to_string())))
                })
                .collect();
            if !credits.is_empty() {
                let length_ms = track["length"]
                    .as_i64()
                    .or_else(|| track["recording"]["length"].as_i64())
                    .filter(|l| *l > 0);
                tracks.push(MbTrack { disc: (mi + 1) as i64, position, title, credits, length_ms });
            }
        }
    }
    // RELEASE-level artist credit — joint albums ("Drake & Future") carry
    // every owner here, separate from the per-track credits.
    let album_artists: Vec<(String, Option<String>)> = body["artist-credit"]
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
            note_canonical(c);
            Some((name, c["artist"]["id"].as_str().map(|s| s.to_string())))
        })
        .collect();

    Ok(if tracks.is_empty() {
        None
    } else {
        Some(MbReleaseFull {
            release_id: release_id.to_string(),
            title: body["title"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()),
            release_group_id: rg["id"].as_str().map(|s| s.to_string()),
            group_title,
            album_type,
            date,
            album_artists,
            tracks,
            artist_names,
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
// Release groups — the album as a work, which is the only thing tags can
// actually identify
// ---------------------------------------------------------------------------
//
// A release group is "the album"; a release is one pressing of it. Tags name
// the album, so that is what the automatic pass is allowed to conclude. Which
// PRESSING you own is not knowable from a title and a track count — nine
// different releases of 2014 Forest Hills Drive share the same thirteen
// tracks, and the pass used to pick whichever one MusicBrainz ranked first,
// which is how a 2024 anniversary double got applied to a 2014 album.
//
// So: groups are matched automatically when the answer is unambiguous, and a
// release is only ever adopted when the FILES name one.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupCandidate {
    pub group_id: String,
    pub title: String,
    pub artist: String,
    /// 'album' | 'ep' | 'single' | 'compilation' — our vocabulary.
    pub album_type: Option<String>,
    pub first_release_date: Option<String>,
    pub disambiguation: Option<String>,
    pub score: i64,
    /// Release-level artist credit; two or more names means a joint album.
    pub artists: Vec<String>,
    /// Each credited name's MB artist id, parallel to `artists`. This is what
    /// makes ARTIST identity derivable with certainty: matching the album
    /// tells us exactly which "God" its credit means.
    pub artist_ids: Vec<Option<String>>,
    /// Each credited artist's CANONICAL MusicBrainz name, parallel to
    /// `artists` — the entity's own name, as opposed to the spelling this
    /// credit used ("Kanye West" credited, entity "Ye"). An identified
    /// artist's page takes this name (user rule 2026-09-20). Absent on
    /// cache rows written before it existed.
    #[serde(default)]
    pub artist_names: Vec<Option<String>>,
}

impl GroupCandidate {
    /// mbid → canonical name, for the credit stamp's rename step.
    pub fn canonical_names(&self) -> HashMap<String, String> {
        self.artist_ids
            .iter()
            .zip(self.artist_names.iter())
            .filter_map(|(id, name)| Some((id.clone()?, name.clone()?)))
            .collect()
    }
}

fn group_of(g: &serde_json::Value, default_score: i64) -> Option<GroupCandidate> {
    let credit: Vec<(String, Option<String>, Option<String>)> = g["artist-credit"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let name = c["name"]
                .as_str()
                .or_else(|| c["artist"]["name"].as_str())?
                .to_string();
            Some((
                name,
                c["artist"]["id"].as_str().map(|s| s.to_string()),
                c["artist"]["name"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()),
            ))
        })
        .collect();
    let artists: Vec<String> = credit.iter().map(|(n, _, _)| n.clone()).collect();
    let artist_ids: Vec<Option<String>> = credit.iter().map(|(_, id, _)| id.clone()).collect();
    let artist_names: Vec<Option<String>> = credit.into_iter().map(|(_, _, c)| c).collect();
    Some(GroupCandidate {
        group_id: g["id"].as_str()?.to_string(),
        title: g["title"].as_str().unwrap_or_default().to_string(),
        artist: artists.join(", "),
        album_type: mb_album_type(g),
        first_release_date: g["first-release-date"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        disambiguation: g["disambiguation"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        score: g["score"].as_i64().unwrap_or(default_score),
        artists,
        artist_ids,
        artist_names,
    })
}

/// Strip the decorations rippers and stores bolt onto album titles. These are
/// the single biggest cause of a failed search: `ASTROWORLD [88.2/24 Tidal]`
/// finds nothing, `ASTROWORLD` finds it immediately. Only bracketed segments
/// containing a known noise word are removed, so `(36 Chambers)` and
/// `(Deluxe)`-as-a-real-title survive.
fn strip_title_decorations(title: &str) -> String {
    const NOISE: &[&str] = &[
        "tidal", "deezer", "qobuz", "spotify", "apple music", "explicit", "clean version",
        "bonus track", "bonus tracks", "web", "flac", "vinyl rip", "khz", "kbps", "remastered",
    ];
    let mut out = String::with_capacity(title.len());
    let mut depth = 0usize;
    let mut segment = String::new();
    for ch in title.chars() {
        match ch {
            '[' | '(' => {
                if depth == 0 {
                    segment.clear();
                }
                depth += 1;
                segment.push(ch);
            }
            ']' | ')' if depth > 0 => {
                depth -= 1;
                segment.push(ch);
                if depth == 0 {
                    let inner = segment.to_lowercase();
                    // Sample rates and bit depths: "88.2/24", "44.1-16".
                    let numeric_noise = inner
                        .split(|c: char| !c.is_ascii_digit() && c != '.' && c != '/' && c != '-')
                        .any(|p| p.contains('/') || (p.contains('.') && p.contains('-')));
                    if NOISE.iter().any(|n| inner.contains(n)) || numeric_noise {
                        segment.clear();
                    }
                    out.push_str(&segment);
                    segment.clear();
                }
            }
            _ => {
                if depth > 0 {
                    segment.push(ch);
                } else {
                    out.push(ch);
                }
            }
        }
    }
    out.push_str(&segment);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn search_release_groups(
    client: &reqwest::Client,
    title: &str,
    artist: Option<&str>,
    // The artist's MBID, when identity is already certain — collapses the
    // search space to that artist's discography (strictly stronger than the
    // name text, which matches any same-named stranger's albums).
    arid: Option<&str>,
) -> Result<Vec<GroupCandidate>, String> {
    let mut query = format!("releasegroup:\"{}\"", title.replace('"', " "));
    if let Some(arid) = arid {
        query.push_str(&format!(" AND arid:{arid}"));
    } else if let Some(artist) = artist {
        query.push_str(&format!(" AND artist:\"{}\"", artist.replace('"', " ")));
    }
    let url = url::Url::parse_with_params(
        "https://musicbrainz.org/ws/2/release-group",
        &[("query", query.as_str()), ("fmt", "json"), ("limit", "10")],
    )
    .map_err(|e| e.to_string())?;
    let resp = mb_get(client, url).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body["release-groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| group_of(g, 0))
        .collect())
}

// ── Pass-wide fetch cache ──────────────────────────────────────────────
// One pass reads the same MusicBrainz entity from several phases (a group as
// match evidence, again for its date; a pressing across harvest sweeps), and
// the sweep loop re-runs phases up to 3×. At MB's 1 req/s the pass's
// duration IS its request count, so duplicates are pure wall-clock waste.
// Successes only (a 503 must stay retryable), cleared when a pass starts,
// and consulted only WHILE a pass runs — dialog-driven fetches between
// passes always hit MB fresh.
static GROUP_FETCH_CACHE: std::sync::OnceLock<
    std::sync::Mutex<HashMap<String, Option<GroupCandidate>>>,
> = std::sync::OnceLock::new();
static RELEASE_FETCH_CACHE: std::sync::OnceLock<
    std::sync::Mutex<HashMap<String, Option<MbReleaseFull>>>,
> = std::sync::OnceLock::new();

fn clear_pass_caches() {
    if let Some(m) = GROUP_FETCH_CACHE.get() {
        m.lock().unwrap().clear();
    }
    if let Some(m) = RELEASE_FETCH_CACHE.get() {
        m.lock().unwrap().clear();
    }
}

/// One release group by id — cached for the duration of a pass.
async fn fetch_release_group(
    client: &reqwest::Client,
    group_id: &str,
) -> Result<Option<GroupCandidate>, String> {
    let in_pass = RUNNING.load(Ordering::SeqCst);
    if in_pass {
        if let Some(hit) = GROUP_FETCH_CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .get(group_id)
        {
            return Ok(hit.clone());
        }
    }
    let got = fetch_release_group_uncached(client, group_id).await?;
    if in_pass {
        GROUP_FETCH_CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(group_id.to_string(), got.clone());
    }
    Ok(got)
}

/// One release by id — cached for the duration of a pass (harvest and the
/// tagged-pin walk revisit the same pressings across sweeps).
async fn fetch_release(
    client: &reqwest::Client,
    release_id: &str,
) -> Result<Option<MbReleaseFull>, String> {
    let in_pass = RUNNING.load(Ordering::SeqCst);
    if in_pass {
        if let Some(hit) = RELEASE_FETCH_CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .get(release_id)
        {
            return Ok(hit.clone());
        }
    }
    let got = fetch_release_uncached(client, release_id).await?;
    if in_pass {
        RELEASE_FETCH_CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(release_id.to_string(), got.clone());
    }
    Ok(got)
}

/// One release group by id, for a pasted link or a tagged id.
async fn fetch_release_group_uncached(
    client: &reqwest::Client,
    group_id: &str,
) -> Result<Option<GroupCandidate>, String> {
    let url = url::Url::parse_with_params(
        &format!("https://musicbrainz.org/ws/2/release-group/{group_id}"),
        &[("inc", "artist-credits"), ("fmt", "json")],
    )
    .map_err(|e| e.to_string())?;
    let resp = mb_get(client, url).await?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(group_of(&body, 100))
}

#[derive(Debug, Serialize)]
pub struct PersonaRef {
    pub artist_id: i64,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct ArtistPersonaLinks {
    /// Set when THIS artist is a persona: the human behind the mask.
    pub parent: Option<PersonaRef>,
    /// Personas this artist performs as.
    pub personas: Vec<PersonaRef>,
}

/// Both directions of the persona relationship for one artist page.
#[tauri::command]
pub async fn get_artist_personas(
    state: State<'_, AppState>,
    artist_id: i64,
) -> Result<ArtistPersonaLinks, String> {
    let pool = &state.app_db;
    let parent: Option<(i64, String)> = sqlx::query_as(
        "SELECT a.id, a.title FROM artist_persona p JOIN artist a ON a.id = p.parent_id
         WHERE p.persona_id = ?",
    )
    .bind(artist_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let personas: Vec<(i64, String)> = sqlx::query_as(
        "SELECT a.id, a.title FROM artist_persona p JOIN artist a ON a.id = p.persona_id
         WHERE p.parent_id = ? ORDER BY a.sort_title COLLATE NOCASE",
    )
    .bind(artist_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(ArtistPersonaLinks {
        parent: parent.map(|(artist_id, title)| PersonaRef { artist_id, title }),
        personas: personas
            .into_iter()
            .map(|(artist_id, title)| PersonaRef { artist_id, title })
            .collect(),
    })
}

/// Link an artist as a PERSONA of another (kiLL edward → J. Cole). Not a
/// merge: both pages keep their own credits, matching, and (possibly absent)
/// MBIDs. One parent per persona, one level deep. Logged and undoable.
#[tauri::command]
pub async fn set_artist_persona(
    state: State<'_, AppState>,
    persona_id: i64,
    parent_id: i64,
) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, persona_id).await?;
    let pool = &state.app_db;
    crate::music_edit::ensure_not_staged(pool, persona_id).await?;
    crate::music_edit::ensure_not_staged(pool, parent_id).await?;
    if persona_id == parent_id {
        return Err("An artist can't be their own persona".to_string());
    }
    let library_id = library_of(pool, persona_id).await?;
    let name_of = |id: i64| async move {
        sqlx::query_as::<_, (String,)>("SELECT title FROM artist WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .map(|(t,)| t)
            .map_err(|e| e.to_string())
    };
    let persona_name = name_of(persona_id).await?;
    let parent_name = name_of(parent_id).await?;
    // One level deep: chains would make "the human behind the mask" ambiguous.
    let parent_is_persona: Option<(i64,)> =
        sqlx::query_as("SELECT parent_id FROM artist_persona WHERE persona_id = ?")
            .bind(parent_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    if parent_is_persona.is_some() {
        return Err(format!(
            "\u{201c}{parent_name}\u{201d} is itself a persona — link to the artist behind it instead"
        ));
    }
    let has_own: Option<(i64,)> =
        sqlx::query_as("SELECT persona_id FROM artist_persona WHERE parent_id = ? LIMIT 1")
            .bind(persona_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    if has_own.is_some() {
        return Err(format!(
            "\u{201c}{persona_name}\u{201d} has personas of their own — unlink those first"
        ));
    }
    let prev: Option<(i64,)> =
        sqlx::query_as("SELECT parent_id FROM artist_persona WHERE persona_id = ?")
            .bind(persona_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    sqlx::query("INSERT OR REPLACE INTO artist_persona (persona_id, parent_id) VALUES (?, ?)")
        .bind(persona_id)
        .bind(parent_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    let batch = next_batch(pool).await?;
    log_change(
        pool,
        &library_id,
        "artist_persona",
        persona_id,
        &format!("\u{201c}{persona_name}\u{201d} is a persona of \u{201c}{parent_name}\u{201d}"),
        &serde_json::json!({ "parent_id": prev.map(|(p,)| p) }),
        &serde_json::json!({ "parent_id": parent_id }),
        batch,
    )
    .await?;
    Ok(())
}

/// Remove a persona link (the pages themselves are untouched).
#[tauri::command]
pub async fn unset_artist_persona(
    state: State<'_, AppState>,
    persona_id: i64,
) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, persona_id).await?;
    let pool = &state.app_db;
    let library_id = library_of(pool, persona_id).await?;
    let Some((prev_parent,)): Option<(i64,)> =
        sqlx::query_as("SELECT parent_id FROM artist_persona WHERE persona_id = ?")
            .bind(persona_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    sqlx::query("DELETE FROM artist_persona WHERE persona_id = ?")
        .bind(persona_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    let persona_name: (String,) = sqlx::query_as("SELECT title FROM artist WHERE id = ?")
        .bind(persona_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let batch = next_batch(pool).await?;
    log_change(
        pool,
        &library_id,
        "artist_persona",
        persona_id,
        &format!("\u{201c}{}\u{201d} — persona link removed", persona_name.0),
        &serde_json::json!({ "parent_id": prev_parent }),
        &serde_json::json!({ "parent_id": null }),
        batch,
    )
    .await?;
    Ok(())
}

/// MusicBrainz's special-purpose placeholder artists. A credit linked to one
/// of these is MB saying "somebody, but we're NOT saying who" — the opposite
/// of an identification, so the stamping walks and the harvest skip them
/// (the local name stays honestly unidentified, same as a credit with no
/// MBID). They're also barred from MBID-proven auto-merges: two different
/// mystery names both credited as [unknown] share an MBID without being the
/// same person. Various Artists is deliberately NOT here — special-purpose,
/// but a real matchable identity.
const PLACEHOLDER_ARTIST_MBIDS: &[&str] = &[
    "125ec42a-7229-4250-afc5-e057484327fe", // [unknown]
    "f731ccc4-e22a-43af-a747-64213329e088", // [anonymous]
    "eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61", // [no artist]
    "33cf029c-63b0-41a0-9855-be2a3665fb3b", // [data]
    "314e1c25-dde7-4e4d-b2f4-0a7b9f7c56dc", // [dialogue]
    "9be7f096-97ec-4615-8957-8d40b5dcbc41", // [traditional]
    "7e84f845-ac16-41fe-9ff8-df12eb32af55", // MusicBrainz Test Artist
];

fn is_placeholder_artist(mbid: &str) -> bool {
    PLACEHOLDER_ARTIST_MBIDS.iter().any(|p| p.eq_ignore_ascii_case(mbid))
}

/// The ONLY automatic artist matching waverunner does: identity derived from
/// the credit of an album that is already matched. The credit names each
/// artist by MBID, so "your artist credited on this album IS this MB artist"
/// holds with certainty — where a bare name search can hit any same-named
/// stranger ("God" is several artists on MusicBrainz; the one credited on
/// Yeezus is Kanye West's collaborator entry or nobody).
///
/// Fills id gaps only: an artist that already has a DIFFERENT id (user-tier
/// or an earlier stamp) is left alone — conflicting evidence is a decision,
/// not an update. The NAME follows either way: an identified page is called
/// what MusicBrainz calls the entity (`canonical`: mbid → name, from the
/// same fetch the credit came from), unless the user renamed it. Same rule
/// as an explicit match, so a feature-only page born from one credit reads
/// the same as one matched by hand (user rule 2026-09-20).
async fn stamp_artist_ids_from_credit(
    pool: &SqlitePool,
    library_id: &str,
    credit: &[(String, Option<String>)],
    canonical: &HashMap<String, String>,
) -> Result<usize, String> {
    let mut stamped = 0usize;
    for (name, mbid) in credit {
        let Some(mbid) = mbid else { continue };
        if is_placeholder_artist(mbid) {
            continue;
        }
        // As-credited name → our artist row (title or redirect), same
        // resolution surface the credit stamps use. Unidentified pages get
        // the id; pages already holding THIS id still get the name step.
        let row: Option<(i64, Option<String>)> = sqlx::query_as(
            "SELECT an.artist_id, a.musicbrainz_id FROM artist_names an
             JOIN media_entry me ON me.id = an.artist_id
             JOIN artist a ON a.id = an.artist_id
             WHERE me.library_id = ?1 AND LOWER(an.name) = LOWER(?2)
               AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '' OR a.musicbrainz_id = ?3)
             LIMIT 1",
        )
        .bind(library_id)
        .bind(name)
        .bind(mbid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if let Some((artist_id, current)) = row {
            if current.as_deref().is_none_or(str::is_empty) {
                sqlx::query("UPDATE artist SET musicbrainz_id = ? WHERE id = ?")
                    .bind(mbid)
                    .bind(artist_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                set_mb_id(pool, artist_id, MB_ARTIST, mbid, TIER_MB).await?;
                settle_artist_card_derived(pool, library_id, artist_id).await?;
                stamped += 1;
            }
            if let Some(canon) = canonical.get(mbid.as_str()) {
                adopt_mb_name(pool, library_id, artist_id, canon).await?;
            }
        }
    }
    Ok(stamped)
}

/// An identified artist's page is named what MusicBrainz names the entity.
/// Records the canonical name as the title's MB tier (the fallback when a
/// rename is cleared), then — unless the user renamed the artist — retitles
/// the page, keeping the old spelling as an 'mb' alias so every credit that
/// carries it keeps resolving. Logged as a rename (undoable) only when the
/// title actually changes.
pub(crate) async fn adopt_mb_name(
    pool: &SqlitePool,
    library_id: &str,
    artist_id: i64,
    canonical: &str,
) -> Result<(), String> {
    let canonical = canonical.trim();
    if canonical.is_empty() {
        return Ok(());
    }
    set_mb_id(pool, artist_id, "title", canonical, TIER_MB).await?;
    if crate::music_edit::has_override(pool, artist_id, "title").await? {
        return Ok(());
    }
    let (title,): (String,) = sqlx::query_as("SELECT title FROM artist WHERE id = ?")
        .bind(artist_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if title == canonical {
        return Ok(());
    }
    let batch = next_batch(pool).await?;
    rename_artist_page(pool, library_id, artist_id, &title, canonical, "mb", batch).await
}

/// Retitle an artist page: the old title becomes an alias (with its source),
/// the title and sort key change, an alias equal to the NEW title is dropped
/// (a redirect to itself says nothing), and the change is logged for undo.
pub(crate) async fn rename_artist_page(
    pool: &SqlitePool,
    library_id: &str,
    artist_id: i64,
    old_title: &str,
    new_title: &str,
    alias_source: &str,
    batch: i64,
) -> Result<(), String> {
    sqlx::query("INSERT OR IGNORE INTO artist_alias (artist_id, name, source) VALUES (?, ?, ?)")
        .bind(artist_id)
        .bind(old_title)
        .bind(alias_source)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE artist SET title = ?, sort_title = ? WHERE id = ?")
        .bind(new_title)
        .bind(crate::commands::generate_sort_title(new_title, "en"))
        .bind(artist_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    crate::music_edit::drop_self_alias(pool, artist_id).await?;
    log_change(
        pool,
        library_id,
        "artist_rename",
        artist_id,
        &format!("{old_title} — renamed to {new_title}"),
        &serde_json::json!({ "title": old_title }),
        &serde_json::json!({ "title": new_title }),
        batch,
    )
    .await
}

/// The album-credit protection's one exception: a SINGLE MusicBrainz credit
/// whose artist id is the very artist the album's single existing credit row
/// already resolves to. Rewriting then changes only the spelling ("Beyonce"
/// → "Beyoncé"), never which discography the album sits in — so a machine
/// match may do it. Any other single-credit rewrite stays user-only.
async fn single_credit_same_artist(
    pool: &SqlitePool,
    album_id: i64,
    mb_artist_ids: &[Option<String>],
) -> Result<bool, String> {
    let [Some(mbid)] = mb_artist_ids else { return Ok(false) };
    if is_placeholder_artist(mbid) {
        return Ok(false);
    }
    let rows: Vec<(Option<String>,)> = sqlx::query_as(
        "SELECT a.musicbrainz_id FROM album_artist_credit ac
         LEFT JOIN artist a ON a.id = ac.artist_id
         WHERE ac.album_id = ?",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(matches!(rows.as_slice(), [(Some(current),)] if current.eq_ignore_ascii_case(mbid)))
}

/// A pending "Which artist is this?" card whose artist just got identified by
/// EVIDENCE is a question that answered itself — settle it (status 'derived':
/// hidden from review, never re-asked) so cards vanish the moment any other
/// page's action makes them moot.
async fn settle_artist_card_derived(
    pool: &SqlitePool,
    library_id: &str,
    artist_id: i64,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE mb_suggestion SET status = 'derived'
         WHERE library_id = ? AND kind = 'artist_match' AND target_key = ? AND status = 'pending'",
    )
    .bind(library_id)
    .bind(artist_id.to_string())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply what a release group knows: album type, first release date, and the
/// album-level artist credit. Never touches tracks — a group has no track
/// list, and that is exactly why it is safe to conclude automatically.
/// Adopt MusicBrainz's ORIGINAL release date (the group's first-release-date)
/// as the album's displayed date — user ruling: a matched album shows the
/// year the album came out, not the year of the owned reissue (tags keep
/// saying 2016 for a 2016 remaster of a 1962 record). Written at mb tier in
/// field_override so reconcile re-stomps it after every tag rebuild; a user
/// edit (user tier) outranks it, and album_year suppression (an undone
/// adoption) stands. Logged when it visibly changes something.
async fn adopt_group_date(
    pool: &SqlitePool,
    library_id: &str,
    album_id: i64,
    album_title: &str,
    date: &str,
    batch: i64,
) -> Result<(), String> {
    if suppressed(pool, "album_year", album_id).await?
        || crate::music_edit::has_override(pool, album_id, "release_date").await?
    {
        return Ok(());
    }
    // Durable across rescans — written even when the row already agrees.
    set_mb_id(pool, album_id, "release_date", date, TIER_MB).await?;
    let (current,): (Option<String>,) =
        sqlx::query_as("SELECT release_date FROM album WHERE id = ?")
            .bind(album_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    if current.as_deref() == Some(date) {
        return Ok(());
    }
    sqlx::query("UPDATE album SET release_date = ? WHERE id = ?")
        .bind(date)
        .bind(album_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    log_change(
        pool,
        library_id,
        "album_year",
        album_id,
        &format!(
            "{album_title} — date {} → {date} (original release)",
            current.as_deref().unwrap_or("(none)")
        ),
        &serde_json::json!({ "release_date": current }),
        &serde_json::json!({ "release_date": date }),
        batch,
    )
    .await
}

/// Store the release GROUP's official title at the MB tier and adopt it as
/// the album's title (never a release's — those carry edition junk). Shared
/// by the group and release applies, so a pressing-only match still records
/// what MusicBrainz calls the album. Same guards as every adoption: the
/// user's own title edit wins the column, an undo suppression stands (and
/// blocks the store too), and the change is logged.
async fn adopt_group_title(
    pool: &SqlitePool,
    library_id: &str,
    album_id: i64,
    album_title: &str,
    group_title: &str,
    batch: i64,
) -> Result<(), String> {
    if group_title.is_empty() || suppressed(pool, "album_title", album_id).await? {
        return Ok(());
    }
    set_mb_id(pool, album_id, "title", group_title, TIER_MB).await?;
    if group_title != album_title
        && !crate::music_edit::has_override(pool, album_id, "title").await?
    {
        sqlx::query("UPDATE album SET title = ?, sort_title = ? WHERE id = ?")
            .bind(group_title)
            .bind(crate::commands::generate_sort_title(group_title, "en"))
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        log_change(
            pool,
            library_id,
            "album_title",
            album_id,
            &format!("{album_title} — renamed to {group_title}"),
            &serde_json::json!({ "title": album_title }),
            &serde_json::json!({ "title": group_title }),
            batch,
        )
        .await?;
    }
    Ok(())
}

async fn apply_group(
    pool: &SqlitePool,
    library_id: &str,
    album_id: i64,
    album_title: &str,
    group: &GroupCandidate,
    tier: &str,
) -> Result<(), String> {
    let batch = next_batch(pool).await?;
    // Pre-match id, captured before it's overwritten — the "before" of the
    // match log written at the end of this function.
    let prev_group_id = mb_id(pool, album_id, MB_RELEASE_GROUP).await?.map(|(v, _)| v);
    set_mb_id(pool, album_id, MB_RELEASE_GROUP, &group.group_id, tier).await?;
    sqlx::query("UPDATE album SET mb_release_group_id = ? WHERE id = ?")
        .bind(&group.group_id)
        .bind(album_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Credited artists that already have pages get their identity from this
    // match; names whose pages don't exist yet are caught by the pass's
    // artist phase after ensure_credit_artists creates them.
    let credit_pairs: Vec<(String, Option<String>)> = group
        .artists
        .iter()
        .cloned()
        .zip(group.artist_ids.iter().cloned())
        .collect();
    stamp_artist_ids_from_credit(pool, library_id, &credit_pairs, &group.canonical_names()).await?;

    // Same rule as apply_release: multi-name credits always rewrite (the
    // joint-credits fix), single-name credits rewrite when a PERSON applied
    // this match — the mismatch warning was their consent — or when the
    // single credit is provably the SAME artist the album already sits under
    // (only the spelling differs: "Beyonce" → "Beyoncé"). Machine matches
    // never recredit a single name to a different artist (V/A compilation
    // protection). The MB tier stores what MusicBrainz says whenever the
    // credit rule admits it — even under a user edit, so Clear overrides can
    // fall back to it without a fetch. The column write below stays
    // user-guarded.
    let credits_eligible = (group.artists.len() >= 2
        || tier == TIER_USER
        || single_credit_same_artist(pool, album_id, &group.artist_ids).await?)
        && !group.artists.is_empty()
        && !suppressed(pool, "album_artists", album_id).await?;
    if credits_eligible {
        set_mb_id(
            pool,
            album_id,
            "artist_credits",
            &serde_json::to_string(&group.artists).map_err(|e| e.to_string())?,
            TIER_MB,
        )
        .await?;
    }
    if credits_eligible
        && !crate::music_edit::has_override(pool, album_id, "artist_credits").await?
    {
        let current: Vec<String> = sqlx::query_as::<_, (String,)>(
            "SELECT name FROM album_artist_credit WHERE album_id = ? ORDER BY position",
        )
        .bind(album_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(n,)| n)
        .collect();
        let differs = current.len() != group.artists.len()
            || current.iter().zip(&group.artists).any(|(a, b)| !a.eq_ignore_ascii_case(b));
        if differs {
            sqlx::query("DELETE FROM album_artist_credit WHERE album_id = ?")
                .bind(album_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            for (i, name) in group.artists.iter().enumerate() {
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
            log_change(
                pool,
                library_id,
                "album_artists",
                album_id,
                &format!("{album_title} — credited to {}", group.artists.join(" · ")),
                &serde_json::json!({ "names": current }),
                &serde_json::json!({ "names": group.artists }),
                batch,
            )
            .await?;
        }
    }

    adopt_group_title(pool, library_id, album_id, album_title, &group.title, batch).await?;

    if let Some(mb_type) = &group.album_type {
        if !suppressed(pool, "album_type", album_id).await? {
            set_mb_id(pool, album_id, "album_type", mb_type, TIER_MB).await?;
        }
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
                    batch,
                )
                .await?;
            }
        }
    }

    // Original release date: the group's first-release-date wins over the
    // owned pressing's tag year on matched albums (user edits outrank).
    if let Some(date) = &group.first_release_date {
        adopt_group_date(pool, library_id, album_id, album_title, date, batch).await?;
    }

    // A person's match is a decision even when every gap-fill above turned
    // out to be a no-op (type, date and credits already agreeing with MB) —
    // log the match itself so history records the answer. Logged LAST so it
    // titles the batch's history row. The automatic pass stays silent here:
    // machine actions log only when they change data.
    if tier == TIER_USER {
        log_change(
            pool,
            library_id,
            "album_match",
            album_id,
            &format!("{album_title} — matched to MusicBrainz"),
            &serde_json::json!({ "release_group_id": prev_group_id }),
            &serde_json::json!({ "release_group_id": group.group_id }),
            batch,
        )
        .await?;
    }
    Ok(())
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
    // Provenance for the ids this writes: TIER_USER when a person picked the
    // release, TIER_MB when the automatic pass resolved it.
    tier: &str,
    // WHICH release of the album this pressing is — its folder. Credits, the
    // track-list diff, and the match itself all scope to this release; other
    // releases of the card keep their own matches untouched.
    folder: &str,
) -> Result<(), String> {
    // Which tracks the two sides disagree about — recorded before anything is
    // applied, since the disagreements are precisely what won't be applied.
    record_match_gaps(pool, album_id, folder, &full.tracks).await?;

    // Everything below is ONE action — applying this release — so it shares a
    // batch and undoes as a unit.
    let batch = next_batch(pool).await?;

    // Pre-match ids, captured before they're overwritten — the "before" of
    // the match log written at the end of this function.
    let prev_group_id = mb_id(pool, album_id, MB_RELEASE_GROUP).await?.map(|(v, _)| v);
    let prev_release_id = release_match_of(pool, album_id, folder)
        .await?
        .map(|(v, _)| v)
        // A sentinel "no MB counterpart" declaration isn't a previous match;
        // logging it as one would make undo restore an empty pin as real.
        .filter(|v| !v.is_empty());

    // Per-track data on this release's tracks: credits replace our parsed
    // guesses, titles adopt MusicBrainz's spelling — each its own history
    // row and its own suppression.
    let credits_ok = !suppressed(pool, "track_credits", album_id).await?;
    let titles_ok = !suppressed(pool, "track_titles", album_id).await?;
    let track_changes =
        apply_release_credits(pool, album_id, folder, &full.tracks, credits_ok, titles_ok, None, false).await?;
    log_track_changes(pool, library_id, album_id, album_title, &track_changes, batch).await?;

    // Joint albums: MB's release-level artist credit names every owner —
    // written as album_artist_credit rows so the album lands in each of their
    // discographies. User-set credits outrank; logged and undoable like every
    // other application.
    let album_artist_names: Vec<String> =
        full.album_artists.iter().map(|(n, _)| n.clone()).collect();
    // Single-name credits rewrite only on USER applies: the person picked the
    // release, and a credit mismatch already made them click through the
    // "credits X — not Y. Match anyway?" warning, so the recredit is
    // consented (persona albums: Delusional Thomas takes over from Mac
    // Miller). The MACHINE keeps the old protection — an auto-match must
    // never silently move an album out of an artist's discography (V/A
    // compilations filed under one artist).
    // A single credit that is provably the SAME artist the album already
    // sits under (same MBID, different spelling) is eligible on any tier —
    // only the text changes (see single_credit_same_artist).
    // MB tier first (stored even under a user edit — the reset's fallback),
    // then the user-guarded column write.
    let album_artist_ids: Vec<Option<String>> =
        full.album_artists.iter().map(|(_, id)| id.clone()).collect();
    let credits_eligible = (album_artist_names.len() >= 2
        || tier == TIER_USER
        || single_credit_same_artist(pool, album_id, &album_artist_ids).await?)
        && !album_artist_names.is_empty()
        && !suppressed(pool, "album_artists", album_id).await?;
    if credits_eligible {
        set_mb_id(
            pool,
            album_id,
            "artist_credits",
            &serde_json::to_string(&album_artist_names).map_err(|e| e.to_string())?,
            TIER_MB,
        )
        .await?;
    }
    if credits_eligible
        && !crate::music_edit::has_override(pool, album_id, "artist_credits").await?
    {
        let current: Vec<String> = sqlx::query_as::<_, (String,)>(
            "SELECT name FROM album_artist_credit WHERE album_id = ? ORDER BY position",
        )
        .bind(album_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(n,)| n)
        .collect();
        let differs = current.len() != album_artist_names.len()
            || current
                .iter()
                .zip(&album_artist_names)
                .any(|(a, b)| !a.eq_ignore_ascii_case(b));
        if differs {
            sqlx::query("DELETE FROM album_artist_credit WHERE album_id = ?")
                .bind(album_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            for (i, name) in album_artist_names.iter().enumerate() {
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
            log_change(
                pool,
                library_id,
                "album_artists",
                album_id,
                &format!("{album_title} — credited to {}", album_artist_names.join(" · ")),
                &serde_json::json!({ "names": current }),
                &serde_json::json!({ "names": album_artist_names }),
                batch,
            )
            .await?;
        }
    }

    // Artist identity from this release's credits — album-level owners AND
    // per-track features (this is where a guest like Xzibit, credited on one
    // matched song, gets his exact MB identity). De-duplicated so a name
    // credited on twelve tracks resolves once.
    {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut credit_pairs: Vec<(String, Option<String>)> = Vec::new();
        for (name, id) in full
            .album_artists
            .iter()
            .chain(full.tracks.iter().flat_map(|t| t.credits.iter()))
        {
            if id.is_some() && seen.insert(name.as_str()) {
                credit_pairs.push((name.clone(), id.clone()));
            }
        }
        stamp_artist_ids_from_credit(pool, library_id, &credit_pairs, &full.artist_names).await?;
    }

    // Album type: MB's release-group type replaces the track-count guess —
    // unless the user set the type themselves (user tier outranks external).
    if let Some(mb_type) = &full.album_type {
        if !suppressed(pool, "album_type", album_id).await? {
            set_mb_id(pool, album_id, "album_type", mb_type, TIER_MB).await?;
        }
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
                    batch,
                )
                .await?;
            }
        }
    }

    // Original release date (the group's first-release-date, pressing date
    // as fallback) wins over the owned reissue's tag year.
    if let Some(mb_date) = &full.date {
        adopt_group_date(pool, library_id, album_id, album_title, mb_date, batch).await?;
    }

    // Remember WHICH pressing THIS release is, durably — folder-keyed so the
    // match survives the rescan rebuilding release rows. (album_release's own
    // mb_release_id column stays purely tag-derived: it reports what the
    // FILES say, this table records what was matched.)
    set_release_match(pool, album_id, folder, &full.release_id, tier).await?;
    if let Some(t) = &full.title {
        sqlx::query("UPDATE release_match SET title = ? WHERE album_id = ? AND folder_path = ?")
            .bind(t)
            .bind(album_id)
            .bind(folder)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(rg) = &full.release_group_id {
        set_mb_id(pool, album_id, MB_RELEASE_GROUP, rg, tier).await?;
        sqlx::query("UPDATE album SET mb_release_group_id = ? WHERE id = ?")
            .bind(rg)
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    // The group's title is the album's MB-tier title whichever way the
    // group got pinned — a pressing-only match stores and adopts it too.
    if let Some(gt) = &full.group_title {
        adopt_group_title(pool, library_id, album_id, album_title, gt, batch).await?;
    }

    // Same rule as apply_group: a person's match logs even when every
    // application above turned out to be a no-op, so the decision itself is
    // visible (and undoable) in history — not only its side effects. Logged
    // LAST so it titles the batch's history row. The automatic pass stays
    // silent: machine actions log only when they change data.
    if tier == TIER_USER {
        log_change(
            pool,
            library_id,
            "album_match",
            album_id,
            &format!("{album_title} — matched to MusicBrainz"),
            &serde_json::json!({
                "release_group_id": prev_group_id,
                "release_id": prev_release_id,
                // Which release the ids belong to — undo restores precisely.
                "folder": folder,
            }),
            &serde_json::json!({
                "release_group_id": full.release_group_id,
                "release_id": full.release_id,
                "folder": folder,
            }),
            batch,
        )
        .await?;
    }
    Ok(())
}

/// Replace the tag-parsed credits of the album's DEFAULT release with MB's,
/// matching tracks by (disc, position) and a loose title check. Returns the
/// per-track (id, before, after) changes for the log. MB-provided artist ids
/// seed the artist-lookup cache so the MBID pass skips them.
/// Per-track outcome of applying a release, for the log: credit swaps and
/// title adoptions, each as (track id, before, after).
#[derive(Default)]
struct ReleaseTrackChanges {
    credits: Vec<(i64, Vec<String>, Vec<String>)>,
    titles: Vec<(i64, String, String)>,
}

/// Log a release application's per-track changes: one history row per
/// kind, keyed by track id so undo can walk them back one by one.
async fn log_track_changes(
    pool: &SqlitePool,
    library_id: &str,
    album_id: i64,
    album_title: &str,
    changes: &ReleaseTrackChanges,
    batch: i64,
) -> Result<(), String> {
    if !changes.credits.is_empty() {
        let before: HashMap<String, Vec<String>> = changes
            .credits
            .iter()
            .map(|(id, b, _)| (id.to_string(), b.clone()))
            .collect();
        let after: HashMap<String, Vec<String>> = changes
            .credits
            .iter()
            .map(|(id, _, a)| (id.to_string(), a.clone()))
            .collect();
        log_change(
            pool,
            library_id,
            "track_credits",
            album_id,
            &format!("{album_title} — credits on {} tracks", changes.credits.len()),
            &serde_json::json!(before),
            &serde_json::json!(after),
            batch,
        )
        .await?;
    }
    if !changes.titles.is_empty() {
        let before: HashMap<String, String> = changes
            .titles
            .iter()
            .map(|(id, b, _)| (id.to_string(), b.clone()))
            .collect();
        let after: HashMap<String, String> = changes
            .titles
            .iter()
            .map(|(id, _, a)| (id.to_string(), a.clone()))
            .collect();
        log_change(
            pool,
            library_id,
            "track_titles",
            album_id,
            &format!("{album_title} — titles on {} tracks", changes.titles.len()),
            &serde_json::json!(before),
            &serde_json::json!(after),
            batch,
        )
        .await?;
    }
    Ok(())
}

/// Apply the release's per-track data to the album's tracks in this folder,
/// matching tracks by (disc, position) and a loose title check. A paired
/// track's MB tier gets the release's title, position and disc (stored even
/// under a user edit — the reset's fallback and the Sources view), and its
/// credits. Columns follow unless a user edit outranks: credits replaced,
/// the title adopted as MusicBrainz spells it. The `_ok` flags are the
/// callers' suppression checks (an undone application): a suppressed kind
/// is neither applied nor stored, or the reapply hook would resurrect it.
/// MB-provided artist ids seed the artist-lookup cache so the MBID pass
/// skips them.
///
/// Pairing takes two witnesses: the loose title check AND the file's runtime
/// within the length window of MB's length (when MB has one). Either one
/// failing keeps MB's data off the track and lands it on the differ page.
/// `only_track` + `force` is that page's Accept: a person confirmed the
/// track at this slot IS MB's, so the witnesses are skipped for that one.
async fn apply_release_credits(
    pool: &SqlitePool,
    album_id: i64,
    folder: &str,
    mb_tracks: &[MbTrack],
    credits_ok: bool,
    titles_ok: bool,
    only_track: Option<i64>,
    force: bool,
) -> Result<ReleaseTrackChanges, String> {
    let ours: Vec<(i64, String, Option<i64>, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT t.id, t.title, t.disc_number, t.track_number, t.runtime
         FROM track t
         JOIN track_release tr ON tr.track_id = t.id
         JOIN album_release ar ON ar.id = tr.release_id
         WHERE ar.album_id = ? AND ar.folder_path = ?",
    )
    .bind(album_id)
    .bind(folder)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut changes = ReleaseTrackChanges::default();
    for (track_id, our_title, disc, number, runtime) in ours {
        if only_track.is_some_and(|t| t != track_id) {
            continue;
        }
        let (disc, number) = (disc.unwrap_or(1), number.unwrap_or(0));
        let Some(mb) = mb_tracks.iter().find(|t| t.disc == disc && t.position == number) else {
            continue;
        };
        let (mb_disc, mb_pos, mb_title, credits) = (mb.disc, mb.position, &mb.title, &mb.credits);
        if !force
            && !(raw_titles_match(&our_title, mb_title) && !length_vetoes(runtime, mb.length_ms))
        {
            continue; // positions collide but the witnesses disagree — keep tag data
        }
        // The track's own MB tier: what the release calls this track and
        // where it sits. Position and disc equal ours by construction of the
        // pairing; stored so the tier is complete (Sources, Clear overrides).
        if titles_ok {
            set_mb_id(pool, track_id, "title", mb_title, TIER_MB).await?;
            set_mb_id(pool, track_id, "track_number", &mb_pos.to_string(), TIER_MB).await?;
            set_mb_id(pool, track_id, "disc_number", &mb_disc.to_string(), TIER_MB).await?;
            // The title column follows MB's spelling — the user's own edit
            // outranks (stored above, not applied).
            if *mb_title != our_title
                && !crate::music_edit::has_override(pool, track_id, "title").await?
            {
                sqlx::query("UPDATE track SET title = ?, sort_title = ? WHERE id = ?")
                    .bind(mb_title)
                    .bind(crate::commands::generate_sort_title(mb_title, "en"))
                    .bind(track_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                changes.titles.push((track_id, our_title.clone(), mb_title.clone()));
            }
        }
        if !credits_ok {
            continue;
        }
        let after: Vec<String> = credits.iter().map(|(n, _)| n.clone()).collect();
        // MB tier: what the release says, stored even when a user edit
        // outranks it (that's what Clear overrides falls back to).
        set_mb_id(
            pool,
            track_id,
            "credits",
            &serde_json::to_string(&after).map_err(|e| e.to_string())?,
            TIER_MB,
        )
        .await?;
        // User-edited credits outrank MB's — stored above, not applied.
        if crate::music_edit::has_override(pool, track_id, "credits").await? {
            continue;
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
            changes.credits.push((track_id, before, after));
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

/// Reconcile the album's default release against the MusicBrainz release it
/// was matched to, recording every track that didn't line up.
///
/// Worth surfacing because a mismatch is silent otherwise: `apply_release_credits`
/// skips any track whose title disagrees with MB's at the same disc/track, so
/// it quietly keeps whatever the tags said — which on a mistagged album is the
/// junk the user matched to MusicBrainz to be rid of. Three shapes of gap:
/// a track of ours at a slot MB doesn't have, a track of MB's at a slot we
/// don't have, and a shared slot holding two different titles.
/// (our unmatched tracks, release tracks missing here). Kept separate because
/// one song absent from both sides is one problem, not two.
#[derive(Debug, Serialize, Clone, Copy)]
pub struct MbGapCounts {
    pub ours: i64,
    pub mb: i64,
}

async fn record_match_gaps(
    pool: &SqlitePool,
    album_id: i64,
    folder: &str,
    mb_tracks: &[MbTrack],
) -> Result<MbGapCounts, String> {
    let ours: Vec<(String, Option<i64>, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT t.title, t.disc_number, t.track_number, t.runtime
         FROM track t
         JOIN track_release tr ON tr.track_id = t.id
         JOIN album_release ar ON ar.id = tr.release_id
         WHERE ar.album_id = ? AND ar.folder_path = ?",
    )
    .bind(album_id)
    .bind(folder)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // (side, disc, position, title, counterpart, length_off)
    let mut gaps: Vec<(&str, i64, i64, String, Option<String>, bool)> = Vec::new();
    let mut our_slots: Vec<(i64, i64)> = Vec::new();
    for (our_title, disc, number, runtime) in &ours {
        let (disc, number) = (disc.unwrap_or(1), number.unwrap_or(0));
        our_slots.push((disc, number));
        match mb_tracks.iter().find(|t| t.disc == disc && t.position == number) {
            None => gaps.push(("ours", disc, number, our_title.clone(), None, false)),
            Some(mb) => {
                // A shared slot is a gap when the titles disagree, or when
                // the lengths are so far apart the title can't carry it
                // (see LENGTH_VETO_MS). length_off reports the tighter
                // window: title off + length off = probably a different song.
                let titles_ok = raw_titles_match(our_title, &mb.title);
                let length_ok = length_agrees(*runtime, mb.length_ms);
                if !titles_ok || length_vetoes(*runtime, mb.length_ms) {
                    gaps.push((
                        "ours",
                        disc,
                        number,
                        our_title.clone(),
                        Some(mb.title.clone()),
                        !length_ok,
                    ));
                }
            }
        }
    }
    // MB tracks at slots we have nothing for. A differing title at a shared
    // slot is already reported once from our side — don't double-count it.
    for mb in mb_tracks {
        if !our_slots.contains(&(mb.disc, mb.position)) {
            gaps.push(("mb", mb.disc, mb.position, mb.title.clone(), None, false));
        }
    }

    sqlx::query("DELETE FROM album_match_gap WHERE album_id = ? AND folder_path = ?")
        .bind(album_id)
        .bind(folder)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    for (side, disc, position, title, counterpart, length_off) in &gaps {
        sqlx::query(
            "INSERT OR REPLACE INTO album_match_gap
             (album_id, folder_path, side, disc, position, title, counterpart, length_off)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(album_id)
        .bind(folder)
        .bind(side)
        .bind(disc)
        .bind(position)
        .bind(title)
        .bind(counterpart)
        .bind(*length_off as i64)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(MbGapCounts {
        ours: gaps.iter().filter(|(side, ..)| *side == "ours").count() as i64,
        mb: gaps.iter().filter(|(side, ..)| *side == "mb").count() as i64,
    })
}

/// Lowercase alphanumerics only — punctuation-proof title comparison.
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .map(fold_diacritic)
        .collect()
}

/// Accented letter → its bare form. Tags are typed on an ASCII keyboard and
/// MusicBrainz spells names properly, so "Jhene Aiko" must reach "Jhené Aiko"
/// and "Beyonce" must reach "Beyoncé". No crate for this — the Latin-1 range
/// plus a few strays covers every name a music library realistically holds.
fn fold_diacritic(c: char) -> char {
    match c {
        'à'..='å' | 'ā' | 'ă' | 'ą' => 'a',
        'è'..='ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ì'..='ï' | 'ĩ' | 'ī' | 'į' | 'ı' => 'i',
        'ò'..='ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ù'..='ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ý' | 'ÿ' => 'y',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ß' => 's',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ź' | 'ż' | 'ž' => 'z',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ð' | 'ď' | 'đ' => 'd',
        'ł' => 'l',
        'ŕ' | 'ř' => 'r',
        'ť' | 'ţ' => 't',
        other => other,
    }
}

fn titles_match(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && (a == b || a.contains(b) || b.contains(a))
}

/// Title comparison from the RAW strings. Normalization keeps alphanumerics
/// only, so an all-symbol title ("$$$", "?", "?!") normalizes to nothing and
/// the empty-guard in titles_match rejected it even when both sides were
/// byte-identical (XXXTENTACION's "?" album could never fully pair). When
/// both sides normalize away, compare the raw text instead — trimmed,
/// lowercased, exact (no containment: symbol runs are too short for it).
fn raw_titles_match(our_raw: &str, mb_raw: &str) -> bool {
    let (a, b) = (normalize(our_raw), normalize(mb_raw));
    if a.is_empty() && b.is_empty() {
        return !our_raw.trim().is_empty()
            && our_raw.trim().to_lowercase() == mb_raw.trim().to_lowercase();
    }
    titles_match(&a, &b)
}

// ---------------------------------------------------------------------------
// Artist MBIDs
// ---------------------------------------------------------------------------

/// Returns (stamped count, artists whose evidence fetch FAILED this pass) —
/// the failures must not fall through to the suggestion sweep, or a transient
/// 503 would permanently convert a derivable artist into a burned question.
async fn enrich_artist_mbids(
    app: &AppHandle,
    pool: &SqlitePool,
    client: &reqwest::Client,
    library_id: &str,
) -> Result<(usize, std::collections::HashSet<i64>), String> {
    // Evidence-based only. An artist qualifies when they're credited on a
    // MATCHED album — album-level credit on a group-matched album, or a track
    // credit on a release-matched one. The matched entity's credit names each
    // artist by MBID, which is the certainty a bare name search can never
    // give ("God" is several artists on MusicBrainz; the one credited on the
    // album you matched is exactly one of them). Artists with no matched
    // evidence stay unidentified on purpose — a person decides those.
    let candidates: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT a.id, a.title,
                (SELECT f.value FROM album_artist_credit ac
                 JOIN field_override f ON f.entity_id = ac.album_id
                    AND f.field = 'mb_release_group_id'
                 WHERE ac.artist_id = a.id LIMIT 1),
                (SELECT rm.mb_release_id FROM track_credit tc
                 JOIN media_entry tme ON tme.id = tc.track_id
                 JOIN release_match rm ON rm.album_id = tme.parent_id
                                      AND rm.mb_release_id <> ''
                 WHERE tc.artist_id = a.id LIMIT 1)
         FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ? AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = a.id AND ig.field = 'mb_ignored')
         ORDER BY a.sort_title COLLATE NOCASE",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    // Evidence already walked to completion without proving its artist is
    // exhausted — skip it until the facts change (rows are cleared on
    // merge/alias/unmatch). Failed fetches never wrote a row, so the retry
    // shield is untouched.
    let exhausted_rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT entity_id, evidence_key FROM mb_derive_exhausted")
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    let exhausted: std::collections::HashSet<(i64, String)> = exhausted_rows.into_iter().collect();
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|(id, _, gid, rid)| {
            let Some(key) = gid.as_ref().or(rid.as_ref()) else { return false };
            !exhausted.contains(&(*id, key.clone()))
        })
        .collect();
    if candidates.is_empty() {
        return Ok((0, std::collections::HashSet::new()));
    }

    // Every name each candidate answers to, for matching against fetched
    // credits with the module's normalize (dash/diacritic folding — MB's
    // typography must not cost a match).
    let mut names_by_artist: HashMap<i64, Vec<String>> = HashMap::new();
    for (artist_id, _, _, _) in &candidates {
        let names: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM artist_names WHERE artist_id = ?")
                .bind(artist_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
        names_by_artist.insert(*artist_id, names.into_iter().map(|(n,)| n).collect());
    }

    // One fetch can identify several members (joint albums), so fetches are
    // cached per pass and already-stamped artists are skipped.
    let total = candidates.len();
    // Per evidence id: the credit pairs plus mbid → canonical names, so a
    // page identified here is named like one identified any other way.
    type Evidence = (Vec<(String, Option<String>)>, HashMap<String, String>);
    let mut group_cache: HashMap<String, Evidence> = HashMap::new();
    let mut release_cache: HashMap<String, Evidence> = HashMap::new();
    let mut stamped: std::collections::HashSet<i64> = std::collections::HashSet::new();
    // Evidence fetches that errored, keyed by the group/release id — every
    // artist leaning on one of these gets shielded from the suggestion sweep
    // this pass and derived next pass instead.
    let mut failed_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut fetch_failed: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut updated = 0usize;

    for (i, (artist_id, title, gid, rid)) in candidates.iter().enumerate() {
        if CANCEL.load(Ordering::SeqCst) {
            break; // skip-remaining: identities fill in on a later pass
        }
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "libraryId": library_id, "phase": "artist-ids", "done": i, "total": total, "name": title }),
        );
        if stamped.contains(artist_id) {
            continue;
        }

        // The credit of this artist's matched evidence, fetched or cached.
        // Transient fetch errors skip the artist (a later pass retries) —
        // never fail the whole phase over one request.
        let (pairs, canonical): &Evidence = if let Some(gid) = gid {
            match group_cache.entry(gid.clone()) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(slot) => {
                    let fetched = match fetch_release_group(client, gid).await {
                        Ok(Some(g)) => (
                            g.artists
                                .iter()
                                .cloned()
                                .zip(g.artist_ids.iter().cloned())
                                .collect(),
                            g.canonical_names(),
                        ),
                        Ok(None) => (Vec::new(), HashMap::new()),
                        Err(e) => {
                            eprintln!("artist identity: group {gid} fetch failed: {e}");
                            failed_keys.insert(gid.clone());
                            (Vec::new(), HashMap::new())
                        }
                    };
                    slot.insert(fetched)
                }
            }
        } else if let Some(rid) = rid {
            match release_cache.entry(rid.clone()) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(slot) => {
                    let fetched = match fetch_release(client, rid).await {
                        Ok(Some(full)) => {
                            let mut seen: std::collections::HashSet<String> =
                                std::collections::HashSet::new();
                            let mut pairs = Vec::new();
                            for (name, id) in full.album_artists.iter().chain(
                                full.tracks.iter().flat_map(|t| t.credits.iter()),
                            ) {
                                if id.is_some() && seen.insert(name.clone()) {
                                    pairs.push((name.clone(), id.clone()));
                                }
                            }
                            (pairs, full.artist_names.clone())
                        }
                        Ok(None) => (Vec::new(), HashMap::new()),
                        Err(e) => {
                            eprintln!("artist identity: release {rid} fetch failed: {e}");
                            failed_keys.insert(rid.clone());
                            (Vec::new(), HashMap::new())
                        }
                    };
                    slot.insert(fetched)
                }
            }
        } else {
            continue;
        };
        if pairs.is_empty() {
            // Nothing to match against. If that's because the fetch FAILED
            // (not because MB returned an empty credit), shield this artist
            // from the sweep — a retry next pass may still derive them.
            let key_failed = gid.as_ref().is_some_and(|g| failed_keys.contains(g))
                || rid.as_ref().is_some_and(|r| failed_keys.contains(r));
            if key_failed {
                fetch_failed.insert(*artist_id);
            } else if let Some(key) = gid.as_ref().or(rid.as_ref()) {
                // Genuinely empty credit — walking it again is pointless.
                mark_exhausted(pool, *artist_id, key).await?;
            }
            continue;
        }

        // Stamp EVERY still-unidentified candidate this credit names, not
        // just the artist that prompted the fetch.
        let walked_key = gid.as_ref().or(rid.as_ref()).cloned();
        for (cname, cid) in pairs {
            let Some(cid) = cid else { continue };
            if is_placeholder_artist(cid) {
                continue;
            }
            let want = normalize(cname);
            let hit = names_by_artist.iter().find(|(aid, names)| {
                !stamped.contains(aid) && names.iter().any(|n| normalize(n) == want)
            });
            if let Some((&aid, _)) = hit {
                sqlx::query("UPDATE artist SET musicbrainz_id = ? WHERE id = ?")
                    .bind(cid)
                    .bind(aid)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                // Durable copy, same as albums: the column is convenience,
                // the override is the record.
                set_mb_id(pool, aid, MB_ARTIST, cid, TIER_MB).await?;
                settle_artist_card_derived(pool, library_id, aid).await?;
                // Identified → named what MusicBrainz names the entity.
                if let Some(canon) = canonical.get(cid.as_str()) {
                    adopt_mb_name(pool, library_id, aid, canon).await?;
                }
                stamped.insert(aid);
                updated += 1;
            }
        }
        // Walk completed (fetch succeeded) and this artist still isn't
        // proven — this evidence is exhausted for them until the facts
        // change (merge/alias renames them, a new match adds evidence).
        if !stamped.contains(artist_id) {
            if let Some(key) = &walked_key {
                mark_exhausted(pool, *artist_id, key).await?;
            }
        }
    }
    Ok((updated, fetch_failed))
}

/// One completed, fruitless walk = one exhaustion row: the pass stops paying
/// for this (entity, evidence) pair until something deletes the row. Never
/// written for FAILED fetches — the retry shield depends on that.
async fn mark_exhausted(pool: &SqlitePool, entity_id: i64, key: &str) -> Result<(), String> {
    sqlx::query("INSERT OR IGNORE INTO mb_derive_exhausted (entity_id, evidence_key) VALUES (?, ?)")
        .bind(entity_id)
        .bind(key)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The manual verification loop, mechanized: group → pressing → track credit
/// → artist MBID. A GROUP-matched album proves its album-level credit, but
/// the features live one fetch deeper — on the group's releases, whose track
/// credits carry artist MBIDs. Walk a few pressings per group and stamp every
/// still-unidentified credited artist whose name (or alias) those credits
/// answer to. Same certainty tier as release-match derivation — MusicBrainz
/// itself saying who the "Castro" on THIS album is — so no card is shown;
/// resolved artists settle 'derived'. Names the pressings never mention fall
/// through to the suggestion sweep unchanged.
async fn harvest_group_credits(
    app: &AppHandle,
    pool: &SqlitePool,
    client: &reqwest::Client,
    library_id: &str,
) -> Result<(usize, std::collections::HashSet<i64>), String> {
    // Every fetched pressing costs a rate-limited request; three is enough to
    // cover standard + deluxe + one regional variant, and whatever they miss
    // still gets its suggestion card.
    const MAX_RELEASES_PER_GROUP: usize = 3;

    // Group-matched albums still crediting an MBID-less artist. Albums with a
    // RELEASE match are excluded — their track credits were already harvested
    // by enrich_artist_mbids from the release itself.
    let albums: Vec<(i64, String)> = sqlx::query_as(
        "SELECT al.id, al.title FROM album al
         JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ?
           AND EXISTS (SELECT 1 FROM field_override f
                       WHERE f.entity_id = al.id AND f.field = 'mb_release_group_id'
                         AND f.value IS NOT NULL AND f.value <> '')
           AND NOT EXISTS (SELECT 1 FROM release_match rm WHERE rm.album_id = al.id)
           AND (EXISTS (SELECT 1 FROM album_artist_credit ac
                        JOIN artist a ON a.id = ac.artist_id
                        WHERE ac.album_id = al.id
                          AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = ''))
                OR EXISTS (SELECT 1 FROM media_entry t
                           JOIN track_credit tc ON tc.track_id = t.id
                           JOIN artist a ON a.id = tc.artist_id
                           WHERE t.parent_id = al.id
                             AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')))
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored')
         ORDER BY al.sort_title COLLATE NOCASE",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if albums.is_empty() {
        return Ok((0, std::collections::HashSet::new()));
    }

    // One group can back several local albums (and vice versa several artists)
    // — work per GROUP, keyed by the winning override, first album's title as
    // the progress label.
    struct GroupWork {
        title: String,
        wanted: std::collections::HashSet<i64>,
    }
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, GroupWork> = HashMap::new();
    for (album_id, title) in &albums {
        let Some((gid, _)) = mb_id(pool, *album_id, MB_RELEASE_GROUP).await? else {
            continue;
        };
        let wanted: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT a.id FROM artist a
             WHERE (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')
               AND NOT EXISTS (SELECT 1 FROM field_override ig
                               WHERE ig.entity_id = a.id AND ig.field = 'mb_ignored')
               -- This group's pressings were already walked without naming
               -- them — exhausted until the facts change (merge/alias/new
               -- match delete the row).
               AND NOT EXISTS (SELECT 1 FROM mb_derive_exhausted x
                               WHERE x.entity_id = a.id AND x.evidence_key = ?2)
               AND a.id IN (SELECT ac.artist_id FROM album_artist_credit ac
                            WHERE ac.album_id = ?1
                            UNION
                            SELECT tc.artist_id FROM track_credit tc
                            JOIN media_entry t ON t.id = tc.track_id
                            WHERE t.parent_id = ?1)",
        )
        .bind(album_id)
        .bind(&gid)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        if wanted.is_empty() {
            continue;
        }
        let entry = groups.entry(gid.clone()).or_insert_with(|| {
            order.push(gid.clone());
            GroupWork { title: title.clone(), wanted: std::collections::HashSet::new() }
        });
        entry.wanted.extend(wanted.into_iter().map(|(id,)| id));
    }
    if order.is_empty() {
        return Ok((0, std::collections::HashSet::new()));
    }

    // Every name each pool artist answers to, for matching fetched credits
    // with the module's normalize (dash/diacritic folding).
    let pool_ids: std::collections::HashSet<i64> =
        groups.values().flat_map(|g| g.wanted.iter().copied()).collect();
    let mut names_by_artist: HashMap<i64, Vec<String>> = HashMap::new();
    for artist_id in &pool_ids {
        let names: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM artist_names WHERE artist_id = ?")
                .bind(artist_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
        names_by_artist.insert(*artist_id, names.into_iter().map(|(n,)| n).collect());
    }

    let total = order.len();
    let mut stamped: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut fetch_failed: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut updated = 0usize;

    for (i, gid) in order.iter().enumerate() {
        if CANCEL.load(Ordering::SeqCst) {
            break; // skip-remaining: unresolved artists get their turn next pass
        }
        let work = &groups[gid];
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "libraryId": library_id, "phase": "artist-credits", "done": i, "total": total, "name": work.title }),
        );
        // An earlier group's pressing may have already named everyone here.
        if work.wanted.iter().all(|id| stamped.contains(id)) {
            continue;
        }

        // Transient fetch errors shield the group's unresolved artists from
        // the suggestion sweep (same as enrich_artist_mbids) — a retry next
        // pass may still derive them; never fail the phase over one request.
        let mut failed = false;
        let mut releases = match releases_in_group(client, gid).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("credit harvest: group {gid} release list failed: {e}");
                fetch_failed
                    .extend(work.wanted.iter().filter(|id| !stamped.contains(id)));
                continue;
            }
        };
        // Official pressings first, bigger track lists first — a deluxe
        // edition's credits are a superset of the standard's.
        releases.sort_by_key(|r| {
            (r.status.as_deref() != Some("Official"), -(r.track_count.unwrap_or(0)))
        });

        for release in releases.iter().take(MAX_RELEASES_PER_GROUP) {
            if CANCEL.load(Ordering::SeqCst) {
                break;
            }
            let full = match fetch_release(client, &release.release_id).await {
                Ok(Some(f)) => f,
                Ok(None) => continue,
                Err(e) => {
                    eprintln!(
                        "credit harvest: release {} fetch failed: {e}",
                        release.release_id
                    );
                    failed = true;
                    continue;
                }
            };
            // Album-level + every track credit, deduped by credited name.
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for (cname, cid) in full
                .album_artists
                .iter()
                .chain(full.tracks.iter().flat_map(|t| t.credits.iter()))
            {
                let Some(cid) = cid else { continue };
                if is_placeholder_artist(cid) {
                    continue;
                }
                if !seen.insert(cname.clone()) {
                    continue;
                }
                // Stamp EVERY still-unidentified pool artist this credit
                // names, not just this group's own — a feature heard on two
                // albums is proven by whichever pressing names them first.
                let want = normalize(cname);
                let hit = names_by_artist.iter().find(|(aid, names)| {
                    !stamped.contains(aid) && names.iter().any(|n| normalize(n) == want)
                });
                if let Some((&aid, _)) = hit {
                    sqlx::query("UPDATE artist SET musicbrainz_id = ? WHERE id = ?")
                        .bind(cid)
                        .bind(aid)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    set_mb_id(pool, aid, MB_ARTIST, cid, TIER_MB).await?;
                    settle_artist_card_derived(pool, library_id, aid).await?;
                    stamped.insert(aid);
                    updated += 1;
                }
            }
            if work.wanted.iter().all(|id| stamped.contains(id)) {
                break; // this group's own artists are all proven — stop paying
            }
        }
        if failed {
            fetch_failed.extend(work.wanted.iter().filter(|id| !stamped.contains(id)));
        } else if !CANCEL.load(Ordering::SeqCst) {
            // The walk ran to its budget cleanly and these artists were never
            // named — this group is exhausted for them. One row per pair;
            // merges/aliases/unmatches delete rows to earn a fresh walk.
            for id in work.wanted.iter().filter(|id| !stamped.contains(id)) {
                mark_exhausted(pool, *id, gid).await?;
            }
        }
    }
    Ok((updated, fetch_failed))
}

// Name-based artist AUTO-matching is GONE on purpose (with its
// mb_artist_lookup cache): an exact name match against all of MusicBrainz can
// hit any same-named stranger — "God" auto-matched a random artist because
// somebody out there is called that. Artist identity now derives only from
// matched albums' credits (enrich_artist_mbids / stamp_artist_ids_from_credit)
// or from the user's own match. Name search survives ONLY as a question:
// suggest_artist_matches below turns a small candidate set into a
// needs-a-decision entry, never a conclusion.

/// For artists no matched album vouches for: search MusicBrainz by name once,
/// and when the plausible candidates are FEW (1–4 at the score bar), park
/// them as an 'artist_match' suggestion for the person to decide — with
/// disambiguation, type, and years, which is what a machine can't weigh.
/// Zero or many candidates settle silently (status 'notfound'): nothing worth
/// asking, and the artist stays honestly unidentified. Each artist is asked
/// about at most once — any existing suggestion row, whatever its status,
/// stands as the record.
async fn suggest_artist_matches(
    app: &AppHandle,
    pool: &SqlitePool,
    client: &reqwest::Client,
    library_id: &str,
    // Artists whose evidence fetch failed THIS pass — asking them now would
    // burn their one-time question on a network hiccup.
    skip: &std::collections::HashSet<i64>,
) -> Result<usize, String> {
    let artists: Vec<(i64, String)> = sqlx::query_as(
        "SELECT a.id, a.title FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?1 AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')
           AND NOT EXISTS (SELECT 1 FROM mb_suggestion s
                           WHERE s.library_id = ?1 AND s.kind = 'artist_match'
                             AND s.target_key = CAST(a.id AS TEXT))
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = a.id AND ig.field = 'mb_ignored')
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
    let mut suggested = 0usize;
    for (i, (artist_id, title)) in artists.into_iter().enumerate() {
        if CANCEL.load(Ordering::SeqCst) {
            break; // skip-remaining: unasked artists get their turn next pass
        }
        if skip.contains(&artist_id) {
            continue; // evidence fetch failed this pass — derivable next pass
        }
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "libraryId": library_id, "phase": "artist-search", "done": i, "total": total, "name": title }),
        );
        // Transient search failure: skip WITHOUT recording, so the artist is
        // asked about again next pass instead of being settled by an outage.
        let candidates = match search_artists(client, &title, 50).await {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!("artist suggestion search '{title}': {e}");
                continue;
            }
        };
        // Candidates are artists actually ANSWERING to this name (title or
        // alias), not high scorers: MB's relevance ranking puts famous
        // partial matches above obscure exact ones — a score bar on "Castro"
        // kept Cristian, Fidel, and Tommy Castro while cutting every artist
        // literally named Castro. And aliases matter as much as titles: a
        // renamed artist ("Hodgy Beats" → "Hodgy") answers through their
        // alias, and the canonical entity must not lose to a bare duplicate
        // that kept the old spelling as its title.
        let credible: Vec<&MbCandidateRow> =
            candidates.iter().filter(|c| c.name_match).collect();
        let (status, payload) = if (1..=4).contains(&credible.len()) {
            suggested += 1;
            (
                "pending",
                serde_json::json!({
                    "artist_id": artist_id,
                    "artist_name": title,
                    "candidates": credible,
                }),
            )
        } else {
            ("notfound", serde_json::json!({ "artist_id": artist_id, "artist_name": title }))
        };
        sqlx::query(
            "INSERT OR IGNORE INTO mb_suggestion (library_id, kind, target_key, payload, status)
             VALUES (?, 'artist_match', ?, ?, ?)",
        )
        .bind(library_id)
        .bind(artist_id.to_string())
        .bind(payload.to_string())
        .bind(status)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(suggested)
}

/// Backfill: albums matched before original-date adoption existed hold a
/// group id but no mb-tier release_date. Fetch each group once and adopt its
/// first-release-date; groups WITHOUT a date get an empty mb-tier marker so
/// they're never refetched. Transient failures skip silently and retry next
/// pass. One-time cost, rate-limited like every phase.
async fn backfill_group_dates(
    app: &AppHandle,
    pool: &SqlitePool,
    client: &reqwest::Client,
    library_id: &str,
) -> Result<(), String> {
    // Pre-tier matches: a group id but no MB-tier TITLE or no MB-tier DATE.
    // Both tests are tier-scoped — every album now carries a TAG-tier
    // release_date row, which the old untiered test mistook for "already
    // backfilled" and skipped the whole library. A standing suppression
    // (an undone adoption) excludes that field from the selection, since the
    // adoption below would refuse it and the album would be refetched on
    // every pass.
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT DISTINCT al.id, al.title, f.value FROM album al
         JOIN media_entry me ON me.id = al.id
         JOIN field_override f ON f.entity_id = al.id
              AND f.field = 'mb_release_group_id' AND f.value IS NOT NULL AND f.value <> ''
              AND f.tier IN ('user', 'mb')
         WHERE me.library_id = ?
           AND (
             (NOT EXISTS (SELECT 1 FROM field_override t
                          WHERE t.entity_id = al.id AND t.field = 'title' AND t.tier = 'mb')
              AND NOT EXISTS (SELECT 1 FROM mb_suppression s
                              WHERE s.kind = 'album_title' AND s.target_id = al.id))
             OR
             (NOT EXISTS (SELECT 1 FROM field_override d
                          WHERE d.entity_id = al.id AND d.field = 'release_date' AND d.tier = 'mb')
              AND NOT EXISTS (SELECT 1 FROM mb_suppression s
                              WHERE s.kind = 'album_year' AND s.target_id = al.id))
           )",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(());
    }
    let total = rows.len();
    for (i, (album_id, title, group_id)) in rows.into_iter().enumerate() {
        if CANCEL.load(Ordering::SeqCst) {
            break;
        }
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "libraryId": library_id, "phase": "dates", "done": i, "total": total, "name": title }),
        );
        let group = match fetch_release_group(client, &group_id).await {
            Ok(g) => g,
            Err(e) => {
                eprintln!("group date backfill '{title}': {e}");
                continue;
            }
        };
        let has_mb_date: bool = sqlx::query_as::<_, (i64,)>(
            "SELECT EXISTS(SELECT 1 FROM field_override
                           WHERE entity_id = ? AND field = 'release_date' AND tier = 'mb')",
        )
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?
        .0 != 0;
        let Some(g) = group else {
            // Group gone from MusicBrainz: empty markers stop the refetching;
            // the resolver treats an empty MB value as "has none".
            set_mb_id(pool, album_id, "title", "", TIER_MB).await?;
            if !has_mb_date {
                set_mb_id(pool, album_id, "release_date", "", TIER_MB).await?;
            }
            continue;
        };
        let batch = next_batch(pool).await?;
        // Matches made before the MB tier existed: store the group's title
        // and type, and adopt the title the way a fresh match does (the
        // guards inside skip a user edit or a suppression) — the tag title
        // a rescan put back is replaced right here, not at the next rescan.
        adopt_group_title(pool, library_id, album_id, &title, &g.title, batch).await?;
        if let Some(t) = &g.album_type {
            if !suppressed(pool, "album_type", album_id).await? {
                set_mb_id(pool, album_id, "album_type", t, TIER_MB).await?;
            }
        }
        if !has_mb_date {
            match &g.first_release_date {
                Some(date) => adopt_group_date(pool, library_id, album_id, &title, date, batch).await?,
                // Known dateless group: the empty marker stops refetching.
                None => set_mb_id(pool, album_id, "release_date", "", TIER_MB).await?,
            }
        }
        // Columns follow the tiers (type in particular has no adopt helper).
        crate::music_edit::reapply_album_overrides(pool, album_id).await?;
    }
    Ok(())
}

/// Backfill: pinned releases whose tracks predate title adoption. A pin
/// applies its per-track data ONCE, at pin time — nothing re-runs it on its
/// own. A track paired to its pin carries an MB-tier title; one that
/// doesn't, and isn't recorded as a gap at its slot, is a pin that ran under
/// an older build. Re-fetch the release once and re-apply with a fresh pin's
/// guards and history rows, then re-diff so the tracks that still can't
/// pair get their gap rows and drop out of this selection. Empties itself
/// after one pass (a dismissed warning re-qualifies its release — the same
/// "it returns on the next check" the Ignore button promises).
async fn backfill_pin_tracks(
    app: &AppHandle,
    pool: &SqlitePool,
    client: &reqwest::Client,
    library_id: &str,
) -> Result<(), String> {
    let rows: Vec<(i64, String, String, String)> = sqlx::query_as(
        "SELECT DISTINCT rm.album_id, al.title, rm.folder_path, rm.mb_release_id
         FROM release_match rm
         JOIN album al ON al.id = rm.album_id
         JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ? AND rm.mb_release_id <> ''
           AND NOT EXISTS (SELECT 1 FROM mb_suppression s
                           WHERE s.kind = 'track_titles' AND s.target_id = rm.album_id)
           AND EXISTS (SELECT 1 FROM track t
                       JOIN track_release tr ON tr.track_id = t.id
                       JOIN album_release ar ON ar.id = tr.release_id
                       WHERE ar.album_id = rm.album_id AND ar.folder_path = rm.folder_path
                         AND NOT EXISTS (SELECT 1 FROM field_override fo
                                         WHERE fo.entity_id = t.id
                                           AND fo.field = 'title' AND fo.tier = 'mb')
                         AND NOT EXISTS (SELECT 1 FROM album_match_gap g
                                         WHERE g.album_id = rm.album_id
                                           AND g.folder_path = rm.folder_path
                                           AND g.side = 'ours'
                                           AND g.disc = COALESCE(t.disc_number, 1)
                                           AND g.position = COALESCE(t.track_number, 0)))
         ORDER BY al.sort_title COLLATE NOCASE",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(());
    }
    let total = rows.len();
    for (i, (album_id, title, folder, mb_release_id)) in rows.into_iter().enumerate() {
        if CANCEL.load(Ordering::SeqCst) {
            break;
        }
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "libraryId": library_id, "phase": "titles", "done": i, "total": total, "name": title }),
        );
        // A staged album's tracks are about to be rewritten by the rescan
        // that applies its directive — leave it for the pass after.
        if crate::music_edit::is_staged_for_rescan(pool, album_id).await? {
            continue;
        }
        let full = match fetch_release(client, &mb_release_id).await {
            Ok(Some(f)) => f,
            Ok(None) => continue,
            Err(e) => {
                eprintln!("pin track backfill '{title}': {e}");
                continue;
            }
        };
        let credits_ok = !suppressed(pool, "track_credits", album_id).await?;
        let batch = next_batch(pool).await?;
        let changes = apply_release_credits(
            pool, album_id, &folder, &full.tracks, credits_ok, true, None, false,
        )
        .await?;
        log_track_changes(pool, library_id, album_id, &title, &changes, batch).await?;
        record_match_gaps(pool, album_id, &folder, &full.tracks).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Identity: MBID-proven merges
// ---------------------------------------------------------------------------

/// Two artist rows with the SAME MusicBrainz id are provably one person —
/// auto-merge (logged, undoable): the one with albums keeps the page, the
/// other's names become 'mb' aliases, its albums (if any) move over. The
/// survivor is then named what MusicBrainz names the entity (the title's MB
/// tier, recorded by whichever side got identified) — not "whichever page
/// had more albums" (user rule 2026-09-20; a manual rename still wins).
async fn merge_mbid_duplicates(pool: &SqlitePool, library_id: &str) -> Result<(), String> {
    let rows: Vec<(i64, String, String, i64)> = sqlx::query_as(
        "SELECT a.id, a.title, a.musicbrainz_id,
                (SELECT COUNT(*) FROM album_artist_credit c WHERE c.artist_id = a.id)
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
        // A shared placeholder id ([unknown] etc.) proves nothing — two
        // different mystery names are NOT the same artist.
        if is_placeholder_artist(&mbid) {
            continue;
        }
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
            // The canonical name, from whichever page recorded it — read
            // before the merge deletes the other page's rows.
            let mut canonical: Option<String> = None;
            for id in [keep_id, other_id] {
                let row: Option<(String,)> = sqlx::query_as(
                    "SELECT value FROM field_override
                     WHERE entity_id = ? AND field = 'title' AND tier = 'mb' AND value <> ''",
                )
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
                if let Some((v,)) = row {
                    canonical = Some(v);
                    break;
                }
            }
            merge_artists(pool, library_id, keep_id, &keep_title, Some(other_id), &other_title, "mb")
                .await?;
            if let Some(canon) = &canonical {
                adopt_mb_name(pool, library_id, keep_id, canon).await?;
            }
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
    // alias_source: who decided the absorbed names mean the survivor — 'mb'
    // for the same-id auto-merge, 'user' for every merge a person clicked.
    alias_source: &str,
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
        // Albums follow the merge through their CREDIT rows (repointed
        // below); the only children an artist still parents are its loose
        // containers, which move here so their tracks stay reachable.
        // (Pre-refactor undo payloads recorded albums in this same list —
        // the undo arm restores whatever ids it finds, either kind.)
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

    // The survivor answers to new names now — evidence that failed to prove
    // them under the old names deserves a fresh walk.
    sqlx::query("DELETE FROM mb_derive_exhausted WHERE entity_id = ?")
        .bind(keep_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(other_id) = other_id {
        // Persona links follow the merge; a link that would now point at
        // itself is meaningless and dropped.
        sqlx::query("UPDATE OR REPLACE artist_persona SET persona_id = ? WHERE persona_id = ?")
            .bind(keep_id)
            .bind(other_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE artist_persona SET parent_id = ? WHERE parent_id = ?")
            .bind(keep_id)
            .bind(other_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM artist_persona WHERE persona_id = parent_id")
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    for name in &aliases_added {
        sqlx::query("INSERT OR IGNORE INTO artist_alias (artist_id, name, source) VALUES (?, ?, ?)")
            .bind(keep_id)
            .bind(name)
            .bind(alias_source)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Credit rows stamped with the absorbed artist re-point to the survivor —
    // by id for what was stamped, then a full re-resolve for bare spellings
    // that only now redirect somewhere (name-only merges stamp NULL → keep).
    // Undo reverses this the same way: it moves the redirects back and
    // re-resolves, so the stamps follow.
    if let Some(other_id) = other_id {
        for table in ["track_credit", "album_artist_credit"] {
            sqlx::query(&format!("UPDATE {table} SET artist_id = ? WHERE artist_id = ?"))
                .bind(keep_id)
                .bind(other_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        // The absorbed page's own "Which artist is this?" card now asks about
        // an entity that no longer exists — settle it as obsolete so it
        // vanishes from review instead of erroring on apply.
        sqlx::query(
            "UPDATE mb_suggestion SET status = 'obsolete'
             WHERE library_id = ? AND kind = 'artist_match' AND target_key = ? AND status = 'pending'",
        )
        .bind(library_id)
        .bind(other_id.to_string())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    crate::music::resolve_credit_ids(pool, library_id).await?;

    let batch = next_batch(pool).await?;
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
            // Who merged: the undo arm reads this — undoing an AUTOMATIC
            // (same-id) merge leaves a standing "no" so the pass can't redo
            // it; undoing a merge a person clicked just puts the question
            // back (the identity card returns).
            "alias_source": alias_source,
        }),
        &serde_json::json!({ "keep_id": keep_id, "keep_title": keep_title }),
        batch,
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

// resolve_merge_suggestions_via_mbid is gone with the name lookup it relied
// on: "the lookalike name resolves to the same MBID" was a name search taking
// MusicBrainz's first exact match — the very uncertainty being retired.
// Lookalike suggestions now wait for the person; merge_mbid_duplicates still
// auto-merges pages whose STORED (credit-derived, certain) ids prove they're
// one artist.

// (The alias classification commands — misspelling / nickname cards under
// File problems — were retired 2026-09-20: an alias is one fact, "this
// spelling means that page", tiered by who wrote it. See artist_alias.source.)

// ---------------------------------------------------------------------------
// Identity clusters — the center's "Resolve identities" cards
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct ClusterMember {
    /// None = a bare credit spelling that never got its own page (the
    /// suggester withheld it as a lookalike of an existing artist).
    pub artist_id: Option<i64>,
    pub name: String,
    pub albums: i64,
    pub unmatched_albums: i64,
    pub tracks: i64,
    pub mbid: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IdentityCluster {
    /// The punctuation-blind key the members share — a stable list identity.
    pub key: String,
    /// Most-albums-first, so members[0] is the natural survivor default.
    pub members: Vec<ClusterMember>,
    /// Unmatched albums across the members: what resolving this identity
    /// unlocks for the next pass (arid-scoped searches once matched).
    pub unlocks: i64,
}

/// Live-computed identity clusters: artist pages (plus bare credit spellings)
/// whose names collapse to one punctuation-blind key — the SAME key the
/// pairwise lookalike suggester uses, so anything it would pair, this groups
/// into one card. Nothing is stored; the clusters reflect the current pages
/// on every call, and a standing "kept separate" rejection removes its member
/// for good (undoing the rejection from History brings it back).
#[tauri::command]
pub async fn mb_identity_clusters(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<Vec<IdentityCluster>, String> {
    let pool = &state.app_db;
    let vetoed: std::collections::HashSet<String> = sqlx::query_as::<_, (String,)>(
        "SELECT target_key FROM mb_suggestion
         WHERE library_id = ? AND kind = 'artist_merge' AND status = 'rejected'",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(k,)| k)
    .collect();

    // Ignored artists have left the machinery; they cluster with nobody.
    let artists: Vec<(i64, String, Option<String>, i64, i64, i64)> = sqlx::query_as(
        "SELECT a.id, a.title, a.musicbrainz_id,
                (SELECT COUNT(DISTINCT ac.album_id) FROM album_artist_credit ac
                 WHERE ac.artist_id = a.id),
                (SELECT COUNT(DISTINCT ac.album_id) FROM album_artist_credit ac
                 WHERE ac.artist_id = a.id
                   AND NOT EXISTS (SELECT 1 FROM field_override f
                                   WHERE f.entity_id = ac.album_id
                                     AND f.field = 'mb_release_group_id')
                   AND NOT EXISTS (SELECT 1 FROM field_override ig
                                   WHERE ig.entity_id = ac.album_id
                                     AND ig.field = 'mb_ignored')),
                (SELECT COUNT(*) FROM track_credit tc WHERE tc.artist_id = a.id)
         FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = a.id AND ig.field = 'mb_ignored')",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut by_key: std::collections::HashMap<String, Vec<ClusterMember>> =
        std::collections::HashMap::new();
    for (id, title, mbid, albums, unmatched, tracks) in artists {
        if vetoed.contains(&title.to_lowercase()) {
            continue;
        }
        let key = crate::music::credit_name_key(&title);
        if key.is_empty() {
            continue;
        }
        by_key.entry(key).or_default().push(ClusterMember {
            artist_id: Some(id),
            name: title,
            albums,
            unmatched_albums: unmatched,
            tracks,
            mbid: mbid.filter(|m| !m.is_empty()),
        });
    }

    // Pending pairwise suggestions carry two things the page walk can't see:
    // bare credit spellings (no page — they join their key's cluster as
    // page-less members), and alias-bridged page pairs whose TITLES key
    // differently (their key groups get unioned below).
    let pending: Vec<(String,)> = sqlx::query_as(
        "SELECT payload FROM mb_suggestion
         WHERE library_id = ? AND kind = 'artist_merge' AND status = 'pending'",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut unions: Vec<(String, String)> = Vec::new();
    for (payload,) in pending {
        let Ok(p) = serde_json::from_str::<serde_json::Value>(&payload) else { continue };
        let Some(other) = p["other_name"].as_str().filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        if vetoed.contains(&other.to_lowercase()) {
            continue;
        }
        let page: Option<(i64, String)> = sqlx::query_as(
            "SELECT a.id, a.title FROM artist_names an
             JOIN artist a ON a.id = an.artist_id
             JOIN media_entry me ON me.id = a.id
             WHERE me.library_id = ?1 AND LOWER(an.name) = LOWER(?2) LIMIT 1",
        )
        .bind(&library_id)
        .bind(other)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if let Some((_, other_title)) = page {
            // Both sides are pages. If their titles key apart (they pair only
            // through an alias), remember to union the two key groups.
            let keep_page: Option<(String,)> = match p["keep_id"].as_i64() {
                Some(keep_id) => sqlx::query_as("SELECT title FROM artist WHERE id = ?")
                    .bind(keep_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| e.to_string())?,
                None => None,
            };
            if let Some((keep_title,)) = keep_page {
                let ka = crate::music::credit_name_key(&keep_title);
                let kb = crate::music::credit_name_key(&other_title);
                if !ka.is_empty() && !kb.is_empty() && ka != kb {
                    unions.push((ka, kb));
                }
            }
            continue;
        }
        let key = crate::music::credit_name_key(other);
        if key.is_empty() {
            continue;
        }
        let entry = by_key.entry(key).or_default();
        if entry.iter().any(|m| m.name.eq_ignore_ascii_case(other)) {
            continue;
        }
        let (tracks,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM track_credit tc
             JOIN media_entry me ON me.id = tc.track_id
             WHERE me.library_id = ?1 AND LOWER(tc.name) = LOWER(?2)",
        )
        .bind(&library_id)
        .bind(other)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        let (albums,): (i64,) = sqlx::query_as(
            "SELECT COUNT(DISTINCT ac.album_id) FROM album_artist_credit ac
             JOIN media_entry me ON me.id = ac.album_id
             WHERE me.library_id = ?1 AND LOWER(ac.name) = LOWER(?2)",
        )
        .bind(&library_id)
        .bind(other)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        entry.push(ClusterMember {
            artist_id: None,
            name: other.to_string(),
            albums,
            unmatched_albums: 0,
            tracks,
            mbid: None,
        });
    }
    for (ka, kb) in unions {
        if let Some(mut moved) = by_key.remove(&kb) {
            by_key.entry(ka).or_default().append(&mut moved);
        }
    }

    let mut clusters: Vec<IdentityCluster> = by_key
        .into_iter()
        .filter(|(_, m)| m.len() >= 2)
        .map(|(key, mut members)| {
            members.sort_by(|a, b| {
                b.albums.cmp(&a.albums).then(b.tracks.cmp(&a.tracks))
            });
            let unlocks = members.iter().map(|m| m.unmatched_albums).sum();
            IdentityCluster { key, members, unlocks }
        })
        .collect();
    clusters.sort_by(|a, b| {
        b.unlocks
            .cmp(&a.unlocks)
            .then(b.members.len().cmp(&a.members.len()))
            .then(a.key.cmp(&b.key))
    });
    Ok(clusters)
}

/// Collapse a cluster into its chosen survivor: every listed page merges in
/// (albums, credits, aliases, persona links follow — merge_artists does the
/// work and logs each one undoably), every listed bare spelling becomes an
/// alias. The caller then optionally matches the survivor to MusicBrainz via
/// the ordinary mb_apply_entity_match — which adopts the canonical name, so
/// which spelling "survives" here stops mattering.
#[tauri::command]
pub async fn mb_resolve_cluster(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    survivor_id: i64,
    merge_artist_ids: Vec<i64>,
    merge_names: Vec<String>,
) -> Result<(), String> {
    ensure_not_matching(&state.app_db, &library_id).await?;
    let pool = &state.app_db;
    crate::music_edit::ensure_not_staged(pool, survivor_id).await?;
    for id in &merge_artist_ids {
        if *id != survivor_id {
            crate::music_edit::ensure_not_staged(pool, *id).await?;
        }
    }
    let survivor: Option<(String,)> = sqlx::query_as(
        "SELECT a.title FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE a.id = ? AND me.library_id = ?",
    )
    .bind(survivor_id)
    .bind(&library_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (survivor_title,) = survivor.ok_or("Surviving artist not found")?;

    let mut merged = 0usize;
    let mut last_name = String::new();
    for id in merge_artist_ids {
        if id == survivor_id {
            continue;
        }
        // A member can be gone by now (absorbed moments ago via another
        // spelling) — skip rather than fail the rest of the cluster.
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT a.title FROM artist a JOIN media_entry me ON me.id = a.id
             WHERE a.id = ? AND me.library_id = ?",
        )
        .bind(id)
        .bind(&library_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        let Some((title,)) = row else { continue };
        merge_artists(pool, &library_id, survivor_id, &survivor_title, Some(id), &title, "user").await?;
        merged += 1;
        last_name = title;
    }
    for name in merge_names {
        let name = name.trim().to_string();
        if name.is_empty() {
            continue;
        }
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
        if source_id == Some(survivor_id) {
            continue; // already answers to the survivor
        }
        merge_artists(pool, &library_id, survivor_id, &survivor_title, source_id, &name, "user").await?;
        merged += 1;
        last_name = name;
    }
    if merged > 0 {
        let desc = if merged == 1 {
            last_name
        } else {
            format!("{merged} spellings")
        };
        enqueue_pass_recheck(pool, &library_id, survivor_id, &survivor_title, &desc, merged == 1).await?;
    }
    let _ = app.emit(
        "music-enrich-done",
        serde_json::json!({ "libraryId": library_id, "updated": 0, "albumsMatched": 0, "processed": 0, "pendingReview": 0 }),
    );
    Ok(())
}

/// Eject a name from its cluster: a standing "this is NOT the same artist".
/// Writes the same rejected suggestion row a pairwise "Keep separate" click
/// left, so the veto is honored everywhere the old ones were (cluster build,
/// lookalike sweep, auto-merge) and History-undo returns the member. A name
/// with no page of its own (the scanner withheld one as a lookalike) GETS
/// one here — "different artists" has to mean the spelling becomes an
/// artist, not just that the question stops (user ruling 2026-09-20); its
/// credits re-stamp to the new page by exact name, ahead of the
/// punctuation-blind fallback that pointed them at the lookalike.
#[tauri::command]
pub async fn mb_keep_separate(
    state: State<'_, AppState>,
    library_id: String,
    name: String,
) -> Result<(), String> {
    ensure_not_matching(&state.app_db, &library_id).await?;
    let pool = &state.app_db;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("No name given".to_string());
    }
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT an.artist_id FROM artist_names an
         JOIN media_entry me ON me.id = an.artist_id
         WHERE me.library_id = ?1 AND LOWER(an.name) = LOWER(?2) LIMIT 1",
    )
    .bind(&library_id)
    .bind(&name)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut created_id: Option<i64> = None;
    if existing.is_none() {
        let artist = crate::music::ScannedArtist {
            title: name.clone(),
            albums: Vec::new(),
            loose: Vec::new(),
        };
        let order = crate::music::next_artist_order(pool, &library_id).await?;
        let id = crate::music::insert_artist_row(
            pool,
            &library_id,
            std::path::Path::new(""),
            &artist,
            order,
        )
        .await?;
        created_id = Some(id);
    }
    // Payload keeps other_name so an undone rejection (status back to
    // pending) re-enters the cluster build even when the sweep never wrote
    // a payload of its own for this name.
    sqlx::query(
        "INSERT INTO mb_suggestion (library_id, kind, target_key, payload, status)
         VALUES (?1, 'artist_merge', LOWER(?2), ?3, 'rejected')
         ON CONFLICT(library_id, kind, target_key) DO UPDATE SET status = 'rejected'",
    )
    .bind(&library_id)
    .bind(&name)
    .bind(serde_json::json!({ "other_name": name }).to_string())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (suggestion_id,): (i64,) = sqlx::query_as(
        "SELECT id FROM mb_suggestion
         WHERE library_id = ? AND kind = 'artist_merge' AND target_key = LOWER(?)",
    )
    .bind(&library_id)
    .bind(&name)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let target_id = created_id.or(existing.map(|(id,)| id)).unwrap_or(0);
    let batch = next_batch(pool).await?;
    log_change(
        pool,
        &library_id,
        "suggestion_rejected",
        target_id,
        &format!(
            "\u{201c}{name}\u{201d} kept separate{}",
            if created_id.is_some() { " — its own artist now" } else { "" }
        ),
        &serde_json::json!({ "suggestion_id": suggestion_id, "created_artist_id": created_id }),
        &serde_json::json!({ "status": "rejected" }),
        batch,
    )
    .await?;
    if created_id.is_some() {
        // The new page answers to its exact name now — credits carrying it
        // move over from the lookalike the fallback had pointed them at.
        crate::music::resolve_credit_ids(pool, &library_id).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Review commands (the metadata center)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct MbSuggestionView {
    pub id: i64,
    pub kind: String,
    pub payload: serde_json::Value,
}

/// Every album the matcher is responsible for, with where it stands. One
/// query, one list — the header tallies THIS rather than counting stamps
/// separately, so the summary can never disagree with what's below it.
#[derive(Debug, Serialize)]
pub struct MbAlbumRow {
    pub album_id: i64,
    pub title: String,
    pub artist_title: Option<String>,
    /// "release"   — matched to a specific release; track lists comparable
    /// "album"     — release group only; knows the album, not the pressing
    /// "notfound"  — searched, nothing found
    /// "unchecked" — never examined
    pub state: String,
    pub gap_ours: i64,
    pub gap_mb: i64,
    /// Every credited artist's entry id (albums have no artist parent) — the
    /// library map hangs the album's chip under each of these rows. Empty for
    /// credit-less albums.
    pub artist_ids: Vec<i64>,
    /// User said "stop counting this": excluded from passes and warn counts,
    /// gray on the map.
    pub ignored: bool,
    /// User declared this album deliberately partial — mb-side track gaps
    /// (release tracks the library doesn't hold) are expected: they stop
    /// counting and stop surfacing in Track lists differ.
    pub partial: bool,
    /// Version counts: `state == "release"` requires EVERY release resolved
    /// (pinned or declared-none); the map renders resolved/releases on
    /// multi-version cards so a half-pinned card can't read as done.
    pub releases: i64,
    pub resolved_releases: i64,
    /// The first release still lacking a pin or a declared-none row (default
    /// first) — where the row's link into the album page should land so
    /// "pick a release" opens on the release that needs picking. None when
    /// every release is resolved.
    pub focus_release_id: Option<i64>,
}

/// Artists and where they stand. An artist's MusicBrainz id only ever comes
/// from the credit of a matched album (certain) or the user's own decision —
/// never from a name search — so "unidentified" here means "no matched album
/// vouches for them yet".
#[derive(Debug, Serialize)]
pub struct MbArtistRow {
    pub artist_id: i64,
    pub title: String,
    /// "matched" | "notfound" | "unchecked"
    pub state: String,
    pub album_count: i64,
    /// User said "stop counting this": excluded from passes and warn counts,
    /// gray on the map.
    pub ignored: bool,
}

#[derive(Debug, Serialize)]
pub struct MbGapRow {
    /// 'ours' — in the library; 'mb' — on the MusicBrainz release.
    pub side: String,
    pub disc: i64,
    pub position: i64,
    pub title: String,
    /// MB's title at the same disc/track, when the slot exists on both sides
    /// but the pairing failed. None = the other side has nothing there.
    pub counterpart: Option<String>,
    /// The diff's release folder — what Accept needs to name the slot.
    pub folder_path: String,
    /// Which witness failed at a shared slot. Both = probably a different
    /// song (no Accept); either alone = a person can accept MB's track.
    pub title_off: bool,
    pub length_off: bool,
}

#[derive(Debug, Serialize)]
pub struct MbGapAlbum {
    pub album_id: i64,
    pub title: String,
    pub artist_title: Option<String>,
    /// Which release of the album this diff is for — the release's label,
    /// when the card holds more than one. None = single-release album.
    pub release_label: Option<String>,
    /// The release row the diff is for — the album page opens onto it.
    pub release_id: Option<i64>,
    pub rows: Vec<MbGapRow>,
}

/// One ACTION in the change list — a match, a merge — however many rows it
/// wrote. `id` is the batch, and undoing it reverts the whole action.
#[derive(Debug, Serialize)]
pub struct MbChangeView {
    pub id: i64,
    pub kind: String,
    pub label: String,
    pub undone: bool,
    pub created_at: String,
    pub change_count: i64,
    pub kinds: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MbReview {
    pub suggestions: Vec<MbSuggestionView>,
    pub albums: Vec<MbAlbumRow>,
    pub artists: Vec<MbArtistRow>,
    pub gaps: Vec<MbGapAlbum>,
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
    let mut suggestions: Vec<MbSuggestionView> = suggestion_rows
        .into_iter()
        .map(|(id, kind, payload)| MbSuggestionView {
            id,
            kind,
            payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        })
        .collect();
    // A suggestion whose subject entity was deleted (keep-artist swept as an
    // orphan, album dissolved by a combine) is unanswerable — purge it here
    // rather than render a card pointing at a ghost. Read time is the one
    // chokepoint every deletion path funnels through.
    let mut dead: Vec<i64> = Vec::new();
    for s in suggestions.iter() {
        let subject = match s.kind.as_str() {
            "artist_merge" => s.payload["keep_id"].as_i64(),
            "artist_match" | "artist_split" => s.payload["artist_id"].as_i64(),
            "album_match" => s.payload["album_id"].as_i64(),
            _ => None,
        };
        let Some(id) = subject else { continue };
        let alive: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM media_entry WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
        if alive.is_none() {
            dead.push(s.id);
        }
    }
    if !dead.is_empty() {
        for id in &dead {
            sqlx::query("DELETE FROM mb_suggestion WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        suggestions.retain(|s| !dead.contains(&s.id));
    }
    // "Which artist is this?" cards get an "In your library:" line — WHERE the
    // artist is credited, which is what jogs the memory for a feature-only
    // name nobody recognizes cold. Computed at read time, not stored: the
    // stored payload froze at suggestion time, but the library moves.
    // Uncertain album matches get the LIBRARY side of the question: how many
    // tracks and versions the album actually holds. A fused album (two bodies
    // of work sharing one tag pair — So Far Gone mixtape + EP) is exactly the
    // case where the candidates can't be told apart without it. Computed at
    // read time like the artist line below — the library moves.
    for s in suggestions.iter_mut() {
        if s.kind != "album_match" {
            continue;
        }
        let Some(album_id) = s.payload["album_id"].as_i64() else { continue };
        let (tracks, versions): (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM media_entry me
                     JOIN track t ON t.id = me.id WHERE me.parent_id = ?1),
                    (SELECT COUNT(*) FROM album_release WHERE album_id = ?1)",
        )
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        s.payload["library_tracks"] = serde_json::json!(tracks);
        s.payload["library_versions"] = serde_json::json!(versions);
        // Per-version track counts (default first): "7 + 18 tracks across 2
        // versions" pairs by eye with an EP and an album on the card, which
        // is the fused-album tell made legible.
        if versions > 1 {
            let per: Vec<(i64,)> = sqlx::query_as(
                "SELECT (SELECT COUNT(*) FROM track_release tr WHERE tr.release_id = ar.id)
                 FROM album_release ar WHERE ar.album_id = ?
                 ORDER BY ar.is_default DESC, ar.id ASC",
            )
            .bind(album_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
            s.payload["library_version_tracks"] =
                serde_json::json!(per.into_iter().map(|(n,)| n).collect::<Vec<i64>>());
        }
    }
    for s in suggestions.iter_mut() {
        if s.kind != "artist_match" {
            continue;
        }
        let Some(artist_id) = s.payload["artist_id"].as_i64() else { continue };
        // Their own / jointly-credited albums (loose containers have empty
        // titles and aren't albums to a reader). Each carries the album's
        // matched release-group id when there is one, so the card can link
        // straight to the MB page — drill to a release there, find the track,
        // compare its credited artist against the candidate.
        let albums: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT al.title,
                    (SELECT f.value FROM field_override f
                     WHERE f.entity_id = al.id AND f.field = 'mb_release_group_id'
                     ORDER BY CASE f.tier WHEN 'user' THEN 0 ELSE 1 END LIMIT 1)
             FROM album_artist_credit ac
             JOIN album al ON al.id = ac.album_id
             WHERE ac.artist_id = ? AND al.title <> ''
             ORDER BY al.id",
        )
        .bind(artist_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        // Tracks crediting them, with the album for context (empty = loose).
        let tracks: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT t.title, COALESCE(al.title, ''),
                    (SELECT f.value FROM field_override f
                     WHERE f.entity_id = me.parent_id AND f.field = 'mb_release_group_id'
                     ORDER BY CASE f.tier WHEN 'user' THEN 0 ELSE 1 END LIMIT 1)
             FROM track_credit tc
             JOIN track t ON t.id = tc.track_id
             JOIN media_entry me ON me.id = tc.track_id
             LEFT JOIN album al ON al.id = me.parent_id
             WHERE tc.artist_id = ?
             ORDER BY t.id",
        )
        .bind(artist_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        let total = albums.len() + tracks.len();
        let appearances: Vec<serde_json::Value> = albums
            .into_iter()
            .map(|(al, gid)| serde_json::json!({ "album": al, "group_id": gid }))
            .chain(tracks.into_iter().map(|(t, al, gid)| {
                serde_json::json!({
                    "track": t,
                    "album": if al.is_empty() { serde_json::Value::Null } else { al.into() },
                    "group_id": gid,
                })
            }))
            .take(3)
            .collect();
        s.payload["appearances"] = serde_json::json!(appearances);
        s.payload["appearance_count"] = serde_json::json!(total);
    }

    // Eligibility matches the pass exactly — loose tracks and sounds are not
    // albums it will ever look at, so they must not appear in a total either.
    // State comes from what is KNOWN (which id is stored), not from the
    // stamp: a stamp says a pass finished, an id says what it found.
    // Credit rows first: the display title (every credited name, in order)
    // and the map's multi-artist grouping both come from them.
    let credit_rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT ac.album_id, ac.name, ac.artist_id FROM album_artist_credit ac
         JOIN media_entry me ON me.id = ac.album_id
         WHERE me.library_id = ?
         ORDER BY ac.album_id, ac.position",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credit_names: HashMap<i64, Vec<String>> = HashMap::new();
    let mut credit_ids: HashMap<i64, Vec<i64>> = HashMap::new();
    for (album_id, name, artist_id) in credit_rows {
        credit_names.entry(album_id).or_default().push(name);
        if let Some(aid) = artist_id {
            let ids = credit_ids.entry(album_id).or_default();
            if !ids.contains(&aid) {
                ids.push(aid);
            }
        }
    }

    let album_rows: Vec<(i64, String, String, i64, i64, i64, i64, i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT al.id, al.title,
                CASE
                  -- 'release' means the WHOLE card is resolved: every version
                  -- carries a release_match row (a pin, or the declared-none
                  -- sentinel). A half-pinned multi-version card stays 'album'
                  -- so the map can't round it up to green.
                  WHEN EXISTS (SELECT 1 FROM release_match rm
                               WHERE rm.album_id = al.id)
                       AND NOT EXISTS (SELECT 1 FROM album_release ar
                                       WHERE ar.album_id = al.id
                                         AND NOT EXISTS (SELECT 1 FROM release_match rm2
                                                         WHERE rm2.album_id = al.id
                                                           AND rm2.folder_path = ar.folder_path COLLATE NOCASE)) THEN 'release'
                  WHEN EXISTS (SELECT 1 FROM release_match rm
                               WHERE rm.album_id = al.id) THEN 'album'
                  WHEN EXISTS (SELECT 1 FROM field_override o
                               WHERE o.entity_id = al.id AND o.field = 'mb_release_group_id'
                                 AND o.value IS NOT NULL AND o.value <> '') THEN 'album'
                  WHEN EXISTS (SELECT 1 FROM mb_credit_fetch f
                               WHERE f.album_id = al.id) THEN 'notfound'
                  ELSE 'unchecked'
                END,
                (SELECT COUNT(*) FROM album_release ar WHERE ar.album_id = al.id),
                (SELECT COUNT(*) FROM album_release ar WHERE ar.album_id = al.id
                   AND EXISTS (SELECT 1 FROM release_match rm3
                               WHERE rm3.album_id = al.id
                                 AND rm3.folder_path = ar.folder_path COLLATE NOCASE)),
                COALESCE((SELECT SUM(side = 'ours') FROM album_match_gap g WHERE g.album_id = al.id), 0),
                -- A declared-partial album EXPECTS mb-side gaps (tracks the
                -- release has, the library deliberately doesn't) — they stop
                -- counting. Ours-side rows still count: real disagreements.
                CASE WHEN EXISTS (SELECT 1 FROM field_override pt
                                  WHERE pt.entity_id = al.id AND pt.field = 'mb_partial')
                     THEN 0
                     ELSE COALESCE((SELECT SUM(side = 'mb') FROM album_match_gap g WHERE g.album_id = al.id), 0)
                END,
                EXISTS (SELECT 1 FROM field_override ig
                        WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored'),
                EXISTS (SELECT 1 FROM field_override pt
                        WHERE pt.entity_id = al.id AND pt.field = 'mb_partial'),
                (SELECT ar.id FROM album_release ar WHERE ar.album_id = al.id
                   AND NOT EXISTS (SELECT 1 FROM release_match rm4
                                   WHERE rm4.album_id = al.id
                                     AND rm4.folder_path = ar.folder_path COLLATE NOCASE)
                 ORDER BY ar.is_default DESC, ar.id LIMIT 1)
         FROM album al
         JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
         ORDER BY al.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let albums = album_rows
        .into_iter()
        .map(
            |(album_id, title, state, releases, resolved_releases, gap_ours, gap_mb, ignored, partial, focus_release_id)| {
                MbAlbumRow {
                    album_id,
                    title,
                    artist_title: credit_names
                        .remove(&album_id)
                        .map(|names| names.join(" · "))
                        .filter(|s| !s.is_empty()),
                    state,
                    gap_ours,
                    gap_mb,
                    artist_ids: credit_ids.remove(&album_id).unwrap_or_default(),
                    ignored: ignored != 0,
                    partial: partial != 0,
                    releases,
                    resolved_releases,
                    focus_release_id,
                }
            },
        )
        .collect();

    // An artist identified before ids were stored durably still carries one on
    // its own row, so the fallback keeps this list agreeing with the dialog.
    let artist_rows: Vec<(i64, String, String, i64, i64)> = sqlx::query_as(
        "SELECT a.id, a.title,
                CASE
                  WHEN EXISTS (SELECT 1 FROM field_override o
                               WHERE o.entity_id = a.id AND o.field = 'mb_artist_id'
                                 AND o.value IS NOT NULL AND o.value <> '') THEN 'matched'
                  WHEN a.musicbrainz_id IS NOT NULL AND a.musicbrainz_id <> '' THEN 'matched'
                  WHEN EXISTS (SELECT 1 FROM mb_artist_lookup l
                               WHERE l.name = LOWER(a.title) AND l.status = 'notfound') THEN 'notfound'
                  ELSE 'unchecked'
                END,
                (SELECT COUNT(*) FROM album_artist_credit ac WHERE ac.artist_id = a.id)
                  + (SELECT COUNT(*) FROM media_entry ame WHERE ame.parent_id = a.id),
                EXISTS (SELECT 1 FROM field_override ig
                        WHERE ig.entity_id = a.id AND ig.field = 'mb_ignored')
         FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?
         ORDER BY a.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let artists = artist_rows
        .into_iter()
        .map(|(artist_id, title, state, album_count, ignored)| MbArtistRow {
            artist_id,
            title,
            state,
            album_count,
            ignored: ignored != 0,
        })
        .collect();

    let gap_rows: Vec<(
        i64,
        String,
        Option<String>,
        String,
        i64,
        i64,
        String,
        Option<String>,
        String,
        i64,
        Option<i64>,
        Option<String>,
    )> = sqlx::query_as(
            "SELECT al.id, al.title,
                    (SELECT ac.name FROM album_artist_credit ac
                     WHERE ac.album_id = al.id ORDER BY ac.position LIMIT 1),
                    g.side, g.disc, g.position, g.title, g.counterpart, g.folder_path, g.length_off,
                    (SELECT ar3.id FROM album_release ar3
                     WHERE ar3.album_id = al.id AND ar3.folder_path = g.folder_path),
                    -- The diff's release label — shown when the card holds
                    -- several releases, each with its own comparison.
                    CASE WHEN (SELECT COUNT(*) FROM album_release ar2
                               WHERE ar2.album_id = al.id) > 1
                         THEN (SELECT COALESCE(ar.label, 'Original')
                               FROM album_release ar
                               WHERE ar.album_id = al.id
                                 AND ar.folder_path = g.folder_path)
                         ELSE NULL
                    END
             FROM album_match_gap g
             JOIN album al ON al.id = g.album_id
             JOIN media_entry me ON me.id = al.id
             WHERE me.library_id = ?
               -- Declared-partial albums: missing (mb-side) tracks are
               -- expected and don't surface; ours-side rows still do.
               AND NOT (g.side = 'mb'
                        AND EXISTS (SELECT 1 FROM field_override pt
                                    WHERE pt.entity_id = al.id AND pt.field = 'mb_partial'))
             ORDER BY al.sort_title COLLATE NOCASE, g.folder_path, g.side, g.disc, g.position",
        )
        .bind(&library_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut gaps: Vec<MbGapAlbum> = Vec::new();
    for (
        album_id,
        title,
        artist_title,
        side,
        disc,
        position,
        gap_title,
        counterpart,
        folder_path,
        length_off,
        release_id,
        release_label,
    ) in gap_rows
    {
        // One card per (album, release): a multi-version card can hold a
        // clean box set AND a mismatched remaster at once.
        if gaps.last().map(|g| (g.album_id, g.release_label.clone()))
            != Some((album_id, release_label.clone()))
        {
            gaps.push(MbGapAlbum {
                album_id,
                title,
                artist_title,
                release_label,
                release_id,
                rows: Vec::new(),
            });
        }
        let title_off = counterpart
            .as_deref()
            .map(|c| !raw_titles_match(&gap_title, c))
            .unwrap_or(false);
        gaps.last_mut().unwrap().rows.push(MbGapRow {
            side,
            disc,
            position,
            title: gap_title,
            counterpart,
            folder_path,
            title_off,
            length_off: length_off != 0,
        });
    }

    // One row per ACTION. A batch's rows share a target and were written
    // together; the newest row supplies the label, and a batch counts as
    // undone only when every row in it is.
    let change_rows: Vec<(i64, String, String, i64, String, i64, String)> = sqlx::query_as(
        "WITH b AS (
            SELECT id, kind, label, undone, created_at, COALESCE(batch_id, id) AS batch
            FROM mb_change_log WHERE library_id = ?
         ),
         agg AS (
            SELECT batch, MIN(undone) AS undone, MAX(created_at) AS created_at,
                   COUNT(*) AS n, GROUP_CONCAT(DISTINCT kind) AS kinds, MAX(id) AS last_id
            FROM b GROUP BY batch
         )
         SELECT agg.batch, b.kind, b.label, agg.undone, agg.created_at, agg.n, agg.kinds
         FROM agg JOIN b ON b.id = agg.last_id
         ORDER BY agg.batch DESC LIMIT 300",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let changes = change_rows
        .into_iter()
        .map(|(id, kind, label, undone, created_at, change_count, kinds)| MbChangeView {
            id,
            kind,
            label,
            undone: undone != 0,
            created_at,
            change_count,
            kinds: kinds.split(',').map(|s| s.trim().to_string()).collect(),
        })
        .collect();

    Ok(MbReview { suggestions, albums, artists, gaps, changes })
}

/// Undo an ACTION: every row the batch wrote, newest first so each undo
/// restores the state the one before it saw. What the review list calls.
#[tauri::command]
pub async fn mb_undo_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    batch_id: i64,
) -> Result<(), String> {
    ensure_not_matching(&state.app_db, &library_id).await?;
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT id FROM mb_change_log
         WHERE library_id = ? AND COALESCE(batch_id, id) = ? AND undone = 0
         ORDER BY id DESC",
    )
    .bind(&library_id)
    .bind(batch_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    for (id,) in rows {
        mb_undo_change(app.clone(), state.clone(), library_id.clone(), id).await?;
    }
    Ok(())
}

/// Re-compare a matched album against its release(s) — after retagging and a
/// rescan, this is what clears the warning (or shows what's still off).
/// Per-release matches: every matched release re-diffs; counts are summed.
#[tauri::command]
pub async fn mb_recheck_album(
    state: State<'_, AppState>,
    album_id: i64,
) -> Result<MbGapCounts, String> {
    let pool = &state.app_db;
    let matches: Vec<(String, String)> = sqlx::query_as(
        "SELECT folder_path, mb_release_id FROM release_match
         WHERE album_id = ? AND mb_release_id <> ''",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if matches.is_empty() {
        return Err("this album isn't matched to a MusicBrainz release".to_string());
    }
    let client = mb_client()?;
    let (library_id, album_title): (String, String) = sqlx::query_as(
        "SELECT me.library_id, a.title FROM album a JOIN media_entry me ON me.id = a.id WHERE a.id = ?",
    )
    .bind(album_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let credits_ok = !suppressed(pool, "track_credits", album_id).await?;
    let titles_ok = !suppressed(pool, "track_titles", album_id).await?;
    let mut totals = MbGapCounts { ours: 0, mb: 0 };
    let mut recredited: Vec<i64> = Vec::new();
    for (folder, mb_release_id) in matches {
        let full = fetch_release(&client, &mb_release_id)
            .await?
            .ok_or_else(|| "release has no usable track data".to_string())?;
        let counts = record_match_gaps(pool, album_id, &folder, &full.tracks).await?;
        totals.ours += counts.ours;
        totals.mb += counts.mb;
        // The pin's per-track data is applied again as well, with a fresh
        // pin's guards and history rows — this is how a pin made before
        // title adoption existed (or a track retitled to pair since) picks
        // up MusicBrainz's titles and credits.
        let batch = next_batch(pool).await?;
        let changes = apply_release_credits(
            pool, album_id, &folder, &full.tracks, credits_ok, titles_ok, None, false,
        )
        .await?;
        log_track_changes(pool, &library_id, album_id, &album_title, &changes, batch).await?;
        recredited.extend(changes.credits.iter().map(|(id, _, _)| *id));
    }
    // Rewritten credit rows carry no artist stamp until the resolver runs
    // (pages for new names, then ids on every row) — without this they'd
    // surface as "credits without an artist" for names that resolve fine.
    crate::music::ensure_credit_artists(pool, &library_id).await?;
    // New credits on a matched album are evidence the next pass can walk
    // for artist ids — the same queue row a pin or a credit edit arms.
    for track_id in recredited {
        enqueue_track_credit_recheck(pool, &library_id, track_id).await?;
    }
    Ok(totals)
}

/// The differ page's Accept: a person confirmed that the track at this slot
/// IS MusicBrainz's track there, even though the automatic check couldn't
/// pair them (a title too different, or a length outside the window).
/// Applies the pin's data for that one track — title, position, credits,
/// with the usual guards and history rows — and clears its gap row.
#[tauri::command]
pub async fn mb_accept_track(
    state: State<'_, AppState>,
    album_id: i64,
    folder_path: String,
    disc: i64,
    position: i64,
) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, album_id).await?;
    accept_slots(&state.app_db, album_id, &folder_path, &[(disc, position)]).await
}

/// The card's "Accept all": every pairable slot on one release in a single
/// go — one release fetch, one history batch, one resolver pass.
#[tauri::command]
pub async fn mb_accept_tracks(
    state: State<'_, AppState>,
    album_id: i64,
    folder_path: String,
    slots: Vec<(i64, i64)>,
) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, album_id).await?;
    accept_slots(&state.app_db, album_id, &folder_path, &slots).await
}

async fn accept_slots(
    pool: &SqlitePool,
    album_id: i64,
    folder_path: &str,
    slots: &[(i64, i64)],
) -> Result<(), String> {
    if slots.is_empty() {
        return Ok(());
    }
    crate::music_edit::ensure_not_staged(pool, album_id).await?;
    let mb_release_id = release_match_of(pool, album_id, folder_path)
        .await?
        .map(|(v, _)| v)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "this release isn't matched to a MusicBrainz release".to_string())?;
    // Resolve every slot to its track first, so a stale slot fails the whole
    // request before anything is written.
    let mut track_ids = Vec::with_capacity(slots.len());
    for &(disc, position) in slots {
        let track_id: i64 = sqlx::query_as::<_, (i64,)>(
            "SELECT t.id FROM track t
             JOIN track_release tr ON tr.track_id = t.id
             JOIN album_release ar ON ar.id = tr.release_id
             WHERE ar.album_id = ? AND ar.folder_path = ?
               AND COALESCE(t.disc_number, 1) = ? AND COALESCE(t.track_number, 0) = ?
             LIMIT 1",
        )
        .bind(album_id)
        .bind(folder_path)
        .bind(disc)
        .bind(position)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .map(|(id,)| id)
        .ok_or_else(|| "no track at that position anymore — re-check the album".to_string())?;
        track_ids.push(track_id);
    }
    let client = mb_client()?;
    let full = fetch_release(&client, &mb_release_id)
        .await?
        .ok_or_else(|| "release has no usable track data".to_string())?;
    let (library_id, album_title): (String, String) = sqlx::query_as(
        "SELECT me.library_id, a.title FROM album a JOIN media_entry me ON me.id = a.id WHERE a.id = ?",
    )
    .bind(album_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let credits_ok = !suppressed(pool, "track_credits", album_id).await?;
    let titles_ok = !suppressed(pool, "track_titles", album_id).await?;
    let batch = next_batch(pool).await?;
    let mut recredited = Vec::new();
    for (&(disc, position), &track_id) in slots.iter().zip(&track_ids) {
        let changes = apply_release_credits(
            pool, album_id, folder_path, &full.tracks, credits_ok, titles_ok, Some(track_id), true,
        )
        .await?;
        log_track_changes(pool, &library_id, album_id, &album_title, &changes, batch).await?;
        if !changes.credits.is_empty() {
            recredited.push(track_id);
        }
        sqlx::query(
            "DELETE FROM album_match_gap
             WHERE album_id = ? AND folder_path = ? AND side = 'ours' AND disc = ? AND position = ?",
        )
        .bind(album_id)
        .bind(folder_path)
        .bind(disc)
        .bind(position)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    // Stamp the rewritten credit rows (see mb_recheck_album), then queue the
    // tracks for the next pass when credits changed: the pin is evidence a
    // pass can prove the newly credited artists from.
    crate::music::ensure_credit_artists(pool, &library_id).await?;
    for track_id in recredited {
        enqueue_track_credit_recheck(pool, &library_id, track_id).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-entity matching (album / artist / track)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct CreditedArtist {
    pub name: String,
    pub mbid: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MbStatus {
    /// "album" | "artist" | "track"
    pub kind: String,
    pub entity_id: i64,
    /// The owning library — lets the dialog open the metadata center.
    pub library_id: String,
    pub title: String,
    /// The owning artist / album, when there is one — disambiguates a search.
    pub context: Option<String>,
    /// Albums only: the first MATCHED credited artist's MusicBrainz id. When
    /// present the dialog browses that artist's release groups instead of
    /// text-searching all of MusicBrainz.
    pub context_mbid: Option<String>,
    /// Albums only: every credited artist in credit order, with the MB id of
    /// each that is identified. Two or more identified = the dialog offers a
    /// chip per artist plus "All" (the union of their discographies) — a
    /// joint album can be filed under either member, or under a joint MB
    /// artist neither page lists.
    pub credited_artists: Vec<CreditedArtist>,
    pub mbid: Option<String>,
    /// 'user' | 'mb' — who decided. None when unmatched.
    pub tier: Option<String>,
    /// Albums only: release group, which survives even when the exact release
    /// isn't known.
    pub release_group_id: Option<String>,
    /// Albums only: how many tracks disagree with the matched release. Split
    /// by side, because one song missing from both directions is ONE problem,
    /// not two — summing them double-counts.
    pub gap_count: i64,
    pub gap_ours: i64,
    pub gap_mb: i64,
    /// The automatic pass looked and found nothing.
    pub searched_not_found: bool,
    /// User said "stop counting this" — the dialog names the state instead
    /// of reading as merely unmatched.
    pub ignored: bool,
    /// A staged rescan action (split/combine) will dissolve this entity —
    /// the dialog shows the state and hides every mutating control.
    pub staged: bool,
    /// Albums only: how many of the card's releases hold their own pinned
    /// pressing, out of how many releases exist. The badge's "2 of 4".
    /// Declared-no-MB releases count as resolved.
    pub matched_releases: i64,
    pub total_releases: i64,
    /// Albums only: releases holding a REAL pinned pressing (declared-none
    /// sentinels excluded). While any exist, the group can't be unmatched —
    /// a pin is a claim inside the group, so the pins go first.
    pub pinned_releases: i64,
    /// Albums only: user declared the album deliberately partial — mb-side
    /// gaps are expected and shouldn't warn.
    pub partial: bool,
    /// The viewed release carries the user's "no MusicBrainz counterpart"
    /// declaration — resolved, but nothing is (or will be) matched.
    pub declared_none: bool,
}

/// The library an entity belongs to. Every album, artist and track is a
/// media_entry, so the caller never has to know or pass it.
async fn library_of(pool: &SqlitePool, entity_id: i64) -> Result<String, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT library_id FROM media_entry WHERE id = ?")
        .bind(entity_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    row.map(|(l,)| l).ok_or_else(|| "entity not found".to_string())
}

fn mb_field_for(kind: &str) -> Result<&'static str, String> {
    match kind {
        "album" => Ok(MB_RELEASE),
        "artist" => Ok(MB_ARTIST),
        "track" => Ok(MB_RECORDING),
        other => Err(format!("unknown entity kind {other}")),
    }
}

/// Everything the match UI needs about one entity, for any of the three kinds.
/// For albums, `release_db_id` scopes the release-level facts (pinned
/// pressing, track-list diff) to the VERSION the dialog was opened on;
/// absent, the default release.
#[tauri::command]
pub async fn mb_status(
    state: State<'_, AppState>,
    kind: String,
    entity_id: i64,
    release_db_id: Option<i64>,
) -> Result<MbStatus, String> {
    let pool = &state.app_db;
    // Albums: which release's view of the card this status is.
    let album_folder: Option<String> = if kind == "album" {
        match release_db_id {
            Some(rid) => sqlx::query_as::<_, (String,)>(
                "SELECT folder_path FROM album_release WHERE id = ? AND album_id = ?",
            )
            .bind(rid)
            .bind(entity_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .map(|(f,)| f),
            None => default_release_folder(pool, entity_id).await?,
        }
    } else {
        None
    };
    let mut declared_none = false;
    let (mut mbid, mut tier) = if kind == "album" {
        match &album_folder {
            Some(folder) => match release_match_of(pool, entity_id, folder).await? {
                // Sentinel row: the user declared this release has no MB
                // counterpart — resolved, but nothing is matched.
                Some((v, _)) if v.is_empty() => {
                    declared_none = true;
                    (None, None)
                }
                Some((v, t)) => (Some(v), Some(t)),
                None => (None, None),
            },
            None => (None, None),
        }
    } else {
        let field = mb_field_for(&kind)?;
        match mb_id(pool, entity_id, field).await? {
            Some((v, t)) => (Some(v), Some(t)),
            None => (None, None),
        }
    };
    // Artists identified before their ids were stored durably still carry one
    // on the artist row; the list already falls back to it, so this must too.
    if mbid.is_none() && kind == "artist" {
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT musicbrainz_id FROM artist WHERE id = ?")
                .bind(entity_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((Some(existing),)) = row {
            if !existing.is_empty() {
                mbid = Some(existing);
                tier = Some(TIER_MB.to_string());
            }
        }
    }

    let ignored = mb_id(pool, entity_id, MB_IGNORED).await?.is_some();
    let partial = kind == "album" && mb_id(pool, entity_id, MB_PARTIAL).await?.is_some();
    let staged = crate::music_edit::is_staged_for_rescan(pool, entity_id).await?;
    let mut context_mbid: Option<String> = None;
    let mut credited_artists: Vec<CreditedArtist> = Vec::new();
    let (title, context) = match kind.as_str() {
        "album" => {
            // The credit as the ARTIST is named, not as the tag spelled it
            // ("Various" merged into Various Artists shows the latter);
            // the tag name only for a credit no artist row backs.
            let row: (String, Option<String>) = sqlx::query_as(
                "SELECT al.title,
                        (SELECT COALESCE(ar.title, ac.name) FROM album_artist_credit ac
                         LEFT JOIN artist ar ON ar.id = ac.artist_id
                         WHERE ac.album_id = al.id ORDER BY ac.position LIMIT 1)
                 FROM album al
                 WHERE al.id = ?",
            )
            .bind(entity_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
            // First credited artist that is MATCHED — any proven member's
            // discography contains a joint album, so position order is fine.
            let ctx_mbid: Option<(String,)> = sqlx::query_as(
                "SELECT ar.musicbrainz_id FROM album_artist_credit ac
                 JOIN artist ar ON ar.id = ac.artist_id
                 WHERE ac.album_id = ? AND ar.musicbrainz_id IS NOT NULL AND ar.musicbrainz_id <> ''
                 ORDER BY ac.position LIMIT 1",
            )
            .bind(entity_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            context_mbid = ctx_mbid.map(|(m,)| m);
            credited_artists = sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT COALESCE(ar.title, ac.name), NULLIF(ar.musicbrainz_id, '')
                 FROM album_artist_credit ac
                 LEFT JOIN artist ar ON ar.id = ac.artist_id
                 WHERE ac.album_id = ?
                 ORDER BY ac.position",
            )
            .bind(entity_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(name, mbid)| CreditedArtist { name, mbid })
            .collect();
            (row.0, row.1)
        }
        "artist" => {
            let row: (String,) = sqlx::query_as("SELECT title FROM artist WHERE id = ?")
                .bind(entity_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            (row.0, None)
        }
        _ => {
            // A track searches best with its album as context.
            let row: (String, Option<String>) = sqlx::query_as(
                "SELECT t.title, al.title FROM track t
                 LEFT JOIN track_release tr ON tr.track_id = t.id
                 LEFT JOIN album_release ar ON ar.id = tr.release_id
                 LEFT JOIN album al ON al.id = ar.album_id
                 WHERE t.id = ?",
            )
            .bind(entity_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
            // First MATCHED credited artist — recording searches scope to
            // their catalogue instead of all of MusicBrainz (same idea as
            // the album dialog browsing the matched artist's discography).
            let ctx_mbid: Option<(String,)> = sqlx::query_as(
                "SELECT ar.musicbrainz_id FROM track_credit tc
                 JOIN artist ar ON ar.id = tc.artist_id
                 WHERE tc.track_id = ? AND ar.musicbrainz_id IS NOT NULL AND ar.musicbrainz_id <> ''
                 ORDER BY tc.position LIMIT 1",
            )
            .bind(entity_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            context_mbid = ctx_mbid.map(|(m,)| m);
            (row.0, row.1)
        }
    };

    let mut matched_releases = 0i64;
    let mut total_releases = 0i64;
    let mut pinned_releases = 0i64;
    let (release_group_id, gap_count, gap_ours, gap_mb, searched_not_found) = if kind == "album" {
        let rg = mb_id(pool, entity_id, MB_RELEASE_GROUP).await?.map(|(v, _)| v);
        // Diff counts scope to the release this status views — each version
        // carries its own comparison against its own pinned pressing.
        let folder = album_folder.clone().unwrap_or_default();
        let gaps: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM album_match_gap WHERE album_id = ? AND folder_path = ?",
        )
        .bind(entity_id)
        .bind(&folder)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        let (ours, theirs): (i64, i64) = sqlx::query_as(
            "SELECT COALESCE(SUM(side = 'ours'), 0), COALESCE(SUM(side = 'mb'), 0)
             FROM album_match_gap WHERE album_id = ? AND folder_path = ?",
        )
        .bind(entity_id)
        .bind(&folder)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        let nf: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM mb_credit_fetch WHERE album_id = ? AND status = 'notfound'",
        )
        .bind(entity_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        let (m, t): (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM release_match rm WHERE rm.album_id = ?1),
                    (SELECT COUNT(*) FROM album_release ar WHERE ar.album_id = ?1)",
        )
        .bind(entity_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        matched_releases = m;
        total_releases = t;
        pinned_releases = pinned_release_count(pool, entity_id).await?;
        (rg, gaps.0, ours, theirs, nf.0 != 0)
    } else if kind == "artist" {
        // The pass's name lookup — same signal the artists list reads, so the
        // dialog's status card agrees with the row that opened it.
        let nf: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM mb_artist_lookup l
             JOIN artist a ON l.name = LOWER(a.title)
             WHERE a.id = ? AND l.status = 'notfound'",
        )
        .bind(entity_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        (None, 0, 0, 0, nf.0 != 0)
    } else {
        (None, 0, 0, 0, false)
    };

    Ok(MbStatus {
        kind,
        entity_id,
        library_id: library_of(pool, entity_id).await?,
        title,
        context,
        context_mbid,
        credited_artists,
        mbid,
        tier,
        release_group_id,
        gap_count,
        gap_ours,
        gap_mb,
        searched_not_found,
        matched_releases,
        total_releases,
        pinned_releases,
        ignored,
        staged,
        partial,
        declared_none,
    })
}

/// One album credited to an artist that still lacks any MusicBrainz identity.
/// The artist dialog lists these when the artist itself can't be identified —
/// a name that isn't on MusicBrainz (game title, label, junk tag) gets fixed
/// the other way around: match its albums and the harvested credits replace it.
#[derive(Debug, Serialize)]
pub struct MbArtistAlbumLead {
    pub album_id: i64,
    pub title: String,
    /// First credited name — context for joint albums.
    pub artist_title: Option<String>,
    /// "notfound" — the pass searched and missed; "unchecked" — never tried.
    pub state: String,
}

#[tauri::command]
pub async fn mb_artist_unmatched_albums(
    state: State<'_, AppState>,
    entity_id: i64,
) -> Result<Vec<MbArtistAlbumLead>, String> {
    let pool = &state.app_db;
    // Same eligibility as the review list: no loose containers, no sounds,
    // nothing ignored — only albums the matching pass is responsible for.
    let rows: Vec<(i64, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT al.id, al.title,
                (SELECT ac2.name FROM album_artist_credit ac2
                 WHERE ac2.album_id = al.id ORDER BY ac2.position LIMIT 1),
                EXISTS (SELECT 1 FROM mb_credit_fetch f WHERE f.album_id = al.id)
         FROM album al
         JOIN album_artist_credit ac ON ac.album_id = al.id AND ac.artist_id = ?
         WHERE NOT EXISTS (SELECT 1 FROM release_match rm WHERE rm.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM field_override o
                           WHERE o.entity_id = al.id AND o.field = 'mb_release_group_id'
                             AND o.value IS NOT NULL AND o.value <> '')
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored')
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
         GROUP BY al.id
         ORDER BY al.sort_title COLLATE NOCASE",
    )
    .bind(entity_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(album_id, title, artist_title, searched)| MbArtistAlbumLead {
            album_id,
            title,
            artist_title,
            state: if searched != 0 { "notfound" } else { "unchecked" }.to_string(),
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct MbCandidateRow {
    /// "release-group" (the album) | "release" (one pressing) | "artist" |
    /// "recording". Applying differs: a group sets identity only, a release
    /// also rewrites track credits.
    pub kind: String,
    pub mbid: String,
    pub title: String,
    /// Artist credit, or for an artist: type + area + lifespan.
    pub subtitle: String,
    pub detail: Option<String>,
    pub score: i64,
    /// Artists only: the searched name equals this artist's name OR one of
    /// their aliases (normalized). This is what the suggestion sweep filters
    /// on — MB's own scoring ranks famous partial matches above obscure
    /// exact ones, and title-only comparison misses the canonical entity
    /// when the searched name lives on it as an alias (an artist who
    /// RENAMED, e.g. "Hodgy Beats" → "Hodgy", answers via alias while a bare
    /// duplicate answers by title).
    #[serde(skip_serializing)]
    pub name_match: bool,
    /// Artists only: MB's primary English artist-name alias, when the
    /// canonical name is something else ("近藤浩治" → "Koji Kondo"). The UI
    /// offers adopting it instead of the canonical script.
    pub en_name: Option<String>,
}

fn group_row(g: GroupCandidate) -> MbCandidateRow {
    MbCandidateRow {
        kind: "release-group".to_string(),
        mbid: g.group_id,
        title: g.title,
        subtitle: g.artist,
        detail: Some(
            [g.album_type.clone(), g.first_release_date.clone(), g.disambiguation.clone()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · "),
        )
        .filter(|s| !s.is_empty()),
        score: g.score,
        name_match: false,
        en_name: None,
    }
}

/// "US" → "🇺🇸 US": flag-prefixed country, MusicBrainz-style (XW = worldwide,
/// XE = Europe). The frontend loads a flag font so Windows actually draws them.
fn country_label(code: &str) -> String {
    match code {
        "XW" => "🌐 XW".to_string(),
        "XE" => "🇪🇺 XE".to_string(),
        c if c.len() == 2 && c.chars().all(|ch| ch.is_ascii_uppercase()) => {
            let flag: String = c
                .chars()
                .filter_map(|ch| char::from_u32(0x1F1E6 + (ch as u32 - 'A' as u32)))
                .collect();
            format!("{flag} {c}")
        }
        c => c.to_string(),
    }
}

fn release_row(c: ReleaseCandidate) -> MbCandidateRow {
    MbCandidateRow {
        kind: "release".to_string(),
        mbid: c.release_id,
        title: c.title,
        subtitle: c.artist,
        detail: Some(
            [
                c.date,
                c.track_count.map(|n| format!("{n} tracks")),
                c.format,
                (!c.countries.is_empty()).then(|| {
                    c.countries.iter().map(|cc| country_label(cc)).collect::<Vec<_>>().join(" ")
                }),
                c.disambiguation,
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · "),
        )
        .filter(|s| !s.is_empty()),
        score: c.score,
        name_match: false,
        en_name: None,
    }
}

/// A pasted id or musicbrainz.org URL for one particular entity type.
fn parse_bare_mbid(text: &str, entity: &str) -> Option<String> {
    let t = text.trim();
    if let Some(rest) = t.split(&format!("/{entity}/")).nth(1) {
        let id: String = rest
            .chars()
            .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
            .collect();
        return is_mbid(&id).then_some(id);
    }
    is_mbid(t).then(|| t.to_string())
}

/// Search MusicBrainz for whichever entity kind the dialog is matching.
/// A pasted id or URL short-circuits the search for every kind.
#[tauri::command]
pub async fn mb_search_entity(
    kind: String,
    query: String,
    context: Option<String>,
    // Tracks only: scope the recording search to this artist's catalogue
    // (arid) — features count, MB indexes every credited artist.
    artist_mbid: Option<String>,
) -> Result<Vec<MbCandidateRow>, String> {
    let _priority = UserPriority::hold();
    let client = mb_client()?;
    let context = context.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    match kind.as_str() {
        "album" => {
            // A pasted release id still wins — naming a pressing explicitly is
            // the one way to be certain which one you have.
            if query.contains("/release/") {
                if let Some(id) = parse_bare_mbid(&query, "release") {
                    if let Some(c) = lookup_release(&client, &id).await? {
                        return Ok(vec![release_row(c)]);
                    }
                }
            }
            if let Some(id) = parse_bare_mbid(&query, "release-group") {
                if let Some(g) = fetch_release_group(&client, &id).await? {
                    return Ok(vec![group_row(g)]);
                }
            }
            let mut groups = search_release_groups(&client, &query, context.as_deref(), None).await?;
            let stripped = strip_title_decorations(&query);
            if groups.is_empty() && stripped != query && !stripped.is_empty() {
                groups = search_release_groups(&client, &stripped, context.as_deref(), None).await?;
            }
            if groups.is_empty() && context.is_some() {
                // A junk artist tag hides every result, same as before.
                groups = search_release_groups(&client, &stripped, None, None).await?;
            }
            Ok(groups.into_iter().map(group_row).collect())
        }
        "release" => {
            let found = mb_search_releases(query, context).await?;
            Ok(found.results.into_iter().map(release_row).collect())
        }
        "artist" => search_artists(&client, &query, 10).await,
        "track" => search_recordings(&client, &query, context.as_deref(), artist_mbid.as_deref()).await,
        other => Err(format!("unknown entity kind {other}")),
    }
}

async fn search_artists(
    client: &reqwest::Client,
    query: &str,
    // MB orders results by fame, and exact-name obscure artists sink below
    // famous partial matches — the suggestion sweep searches DEEP (a page of
    // 50) so the exact-name filter sees them; the dialog stays at 10, since
    // a human is scanning that list.
    limit: u32,
) -> Result<Vec<MbCandidateRow>, String> {
    let body = if let Some(id) = parse_bare_mbid(query, "artist") {
        let url = url::Url::parse_with_params(
            &format!("https://musicbrainz.org/ws/2/artist/{id}"),
            &[("fmt", "json")],
        )
        .map_err(|e| e.to_string())?;
        let resp = mb_get(client, url).await?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let one: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        serde_json::json!({ "artists": [one] })
    } else {
        // artist: matches NAMES only — an entity answering via alias is never
        // returned by it at all ("Hodgy", alias "Hodgy Beats", was invisible
        // to artist:"Hodgy Beats"). The alias: clause brings those in; the
        // exact-match filter then checks names AND aliases, which the search
        // rows carry.
        let escaped = query.replace('"', " ");
        let url = url::Url::parse_with_params(
            "https://musicbrainz.org/ws/2/artist",
            &[
                (
                    "query",
                    format!("artist:\"{escaped}\" OR alias:\"{escaped}\"").as_str(),
                ),
                ("fmt", "json"),
                ("limit", limit.to_string().as_str()),
            ],
        )
        .map_err(|e| e.to_string())?;
        let resp = mb_get(client, url).await?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        resp.json().await.map_err(|e| e.to_string())?
    };

    let want = normalize(query);
    Ok(body["artists"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let begin = a["life-span"]["begin"].as_str().unwrap_or_default();
            let end = a["life-span"]["end"].as_str().unwrap_or_default();
            // A trailing en dash means "still going". After a bare year it
            // sits tight ("1991–"), the usual convention; after a full date
            // it needs a space ("1992-06-24 –") or it reads as another hyphen
            // in the date rather than an open range.
            let years = match (begin.is_empty(), end.is_empty()) {
                (false, false) => format!("{begin}–{end}"),
                (false, true) if begin.len() == 4 => format!("{begin}–"),
                (false, true) => format!("{begin} –"),
                _ => String::new(),
            };
            // Name OR alias: an artist who renamed answers to the old name
            // through their alias — that's the canonical entity, and it must
            // not lose to a bare same-named duplicate on title alone.
            let name_match = normalize(a["name"].as_str().unwrap_or_default()) == want
                || a["aliases"]
                    .as_array()
                    .map(|aliases| {
                        aliases
                            .iter()
                            .any(|al| al["name"].as_str().is_some_and(|n| normalize(n) == want))
                    })
                    .unwrap_or(false);
            // MB's English artist name, when the canonical is another script:
            // the locale-en "Artist name" alias (primary preferred). Search
            // rows carry aliases, so this costs nothing extra.
            let name = a["name"].as_str().unwrap_or_default();
            let en_alias = |primary_only: bool| {
                a["aliases"].as_array().into_iter().flatten().find_map(|al| {
                    let is_name = al["type"].as_str() == Some("Artist name");
                    let is_en = al["locale"].as_str() == Some("en");
                    let is_primary = al["primary"].as_bool() == Some(true);
                    if is_name && is_en && (is_primary || !primary_only) {
                        al["name"].as_str().map(|n| n.to_string())
                    } else {
                        None
                    }
                })
            };
            let en_name = en_alias(true)
                .or_else(|| en_alias(false))
                .filter(|n| n != name);
            Some(MbCandidateRow {
                kind: "artist".to_string(),
                mbid: a["id"].as_str()?.to_string(),
                title: a["name"].as_str().unwrap_or_default().to_string(),
                subtitle: [
                    a["type"].as_str().unwrap_or_default().to_string(),
                    a["area"]["name"].as_str().unwrap_or_default().to_string(),
                    years,
                ]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · "),
                detail: a["disambiguation"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string()),
                score: a["score"].as_i64().unwrap_or(100),
                name_match,
                en_name,
            })
        })
        // NO score floor. Scores are lucene relevance, and the OR alias:
        // clause dilutes them — obscure exact-name artists can land under
        // any fixed cutoff (Castro's namesakes dropped below 50) while the
        // famous stay comfortably above it. The sweep's exact name/alias
        // filter is the real gatekeeper; the dialog is a ranked list a human
        // reads, where a weak tail is harmless.
        .collect())
}

async fn search_recordings(
    client: &reqwest::Client,
    query: &str,
    album: Option<&str>,
    artist_mbid: Option<&str>,
) -> Result<Vec<MbCandidateRow>, String> {
    let body = if let Some(id) = parse_bare_mbid(query, "recording") {
        let url = url::Url::parse_with_params(
            &format!("https://musicbrainz.org/ws/2/recording/{id}"),
            &[("inc", "artist-credits+releases"), ("fmt", "json")],
        )
        .map_err(|e| e.to_string())?;
        let resp = mb_get(client, url).await?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let one: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        serde_json::json!({ "recordings": [one] })
    } else {
        let mut q = format!("recording:\"{}\"", query.replace('"', " "));
        if let Some(album) = album {
            q.push_str(&format!(" AND release:\"{}\"", album.replace('"', " ")));
        }
        // MBIDs are plain hex-and-dashes — safe in the query unquoted.
        if let Some(arid) = artist_mbid.filter(|a| !a.is_empty()) {
            q.push_str(&format!(" AND arid:{arid}"));
        }
        let url = url::Url::parse_with_params(
            "https://musicbrainz.org/ws/2/recording",
            &[("query", q.as_str()), ("fmt", "json"), ("limit", "10")],
        )
        .map_err(|e| e.to_string())?;
        let resp = mb_get(client, url).await?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        resp.json().await.map_err(|e| e.to_string())?
    };

    Ok(body["recordings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let secs = r["length"].as_i64().map(|ms| ms / 1000);
            Some(MbCandidateRow {
                kind: "recording".to_string(),
                mbid: r["id"].as_str()?.to_string(),
                title: r["title"].as_str().unwrap_or_default().to_string(),
                subtitle: r["artist-credit"]
                    .as_array()
                    .map(|ac| {
                        ac.iter()
                            .filter_map(|c| {
                                c["name"].as_str().or_else(|| c["artist"]["name"].as_str())
                            })
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default(),
                name_match: false,
                en_name: None,
                detail: Some(
                    [
                        secs.map(|s| format!("{}:{:02}", s / 60, s % 60)),
                        r["releases"]
                            .as_array()
                            .and_then(|rs| rs.first())
                            .and_then(|rel| rel["title"].as_str())
                            .map(|t| t.to_string()),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · "),
                )
                .filter(|s| !s.is_empty()),
                score: r["score"].as_i64().unwrap_or(100),
            })
        })
        .filter(|c| c.score >= 50)
        .collect())
}

/// Apply a chosen MusicBrainz entity. Albums go through the full release
/// application (credits, type, date, gaps); artists and tracks write their id
/// and pull their credits from it.
#[tauri::command]
pub async fn mb_apply_entity_match(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    entity_id: i64,
    mbid: String,
    // For albums: "release-group" identifies the album only, "release" adopts
    // one pressing and rewrites track credits from it. Defaults to the album
    // reading, since that is what a search now returns.
    mbid_kind: Option<String>,
    // Release applies: WHICH release of the album (db row id) the pressing
    // pins — the version the dialog was opened on. None = default release.
    release_db_id: Option<i64>,
    // Artists: adopt THIS display name instead of MB's canonical one (the
    // user ticked "use the English name" on a candidate). The canonical
    // name is recorded as an alias so MB-authored credits still resolve.
    preferred_name: Option<String>,
) -> Result<ApplyOutcome, String> {
    let _priority = UserPriority::hold();
    ensure_entity_not_matching(&state.app_db, entity_id).await?;
    let pool = &state.app_db;
    // Staged = immutable: a match on an entity a staged rescan action will
    // dissolve would be silently discarded when it applies.
    crate::music_edit::ensure_not_staged(pool, entity_id).await?;
    clear_suppressions(pool, entity_id).await?;
    let library_id = library_of(pool, entity_id).await?;
    // One batch per apply. The album branch delegates to mb_apply_album_match,
    // which allocates its own inside apply_release.
    let batch = next_batch(pool).await?;
    // Album group matches: the credit pairs, kept for a second stamping walk
    // at the tail — after ensure_credit_artists creates pages for names new
    // to the library (the in-arm walk ran before they existed).
    // Credit pairs + mbid → canonical names, for the post-ensure stamp walk.
    let mut album_credit_pairs: Option<(Vec<(String, Option<String>)>, HashMap<String, String>)> =
        None;
    // Track matches: whether the recording's credits actually replaced ours —
    // only then does the parent album hold new evidence worth re-checking.
    let mut track_credits_applied = false;
    // Artist matches: whether the page took a new name or alias — only then
    // can a credit row that was unlinked now resolve to it.
    let mut artist_names_changed = false;
    match kind.as_str() {
        "album" => {
            if mbid_kind.as_deref() == Some("release") {
                mb_apply_album_match(app, state, library_id, entity_id, mbid, release_db_id)
                    .await?;
                return Ok(ApplyOutcome { merged_into: None });
            }
            let (title,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
                .bind(entity_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            let client = mb_client()?;
            let group = fetch_release_group(&client, &mbid)
                .await?
                .ok_or_else(|| "no MusicBrainz release group with that id".to_string())?;
            apply_group(pool, &library_id, entity_id, &title, &group, TIER_USER).await?;
            album_credit_pairs = Some((
                group
                    .artists
                    .iter()
                    .cloned()
                    .zip(group.artist_ids.iter().cloned())
                    .collect::<Vec<(String, Option<String>)>>(),
                group.canonical_names(),
            ));
            stamp(pool, entity_id, "matched").await?;
            // The pending "which album is this?" suggestion is now answered —
            // without this the card lingers after Apply and the decision
            // count never moves (the release path settles it in
            // mb_apply_album_match; this group path forgot to).
            sqlx::query(
                "UPDATE mb_suggestion SET status = 'accepted'
                 WHERE library_id = ? AND kind = 'album_match' AND target_key = ? AND status = 'pending'",
            )
            .bind(&library_id)
            .bind(entity_id.to_string())
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
        "artist" => {
            let (title,): (String,) = sqlx::query_as("SELECT title FROM artist WHERE id = ?")
                .bind(entity_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            let previous: (Option<String>,) =
                sqlx::query_as("SELECT musicbrainz_id FROM artist WHERE id = ?")
                    .bind(entity_id)
                    .fetch_one(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            // Another page in this library already holds the id: the match
            // IS a merge — "Cash" is the Johnny Cash page that's already
            // here. Merge into the existing page now, keeping it (its ids,
            // matches and history all stand), instead of renaming this one
            // into a same-named duplicate that waits for the next pass or a
            // suggestion click to fold it in (2026-09-25). Logged as a USER
            // merge: the person said who this is, so undo simply restores
            // the page — no standing "no" against the pass.
            if !is_placeholder_artist(&mbid) {
                let holder: Option<(i64, String)> = sqlx::query_as(
                    "SELECT a.id, a.title FROM artist a
                     JOIN media_entry me ON me.id = a.id
                     WHERE me.library_id = ? AND a.musicbrainz_id = ? AND a.id != ?
                     ORDER BY (SELECT COUNT(*) FROM album_artist_credit c WHERE c.artist_id = a.id) DESC,
                              a.id ASC
                     LIMIT 1",
                )
                .bind(&library_id)
                .bind(&mbid)
                .bind(entity_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
                if let Some((keep_id, keep_title)) = holder {
                    // This page's own "which artist is this?" card is answered
                    // (merge_artists would mark it obsolete — accepted is the
                    // truth: the person chose).
                    sqlx::query(
                        "UPDATE mb_suggestion SET status = 'accepted'
                         WHERE library_id = ? AND kind = 'artist_match' AND target_key = ? AND status = 'pending'",
                    )
                    .bind(&library_id)
                    .bind(entity_id.to_string())
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                    merge_artists(pool, &library_id, keep_id, &keep_title, Some(entity_id), &title, "user")
                        .await?;
                    // The survivor just gained this page's unmatched albums —
                    // searchable under its id on the next pass.
                    enqueue_artist_match_recheck(pool, &library_id, keep_id).await?;
                    let _ = app.emit(
                        "music-enrich-done",
                        serde_json::json!({ "libraryId": library_id, "updated": 0, "albumsMatched": 0, "processed": 0, "pendingReview": 0 }),
                    );
                    evict_artist_group_caches(pool).await?;
                    // The caller's entity is gone — a dialog open on it must
                    // close rather than reload it.
                    return Ok(ApplyOutcome {
                        merged_into: Some(MergedInto { artist_id: keep_id, title: keep_title }),
                    });
                }
            }
            set_mb_id(pool, entity_id, MB_ARTIST, &mbid, TIER_USER).await?;
            sqlx::query("UPDATE artist SET musicbrainz_id = ? WHERE id = ?")
                .bind(&mbid)
                .bind(entity_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            // Adopt a display name. Default: MB's canonical name (the tag
            // spelling lives on as an alias, identity survives rescans, the
            // user's own rename wins). With preferred_name — the user ticked
            // "use the English name" on a candidate — that spelling wins the
            // title and the canonical name is recorded as an alias instead,
            // so MB-authored credits ("近藤浩治" on harvested releases) still
            // resolve to this page. Logged with an undo either way; a fetch
            // failure keeps the current name (or still adopts the preferred
            // one, which needs no fetch).
            if !crate::music_edit::has_override(pool, entity_id, "title").await? {
                let mut canonical: Option<String> = None;
                if let Ok(client) = mb_client() {
                    if let Ok(url) = url::Url::parse_with_params(
                        &format!("https://musicbrainz.org/ws/2/artist/{mbid}"),
                        &[("fmt", "json")],
                    ) {
                        if let Ok(resp) = mb_get(&client, url).await {
                            if resp.status().is_success() {
                                if let Ok(body) = resp.json::<serde_json::Value>().await {
                                    canonical = body["name"]
                                        .as_str()
                                        .filter(|n| !n.is_empty())
                                        .map(|n| n.to_string());
                                }
                            }
                        }
                    }
                }
                let preferred = preferred_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .map(|n| n.to_string());
                let target = preferred.clone().or_else(|| canonical.clone());
                // MB tier of the name (canonical, or the English alias the
                // user preferred) — the fallback when a later rename is cleared.
                if let Some(t) = &target {
                    set_mb_id(pool, entity_id, "title", t, TIER_MB).await?;
                }
                if let Some(target) = target.filter(|n| *n != title) {
                    rename_artist_page(pool, &library_id, entity_id, &title, &target, "mb", batch)
                        .await?;
                    artist_names_changed = true;
                }
                // The canonical spelling must keep resolving to this page
                // even when the preferred name won the title.
                if let (Some(pref), Some(canon)) = (preferred.as_deref(), canonical.as_deref()) {
                    if pref != canon {
                        sqlx::query(
                            "INSERT OR IGNORE INTO artist_alias (artist_id, name, source) VALUES (?, ?, 'mb')",
                        )
                        .bind(entity_id)
                        .bind(canon)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                        artist_names_changed = true;
                    }
                }
            }
            // A pending "which artist is this?" suggestion is now answered.
            sqlx::query(
                "UPDATE mb_suggestion SET status = 'accepted'
                 WHERE library_id = ? AND kind = 'artist_match' AND target_key = ? AND status = 'pending'",
            )
            .bind(&library_id)
            .bind(entity_id.to_string())
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            // Pending MERGE suggestions whose two sides now hold DIFFERENT
            // ids are answered by the ids themselves: provably two artists.
            // Reject them — the same standing "no" a human click leaves.
            // (Sides proven EQUAL are left for merge_mbid_duplicates, which
            // merges them properly on the next pass.)
            let pending_merges: Vec<(i64, String)> = sqlx::query_as(
                "SELECT id, payload FROM mb_suggestion
                 WHERE library_id = ? AND kind = 'artist_merge' AND status = 'pending'",
            )
            .bind(&library_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
            for (sid, payload) in pending_merges {
                let Ok(p) = serde_json::from_str::<serde_json::Value>(&payload) else { continue };
                let (Some(keep_id), Some(other_name)) =
                    (p["keep_id"].as_i64(), p["other_name"].as_str())
                else {
                    continue;
                };
                let keep: Option<(Option<String>,)> =
                    sqlx::query_as("SELECT musicbrainz_id FROM artist WHERE id = ?")
                        .bind(keep_id)
                        .fetch_optional(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                let Some((Some(keep_mbid),)) = keep else { continue };
                let other: Option<(Option<String>,)> = sqlx::query_as(
                    "SELECT a.musicbrainz_id FROM artist_names an
                     JOIN artist a ON a.id = an.artist_id
                     JOIN media_entry me ON me.id = a.id
                     WHERE me.library_id = ?1 AND LOWER(an.name) = LOWER(?2) AND a.id != ?3
                     LIMIT 1",
                )
                .bind(&library_id)
                .bind(other_name)
                .bind(keep_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
                let Some((Some(other_mbid),)) = other else { continue };
                if !keep_mbid.is_empty() && !other_mbid.is_empty() && keep_mbid != other_mbid {
                    sqlx::query("UPDATE mb_suggestion SET status = 'rejected' WHERE id = ?")
                        .bind(sid)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            log_change(
                pool,
                &library_id,
                "artist_mbid",
                entity_id,
                &format!("{title} — matched to MusicBrainz"),
                &serde_json::json!({ "musicbrainz_id": previous.0 }),
                &serde_json::json!({ "musicbrainz_id": mbid }),
                batch,
            )
            .await?;
        }
        "track" => {
            // Only LOOSE tracks match on their own. An album's tracks match
            // through its release pin, all together — a release in
            // waverunner wants to line up with a release on MusicBrainz,
            // not accumulate per-song exceptions (user rule, 2026-09-07).
            let on_album: bool = sqlx::query_as::<_, (i64,)>(
                "SELECT EXISTS(SELECT 1 FROM media_entry me
                               WHERE me.id = ? AND me.parent_id IS NOT NULL
                                 AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = me.parent_id))",
            )
            .bind(entity_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?
            .0 != 0;
            if on_album {
                return Err("Album tracks are matched through their album's release, not one at a time.".to_string());
            }
            let (title,): (String,) = sqlx::query_as("SELECT title FROM track WHERE id = ?")
                .bind(entity_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
            let client = mb_client()?;
            let credits = recording_credits(&client, &mbid).await?;
            let before: Vec<String> = sqlx::query_as::<_, (String,)>(
                "SELECT name FROM track_credit WHERE track_id = ? ORDER BY position",
            )
            .bind(entity_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(n,)| n)
            .collect();
            let prev_recording_id = mb_id(pool, entity_id, MB_RECORDING).await?.map(|(v, _)| v);
            set_mb_id(pool, entity_id, MB_RECORDING, &mbid, TIER_USER).await?;
            if !credits.is_empty() && before != credits {
                track_credits_applied = true;
                sqlx::query("DELETE FROM track_credit WHERE track_id = ?")
                    .bind(entity_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                for (pos, name) in credits.iter().enumerate() {
                    sqlx::query(
                        "INSERT INTO track_credit (track_id, position, name) VALUES (?, ?, ?)",
                    )
                    .bind(entity_id)
                    .bind(pos as i64)
                    .bind(name)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                }
                log_change(
                    pool,
                    &library_id,
                    "track_credits",
                    entity_id,
                    &format!("{title} — credits from MusicBrainz"),
                    &serde_json::json!({ entity_id.to_string(): before }),
                    &serde_json::json!({ entity_id.to_string(): credits }),
                    batch,
                )
                .await?;
            }
            // The match itself logs unconditionally (same rule as albums and
            // artists) — the credits row above is only its side effect.
            // Logged last so it titles the batch's history row.
            log_change(
                pool,
                &library_id,
                "track_match",
                entity_id,
                &format!("{title} — matched to MusicBrainz"),
                &serde_json::json!({ "recording_id": prev_recording_id }),
                &serde_json::json!({ "recording_id": mbid }),
                batch,
            )
            .await?;
        }
        other => return Err(format!("unknown entity kind {other}")),
    }
    // Applied credits can carry names new to the library: pages for them, and
    // fresh stamps for every touched row (ensure ends with resolve_credit_ids).
    // Album and track matches only — an artist match writes no credit rows,
    // and the library-wide walk was most of what made the click slow. A
    // renamed/aliased artist page still gets one re-stamp pass so credits
    // that were unlinked under the old spelling can find it.
    if kind != "artist" {
        crate::music::ensure_credit_artists(pool, &library_id).await?;
    } else if artist_names_changed {
        crate::music::resolve_credit_ids(pool, &library_id).await?;
    }
    // Second stamping walk now that pages for newly-credited names exist.
    if let Some((pairs, canonical)) = &album_credit_pairs {
        stamp_artist_ids_from_credit(pool, &library_id, pairs, canonical).await?;
    }
    if kind == "album" {
        enqueue_pass_work(pool, &library_id, entity_id).await?;
    }
    // The other kinds arm pass work too, each conditionally: an artist's new
    // MBID re-opens the arid retry for their unfound albums; a track's new
    // credits can name artists the album's own evidence could prove.
    if kind == "artist" {
        enqueue_artist_match_recheck(pool, &library_id, entity_id).await?;
    }
    if kind == "track" && track_credits_applied {
        enqueue_track_credit_recheck(pool, &library_id, entity_id).await?;
    }
    let _ = app.emit(
        "music-enrich-done",
        serde_json::json!({ "libraryId": library_id, "updated": 0, "albumsMatched": 0, "processed": 0, "pendingReview": 0 }),
    );
    // A matched album may have been its artists' last unmatched one.
    evict_artist_group_caches(pool).await?;
    Ok(ApplyOutcome { merged_into: None })
}

/// What an apply did beyond the match itself. `merged_into`: an artist
/// match whose id another page already held folded the matched page into
/// that one — the entity the caller named no longer exists.
#[derive(Debug, Serialize)]
pub struct ApplyOutcome {
    pub merged_into: Option<MergedInto>,
}

#[derive(Debug, Serialize)]
pub struct MergedInto {
    pub artist_id: i64,
    pub title: String,
}

/// The ordered artist credit of one recording.
async fn recording_credits(
    client: &reqwest::Client,
    recording_id: &str,
) -> Result<Vec<String>, String> {
    let url = url::Url::parse_with_params(
        &format!("https://musicbrainz.org/ws/2/recording/{recording_id}"),
        &[("inc", "artist-credits"), ("fmt", "json")],
    )
    .map_err(|e| e.to_string())?;
    let resp = mb_get(client, url).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body["artist-credit"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            c["name"]
                .as_str()
                .or_else(|| c["artist"]["name"].as_str())
                .map(|s| s.to_string())
        })
        .collect())
}

/// Forget an entity's match. Reverts what the match wrote by undoing its
/// change-log entries, then drops the id — so an unmatch leaves the entity as
/// its tags describe it, not as MusicBrainz last left it.
#[tauri::command]
pub async fn mb_unmatch_entity(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    entity_id: i64,
) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, entity_id).await?;
    let pool = &state.app_db;
    let library_id = library_of(pool, entity_id).await?;
    let field = mb_field_for(&kind)?;
    // A pinned pressing is a claim inside the group; the group can't be
    // forgotten out from under it. Unmatch the release(s) first — the
    // dialog disables the button for the same reason, this guards every
    // other caller (the pending-pass list's Unmatch).
    if kind == "album" {
        let pinned = pinned_release_count(pool, entity_id).await?;
        if pinned > 0 {
            return Err(if pinned == 1 {
                "A release is still matched — unmatch it first, then the album".to_string()
            } else {
                format!("{pinned} releases are still matched — unmatch them first, then the album")
            });
        }
    }

    let changes: Vec<(i64,)> = sqlx::query_as(
        "SELECT id FROM mb_change_log
         WHERE library_id = ? AND target_id = ? AND undone = 0
         ORDER BY id DESC",
    )
    .bind(&library_id)
    .bind(entity_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (change_id,) in changes {
        // Newest first, so each undo restores the state the one before it saw.
        mb_undo_change(app.clone(), state.clone(), library_id.clone(), change_id).await?;
    }

    // Undo writes a suppression — "never apply this to this album again" —
    // which is right when you reject ONE change in the review list, and wrong
    // here: unmatching means start over, not never again. Without this, an
    // album could be unmatched but never fully re-matched, and nothing in the
    // UI can clear a suppression.
    sqlx::query("DELETE FROM mb_suppression WHERE target_id = ?")
        .bind(entity_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    clear_mb_id(pool, entity_id, field).await?;
    if kind == "album" {
        clear_mb_id(pool, entity_id, MB_RELEASE_GROUP).await?;
        sqlx::query("UPDATE album SET mb_release_group_id = NULL WHERE id = ?")
            .bind(entity_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        // Every release's pin goes — full unmatch is the card-wide start-over.
        // (album_release.mb_release_id stays: it's tag truth, not match state.)
        sqlx::query("DELETE FROM release_match WHERE album_id = ?")
            .bind(entity_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM album_match_gap WHERE album_id = ?")
            .bind(entity_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM mb_credit_fetch WHERE album_id = ?")
            .bind(entity_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        // No match, nothing for a pass to cash in — the queue rows go too:
        // the match's own row, and any credits re-check row (its "new
        // evidence" WAS this match; a manually-edited-credits row has no
        // History entry to dequeue it, so it must go here).
        sqlx::query("DELETE FROM pending_pass WHERE library_id = ? AND target IN (?, ?)")
            .bind(&library_id)
            .bind(entity_id.to_string())
            .bind(format!("album:{entity_id}:credits"))
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    if kind == "artist" {
        sqlx::query("UPDATE artist SET musicbrainz_id = NULL WHERE id = ?")
            .bind(entity_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    // Unmatch = start over — exhaustion records included, for either kind.
    sqlx::query("DELETE FROM mb_derive_exhausted WHERE entity_id = ?")
        .bind(entity_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// First stage of a two-stage unmatch: forget WHICH pressing a release is,
/// keep WHICH album the card is (the group). The dialog drops back to the
/// release picker; applying a new release overwrites whatever the old one
/// wrote. `release_db_id` scopes to one version; absent, every version's
/// pin is forgotten (the center's start-over). Note: a release whose FILES
/// carry the id will be re-pinned by the next pass — tags are certainty.
#[tauri::command]
pub async fn mb_unmatch_release(
    app: AppHandle,
    state: State<'_, AppState>,
    entity_id: i64,
    release_db_id: Option<i64>,
) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, entity_id).await?;
    let pool = &state.app_db;
    let library_id = library_of(pool, entity_id).await?;
    let folder: Option<String> = match release_db_id {
        Some(rid) => sqlx::query_as::<_, (String,)>(
            "SELECT folder_path FROM album_release WHERE id = ? AND album_id = ?",
        )
        .bind(rid)
        .bind(entity_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .map(|(f,)| f),
        None => None,
    };
    match &folder {
        Some(f) => {
            sqlx::query("DELETE FROM release_match WHERE album_id = ? AND folder_path = ?")
                .bind(entity_id)
                .bind(f)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            // Track-list comparison was against the forgotten release.
            sqlx::query("DELETE FROM album_match_gap WHERE album_id = ? AND folder_path = ?")
                .bind(entity_id)
                .bind(f)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        None => {
            sqlx::query("DELETE FROM release_match WHERE album_id = ?")
                .bind(entity_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM album_match_gap WHERE album_id = ?")
                .bind(entity_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    let _ = app.emit(
        "music-enrich-done",
        serde_json::json!({ "libraryId": library_id, "updated": 0, "albumsMatched": 0, "processed": 0, "pendingReview": 0 }),
    );
    Ok(())
}

/// Dismiss an album's track-list warning. Nothing else changes — a re-check
/// or a fresh match brings it back if the two sides still disagree.
#[tauri::command]
pub async fn mb_dismiss_gaps(state: State<'_, AppState>, album_id: i64) -> Result<(), String> {
    ensure_entity_not_matching(&state.app_db, album_id).await?;
    sqlx::query("DELETE FROM album_match_gap WHERE album_id = ?")
        .bind(album_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ReleaseSearch {
    pub results: Vec<ReleaseCandidate>,
    /// The artist name that was dropped to get these results — set only when
    /// the filtered search found nothing and the retry did. The UI says so.
    pub widened_from: Option<String>,
    /// These came from a pasted id/URL, not a text search: exact, unranked,
    /// and (for a release group) every pressing of the album.
    pub from_id: bool,
}

/// Live release search for the modal's manual matching.
///
/// Two ways in. Paste a MusicBrainz id or URL and it resolves directly — a
/// release gives that pressing, a release-group gives all of them. Otherwise
/// it's a text search, narrowed by the artist field.
///
/// The artist narrows well until the tag is junk ("Soundtrack", "Various", a
/// label name): then it ANDs away every real hit and the album looks absent
/// from a database that plainly has it. So a zero-result filtered search
/// retries on the title alone rather than dead-ending.
#[tauri::command]
pub async fn mb_search_releases(
    query: String,
    artist: Option<String>,
) -> Result<ReleaseSearch, String> {
    let _priority = UserPriority::hold();
    let client = mb_client()?;
    let artist = artist.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());

    if let Some(mb_ref) = parse_mb_ref(&query) {
        let results = match mb_ref {
            MbRef::Release(id) => lookup_release(&client, &id).await?.into_iter().collect(),
            MbRef::ReleaseGroup(id) => releases_in_group(&client, &id).await?,
            MbRef::Bare(id) => match lookup_release(&client, &id).await? {
                Some(c) => vec![c],
                None => releases_in_group(&client, &id).await?,
            },
        };
        if results.is_empty() {
            return Err("no MusicBrainz release found for that id".to_string());
        }
        return Ok(ReleaseSearch { results, widened_from: None, from_id: true });
    }

    let results = search_releases(&client, &query, artist.as_deref()).await?;
    if !results.is_empty() || artist.is_none() {
        return Ok(ReleaseSearch { results, widened_from: None, from_id: false });
    }
    let results = search_releases(&client, &query, None).await?;
    let widened_from = (!results.is_empty()).then(|| artist.unwrap_or_default());
    Ok(ReleaseSearch { results, widened_from, from_id: false })
}

/// Which release group a release belongs to — the release picker's guard for
/// pasted ids: a release from a DIFFERENT group contradicts the album's
/// existing group match, and silently re-grouping would be a trap.
#[tauri::command]
pub async fn mb_release_group_of(release_mbid: String) -> Result<Option<String>, String> {
    let _priority = UserPriority::hold();
    let client = mb_client()?;
    Ok(fetch_release(&client, &release_mbid)
        .await?
        .and_then(|f| f.release_group_id))
}

#[derive(Serialize)]
pub struct MbCreditCheck {
    /// The credit names the target carries on MusicBrainz — the warning text.
    pub credited: Vec<String>,
    pub includes: bool,
}

/// Does this release group / release credit the given artist? The match
/// dialog's consistency check for the free-text search path: applying a
/// target whose credit lacks the album's matched artist WARNS (never blocks —
/// compilations and V/A albums legitimately live under other artists).
#[tauri::command]
pub async fn mb_credit_check(
    state: State<'_, AppState>,
    mbid_kind: String,
    mbid: String,
    // Every identified credited artist: a joint album is consistent when
    // ANY of them is on MusicBrainz's credit.
    artist_mbids: Vec<String>,
) -> Result<MbCreditCheck, String> {
    let client = mb_client()?;
    let (credited, ids): (Vec<String>, Vec<Option<String>>) = if mbid_kind == "release" {
        let full = fetch_release(&client, &mbid)
            .await?
            .ok_or_else(|| "no MusicBrainz release with that id".to_string())?;
        (
            full.album_artists.iter().map(|(n, _)| n.clone()).collect(),
            full.album_artists.iter().map(|(_, i)| i.clone()).collect(),
        )
    } else {
        let g = fetch_release_group(&client, &mbid)
            .await?
            .ok_or_else(|| "no MusicBrainz release group with that id".to_string())?;
        (g.artists.clone(), g.artist_ids.clone())
    };
    let mut includes = ids
        .iter()
        .flatten()
        .any(|i| artist_mbids.iter().any(|m| m == i));
    // A credit to a linked PERSONA (or the persona's human) is the same
    // person wearing another mask — not a mismatch worth warning about.
    if !includes {
        for artist_mbid in &artist_mbids {
            let linked: Vec<(Option<String>,)> = sqlx::query_as(
                "SELECT a2.musicbrainz_id
                 FROM artist a JOIN artist_persona p
                   ON p.persona_id = a.id OR p.parent_id = a.id
                 JOIN artist a2 ON a2.id = CASE WHEN p.persona_id = a.id
                                                THEN p.parent_id ELSE p.persona_id END
                 WHERE a.musicbrainz_id = ?",
            )
            .bind(artist_mbid)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
            if linked
                .iter()
                .filter_map(|(m,)| m.as_ref())
                .any(|m| !m.is_empty() && ids.iter().flatten().any(|i| i == m))
            {
                includes = true;
                break;
            }
        }
    }
    Ok(MbCreditCheck { credited, includes })
}

// ── Artist discography (match dialog) ──────────────────────────────────────
// An album whose credited artist is already matched doesn't search all of
// MusicBrainz by text — it browses the artist's own discography, where the
// album either is or isn't. Served three ways, fastest first:
//   1. `mb_artist_groups_cached` — the last complete fetch, instantly.
//   2. `mb_artist_release_groups_page` — MB's 100/request pages, one call
//      each, so a cold open renders page 1 while page 2 is in flight.
//   3. The last page stores the whole sorted list back into the cache.
// The dialog always refreshes on open (stale-while-revalidate) and never on
// a schedule; `evict_artist_group_caches` drops an artist's row once no
// unmatched album of theirs remains. Capped at 500 groups.

/// Albums first, then EPs, singles, compilations; oldest first within each.
fn sort_groups(out: &mut [GroupCandidate]) {
    out.sort_by(|a, b| {
        let rank = |t: &Option<String>| match t.as_deref() {
            Some("album") => 0,
            Some("ep") => 1,
            Some("single") => 2,
            Some("compilation") => 3,
            _ => 4,
        };
        rank(&a.album_type)
            .cmp(&rank(&b.album_type))
            .then_with(|| match (&a.first_release_date, &b.first_release_date) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
    });
}

const GROUP_PAGE_LIMIT: usize = 100;
const GROUP_CAP: usize = 500;

/// Pages fetched so far per artist, until the last one lands and the whole
/// list is written to the cache table.
static GROUP_PAGE_BUFFER: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<GroupCandidate>>>,
> = std::sync::OnceLock::new();

#[derive(Serialize)]
pub struct GroupsPage {
    pub groups: Vec<GroupCandidate>,
    pub total: usize,
    /// No more pages (end of discography, or the cap).
    pub done: bool,
}

/// The cached discography, if the dialog has browsed this artist before.
#[tauri::command]
pub async fn mb_artist_groups_cached(
    state: State<'_, AppState>,
    artist_mbid: String,
) -> Result<Option<Vec<GroupCandidate>>, String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT groups_json FROM mb_artist_groups_cache WHERE artist_mbid = ?")
            .bind(&artist_mbid)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(json,)| serde_json::from_str(&json).ok()))
}

/// One raw page of an artist's release groups: (groups, MB's total, done).
async fn fetch_artist_groups_page(
    client: &reqwest::Client,
    artist_mbid: &str,
    offset: usize,
) -> Result<(Vec<GroupCandidate>, usize, bool), String> {
    let offset_s = offset.to_string();
    let limit_s = GROUP_PAGE_LIMIT.to_string();
    let url = url::Url::parse_with_params(
        "https://musicbrainz.org/ws/2/release-group",
        &[
            ("artist", artist_mbid),
            ("inc", "artist-credits"),
            ("fmt", "json"),
            ("limit", limit_s.as_str()),
            ("offset", offset_s.as_str()),
        ],
    )
    .map_err(|e| e.to_string())?;
    let resp = mb_get(client, url).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let total = body["release-group-count"].as_i64().unwrap_or(0) as usize;
    let page: Vec<GroupCandidate> = body["release-groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| group_of(g, 100))
        .collect();
    let next = offset + page.len();
    let done = page.is_empty() || next >= total || next >= GROUP_CAP;
    Ok((page, total, done))
}

/// Sort and store a complete discography.
async fn store_artist_groups(
    pool: &SqlitePool,
    artist_mbid: &str,
    mut all: Vec<GroupCandidate>,
) -> Result<(), String> {
    sort_groups(&mut all);
    let json = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO mb_artist_groups_cache (artist_mbid, groups_json, fetched_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(artist_mbid) DO UPDATE SET
           groups_json = excluded.groups_json, fetched_at = excluded.fetched_at",
    )
    .bind(artist_mbid)
    .bind(&json)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// One page of an artist's release groups (offset 0 starts a fresh walk).
#[tauri::command]
pub async fn mb_artist_release_groups_page(
    state: State<'_, AppState>,
    artist_mbid: String,
    offset: usize,
) -> Result<GroupsPage, String> {
    let client = mb_client()?;
    let (page, total, done) = fetch_artist_groups_page(&client, &artist_mbid, offset).await?;
    let buffer = GROUP_PAGE_BUFFER.get_or_init(|| std::sync::Mutex::new(Default::default()));
    let complete: Option<Vec<GroupCandidate>> = {
        let mut map = buffer.lock().map_err(|e| e.to_string())?;
        let acc = map.entry(artist_mbid.clone()).or_default();
        if offset == 0 {
            acc.clear();
        }
        acc.extend(page.iter().cloned());
        if done {
            map.remove(&artist_mbid)
        } else {
            None
        }
    };
    if let Some(all) = complete {
        store_artist_groups(&state.app_db, &artist_mbid, all).await?;
    }
    Ok(GroupsPage { groups: page, total, done })
}

/// Drop every cached discography whose artist has no unmatched album left
/// (no album credited to them, in any library, still without a release
/// group and not ignored), and every cached release list whose group has
/// no album with an unresolved release left. Runs after a pass, an apply,
/// or an ignore — the moments an album stops being unmatched.
pub(crate) async fn evict_artist_group_caches(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(&format!(
        "DELETE FROM mb_artist_groups_cache
         WHERE artist_mbid NOT IN (
           SELECT ar.musicbrainz_id
           FROM album_artist_credit ac
           JOIN artist ar ON ar.id = ac.artist_id
           JOIN album al ON al.id = ac.album_id
           WHERE ar.musicbrainz_id IS NOT NULL AND ar.musicbrainz_id <> ''
             AND NOT EXISTS (SELECT 1 FROM field_override fo
                             WHERE fo.entity_id = al.id AND fo.field = 'mb_release_group_id' AND fo.value <> '')
             AND NOT EXISTS (SELECT 1 FROM field_override fo
                             WHERE fo.entity_id = al.id AND fo.field = '{MB_IGNORED}')
             AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
             AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
         )"
    ))
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "DELETE FROM mb_group_releases_cache
         WHERE group_id NOT IN (
           SELECT fo.value FROM field_override fo
           JOIN album al ON al.id = fo.entity_id
           WHERE fo.field = 'mb_release_group_id' AND fo.value <> ''
             AND EXISTS (SELECT 1 FROM album_release r
                         WHERE r.album_id = al.id
                           AND NOT EXISTS (SELECT 1 FROM release_match rm
                                           WHERE rm.album_id = r.album_id
                                             AND rm.folder_path = r.folder_path COLLATE NOCASE))
         )",
    )
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Release-list cache + prefetch jobs ─────────────────────────────────────

/// A group's releases in picker order: official first, oldest first.
async fn group_releases_sorted(
    client: &reqwest::Client,
    group_id: &str,
) -> Result<Vec<ReleaseCandidate>, String> {
    let mut releases = releases_in_group(client, group_id).await?;
    releases.sort_by(|a, b| {
        let official = |r: &ReleaseCandidate| r.status.as_deref() != Some("Official");
        official(a)
            .cmp(&official(b))
            .then_with(|| match (&a.date, &b.date) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
    });
    Ok(releases)
}

async fn store_group_releases(
    pool: &SqlitePool,
    group_id: &str,
    releases: &[ReleaseCandidate],
) -> Result<(), String> {
    let json = serde_json::to_string(releases).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO mb_group_releases_cache (group_id, releases_json, fetched_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(group_id) DO UPDATE SET
           releases_json = excluded.releases_json, fetched_at = excluded.fetched_at",
    )
    .bind(group_id)
    .bind(&json)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The matched release leads the list — it's the row the user came to
/// check, not something to scroll 40 pressings for.
fn pin_current(releases: &mut Vec<ReleaseCandidate>, current: Option<&str>) -> bool {
    let Some(cur) = current.filter(|c| !c.is_empty()) else { return true };
    if let Some(pos) = releases.iter().position(|r| r.release_id == cur) {
        let current = releases.remove(pos);
        releases.insert(0, current);
        true
    } else {
        false
    }
}

/// The cached release list for a group, if the picker (or the prefetch) has
/// fetched it before — no network. The current release is pinned when it's
/// in the list; a deeper one waits for the fresh fetch to look it up.
#[tauri::command]
pub async fn mb_group_releases_cached(
    state: State<'_, AppState>,
    group_id: String,
    current_release_id: Option<String>,
) -> Result<Option<Vec<ReleaseCandidate>>, String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT releases_json FROM mb_group_releases_cache WHERE group_id = ?")
            .bind(&group_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(json,)| serde_json::from_str::<Vec<ReleaseCandidate>>(&json).ok()).map(
        |mut releases| {
            pin_current(&mut releases, current_release_id.as_deref());
            releases
        },
    ))
}

#[derive(Serialize)]
pub struct PrefetchEstimate {
    /// Identified artists with an unmatched album here and no cached discography.
    pub artists: usize,
    /// Matched release groups with an unresolved release here and no cached list.
    pub groups: usize,
    pub groups_running: bool,
    pub releases_running: bool,
}

pub const PREFETCH_GROUPS_KIND: &str = "mb-prefetch-groups";
pub const PREFETCH_RELEASES_KIND: &str = "mb-prefetch-releases";

/// Artists whose discographies the groups prefetch would fetch: identified,
/// credited on an unmatched (un-ignored, real) album of this library, not
/// Various Artists, and not already cached.
async fn artists_needing_groups(
    pool: &SqlitePool,
    library_id: &str,
) -> Result<Vec<(String, String)>, String> {
    sqlx::query_as(&format!(
        "SELECT DISTINCT ar.musicbrainz_id, ar.title
         FROM album_artist_credit ac
         JOIN artist ar ON ar.id = ac.artist_id
         JOIN album al ON al.id = ac.album_id
         JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ?
           AND ar.musicbrainz_id IS NOT NULL AND ar.musicbrainz_id <> ''
           AND LOWER(ar.musicbrainz_id) <> '{VARIOUS_ARTISTS_MBID}'
           AND NOT EXISTS (SELECT 1 FROM field_override fo
                           WHERE fo.entity_id = al.id AND fo.field = 'mb_release_group_id' AND fo.value <> '')
           AND NOT EXISTS (SELECT 1 FROM field_override fo
                           WHERE fo.entity_id = al.id AND fo.field = '{MB_IGNORED}')
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM mb_artist_groups_cache c WHERE c.artist_mbid = ar.musicbrainz_id)
         ORDER BY ar.title"
    ))
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

/// Release groups whose release lists the releases prefetch would fetch:
/// matched, with at least one release of the album still unresolved (no
/// pin, no declared-none), not already cached.
async fn groups_needing_releases(
    pool: &SqlitePool,
    library_id: &str,
) -> Result<Vec<(String, String)>, String> {
    sqlx::query_as(
        "SELECT DISTINCT fo.value, al.title
         FROM field_override fo
         JOIN album al ON al.id = fo.entity_id
         JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ? AND fo.field = 'mb_release_group_id' AND fo.value <> ''
           AND EXISTS (SELECT 1 FROM album_release r
                       WHERE r.album_id = al.id
                         AND NOT EXISTS (SELECT 1 FROM release_match rm
                                         WHERE rm.album_id = r.album_id
                                           AND rm.folder_path = r.folder_path COLLATE NOCASE))
           AND NOT EXISTS (SELECT 1 FROM mb_group_releases_cache c WHERE c.group_id = fo.value)
         ORDER BY al.title",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

/// Various Artists' MB id — never prefetched (its "discography" is every
/// compilation ever entered; the dialog doesn't browse it either).
const VARIOUS_ARTISTS_MBID: &str = "89ad4ac3-39f7-470e-963a-56509c546377";

#[tauri::command]
pub async fn mb_prefetch_estimate(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<PrefetchEstimate, String> {
    let pool = &state.app_db;
    Ok(PrefetchEstimate {
        artists: artists_needing_groups(pool, &library_id).await?.len(),
        groups: groups_needing_releases(pool, &library_id).await?.len(),
        groups_running: crate::jobs::is_running(&format!("{PREFETCH_GROUPS_KIND}:{library_id}")),
        releases_running: crate::jobs::is_running(&format!("{PREFETCH_RELEASES_KIND}:{library_id}")),
    })
}

/// Wait out a running matching pass (it shares the MB request gate — a
/// prefetch alongside it would halve the pass) and any user-initiated MB
/// command (a click must never queue behind background fetches; polled
/// finely so the loop resumes the moment the click is served). True =
/// cancelled meanwhile.
async fn yield_to_pass(job: &crate::jobs::JobHandle) -> bool {
    loop {
        if job.cancelled() {
            break;
        }
        if pass_running() {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        } else if user_waiting() {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        } else {
            break;
        }
    }
    job.cancelled()
}

/// Background: fill the discography cache for every identified artist that
/// still has an unmatched album here. Fill-only — artists already cached
/// are skipped (the dialog refreshes those on open).
#[tauri::command]
pub async fn mb_prefetch_groups_start(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    let pool = state.app_db.clone();
    let artists = artists_needing_groups(&pool, &library_id).await?;
    let total = artists.len();
    let Some(job) = crate::jobs::start(
        &app,
        format!("{PREFETCH_GROUPS_KIND}:{library_id}"),
        PREFETCH_GROUPS_KIND,
        "prefetching release groups",
        Some(library_id.clone()),
        total,
    ) else {
        return Ok(());
    };
    tauri::async_runtime::spawn(async move {
        let Ok(client) = mb_client() else { return };
        let mut done = 0usize;
        for (mbid, name) in artists {
            if yield_to_pass(&job).await {
                break;
            }
            job.progress(done, total, Some(name.clone()));
            let mut all: Vec<GroupCandidate> = Vec::new();
            let mut offset = 0usize;
            let mut ok = true;
            loop {
                match fetch_artist_groups_page(&client, &mbid, offset).await {
                    Ok((page, _, finished)) => {
                        offset += page.len();
                        all.extend(page);
                        if finished {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("prefetch groups {name}: {e}");
                        ok = false;
                        break;
                    }
                }
                if job.cancelled() {
                    ok = false;
                    break;
                }
            }
            if ok {
                let _ = store_artist_groups(&pool, &mbid, all).await;
            }
            done += 1;
            job.progress(done, total, Some(name));
        }
        job.finish();
        use tauri::Emitter;
        let _ = app.emit("mb-prefetch-done", serde_json::json!({ "libraryId": library_id }));
    });
    Ok(())
}

/// Background: fill the release-list cache for every matched group here that
/// still has an unresolved release. Fill-only, like the groups prefetch.
#[tauri::command]
pub async fn mb_prefetch_releases_start(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    let pool = state.app_db.clone();
    let groups = groups_needing_releases(&pool, &library_id).await?;
    let total = groups.len();
    let Some(job) = crate::jobs::start(
        &app,
        format!("{PREFETCH_RELEASES_KIND}:{library_id}"),
        PREFETCH_RELEASES_KIND,
        "prefetching releases",
        Some(library_id.clone()),
        total,
    ) else {
        return Ok(());
    };
    tauri::async_runtime::spawn(async move {
        let Ok(client) = mb_client() else { return };
        let mut done = 0usize;
        for (group_id, title) in groups {
            if yield_to_pass(&job).await {
                break;
            }
            job.progress(done, total, Some(title.clone()));
            match group_releases_sorted(&client, &group_id).await {
                Ok(releases) => {
                    let _ = store_group_releases(&pool, &group_id, &releases).await;
                }
                Err(e) => eprintln!("prefetch releases {title}: {e}"),
            }
            done += 1;
            job.progress(done, total, Some(title));
        }
        job.finish();
        use tauri::Emitter;
        let _ = app.emit("mb-prefetch-done", serde_json::json!({ "libraryId": library_id }));
    });
    Ok(())
}

/// The releases of one release group, for the match dialog's release picker:
/// a group-matched album lists what's IN its group instead of making the
/// user search for what is already known. Official releases first, oldest
/// first — the top of the list is usually the standard edition.
#[tauri::command]
pub async fn mb_group_releases(
    group_id: String,
    // The album's currently matched release, if any: guaranteed a row even
    // when the group's release list is deeper than the page cap — fetched
    // directly and pinned to the top so "current" always has something to
    // mark.
    current_release_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ReleaseCandidate>, String> {
    let _priority = UserPriority::hold();
    let client = mb_client()?;
    let mut releases = group_releases_sorted(&client, &group_id).await?;
    // Fresh list → the cache (the picker serves it instantly next time and
    // refreshes through here in the background).
    store_group_releases(&state.app_db, &group_id, &releases).await?;
    if !pin_current(&mut releases, current_release_id.as_deref()) {
        if let Some(cur) = current_release_id.as_deref() {
            if let Ok(Some(c)) = lookup_release(&client, cur).await {
                releases.insert(0, c);
            }
        }
    }
    Ok(releases)
}

/// Queue a matched album for the next matching pass. The pass is what stamps
/// the artists a match's credits prove (pages new to the library are created
/// after the apply-time stamping walk), and this queue is the visible list of
/// matches still waiting for one. Deduped per album; unmatch removes the row;
/// a completed pass clears the library's whole queue.
/// One queue row: delete-then-insert keyed on target, so repeating an action
/// replaces its row (latest reason shown) instead of stacking duplicates.
/// Targets: a bare album id for album matches (the only kind whose row offers
/// an Unmatch button); prefixed forms — "artist:<id>", "artist:<id>:match",
/// "album:<id>:credits" — for everything else, distinct per cause so each
/// undo path can remove exactly the row its action created. Renames never
/// enqueue: matching after a rename is the user's call.
async fn enqueue_pass_row(
    pool: &SqlitePool,
    library_id: &str,
    target: &str,
    label: &str,
    batch_id: Option<i64>,
) -> Result<(), String> {
    sqlx::query("DELETE FROM pending_pass WHERE library_id = ? AND target = ?")
        .bind(library_id)
        .bind(target)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO pending_pass (library_id, target, label, batch_id) VALUES (?, ?, ?, ?)")
        .bind(library_id)
        .bind(target)
        .bind(label)
        .bind(batch_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The History batch of the newest live merge into this artist — what a
/// queue row's Undo points at. None when there isn't exactly one candidate
/// to name (no merge logged), so the queue shows "see History" instead.
async fn latest_merge_batch(pool: &SqlitePool, artist_id: i64) -> Result<Option<i64>, String> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT batch_id FROM mb_change_log
         WHERE target_id = ? AND kind = 'artist_merge' AND undone = 0 AND batch_id IS NOT NULL
         ORDER BY id DESC LIMIT 1",
    )
    .bind(artist_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|(b,)| b))
}

// ---------------------------------------------------------------------------
// Match-state dots for the grids and lists OUTSIDE the metadata center: one
// word per entity, coloured like the entity's own page chip.
//   "matched"   green  — artist: has an MBID; album: EVERY release resolved
//                        and its tracks line up; track: on such a release
//   "partial"   amber  — album: group known but a release still unpinned (a
//                        multi-version card stays amber until all are), or
//                        pinned with tracks that don't line up; track: on an
//                        album in that state, or itself an unpaired track
//   "unmatched" red    — nothing known
//   "ignored"   grey   — flagged out of matching (and nothing matched)
// Bulk, per library: the pages render hundreds of these per view.
// ---------------------------------------------------------------------------

pub(crate) async fn artist_dot_states(
    pool: &SqlitePool,
    library_id: &str,
) -> Result<HashMap<i64, &'static str>, String> {
    let rows: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT a.id,
                (a.musicbrainz_id IS NOT NULL AND a.musicbrainz_id <> '')
                  OR EXISTS (SELECT 1 FROM field_override o
                             WHERE o.entity_id = a.id AND o.field = 'mb_artist_id'
                               AND o.value IS NOT NULL AND o.value <> ''),
                EXISTS (SELECT 1 FROM field_override ig
                        WHERE ig.entity_id = a.id AND ig.field = 'mb_ignored')
         FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, matched, ignored)| {
            (id, if matched != 0 { "matched" } else if ignored != 0 { "ignored" } else { "unmatched" })
        })
        .collect())
}

pub(crate) async fn album_dot_states(
    pool: &SqlitePool,
    library_id: &str,
) -> Result<HashMap<i64, &'static str>, String> {
    // Same resolution rule as the metadata center's map: 'release' only
    // when every version carries a release_match row (a pin or the
    // declared-none sentinel); 'album' when the group is known or some
    // versions are pinned. Our-side gaps (a track of ours the release
    // doesn't pair) keep a pinned album amber, like its page chip.
    let rows: Vec<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT al.id,
                CASE
                  WHEN EXISTS (SELECT 1 FROM release_match rm WHERE rm.album_id = al.id)
                       AND NOT EXISTS (SELECT 1 FROM album_release ar
                                       WHERE ar.album_id = al.id
                                         AND NOT EXISTS (SELECT 1 FROM release_match rm2
                                                         WHERE rm2.album_id = al.id
                                                           AND rm2.folder_path = ar.folder_path COLLATE NOCASE)) THEN 'release'
                  WHEN EXISTS (SELECT 1 FROM release_match rm WHERE rm.album_id = al.id) THEN 'album'
                  WHEN EXISTS (SELECT 1 FROM field_override o
                               WHERE o.entity_id = al.id AND o.field = 'mb_release_group_id'
                                 AND o.value IS NOT NULL AND o.value <> '') THEN 'album'
                  ELSE 'none'
                END,
                COALESCE((SELECT SUM(side = 'ours') FROM album_match_gap g WHERE g.album_id = al.id), 0),
                EXISTS (SELECT 1 FROM field_override ig
                        WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored')
         FROM album al JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, state, gap_ours, ignored)| {
            let dot = match state.as_str() {
                "release" if gap_ours > 0 => "partial",
                "release" => "matched",
                "album" => "partial",
                _ if ignored != 0 => "ignored",
                _ => "unmatched",
            };
            (id, dot)
        })
        .collect())
}

pub(crate) async fn track_dot_states(
    pool: &SqlitePool,
    library_id: &str,
) -> Result<HashMap<i64, &'static str>, String> {
    // Album tracks take their release's state, minus their own gap row (a
    // track the release didn't pair is amber on its own). Loose tracks match
    // on their own recording.
    let rows: Vec<(i64, i64, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT t.id,
                EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = me.parent_id),
                EXISTS (SELECT 1 FROM track_release tr
                        JOIN album_release ar ON ar.id = tr.release_id
                        JOIN release_match rm ON rm.album_id = ar.album_id
                                             AND rm.folder_path = ar.folder_path COLLATE NOCASE
                        WHERE tr.track_id = t.id),
                EXISTS (SELECT 1 FROM field_override o
                        WHERE o.entity_id = me.parent_id AND o.field = 'mb_release_group_id'
                          AND o.value IS NOT NULL AND o.value <> ''),
                EXISTS (SELECT 1 FROM album_match_gap g
                        JOIN track_release tr2 ON tr2.track_id = t.id
                        JOIN album_release ar2 ON ar2.id = tr2.release_id
                        WHERE g.album_id = me.parent_id AND g.side = 'ours'
                          AND g.folder_path = ar2.folder_path COLLATE NOCASE
                          AND g.disc = COALESCE(t.disc_number, 1)
                          AND g.position = COALESCE(t.track_number, 0)),
                EXISTS (SELECT 1 FROM field_override r
                        WHERE r.entity_id = t.id AND r.field = 'mb_recording_id'
                          AND r.value IS NOT NULL AND r.value <> ''),
                EXISTS (SELECT 1 FROM field_override ig
                        WHERE ig.entity_id = me.parent_id AND ig.field = 'mb_ignored')
         FROM track t JOIN media_entry me ON me.id = t.id
         WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, loose, release_matched, group_matched, gapped, recording, album_ignored)| {
            let dot = if loose != 0 {
                if recording != 0 { "matched" } else { "unmatched" }
            } else if release_matched != 0 {
                if gapped != 0 { "partial" } else { "matched" }
            } else if group_matched != 0 {
                "partial"
            } else if album_ignored != 0 {
                "ignored"
            } else {
                "unmatched"
            };
            (id, dot)
        })
        .collect())
}

pub(crate) async fn enqueue_pass_work(
    pool: &SqlitePool,
    library_id: &str,
    album_id: i64,
) -> Result<(), String> {
    let (title,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    enqueue_pass_row(
        pool,
        library_id,
        &album_id.to_string(),
        &format!("Match \u{201c}{title}\u{201d}"),
        None,
    )
    .await
}

/// Artist-flavored twin of enqueue_pass_work, for merges and alias links: the
/// survivor answers to new names and its exhaustion rows were cleared, so a
/// pass may now prove what it previously couldn't (alias-aware harvest
/// matches, fresh derive walks, arid album retries). The label names the
/// absorbed spelling — a bare "Re-check X" didn't say why.
pub(crate) async fn enqueue_pass_recheck(
    pool: &SqlitePool,
    library_id: &str,
    artist_id: i64,
    artist_title: &str,
    merged_name: &str,
    // `undoable`: this re-check came from ONE merge — link its History batch
    // so the queue can undo it in place. A cluster of several merges passes
    // false: one row can't stand for several changes.
    undoable: bool,
) -> Result<(), String> {
    let batch_id = if undoable { latest_merge_batch(pool, artist_id).await? } else { None };
    enqueue_pass_row(
        pool,
        library_id,
        &format!("artist:{artist_id}"),
        &format!(
            "Re-check \u{201c}{artist_title}\u{201d} \u{2014} \u{201c}{merged_name}\u{201d} merged in"
        ),
        batch_id,
    )
    .await
}

/// After a USER artist match: the fresh MBID re-arms the arid-tier retry for
/// every notfound OR uncertain album whose first credit is this artist — a
/// scoped search far sharper than the name search that already ran (it finds
/// what that missed, and narrows same-named candidates to the artist's own).
/// Enqueues only when at least one such album exists; matching an artist
/// whose albums are all matched (or arid-exhausted) creates no pass work, so
/// no row.
pub(crate) async fn enqueue_artist_match_recheck(
    pool: &SqlitePool,
    library_id: &str,
    artist_id: i64,
) -> Result<(), String> {
    // Mirror of the retry_albums estimate in music_match_state / the arid
    // retry selection in enrich_albums, scoped to this one artist.
    let (retry,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM album al
         JOIN media_entry me ON me.id = al.id
         JOIN album_artist_credit ac0
              ON ac0.album_id = al.id
             AND ac0.position = (SELECT MIN(position) FROM album_artist_credit
                                 WHERE album_id = al.id)
         JOIN artist ar ON ar.id = ac0.artist_id
         WHERE me.library_id = ? AND ar.id = ?
           AND ar.musicbrainz_id IS NOT NULL AND ar.musicbrainz_id <> ''
           AND EXISTS (SELECT 1 FROM mb_credit_fetch f
                       WHERE f.album_id = al.id AND f.status IN ('notfound', 'uncertain'))
           AND NOT EXISTS (SELECT 1 FROM mb_derive_exhausted x
                           WHERE x.entity_id = al.id
                             AND x.evidence_key = 'arid:' || ar.musicbrainz_id)
           AND NOT EXISTS (SELECT 1 FROM mb_suppression s
                           WHERE s.kind = 'album_match' AND s.target_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored')
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)",
    )
    .bind(library_id)
    .bind(artist_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    if retry == 0 {
        return Ok(());
    }
    let (title,): (String,) = sqlx::query_as("SELECT title FROM artist WHERE id = ?")
        .bind(artist_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let noun = if retry == 1 { "album" } else { "albums" };
    enqueue_pass_row(
        pool,
        library_id,
        &format!("artist:{artist_id}:match"),
        &format!(
            "Re-check \u{201c}{title}\u{201d} \u{2014} {retry} unmatched {noun} now searchable by artist"
        ),
        None,
    )
    .await
}

/// Credits changed on a track (an MB match applied them, or the user edited
/// them): if the parent album is matched — its group/release IS derive
/// evidence — and any credited artist still lacks an MBID, a pass can try to
/// prove them from that evidence. Loose and sound containers hold no albums
/// to re-check; ignored albums have left the machinery.
pub(crate) async fn enqueue_track_credit_recheck(
    pool: &SqlitePool,
    library_id: &str,
    track_id: i64,
) -> Result<(), String> {
    let album: Option<(i64, String)> = sqlx::query_as(
        "SELECT al.id, al.title FROM media_entry tme
         JOIN album al ON al.id = tme.parent_id
         WHERE tme.id = ?
           AND (EXISTS (SELECT 1 FROM field_override f
                        WHERE f.entity_id = al.id
                          AND f.field = 'mb_release_group_id')
             OR EXISTS (SELECT 1 FROM release_match rm
                        WHERE rm.album_id = al.id AND rm.mb_release_id <> ''))
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored')
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)
           AND EXISTS (SELECT 1 FROM track_credit tc
                       JOIN artist a ON a.id = tc.artist_id
                       WHERE tc.track_id = tme.id
                         AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = ''))",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((album_id, title)) = album else { return Ok(()) };
    enqueue_pass_row(
        pool,
        library_id,
        &format!("album:{album_id}:credits"),
        &format!("Re-check \u{201c}{title}\u{201d} \u{2014} new credits"),
        None,
    )
    .await
}

/// The user edited an album's artist credits. Two things that can arm a pass:
/// on a MATCHED album, a newly credited co-artist without an MBID is derivable
/// from the album's own evidence; on a NOTFOUND album, a new first-credit
/// artist who carries an MBID re-arms the arid retry (its exhaustion key is
/// per-artist-identity, so a different artist means an unburned search).
pub(crate) async fn enqueue_album_credit_recheck(
    pool: &SqlitePool,
    library_id: &str,
    album_id: i64,
) -> Result<(), String> {
    let gate: Option<(String, i64, i64)> = sqlx::query_as(
        "SELECT al.title,
                (EXISTS (SELECT 1 FROM field_override f
                         WHERE f.entity_id = al.id
                           AND f.field = 'mb_release_group_id')
                  OR EXISTS (SELECT 1 FROM release_match rm
                             WHERE rm.album_id = al.id AND rm.mb_release_id <> ''))
                AND EXISTS (SELECT 1 FROM album_artist_credit ac
                            JOIN artist a ON a.id = ac.artist_id
                            WHERE ac.album_id = al.id
                              AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')),
                EXISTS (SELECT 1 FROM mb_credit_fetch f
                        WHERE f.album_id = al.id AND f.status IN ('notfound', 'uncertain'))
                AND EXISTS (SELECT 1 FROM album_artist_credit ac0
                            JOIN artist ar ON ar.id = ac0.artist_id
                            WHERE ac0.album_id = al.id
                              AND ac0.position = (SELECT MIN(position)
                                                  FROM album_artist_credit
                                                  WHERE album_id = al.id)
                              AND ar.musicbrainz_id IS NOT NULL
                              AND ar.musicbrainz_id <> ''
                              AND NOT EXISTS (SELECT 1 FROM mb_derive_exhausted x
                                              WHERE x.entity_id = al.id
                                                AND x.evidence_key = 'arid:' || ar.musicbrainz_id))
         FROM album al
         JOIN media_entry me ON me.id = al.id
         WHERE al.id = ?
           AND NOT EXISTS (SELECT 1 FROM mb_suppression s
                           WHERE s.kind = 'album_match' AND s.target_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM field_override ig
                           WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored')
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)",
    )
    .bind(album_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((title, derivable, retryable)) = gate else { return Ok(()) };
    if derivable != 0 {
        enqueue_pass_row(
            pool,
            library_id,
            &format!("album:{album_id}:credits"),
            &format!("Re-check \u{201c}{title}\u{201d} \u{2014} new credits"),
            None,
        )
        .await
    } else if retryable != 0 {
        enqueue_pass_row(
            pool,
            library_id,
            &format!("album:{album_id}:credits"),
            &format!("Search \u{201c}{title}\u{201d} \u{2014} credits changed"),
            None,
        )
        .await
    } else {
        Ok(())
    }
}

/// The user renamed a NOTFOUND album. Retries only re-run the arid tier —
/// "the name tier is exactly what already failed" — but that reasoning died
/// with the old title, so the notfound stamp is cleared and the album reads
/// unchecked again. Nothing is enqueued: whether to search under the new
/// name is the user's call (a pass they run, or the match dialog).
pub(crate) async fn forget_album_notfound(pool: &SqlitePool, album_id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM mb_credit_fetch WHERE album_id = ? AND status = 'notfound'")
        .bind(album_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The user renamed an artist. The derive and harvest walks compare NAMES, so
/// a corrected spelling can flip a fruitless walk to fruitful — the same
/// reasoning that has merges clear exhaustion. Clears this artist's exhaustion
/// rows so the next pass the user runs walks again; enqueues nothing.
pub(crate) async fn forget_artist_exhaustion(pool: &SqlitePool, artist_id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM mb_derive_exhausted WHERE entity_id = ?")
        .bind(artist_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct PendingPassRow {
    pub id: i64,
    /// Album entry id, as text (matches pending_change's target shape).
    pub target: String,
    pub label: String,
    /// The History batch that queued this row, when exactly one change did
    /// — the queue's Undo runs it (and the undo clears the row).
    pub batch_id: Option<i64>,
}

/// The matching-pass queue — the pass-side twin of get_pending_changes.
#[tauri::command]
pub async fn get_pending_pass(
    state: State<'_, AppState>,
    library_id: String,
) -> Result<Vec<PendingPassRow>, String> {
    let rows: Vec<(i64, String, String, Option<i64>)> = sqlx::query_as(
        "SELECT id, target, label, batch_id FROM pending_pass WHERE library_id = ? ORDER BY id",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, target, label, batch_id)| PendingPassRow { id, target, label, batch_id })
        .collect())
}

/// An explicit user match is an INSTRUCTION, not a suggestion — so it starts
/// from a clean slate. Suppressions exist to stop the AUTOMATIC pass from
/// re-applying something you undid; letting them survive a match you just
/// asked for produces an album carrying MusicBrainz ids but none of the data
/// (undoing a match from History writes a suppression per field it reverted,
/// so the SECOND match silently skipped credits, type and dates).
/// mb_unmatch_entity already clears these for the same reason.
async fn clear_suppressions(pool: &SqlitePool, entity_id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM mb_suppression WHERE target_id = ?")
        .bind(entity_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply a chosen release to an album (modal candidate pick or manual search
/// result). Same application path as a confident auto-match. `release_db_id`
/// names WHICH release of the album this pressing is — the version the user
/// was viewing; absent (metadata-center dialogs), the default release.
#[tauri::command]
pub async fn mb_apply_album_match(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    album_id: i64,
    mb_release_id: String,
    release_db_id: Option<i64>,
) -> Result<(), String> {
    let _priority = UserPriority::hold();
    ensure_not_matching(&state.app_db, &library_id).await?;
    let pool = &state.app_db;
    crate::music_edit::ensure_not_staged(pool, album_id).await?;
    clear_suppressions(pool, album_id).await?;
    let folder = match release_db_id {
        Some(rid) => sqlx::query_as::<_, (String,)>(
            "SELECT folder_path FROM album_release WHERE id = ? AND album_id = ?",
        )
        .bind(rid)
        .bind(album_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .map(|(f,)| f)
        .ok_or("Release not found on this album")?,
        None => default_release_folder(pool, album_id)
            .await?
            .ok_or("Album has no releases")?,
    };
    let client = mb_client()?;
    let (album_title,): (String,) = sqlx::query_as("SELECT title FROM album WHERE id = ?")
        .bind(album_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let full = fetch_release(&client, &mb_release_id)
        .await?
        .ok_or_else(|| "release has no usable track data".to_string())?;
    apply_release(pool, &library_id, album_id, &album_title, &full, TIER_USER, &folder).await?;
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
    // Applied credits can carry names new to the library: pages for them, and
    // fresh stamps for every touched row (ensure ends with resolve_credit_ids).
    crate::music::ensure_credit_artists(pool, &library_id).await?;
    // Second stamping walk, AFTER the pages exist: the walk inside
    // apply_release ran before ensure created pages for names new to the
    // library, so those pages were born id-less even though the fetched
    // credit carried their MBID. Pure database work — no new fetches.
    {
        let mut seen = std::collections::HashSet::new();
        let mut credit_pairs: Vec<(String, Option<String>)> = Vec::new();
        for (name, id) in full
            .album_artists
            .iter()
            .chain(full.tracks.iter().flat_map(|t| t.credits.iter()))
        {
            if id.is_some() && seen.insert(name.clone()) {
                credit_pairs.push((name.clone(), id.clone()));
            }
        }
        stamp_artist_ids_from_credit(pool, &library_id, &credit_pairs, &full.artist_names).await?;
    }
    enqueue_pass_work(pool, &library_id, album_id).await?;
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
    ensure_not_matching(&state.app_db, &library_id).await?;
    let pool = &state.app_db;
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT kind, payload, target_key FROM mb_suggestion WHERE id = ? AND library_id = ?",
    )
    .bind(suggestion_id)
    .bind(&library_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((kind, payload, target_key)) = row else {
        return Err("suggestion not found".to_string());
    };

    if !accept {
        sqlx::query("UPDATE mb_suggestion SET status = 'rejected' WHERE id = ?")
            .bind(suggestion_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        // A "no" is as much a decision as a "yes" — log it so history holds
        // every answer, and so a misclicked rejection has an undo (which
        // returns the card to pending).
        let p: serde_json::Value = serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
        let label = match kind.as_str() {
            "artist_match" => format!(
                "{} — suggested match declined",
                p["artist_name"].as_str().unwrap_or("artist")
            ),
            "album_match" => format!(
                "{} — suggested match declined",
                p["album_title"].as_str().unwrap_or("album")
            ),
            "artist_merge" => format!(
                "{} and {} kept separate",
                p["keep_title"].as_str().unwrap_or("?"),
                p["other_name"].as_str().unwrap_or("?")
            ),
            _ => "suggestion declined".to_string(),
        };
        // Merge suggestions key on a name, not an entity id — fall back to
        // the payload's artist hint so the row still points somewhere real.
        let target_id = target_key
            .parse::<i64>()
            .ok()
            .or_else(|| p["keep_id"].as_i64())
            .unwrap_or(0);
        let batch = next_batch(pool).await?;
        log_change(
            pool,
            &library_id,
            "suggestion_rejected",
            target_id,
            &label,
            &serde_json::json!({ "suggestion_id": suggestion_id }),
            &serde_json::json!({ "status": "rejected" }),
            batch,
        )
        .await?;
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
            merge_artists(pool, &library_id, keep_id, &keep_title, other_id.map(|(id,)| id), other_name, "user")
                .await?;
            enqueue_pass_recheck(pool, &library_id, keep_id, &keep_title, other_name, true).await?;
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
    ensure_not_matching(&state.app_db, &library_id).await?;
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
                    // The retracted value leaves the MB tier too — reapply
                    // would resurrect it after the next rescan otherwise.
                    clear_mb_tier(pool, track_id, "credits").await?;
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
                    // The credits these rows advertised as fresh evidence are
                    // gone — drop the parent album's re-check row, if any.
                    sqlx::query(
                        "DELETE FROM pending_pass WHERE library_id = ?
                           AND target = 'album:' || (SELECT parent_id FROM media_entry
                                                     WHERE id = ?) || ':credits'",
                    )
                    .bind(&library_id)
                    .bind(track_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        "track_titles" => {
            if let Some(map) = before.as_object() {
                for (track_id, title) in map {
                    let Ok(track_id) = track_id.parse::<i64>() else { continue };
                    // The retracted title leaves the MB tier too — reapply
                    // would put it back after the next rescan otherwise.
                    clear_mb_tier(pool, track_id, "title").await?;
                    if crate::music_edit::has_override(pool, track_id, "title").await? {
                        continue;
                    }
                    if let Some(t) = title.as_str() {
                        sqlx::query("UPDATE track SET title = ?, sort_title = ? WHERE id = ?")
                            .bind(t)
                            .bind(crate::commands::generate_sort_title(t, "en"))
                            .bind(track_id)
                            .execute(pool)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        "album_artists" => {
            clear_mb_tier(pool, target_id, "artist_credits").await?;
            // User-set credits stay put through an MB undo too.
            if !crate::music_edit::has_override(pool, target_id, "artist_credits").await? {
                sqlx::query("DELETE FROM album_artist_credit WHERE album_id = ?")
                    .bind(target_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                let names: Vec<&str> = before["names"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|n| n.as_str())
                    .collect();
                // Solo credit sets are real now too — restore any non-empty
                // set (an empty one means pre-13 data; resolve_credit_ids
                // refills the solo row from the parent).
                if !names.is_empty() {
                    for (i, name) in names.iter().enumerate() {
                        sqlx::query(
                            "INSERT INTO album_artist_credit (album_id, position, name) VALUES (?, ?, ?)",
                        )
                        .bind(target_id)
                        .bind(i as i64)
                        .bind(name)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        "album_title" => {
            clear_mb_tier(pool, target_id, "title").await?;
            if let Some(t) = before["title"].as_str() {
                sqlx::query("UPDATE album SET title = ?, sort_title = ? WHERE id = ?")
                    .bind(t)
                    .bind(crate::commands::generate_sort_title(t, "en"))
                    .bind(target_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        "artist_persona" => {
            match before["parent_id"].as_i64() {
                Some(p) => {
                    sqlx::query(
                        "INSERT OR REPLACE INTO artist_persona (persona_id, parent_id) VALUES (?, ?)",
                    )
                    .bind(target_id)
                    .bind(p)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                }
                None => {
                    sqlx::query("DELETE FROM artist_persona WHERE persona_id = ?")
                        .bind(target_id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        "artist_rename" => {
            // The display name goes back, and the MB tier with it. The alias
            // the rename created is the name coming back — dropped, since a
            // redirect to the page's own title says nothing. Other aliases
            // stay and keep references resolving.
            clear_mb_tier(pool, target_id, "title").await?;
            if let Some(t) = before["title"].as_str() {
                sqlx::query("UPDATE artist SET title = ?, sort_title = ? WHERE id = ?")
                    .bind(t)
                    .bind(crate::commands::generate_sort_title(t, "en"))
                    .bind(target_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                crate::music_edit::drop_self_alias(pool, target_id).await?;
            }
        }
        "album_type" => {
            clear_mb_tier(pool, target_id, "album_type").await?;
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
            // Drop the adopted mb-tier date too — reapply re-stomps it after
            // every rescan otherwise, resurrecting what was just undone.
            sqlx::query(
                "DELETE FROM field_override WHERE entity_id = ? AND field = 'release_date' AND tier = 'mb'",
            )
            .bind(target_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
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
                        // Sources weren't recorded in the payload — restored
                        // aliases come back as the user's (visible, never
                        // pruned), the conservative reading.
                        sqlx::query("INSERT OR IGNORE INTO artist_alias (artist_id, name, source) VALUES (?, ?, 'user')")
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
            // What the undo leaves behind depends on who merged. The
            // automatic same-id merge (alias_source 'mb', or a legacy row
            // without the field) gets a standing "no" so the next pass can't
            // redo it. A merge a PERSON clicked ('user') just goes back to a
            // pending question — the identity card returns as it was, and
            // "they're different artists" stays a decision only they make.
            if !other_title.is_empty() {
                let automatic = before["alias_source"].as_str().unwrap_or("mb") == "mb";
                if automatic {
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
                } else {
                    sqlx::query(
                        "UPDATE mb_suggestion SET status = 'pending'
                         WHERE library_id = ? AND kind = 'artist_merge' AND target_key = ?
                           AND status = 'accepted'",
                    )
                    .bind(&library_id)
                    .bind(other_title.to_lowercase())
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                }
            }
            // The undone merge has nothing left for a pass to re-check.
            sqlx::query("DELETE FROM pending_pass WHERE library_id = ? AND target = ?")
                .bind(&library_id)
                .bind(format!("artist:{target_id}"))
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            // The merge re-pointed every credit stamped with the absorbed
            // page to the survivor. With that page (and its names) back, a
            // full re-resolve moves those stamps home — the resolver rewrites
            // every row whose exact-name lookup disagrees with what's stored.
            crate::music::resolve_credit_ids(pool, &library_id).await?;
        }
        "alias_kind" => {
            // Historical: alias classification (misspelling / nickname) was
            // retired 2026-09-20 with the kind column. Old entries stay
            // readable in History; undoing one has nothing left to restore.
        }
        "artist_mbid" => {
            // Restore the pre-match id — null for a suggestion-accepted
            // match, returning the artist to unidentified. The settled
            // suggestion deliberately stays settled (never re-ask); the
            // artist remains matchable via Match or the evidence pass.
            let prev = before["musicbrainz_id"].as_str().filter(|s| !s.is_empty());
            sqlx::query("UPDATE artist SET musicbrainz_id = ? WHERE id = ?")
                .bind(prev)
                .bind(target_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            clear_mb_id(pool, target_id, MB_ARTIST).await?;
            if let Some(prev) = prev {
                // An earlier id existed (evidence stamp mirrored in the
                // column) — keep it on record at mb tier.
                set_mb_id(pool, target_id, MB_ARTIST, prev, TIER_MB).await?;
            }
            // The arid retries the match re-armed went with the id.
            sqlx::query("DELETE FROM pending_pass WHERE library_id = ? AND target = ?")
                .bind(&library_id)
                .bind(format!("artist:{target_id}:match"))
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        "album_match" => {
            // Forget the ids the match wrote, un-stamp the fetch so the album
            // reads unchecked, and restore whatever stood before. Release
            // pins are per-release (folder in the payload; legacy payloads
            // fall back to the default release). The suppression written
            // below keeps the automatic pass from re-concluding the same
            // match next pass; Unmatch clears it for a true start-over.
            let folder = match before["folder"].as_str().filter(|s| !s.is_empty()) {
                Some(f) => Some(f.to_string()),
                None => default_release_folder(pool, target_id).await?,
            };
            if let Some(f) = &folder {
                sqlx::query("DELETE FROM release_match WHERE album_id = ? AND folder_path = ?")
                    .bind(target_id)
                    .bind(f)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                sqlx::query("DELETE FROM album_match_gap WHERE album_id = ? AND folder_path = ?")
                    .bind(target_id)
                    .bind(f)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            clear_mb_id(pool, target_id, MB_RELEASE_GROUP).await?;
            sqlx::query("UPDATE album SET mb_release_group_id = NULL WHERE id = ?")
                .bind(target_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM mb_credit_fetch WHERE album_id = ?")
                .bind(target_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            // The undone match has nothing left for a pass to cash in.
            sqlx::query("DELETE FROM pending_pass WHERE library_id = ? AND target = ?")
                .bind(&library_id)
                .bind(target_id.to_string())
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            let prev_group = before["release_group_id"].as_str().filter(|s| !s.is_empty());
            if let Some(g) = prev_group {
                set_mb_id(pool, target_id, MB_RELEASE_GROUP, g, TIER_MB).await?;
                sqlx::query("UPDATE album SET mb_release_group_id = ? WHERE id = ?")
                    .bind(g)
                    .bind(target_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            let prev_release = before["release_id"].as_str().filter(|s| !s.is_empty());
            if let (Some(r), Some(f)) = (prev_release, &folder) {
                set_release_match(pool, target_id, f, r, TIER_MB).await?;
            }
            if prev_group.is_some() || prev_release.is_some() {
                stamp(pool, target_id, "matched").await?;
            }
        }
        "track_match" => {
            // Same shape as artist_mbid: drop the id, restore any earlier one
            // at mb tier. Credits the match rewrote are their own row.
            clear_mb_id(pool, target_id, MB_RECORDING).await?;
            if let Some(prev) = before["recording_id"].as_str().filter(|s| !s.is_empty()) {
                set_mb_id(pool, target_id, MB_RECORDING, prev, TIER_MB).await?;
            }
        }
        "mb_ignored" => {
            // Restore the previous ignored state — the flag flips back.
            if before["ignored"].as_bool().unwrap_or(false) {
                set_mb_id(pool, target_id, MB_IGNORED, "1", TIER_USER).await?;
            } else {
                clear_mb_id(pool, target_id, MB_IGNORED).await?;
            }
        }
        "album_partial" => {
            // Same shape: the declaration flips back.
            if before["partial"].as_bool().unwrap_or(false) {
                set_mb_id(pool, target_id, MB_PARTIAL, "1", TIER_USER).await?;
            } else {
                clear_mb_id(pool, target_id, MB_PARTIAL).await?;
            }
        }
        "release_no_mb" => {
            // The per-release declaration flips back on its folder.
            let folder = match before["folder"].as_str().filter(|f| !f.is_empty()) {
                Some(f) => f.to_string(),
                None => default_release_folder(pool, target_id).await?.unwrap_or_default(),
            };
            if before["declared"].as_bool().unwrap_or(false) {
                set_release_match(pool, target_id, &folder, "", TIER_NONE).await?;
            } else {
                sqlx::query(
                    "DELETE FROM release_match WHERE album_id = ? AND folder_path = ? AND mb_release_id = ''",
                )
                .bind(target_id)
                .bind(&folder)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        "suggestion_rejected" => {
            // The card returns to pending — the one place a settled answer
            // deliberately unsettles, because the settled state IS the change
            // being undone. Row gone (merged away, swept)? Nothing to
            // restore; the undo still marks itself done below.
            if let Some(sid) = before["suggestion_id"].as_i64() {
                sqlx::query(
                    "UPDATE mb_suggestion SET status = 'pending' WHERE id = ? AND status = 'rejected'",
                )
                .bind(sid)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        other => return Err(format!("change kind '{other}' cannot be undone")),
    }

    // Merge suppression is handled by the rejected suggestion row above;
    // un-rejecting, un-ignoring, and alias-kind flips have nothing to
    // suppress (nothing automatic ever re-applies them); the rest suppress
    // by (kind, target).
    if kind != "artist_merge"
        && kind != "suggestion_rejected"
        && kind != "mb_ignored"
        && kind != "alias_kind"
        && kind != "album_partial"
        && kind != "release_no_mb"
    {
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

    // Restored credits may name artists the sweep since removed (pages come
    // back), and every row the undo rewrote needs a fresh stamp — including
    // re-resolving names away from a keep-artist after an unmerge.
    crate::music::ensure_credit_artists(pool, &library_id).await?;

    let _ = app.emit(
        "music-enrich-done",
        serde_json::json!({ "libraryId": library_id, "updated": 0, "albumsMatched": 0, "processed": 0, "pendingReview": 0 }),
    );
    Ok(())
}
