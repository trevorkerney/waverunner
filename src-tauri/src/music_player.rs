//! Second, audio-only mpv instance for music playback.
//!
//! Lives behind the persistent now-playing bar: no wid, no video decoding, its
//! own event loop emitting `music-*` events so the video player's `mpv-*`
//! stream is untouched. The queue lives in the frontend — this side plays one
//! file at a time and reports progress/EOF.
//!
//! Play history: one `music_play` row per playback START (however brief),
//! written by `music_play_track`; the event loop keeps `played_secs` fresh and
//! flips `scrobbled` once the Last.fm rule trips (≥50% of the track or ≥4
//! minutes of ACCUMULATED listening, whichever comes first). Listening is
//! accumulated from small forward time-pos deltas — a seek is one large jump
//! and credits nothing, so skipping into a song doesn't count as having
//! listened up to that point. No resume for music — by design.
//!
//! Exclusivity with the video player is symmetric: starting either pauses the
//! other, nothing auto-resumes.

use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::mpv::{self, MpvFormat, MpvHandle};
use crate::AppState;

// Real mpv_event_id values — the shared `mpv::event_id` module has several
// incorrect constants (see the note in player.rs).
const EV_END_FILE: u32 = 7;
const EV_FILE_LOADED: u32 = 8;

/// Scrobble once listened_secs ≥ min(duration * RATIO, CAP).
const SCROBBLE_RATIO: f64 = 0.5;
const SCROBBLE_CAP_SECS: f64 = 240.0;
/// How often the play-log row is refreshed during playback.
const LOG_WRITE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);
/// A time-pos delta at or above this is a seek, not playback, and credits
/// nothing. Real ticks arrive many times a second; pauses just stop ticking.
const MAX_TICK_SECS: f64 = 2.0;

/// The music_play row being written for the current track.
struct PlayLog {
    row_id: i64,
    /// Seconds actually listened (sum of small forward deltas; seeks excluded).
    listened_secs: f64,
    /// Last observed time-pos, for delta computation. None until first tick.
    last_pos: Option<f64>,
    duration: f64,
    scrobbled: bool,
}

pub struct MusicInner {
    pub mpv: MpvHandle,
    pub shutdown: Arc<AtomicBool>,
    log: Mutex<Option<PlayLog>>,
    /// Unpause when the NEXT file finishes loading, not before. Unpausing at
    /// loadfile time resumes the still-current (old, paused) track for the few
    /// tens of ms until the swap — an audible blip of the previous song.
    unpause_on_load: AtomicBool,
}

// ---------------------------------------------------------------------------
// Cross-player exclusivity
// ---------------------------------------------------------------------------

/// Pause the music player if it exists (video started). Best-effort.
pub fn pause_music(state: &State<'_, AppState>) {
    if let Ok(guard) = state.music_player.lock() {
        if let Some(inner) = guard.as_ref() {
            let _ = inner.mpv.set_property_string("pause", "yes");
        }
    }
}

/// Pause the video player if it exists (music started). Best-effort.
fn pause_video(state: &State<'_, AppState>) {
    if let Ok(guard) = state.player.lock() {
        if let Some(inner) = guard.as_ref() {
            let _ = inner.mpv.set_property_string("pause", "yes");
        }
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

fn build_music_mpv(app: &AppHandle, initial_volume: f64) -> Result<MpvHandle, String> {
    let search_dirs = crate::player::libmpv_search_dirs(app);
    let dir_refs: Vec<&std::path::Path> = search_dirs.iter().map(|p| p.as_path()).collect();
    let mpv = MpvHandle::new(&dir_refs)?;

    let volume = format!("{initial_volume}");
    for (k, v) in [
        ("vid", "no"),            // audio only — never decode video
        ("audio-display", "no"),  // embedded cover art isn't a video track
        ("force-window", "no"),
        ("osc", "no"),
        ("osd-level", "0"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("keep-open", "yes"),     // hold at EOF; the frontend advances the queue
        ("idle", "yes"),
        ("gapless-audio", "weak"),
        // Set BEFORE initialize so the very first samples already play at the
        // configured default — setting it after the first loadfile produced a
        // split second of mpv's own default (100%).
        ("volume", volume.as_str()),
    ] {
        let _ = mpv.set_option_string(k, v);
    }
    mpv.initialize()?;

    mpv.observe_property(1, "time-pos", MpvFormat::Double)?;
    mpv.observe_property(2, "duration", MpvFormat::Double)?;
    mpv.observe_property(4, "volume", MpvFormat::Double)?;
    mpv.observe_property(5, "mute", MpvFormat::Flag)?;
    mpv.observe_property(6, "eof-reached", MpvFormat::Flag)?;
    Ok(mpv)
}

/// Get the live music player, creating it on first use at `initial_volume`
/// (the Settings → Audio Player default; only creation uses it — a live
/// instance keeps whatever the user set in the bar).
fn ensure_music_player(
    app: &AppHandle,
    state: &State<'_, AppState>,
    initial_volume: f64,
) -> Result<Arc<MusicInner>, String> {
    {
        let guard = state.music_player.lock().map_err(|e| e.to_string())?;
        if let Some(inner) = guard.as_ref() {
            return Ok(inner.clone());
        }
    }
    let mpv = build_music_mpv(app, initial_volume)?;
    let inner = Arc::new(MusicInner {
        mpv,
        shutdown: Arc::new(AtomicBool::new(false)),
        log: Mutex::new(None),
        unpause_on_load: AtomicBool::new(false),
    });
    let mut guard = state.music_player.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone()); // lost a race — use the winner
    }
    let loop_inner = inner.clone();
    let loop_app = app.clone();
    std::thread::spawn(move || event_loop(&loop_app, loop_inner));
    *guard = Some(inner.clone());
    Ok(inner)
}

fn current_music(state: &State<'_, AppState>) -> Result<Arc<MusicInner>, String> {
    let guard = state.music_player.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "Music player not initialised".to_string())
}

async fn run_music<F, T>(inner: Arc<MusicInner>, f: F) -> Result<T, String>
where
    F: FnOnce(&MpvHandle) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(&inner.mpv))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Load and play one track, logging a play-history row for it. The frontend
/// owns the queue and calls this per track.
#[tauri::command]
pub async fn music_play_track(
    app: AppHandle,
    state: State<'_, AppState>,
    track_id: i64,
    path: String,
) -> Result<(), String> {
    pause_video(&state);
    // Startup default from Settings → Audio Player (0–100, default 50).
    let initial_volume: f64 = sqlx::query_as::<_, (String,)>(
        "SELECT value FROM settings WHERE key = 'music_default_volume'",
    )
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?
    .and_then(|(v,)| v.parse::<f64>().ok())
    .map(|v| v.clamp(0.0, 100.0))
    .unwrap_or(50.0);
    let inner = ensure_music_player(&app, &state, initial_volume)?;

    // Play-event row first — every start counts, even a one-second one.
    let res = sqlx::query("INSERT INTO music_play (track_id) VALUES (?)")
        .bind(track_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    *inner.log.lock().map_err(|e| e.to_string())? = Some(PlayLog {
        row_id: res.last_insert_rowid(),
        listened_secs: 0.0,
        last_pos: None,
        duration: 0.0,
        scrobbled: false,
    });

    // Flag BEFORE the loadfile so the event thread can't see the new file's
    // FileLoaded first. The unpause itself happens there — never here, where
    // it would resume the outgoing (possibly paused) track for a moment.
    inner.unpause_on_load.store(true, Ordering::SeqCst);
    run_music(inner, move |mpv| mpv.command(&["loadfile", &path])).await
}

/// Append the NEXT queue track to mpv's internal playlist so the transition
/// happens inside mpv (gapless-audio) instead of via a frontend round-trip —
/// back-to-back tracks like Parabol→Parabola play seamlessly. Guarded by the
/// expected current path so a stale in-flight prefetch (user already switched
/// tracks) can't append the wrong file. Returns:
///   "appended" — next entry queued, mpv will advance natively.
///   "stale"    — current file no longer matches; nothing appended.
///   "eof"      — the current file already ended (keep-open hold) before the
///                prefetch landed; the frontend should advance normally.
#[tauri::command]
pub async fn music_prefetch_next(
    state: State<'_, AppState>,
    current_path: String,
    path: String,
) -> Result<&'static str, String> {
    let inner = current_music(&state)?;
    run_music(inner, move |mpv| {
        if mpv.get_property_string("path").as_deref() != Some(current_path.as_str()) {
            return Ok("stale");
        }
        if mpv.get_property_string("eof-reached").as_deref() == Some("yes") {
            return Ok("eof");
        }
        mpv.command(&["loadfile", &path, "append"])?;
        Ok("appended")
    })
    .await
}

/// Swap in a play-history row for a track mpv advanced to NATIVELY (gapless
/// playlist advance). Playback is already running — this never touches mpv.
/// Manual starts go through music_play_track instead.
#[tauri::command]
pub async fn music_track_started(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<(), String> {
    let inner = current_music(&state)?;
    let res = sqlx::query("INSERT INTO music_play (track_id) VALUES (?)")
        .bind(track_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    *inner.log.lock().map_err(|e| e.to_string())? = Some(PlayLog {
        row_id: res.last_insert_rowid(),
        listened_secs: 0.0,
        last_pos: None,
        duration: 0.0,
        scrobbled: false,
    });
    Ok(())
}

#[tauri::command]
pub async fn music_command(
    state: State<'_, AppState>,
    cmd: String,
    args: Vec<String>,
) -> Result<(), String> {
    let inner = current_music(&state)?;
    run_music(inner, move |mpv| {
        let mut all: Vec<&str> = vec![&cmd];
        all.extend(args.iter().map(|s| s.as_str()));
        mpv.command(&all)
    })
    .await
}

#[tauri::command]
pub async fn music_set_property(
    state: State<'_, AppState>,
    name: String,
    value: String,
) -> Result<(), String> {
    let inner = current_music(&state)?;
    run_music(inner, move |mpv| mpv.set_property_string(&name, &value)).await
}

#[derive(serde::Serialize)]
pub struct MusicStatus {
    pub path: Option<String>,
    pub paused: bool,
    pub position: f64,
    pub duration: f64,
    pub volume: f64,
    pub muted: bool,
}

/// Snapshot for rehydrating the now-playing bar after a webview refresh.
#[tauri::command]
pub async fn music_get_status(state: State<'_, AppState>) -> Result<Option<MusicStatus>, String> {
    let inner = {
        let guard = state.music_player.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(inner) => inner.clone(),
            None => return Ok(None),
        }
    };
    run_music(inner, |mpv| {
        let num = |key: &str| {
            mpv.get_property_string(key)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0)
        };
        let flag = |key: &str| mpv.get_property_string(key).map(|s| s == "yes").unwrap_or(false);
        Ok(Some(MusicStatus {
            path: mpv.get_property_string("path"),
            paused: flag("pause"),
            position: num("time-pos"),
            duration: num("duration"),
            volume: num("volume"),
            muted: flag("mute"),
        }))
    })
    .await
}

/// Stop playback (queue cleared frontend-side). The instance stays alive for
/// the next play.
#[tauri::command]
pub async fn music_stop(state: State<'_, AppState>) -> Result<(), String> {
    let inner = match state.music_player.lock().map_err(|e| e.to_string())?.as_ref() {
        Some(inner) => inner.clone(),
        None => return Ok(()),
    };
    *inner.log.lock().map_err(|e| e.to_string())? = None;
    run_music(inner, |mpv| mpv.command(&["stop"])).await
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

fn event_loop(app: &AppHandle, inner: Arc<MusicInner>) {
    let mut last_emit: Option<std::time::Instant> = None;
    const EMIT_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);
    let mut last_log_write: Option<std::time::Instant> = None;

    loop {
        if inner.shutdown.load(Ordering::SeqCst) {
            break;
        }
        let event = inner.mpv.wait_event(0.0);
        match event.event_id {
            mpv::event_id::NONE => {
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            mpv::event_id::SHUTDOWN => break,
            mpv::event_id::PROPERTY_CHANGE => {
                if event.data.is_null() {
                    continue;
                }
                let prop = unsafe { &*(event.data as *const mpv::MpvEventProperty) };
                if prop.name.is_null() {
                    continue;
                }
                let name = unsafe { CStr::from_ptr(prop.name).to_string_lossy().into_owned() };
                if name == "time-pos" {
                    let now = std::time::Instant::now();
                    if let Some(pos) = property_value_to_f64(prop) {
                        update_play_log(app, &inner, pos, &mut last_log_write, now);
                    }
                    if last_emit.is_some_and(|t| now.duration_since(t) < EMIT_MIN_INTERVAL) {
                        continue;
                    }
                    last_emit = Some(now);
                }
                let value = property_value_to_json(prop);
                let _ = app.emit(
                    "music-property-change",
                    serde_json::json!({ "name": name, "value": value }),
                );
            }
            EV_END_FILE => {
                // Final history write for whatever just ended.
                flush_play_log(app, &inner);
                let reason = if !event.data.is_null() {
                    let ef = unsafe { &*(event.data as *const mpv::MpvEventEndFile) };
                    ef.reason as i32
                } else {
                    -1
                };
                if reason == 0 {
                    // Natural EOF (native gapless advance follows): drop the
                    // finished row so the next track's early time-pos can't
                    // smear it — music_track_started installs the new row.
                    // Manual switches install theirs in music_play_track, so
                    // other reasons must NOT clear.
                    if let Ok(mut guard) = inner.log.lock() {
                        *guard = None;
                    }
                }
                let _ = app.emit("music-end-file", serde_json::json!({ "reason": reason }));
            }
            EV_FILE_LOADED => {
                // Deferred unpause from music_play_track — the new file is now
                // current, so this can't leak audio from the previous one.
                if inner.unpause_on_load.swap(false, Ordering::SeqCst) {
                    let _ = inner.mpv.set_property_string("pause", "no");
                }
                let _ = inner.mpv.observe_property(3, "pause", MpvFormat::Flag);
                let _ = app.emit("music-file-loaded", ());
            }
            _ => {}
        }
    }
}

/// Accumulate listened time, throttle DB writes, flip `scrobbled` when the
/// rule trips. Only small forward deltas count as listening — a seek shows up
/// as one large (or negative) jump and credits nothing.
fn update_play_log(
    app: &AppHandle,
    inner: &Arc<MusicInner>,
    pos: f64,
    last_write: &mut Option<std::time::Instant>,
    now: std::time::Instant,
) {
    let mut wrote = false;
    if let Ok(mut guard) = inner.log.lock() {
        if let Some(log) = guard.as_mut() {
            if let Some(last) = log.last_pos {
                let delta = pos - last;
                if delta > 0.0 && delta < MAX_TICK_SECS {
                    log.listened_secs += delta;
                }
            }
            log.last_pos = Some(pos);
            if log.duration <= 0.0 {
                if let Some(d) = inner.mpv.get_property_double("duration") {
                    log.duration = d;
                }
            }
            let due = last_write.map_or(true, |t| now.duration_since(t) >= LOG_WRITE_INTERVAL);
            let scrobble_now = !log.scrobbled
                && log.duration > 0.0
                && log.listened_secs >= (log.duration * SCROBBLE_RATIO).min(SCROBBLE_CAP_SECS);
            if due || scrobble_now {
                if scrobble_now {
                    log.scrobbled = true;
                }
                *last_write = Some(now);
                wrote = true;
                let (row_id, listened, duration, scrobbled) =
                    (log.row_id, log.listened_secs, log.duration, log.scrobbled);
                let pool = app.state::<AppState>().app_db.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = sqlx::query(
                        "UPDATE music_play SET played_secs = ?, duration_secs = ?, scrobbled = ? WHERE id = ?",
                    )
                    .bind(listened)
                    .bind(if duration > 0.0 { Some(duration) } else { None })
                    .bind(scrobbled as i64)
                    .bind(row_id)
                    .execute(&pool)
                    .await;
                });
            }
        }
    }
    let _ = wrote;
}

/// Write the current log row one last time (track ended / was replaced).
fn flush_play_log(app: &AppHandle, inner: &Arc<MusicInner>) {
    if let Ok(mut guard) = inner.log.lock() {
        if let Some(log) = guard.as_mut() {
            if log.duration > 0.0 {
                // On natural EOF, credit the played tail between the last tick
                // and the actual end — but only that tail, never a seek gap.
                if let Some(eof) = inner.mpv.get_property_string("eof-reached") {
                    if eof == "yes" {
                        if let Some(last) = log.last_pos {
                            let tail = log.duration - last;
                            if tail > 0.0 && tail < MAX_TICK_SECS {
                                log.listened_secs += tail;
                            }
                        }
                    }
                }
                if log.listened_secs >= (log.duration * SCROBBLE_RATIO).min(SCROBBLE_CAP_SECS) {
                    log.scrobbled = true;
                }
            }
            let (row_id, listened, duration, scrobbled) =
                (log.row_id, log.listened_secs, log.duration, log.scrobbled);
            let pool = app.state::<AppState>().app_db.clone();
            tauri::async_runtime::spawn(async move {
                let _ = sqlx::query(
                    "UPDATE music_play SET played_secs = ?, duration_secs = ?, scrobbled = ? WHERE id = ?",
                )
                .bind(listened)
                .bind(if duration > 0.0 { Some(duration) } else { None })
                .bind(scrobbled as i64)
                .bind(row_id)
                .execute(&pool)
                .await;
            });
        }
    }
}

fn property_value_to_f64(prop: &mpv::MpvEventProperty) -> Option<f64> {
    if prop.data.is_null() || prop.format != MpvFormat::Double as c_int {
        return None;
    }
    Some(unsafe { *(prop.data as *const f64) })
}

fn property_value_to_json(prop: &mpv::MpvEventProperty) -> serde_json::Value {
    if prop.data.is_null() {
        return serde_json::Value::Null;
    }
    match prop.format {
        f if f == MpvFormat::Double as c_int => {
            let val = unsafe { *(prop.data as *const f64) };
            serde_json::json!(val)
        }
        f if f == MpvFormat::Flag as c_int => {
            let val = unsafe { *(prop.data as *const c_int) };
            serde_json::json!(val != 0)
        }
        f if f == MpvFormat::String as c_int => {
            let ptr = unsafe { *(prop.data as *const *const c_char) };
            if ptr.is_null() {
                serde_json::Value::Null
            } else {
                let s = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
                serde_json::json!(s)
            }
        }
        _ => serde_json::Value::Null,
    }
}
