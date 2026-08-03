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

/// GET with 503 patience: MusicBrainz sheds load in waves of Service
/// Unavailable, so wait it out (5s, then 15s) before giving the item up as a
/// transient failure. Cancellation (skip-remaining) aborts the waits.
async fn mb_get(
    client: &reqwest::Client,
    url: url::Url,
) -> Result<reqwest::Response, String> {
    let mut delay = std::time::Duration::from_secs(5);
    for attempt in 0..3 {
        let resp = client.get(url.clone()).send().await.map_err(|e| e.to_string())?;
        if resp.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE
            && attempt < 2
            && !CANCEL.load(Ordering::SeqCst)
        {
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
    // Backstop for the per-library opt-out — the UI hides every entry point,
    // but no pass should ever reach MusicBrainz against a recorded "off".
    let pool = app.state::<AppState>().app_db.clone();
    if !crate::commands::library_online_metadata(&pool, &library_id).await? {
        return Err("Online metadata is turned off for this library".to_string());
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
    /// Albums never checked against MusicBrainz (no stamp).
    pub unchecked: i64,
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
    let (unchecked_artists,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?1 AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')
           AND (EXISTS (SELECT 1 FROM album_artist_credit ac
                        JOIN field_override f ON f.entity_id = ac.album_id
                           AND f.field = 'mb_release_group_id'
                        WHERE ac.artist_id = a.id)
             OR EXISTS (SELECT 1 FROM track_credit tc
                        JOIN media_entry tme ON tme.id = tc.track_id
                        JOIN field_override f ON f.entity_id = tme.parent_id
                           AND f.field = 'mb_release_id'
                        WHERE tc.artist_id = a.id)
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
    // Unchecked albums, plus NOT-FOUND albums whose artist has since been
    // identified: an arid-scoped search is strictly stronger evidence than
    // the name search that failed, so those earn a re-try each pass.
    let albums: Vec<(i64, String, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT al.id, al.title, ar.title, ar.musicbrainz_id,
                COALESCE((SELECT f.status FROM mb_credit_fetch f WHERE f.album_id = al.id), '')
         FROM album al
         JOIN media_entry me ON me.id = al.id
         LEFT JOIN artist ar ON ar.id = me.parent_id
         WHERE me.library_id = ?
           AND (NOT EXISTS (SELECT 1 FROM mb_credit_fetch f WHERE f.album_id = al.id)
                OR (EXISTS (SELECT 1 FROM mb_credit_fetch f
                            WHERE f.album_id = al.id AND f.status = 'notfound')
                    AND ar.musicbrainz_id IS NOT NULL AND ar.musicbrainz_id <> ''))
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
        // this is, so it wins outright and brings track credits with it.
        let tagged_release: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT mb_release_id FROM album_release WHERE album_id = ? AND is_default = 1",
        )
        .bind(album_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if let Some((Some(release_id),)) = tagged_release {
            if !release_id.is_empty() {
                match fetch_release(client, &release_id).await {
                    Ok(Some(full)) => {
                        apply_release(pool, library_id, album_id, &title, &full, TIER_MB).await?;
                        stamp(pool, album_id, "matched").await?;
                        matched += 1;
                        continue;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("musicbrainz tagged release '{title}': {e}");
                        continue; // transient — unstamped, retried next pass
                    }
                }
            }
        }

        // Otherwise identify the ALBUM only. Attempts run strongest-evidence
        // first: an identified artist scopes the search to their discography
        // (arid:), which is near-deterministic; the name-text scope is the
        // fallback so a differently-credited group (compilations, joint
        // credits filed under one member) is still findable. Each tier tries
        // the title as tagged, then with store/ripper decorations stripped —
        // `[88.2/24 Tidal]` is the most common reason a search finds nothing.
        // Re-tried not-founds run ONLY the arid tier: the name tier is
        // exactly what already failed, and repeating it would bill two
        // pointless requests per album every pass.
        let arid = artist_mbid.as_deref().filter(|s| !s.is_empty());
        let retry = prior_stamp == "notfound";
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
        } else if !credible.is_empty() {
            let payload = serde_json::json!({
                "album_id": album_id,
                "album_title": title,
                "artist_title": artist,
                "groups": credible.iter().take(5).collect::<Vec<_>>(),
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

pub const TIER_USER: &str = "user";
pub const TIER_MB: &str = "mb";

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
/// field_override like the ids — per entity, rescan-proof.
#[tauri::command]
pub async fn mb_set_ignored(
    state: State<'_, AppState>,
    entity_id: i64,
    ignored: bool,
) -> Result<(), String> {
    let pool = &state.app_db;
    if ignored {
        set_mb_id(pool, entity_id, MB_IGNORED, "1", TIER_USER).await
    } else {
        clear_mb_id(pool, entity_id, MB_IGNORED).await
    }
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
        country: r["country"].as_str().map(|s| s.to_string()),
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
    tokio::time::sleep(REQUEST_GAP).await;
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
    tokio::time::sleep(REQUEST_GAP).await;
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
    let url = url::Url::parse_with_params(
        "https://musicbrainz.org/ws/2/release",
        &[
            ("release-group", id),
            ("inc", "artist-credits+labels+media"),
            ("fmt", "json"),
            ("limit", "25"),
        ],
    )
    .map_err(|e| e.to_string())?;
    let resp = mb_get(client, url).await?;
    tokio::time::sleep(REQUEST_GAP).await;
    if resp.status() == reqwest::StatusCode::NOT_FOUND
        || resp.status() == reqwest::StatusCode::BAD_REQUEST
    {
        return Ok(Vec::new());
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body["releases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| candidate_of(r, 100))
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
    /// RELEASE-level artist credit ("Drake & Future" → [Drake, Future]),
    /// each name with its MB artist id. Two or more names = a joint album;
    /// the pass writes album_artist_credit.
    album_artists: Vec<(String, Option<String>)>,
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
    let resp = mb_get(client, url).await?;
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
            Some((name, c["artist"]["id"].as_str().map(|s| s.to_string())))
        })
        .collect();

    Ok(if tracks.is_empty() {
        None
    } else {
        Some(MbReleaseFull {
            release_id: release_id.to_string(),
            release_group_id: rg["id"].as_str().map(|s| s.to_string()),
            album_type,
            date,
            album_artists,
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

#[derive(Debug, Clone, Serialize)]
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
}

fn group_of(g: &serde_json::Value, default_score: i64) -> Option<GroupCandidate> {
    let credit: Vec<(String, Option<String>)> = g["artist-credit"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let name = c["name"]
                .as_str()
                .or_else(|| c["artist"]["name"].as_str())?
                .to_string();
            Some((name, c["artist"]["id"].as_str().map(|s| s.to_string())))
        })
        .collect();
    let artists: Vec<String> = credit.iter().map(|(n, _)| n.clone()).collect();
    let artist_ids: Vec<Option<String>> = credit.into_iter().map(|(_, id)| id).collect();
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
    tokio::time::sleep(REQUEST_GAP).await;
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

/// One release group by id, for a pasted link or a tagged id.
async fn fetch_release_group(
    client: &reqwest::Client,
    group_id: &str,
) -> Result<Option<GroupCandidate>, String> {
    let url = url::Url::parse_with_params(
        &format!("https://musicbrainz.org/ws/2/release-group/{group_id}"),
        &[("inc", "artist-credits"), ("fmt", "json")],
    )
    .map_err(|e| e.to_string())?;
    let resp = mb_get(client, url).await?;
    tokio::time::sleep(REQUEST_GAP).await;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(group_of(&body, 100))
}

/// The ONLY automatic artist matching waverunner does: identity derived from
/// the credit of an album that is already matched. The credit names each
/// artist by MBID, so "your artist credited on this album IS this MB artist"
/// holds with certainty — where a bare name search can hit any same-named
/// stranger ("God" is several artists on MusicBrainz; the one credited on
/// Yeezus is Kanye West's collaborator entry or nobody).
///
/// Fills gaps only: an artist that already has an id (user-tier or an earlier
/// stamp) is left alone — conflicting evidence is a decision, not an update.
async fn stamp_artist_ids_from_credit(
    pool: &SqlitePool,
    library_id: &str,
    credit: &[(String, Option<String>)],
) -> Result<usize, String> {
    let mut stamped = 0usize;
    for (name, mbid) in credit {
        let Some(mbid) = mbid else { continue };
        // As-credited name → our artist row (title or redirect), same
        // resolution surface the credit stamps use.
        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT an.artist_id FROM artist_names an
             JOIN media_entry me ON me.id = an.artist_id
             JOIN artist a ON a.id = an.artist_id
             WHERE me.library_id = ?1 AND LOWER(an.name) = LOWER(?2)
               AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')
             LIMIT 1",
        )
        .bind(library_id)
        .bind(name)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if let Some((artist_id,)) = row {
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
    }
    Ok(stamped)
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
    stamp_artist_ids_from_credit(pool, library_id, &credit_pairs).await?;

    if group.artists.len() >= 2
        && !suppressed(pool, "album_artists", album_id).await?
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

    if let Some(mb_type) = &group.album_type {
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

    if let Some(date) = &group.first_release_date {
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
                    &format!("{album_title} — date filled: {date}"),
                    &serde_json::json!({ "release_date": null }),
                    &serde_json::json!({ "release_date": date }),
                    batch,
                )
                .await?;
            }
        }
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
) -> Result<(), String> {
    // Which tracks the two sides disagree about — recorded before anything is
    // applied, since the disagreements are precisely what won't be applied.
    record_match_gaps(pool, album_id, &full.tracks).await?;

    // Everything below is ONE action — applying this release — so it shares a
    // batch and undoes as a unit.
    let batch = next_batch(pool).await?;

    // Pre-match ids, captured before they're overwritten — the "before" of
    // the match log written at the end of this function.
    let prev_group_id = mb_id(pool, album_id, MB_RELEASE_GROUP).await?.map(|(v, _)| v);
    let prev_release_id = mb_id(pool, album_id, MB_RELEASE).await?.map(|(v, _)| v);

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
                batch,
            )
            .await?;
        }
    }

    // Joint albums: MB's release-level artist credit names every owner —
    // written as album_artist_credit rows so the album lands in each of their
    // discographies. User-set credits outrank; logged and undoable like every
    // other application.
    let album_artist_names: Vec<String> =
        full.album_artists.iter().map(|(n, _)| n.clone()).collect();
    if album_artist_names.len() >= 2
        && !suppressed(pool, "album_artists", album_id).await?
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
            .chain(full.tracks.iter().flat_map(|(_, _, _, credits)| credits.iter()))
        {
            if id.is_some() && seen.insert(name.as_str()) {
                credit_pairs.push((name.clone(), id.clone()));
            }
        }
        stamp_artist_ids_from_credit(pool, library_id, &credit_pairs).await?;
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
                    batch,
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
                    batch,
                )
                .await?;
            }
        }
    }

    // Remember WHICH release this is, durably. The album_release row also gets
    // it for the current session's convenience, but that row is deleted and
    // rebuilt by the next rescan — field_override is the copy that lasts.
    set_mb_id(pool, album_id, MB_RELEASE, &full.release_id, tier).await?;
    sqlx::query(
        "UPDATE album_release SET mb_release_id = ? WHERE album_id = ? AND is_default = 1",
    )
    .bind(&full.release_id)
    .bind(album_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(rg) = &full.release_group_id {
        set_mb_id(pool, album_id, MB_RELEASE_GROUP, rg, tier).await?;
        sqlx::query("UPDATE album SET mb_release_group_id = ? WHERE id = ?")
            .bind(rg)
            .bind(album_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
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
            }),
            &serde_json::json!({
                "release_group_id": full.release_group_id,
                "release_id": full.release_id,
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
    mb_tracks: &[MbTrack],
) -> Result<MbGapCounts, String> {
    let ours: Vec<(String, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT t.title, t.disc_number, t.track_number
         FROM track t
         JOIN track_release tr ON tr.track_id = t.id
         JOIN album_release ar ON ar.id = tr.release_id
         WHERE ar.album_id = ? AND ar.is_default = 1",
    )
    .bind(album_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // (side, disc, position, title, counterpart)
    let mut gaps: Vec<(&str, i64, i64, String, Option<String>)> = Vec::new();
    let mut our_slots: Vec<(i64, i64)> = Vec::new();
    for (our_title, disc, number) in &ours {
        let (disc, number) = (disc.unwrap_or(1), number.unwrap_or(0));
        our_slots.push((disc, number));
        match mb_tracks.iter().find(|(d, p, _, _)| *d == disc && *p == number) {
            None => gaps.push(("ours", disc, number, our_title.clone(), None)),
            Some((_, _, mb_title, _)) => {
                if !titles_match(&normalize(our_title), &normalize(mb_title)) {
                    gaps.push(("ours", disc, number, our_title.clone(), Some(mb_title.clone())));
                }
            }
        }
    }
    // MB tracks at slots we have nothing for. A differing title at a shared
    // slot is already reported once from our side — don't double-count it.
    for (disc, pos, mb_title, _) in mb_tracks {
        if !our_slots.contains(&(*disc, *pos)) {
            gaps.push(("mb", *disc, *pos, mb_title.clone(), None));
        }
    }

    sqlx::query("DELETE FROM album_match_gap WHERE album_id = ?")
        .bind(album_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    for (side, disc, position, title, counterpart) in &gaps {
        sqlx::query(
            "INSERT OR REPLACE INTO album_match_gap
             (album_id, side, disc, position, title, counterpart) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(album_id)
        .bind(side)
        .bind(disc)
        .bind(position)
        .bind(title)
        .bind(counterpart)
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
                (SELECT f.value FROM track_credit tc
                 JOIN media_entry tme ON tme.id = tc.track_id
                 JOIN field_override f ON f.entity_id = tme.parent_id
                    AND f.field = 'mb_release_id'
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
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|(_, _, gid, rid)| gid.is_some() || rid.is_some())
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
    let mut group_cache: HashMap<String, Vec<(String, Option<String>)>> = HashMap::new();
    let mut release_cache: HashMap<String, Vec<(String, Option<String>)>> = HashMap::new();
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
        let pairs: &[(String, Option<String>)] = if let Some(gid) = gid {
            match group_cache.entry(gid.clone()) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(slot) => {
                    let fetched = match fetch_release_group(client, gid).await {
                        Ok(Some(g)) => g
                            .artists
                            .iter()
                            .cloned()
                            .zip(g.artist_ids.iter().cloned())
                            .collect(),
                        Ok(None) => Vec::new(),
                        Err(e) => {
                            eprintln!("artist identity: group {gid} fetch failed: {e}");
                            failed_keys.insert(gid.clone());
                            Vec::new()
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
                                full.tracks.iter().flat_map(|(_, _, _, c)| c.iter()),
                            ) {
                                if id.is_some() && seen.insert(name.clone()) {
                                    pairs.push((name.clone(), id.clone()));
                                }
                            }
                            pairs
                        }
                        Ok(None) => Vec::new(),
                        Err(e) => {
                            eprintln!("artist identity: release {rid} fetch failed: {e}");
                            failed_keys.insert(rid.clone());
                            Vec::new()
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
            }
            continue;
        }

        // Stamp EVERY still-unidentified candidate this credit names, not
        // just the artist that prompted the fetch.
        for (cname, cid) in pairs {
            let Some(cid) = cid else { continue };
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
                stamped.insert(aid);
                updated += 1;
            }
        }
    }
    Ok((updated, fetch_failed))
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
           AND NOT EXISTS (SELECT 1 FROM field_override r
                           WHERE r.entity_id = al.id AND r.field = 'mb_release_id'
                             AND r.value IS NOT NULL AND r.value <> '')
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
               AND a.id IN (SELECT ac.artist_id FROM album_artist_credit ac
                            WHERE ac.album_id = ?1
                            UNION
                            SELECT tc.artist_id FROM track_credit tc
                            JOIN media_entry t ON t.id = tc.track_id
                            WHERE t.parent_id = ?1)",
        )
        .bind(album_id)
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
                .chain(full.tracks.iter().flat_map(|(_, _, _, c)| c.iter()))
            {
                let Some(cid) = cid else { continue };
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
    /// The owning artist (media_entry.parent_id) — how the library map groups
    /// albums under their artist rows. None for root/orphan albums.
    pub artist_id: Option<i64>,
    /// User said "stop counting this": excluded from passes and warn counts,
    /// gray on the map.
    pub ignored: bool,
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
    /// but the titles differ. None = the other side has nothing there.
    pub counterpart: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MbGapAlbum {
    pub album_id: i64,
    pub title: String,
    pub artist_title: Option<String>,
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
    // "Which artist is this?" cards get an "In your library:" line — WHERE the
    // artist is credited, which is what jogs the memory for a feature-only
    // name nobody recognizes cold. Computed at read time, not stored: the
    // stored payload froze at suggestion time, but the library moves.
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
    let album_rows: Vec<(i64, String, Option<String>, String, i64, i64, Option<i64>, i64)> = sqlx::query_as(
        "SELECT al.id, al.title, ar.title,
                CASE
                  WHEN EXISTS (SELECT 1 FROM field_override o
                               WHERE o.entity_id = al.id AND o.field = 'mb_release_id'
                                 AND o.value IS NOT NULL AND o.value <> '') THEN 'release'
                  WHEN EXISTS (SELECT 1 FROM field_override o
                               WHERE o.entity_id = al.id AND o.field = 'mb_release_group_id'
                                 AND o.value IS NOT NULL AND o.value <> '') THEN 'album'
                  WHEN EXISTS (SELECT 1 FROM mb_credit_fetch f
                               WHERE f.album_id = al.id) THEN 'notfound'
                  ELSE 'unchecked'
                END,
                COALESCE((SELECT SUM(side = 'ours') FROM album_match_gap g WHERE g.album_id = al.id), 0),
                COALESCE((SELECT SUM(side = 'mb') FROM album_match_gap g WHERE g.album_id = al.id), 0),
                me.parent_id,
                EXISTS (SELECT 1 FROM field_override ig
                        WHERE ig.entity_id = al.id AND ig.field = 'mb_ignored')
         FROM album al
         JOIN media_entry me ON me.id = al.id
         LEFT JOIN artist ar ON ar.id = me.parent_id
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
        .map(|(album_id, title, artist_title, state, gap_ours, gap_mb, artist_id, ignored)| MbAlbumRow {
            album_id,
            title,
            artist_title,
            state,
            gap_ours,
            gap_mb,
            artist_id,
            ignored: ignored != 0,
        })
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
                (SELECT COUNT(*) FROM media_entry ame WHERE ame.parent_id = a.id),
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

    let gap_rows: Vec<(i64, String, Option<String>, String, i64, i64, String, Option<String>)> =
        sqlx::query_as(
            "SELECT al.id, al.title, ar.title, g.side, g.disc, g.position, g.title, g.counterpart
             FROM album_match_gap g
             JOIN album al ON al.id = g.album_id
             JOIN media_entry me ON me.id = al.id
             LEFT JOIN artist ar ON ar.id = me.parent_id
             WHERE me.library_id = ?
             ORDER BY al.sort_title COLLATE NOCASE, g.side, g.disc, g.position",
        )
        .bind(&library_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut gaps: Vec<MbGapAlbum> = Vec::new();
    for (album_id, title, artist_title, side, disc, position, gap_title, counterpart) in gap_rows {
        if gaps.last().map(|g| g.album_id) != Some(album_id) {
            gaps.push(MbGapAlbum { album_id, title, artist_title, rows: Vec::new() });
        }
        gaps.last_mut().unwrap().rows.push(MbGapRow {
            side,
            disc,
            position,
            title: gap_title,
            counterpart,
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

/// Re-compare a matched album against its release — after retagging and a
/// rescan, this is what clears the warning (or shows what's still off).
#[tauri::command]
pub async fn mb_recheck_album(
    state: State<'_, AppState>,
    album_id: i64,
) -> Result<MbGapCounts, String> {
    let pool = &state.app_db;
    let Some((mb_release_id, _)) = mb_id(pool, album_id, MB_RELEASE).await? else {
        return Err("this album isn't matched to a MusicBrainz release".to_string());
    };
    let client = mb_client()?;
    let full = fetch_release(&client, &mb_release_id)
        .await?
        .ok_or_else(|| "release has no usable track data".to_string())?;
    record_match_gaps(pool, album_id, &full.tracks).await
}

// ---------------------------------------------------------------------------
// Per-entity matching (album / artist / track)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct MbStatus {
    /// "album" | "artist" | "track"
    pub kind: String,
    pub entity_id: i64,
    pub title: String,
    /// The owning artist / album, when there is one — disambiguates a search.
    pub context: Option<String>,
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
#[tauri::command]
pub async fn mb_status(
    state: State<'_, AppState>,
    kind: String,
    entity_id: i64,
) -> Result<MbStatus, String> {
    let pool = &state.app_db;
    let field = mb_field_for(&kind)?;
    let (mut mbid, mut tier) = match mb_id(pool, entity_id, field).await? {
        Some((v, t)) => (Some(v), Some(t)),
        None => (None, None),
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

    let (title, context) = match kind.as_str() {
        "album" => {
            let row: (String, Option<String>) = sqlx::query_as(
                "SELECT al.title, ar.title FROM album al
                 JOIN media_entry me ON me.id = al.id
                 LEFT JOIN artist ar ON ar.id = me.parent_id
                 WHERE al.id = ?",
            )
            .bind(entity_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
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
            (row.0, row.1)
        }
    };

    let (release_group_id, gap_count, gap_ours, gap_mb, searched_not_found) = if kind == "album" {
        let rg = mb_id(pool, entity_id, MB_RELEASE_GROUP).await?.map(|(v, _)| v);
        let gaps: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM album_match_gap WHERE album_id = ?")
                .bind(entity_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
        let (ours, theirs): (i64, i64) = sqlx::query_as(
            "SELECT COALESCE(SUM(side = 'ours'), 0), COALESCE(SUM(side = 'mb'), 0)
             FROM album_match_gap WHERE album_id = ?",
        )
        .bind(entity_id)
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
        (rg, gaps.0, ours, theirs, nf.0 != 0)
    } else {
        (None, 0, 0, 0, false)
    };

    Ok(MbStatus {
        kind,
        entity_id,
        title,
        context,
        mbid,
        tier,
        release_group_id,
        gap_count,
        gap_ours,
        gap_mb,
        searched_not_found,
    })
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
                c.country,
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
) -> Result<Vec<MbCandidateRow>, String> {
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
        "track" => search_recordings(&client, &query, context.as_deref()).await,
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
        tokio::time::sleep(REQUEST_GAP).await;
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
        tokio::time::sleep(REQUEST_GAP).await;
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
) -> Result<Vec<MbCandidateRow>, String> {
    let body = if let Some(id) = parse_bare_mbid(query, "recording") {
        let url = url::Url::parse_with_params(
            &format!("https://musicbrainz.org/ws/2/recording/{id}"),
            &[("inc", "artist-credits+releases"), ("fmt", "json")],
        )
        .map_err(|e| e.to_string())?;
        let resp = mb_get(client, url).await?;
        tokio::time::sleep(REQUEST_GAP).await;
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
        let url = url::Url::parse_with_params(
            "https://musicbrainz.org/ws/2/recording",
            &[("query", q.as_str()), ("fmt", "json"), ("limit", "10")],
        )
        .map_err(|e| e.to_string())?;
        let resp = mb_get(client, url).await?;
        tokio::time::sleep(REQUEST_GAP).await;
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
) -> Result<(), String> {
    let pool = &state.app_db;
    let library_id = library_of(pool, entity_id).await?;
    // One batch per apply. The album branch delegates to mb_apply_album_match,
    // which allocates its own inside apply_release.
    let batch = next_batch(pool).await?;
    match kind.as_str() {
        "album" => {
            if mbid_kind.as_deref() == Some("release") {
                return mb_apply_album_match(app, state, library_id, entity_id, mbid).await;
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
            set_mb_id(pool, entity_id, MB_ARTIST, &mbid, TIER_USER).await?;
            sqlx::query("UPDATE artist SET musicbrainz_id = ? WHERE id = ?")
                .bind(&mbid)
                .bind(entity_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
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
    crate::music::ensure_credit_artists(pool, &library_id).await?;
    let _ = app.emit(
        "music-enrich-done",
        serde_json::json!({ "libraryId": library_id, "updated": 0, "albumsMatched": 0, "processed": 0, "pendingReview": 0 }),
    );
    Ok(())
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
    tokio::time::sleep(REQUEST_GAP).await;
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
    let pool = &state.app_db;
    let library_id = library_of(pool, entity_id).await?;
    let field = mb_field_for(&kind)?;

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
        sqlx::query("UPDATE album_release SET mb_release_id = NULL WHERE album_id = ?")
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
    }
    if kind == "artist" {
        sqlx::query("UPDATE artist SET musicbrainz_id = NULL WHERE id = ?")
            .bind(entity_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Dismiss an album's track-list warning. Nothing else changes — a re-check
/// or a fresh match brings it back if the two sides still disagree.
#[tauri::command]
pub async fn mb_dismiss_gaps(state: State<'_, AppState>, album_id: i64) -> Result<(), String> {
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

/// The releases of one release group, for the match dialog's release picker:
/// a group-matched album lists what's IN its group instead of making the
/// user search for what is already known. Official releases first, oldest
/// first — the top of the list is usually the standard edition.
#[tauri::command]
pub async fn mb_group_releases(group_id: String) -> Result<Vec<ReleaseCandidate>, String> {
    let client = mb_client()?;
    let mut releases = releases_in_group(&client, &group_id).await?;
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
    apply_release(pool, &library_id, album_id, &album_title, &full, TIER_USER).await?;
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
        "album_artists" => {
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
        }
        "album_match" => {
            // Forget the ids the match wrote (every tier), un-stamp the fetch
            // so the album reads unchecked, and restore whatever id stood
            // before. The suppression written below keeps the automatic pass
            // from re-concluding the same match next pass; Unmatch clears it
            // for a true start-over.
            clear_mb_id(pool, target_id, MB_RELEASE).await?;
            clear_mb_id(pool, target_id, MB_RELEASE_GROUP).await?;
            sqlx::query("UPDATE album SET mb_release_group_id = NULL WHERE id = ?")
                .bind(target_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("UPDATE album_release SET mb_release_id = NULL WHERE album_id = ?")
                .bind(target_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM album_match_gap WHERE album_id = ?")
                .bind(target_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM mb_credit_fetch WHERE album_id = ?")
                .bind(target_id)
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
            if let Some(r) = prev_release {
                set_mb_id(pool, target_id, MB_RELEASE, r, TIER_MB).await?;
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
    // un-rejecting has nothing to suppress (the pending card is the whole
    // point); the rest suppress by (kind, target).
    if kind != "artist_merge" && kind != "suggestion_rejected" {
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
