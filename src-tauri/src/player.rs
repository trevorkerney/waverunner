//! Higher-level player state management — Tauri commands that drive the
//! mpv FFI wrapper and an event loop thread that pushes property changes
//! to the React frontend.

use std::os::raw::{c_char, c_int};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::ffi::CStr;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::mpv::{self, MpvFormat, MpvHandle};
use crate::AppState;

/// Holds the live mpv instance + a flag the event loop checks for shutdown.
pub struct PlayerInner {
    pub mpv: MpvHandle,
    pub shutdown: Arc<AtomicBool>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn init_player(window: tauri::WebviewWindow, state: State<'_, AppState>, titlebar_height: Option<u32>) -> Result<(), String> {
    let mut guard = state.player.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Player already initialised".into());
    }

    // Build list of directories to search for libmpv
    let search_dirs = libmpv_search_dirs(window.app_handle());
    let dir_refs: Vec<&std::path::Path> = search_dirs.iter().map(|p| p.as_path()).collect();
    let mpv = MpvHandle::new(&dir_refs)?;

    // ---- Pre-init options ------------------------------------------------

    // Embed into our window
    let wid = get_native_window_id(&window)?;
    mpv.set_option_string("wid", &wid)?;

    // Push video below the titlebar by setting a top margin ratio
    if let Some(tb_h) = titlebar_height {
        if tb_h > 0 {
            if let Ok(size) = window.inner_size() {
                let ratio = tb_h as f64 / size.height as f64;
                mpv.set_option_string("video-margin-ratio-top", &format!("{ratio:.6}"))?;
            }
        }
    }

    // No built-in UI — we build our own in React
    mpv.set_option_string("osc", "no")?;
    mpv.set_option_string("osd-level", "0")?;
    mpv.set_option_string("input-default-bindings", "no")?;
    mpv.set_option_string("input-vo-keyboard", "no")?;

    // Keep the window open when playback ends (we manage lifecycle)
    mpv.set_option_string("keep-open", "yes")?;
    mpv.set_option_string("idle", "yes")?;

    // Initialize
    mpv.initialize()?;

    // ---- Observe properties we care about --------------------------------
    // Note: `pause` is NOT observed here — it's deferred until FILE_LOADED
    // so we don't get a spurious pause=true from the idle state.
    mpv.observe_property(1, "time-pos", MpvFormat::Double)?;
    mpv.observe_property(2, "duration", MpvFormat::Double)?;
    mpv.observe_property(4, "volume", MpvFormat::Double)?;
    mpv.observe_property(5, "mute", MpvFormat::Flag)?;
    mpv.observe_property(6, "eof-reached", MpvFormat::Flag)?;
    mpv.observe_property(7, "seeking", MpvFormat::Flag)?;
    mpv.observe_property(8, "track-list/count", MpvFormat::String)?;

    // ---- Event loop thread -----------------------------------------------
    let shutdown = Arc::new(AtomicBool::new(false));
    let app = window.app_handle().clone();

    // The handle lives behind an Arc so commands can clone it out and call mpv
    // *without* holding the player mutex — keeping playback control responsive
    // even while a file is loading off a slow/spun-down disk. The event loop
    // gets its own clone instead of re-locking state every iteration.
    let inner = Arc::new(PlayerInner { mpv, shutdown });
    let loop_inner = inner.clone();
    std::thread::spawn(move || {
        event_loop(&app, loop_inner);
    });

    *guard = Some(inner);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct PlayerStatus {
    pub path: Option<String>,
    pub paused: bool,
    pub position: f64,
    pub duration: f64,
    pub volume: f64,
    pub muted: bool,
}

/// Snapshot of the live mpv instance, or None when no player exists. Used to
/// rehydrate the React player UI after a webview refresh (F5): mpv is native
/// and keeps playing; the frontend state it was driven by is gone.
#[tauri::command]
pub async fn get_player_status(state: State<'_, AppState>) -> Result<Option<PlayerStatus>, String> {
    let inner = {
        let guard = state.player.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(inner) => inner.clone(),
            None => return Ok(None),
        }
    };
    run_mpv(inner, |mpv| {
        let num = |key: &str| {
            mpv.get_property_string(key)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0)
        };
        let flag = |key: &str| mpv.get_property_string(key).map(|s| s == "yes").unwrap_or(false);
        Ok(Some(PlayerStatus {
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

#[tauri::command]
pub fn destroy_player(state: State<'_, AppState>) -> Result<(), String> {
    // An interactive session drives this mpv instance — stop it first.
    crate::interactive_session::stop_session(&state);
    let mut guard = state.player.lock().map_err(|e| e.to_string())?;
    if let Some(inner) = guard.take() {
        // Signal event loop to stop
        inner.shutdown.store(true, Ordering::SeqCst);
        // Send quit command so mpv_wait_event returns SHUTDOWN
        let _ = inner.mpv.command(&["quit"]);
        // MpvHandle::drop calls mpv_terminate_destroy
    }
    Ok(())
}

#[tauri::command]
pub async fn play_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    // Linear playback replaces any interactive session on this instance.
    crate::interactive_session::stop_session(&state);
    let inner = current_player(&state)?;
    run_mpv(inner, move |mpv| {
        mpv.command(&["loadfile", &path])?;
        // `pause` is sticky across loadfile, and keep-open leaves mpv paused
        // after a natural EOF — without this the next file sits frozen on its
        // first frame.
        mpv.set_property_string("pause", "no")
    })
    .await
}

#[tauri::command]
pub async fn player_command(
    state: State<'_, AppState>,
    cmd: String,
    args: Vec<String>,
) -> Result<(), String> {
    let inner = current_player(&state)?;
    run_mpv(inner, move |mpv| {
        let mut all: Vec<&str> = vec![&cmd];
        all.extend(args.iter().map(|s| s.as_str()));
        mpv.command(&all)
    })
    .await
}

#[tauri::command]
pub async fn set_player_property(
    state: State<'_, AppState>,
    name: String,
    value: String,
) -> Result<(), String> {
    let inner = current_player(&state)?;
    run_mpv(inner, move |mpv| mpv.set_property_string(&name, &value)).await
}

#[tauri::command]
pub async fn set_player_region(
    state: State<'_, AppState>,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
) -> Result<(), String> {
    let inner = current_player(&state)?;
    let clamp = |v: f64| v.max(0.0).min(1.0);
    let (left, right, top, bottom) = (clamp(left), clamp(right), clamp(top), clamp(bottom));
    run_mpv(inner, move |mpv| {
        mpv.set_property_string("video-margin-ratio-left", &format!("{left:.6}"))?;
        mpv.set_property_string("video-margin-ratio-right", &format!("{right:.6}"))?;
        mpv.set_property_string("video-margin-ratio-top", &format!("{top:.6}"))?;
        mpv.set_property_string("video-margin-ratio-bottom", &format!("{bottom:.6}"))?;
        Ok(())
    })
    .await
}

/// Get all audio/subtitle/video tracks as JSON array.
#[tauri::command]
pub async fn get_player_tracks(state: State<'_, AppState>) -> Result<String, String> {
    let inner = current_player(&state)?;
    run_mpv(inner, |mpv| {
        let count: i64 = mpv
            .get_property_string("track-list/count")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let mut tracks = Vec::new();
        for i in 0..count {
            let prefix = format!("track-list/{i}");
            let id = mpv.get_property_string(&format!("{prefix}/id")).unwrap_or_default();
            let kind = mpv.get_property_string(&format!("{prefix}/type")).unwrap_or_default();
            let title = mpv.get_property_string(&format!("{prefix}/title"));
            let lang = mpv.get_property_string(&format!("{prefix}/lang"));
            let selected = mpv.get_property_string(&format!("{prefix}/selected"))
                .map(|s| s == "yes")
                .unwrap_or(false);
            // Attached-picture streams (embedded cover art / backdrops / posters)
            // show up as "video" tracks; mpv flags them so we can hide them from
            // the video-track picker.
            let albumart = mpv.get_property_string(&format!("{prefix}/albumart"))
                .map(|s| s == "yes")
                .unwrap_or(false);

            tracks.push(serde_json::json!({
                "id": id.parse::<i64>().unwrap_or(0),
                "type": kind,
                "title": title,
                "lang": lang,
                "selected": selected,
                "albumart": albumart,
            }));
        }

        serde_json::to_string(&tracks).map_err(|e| e.to_string())
    })
    .await
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Clone the live mpv handle out from under the lock. The lock is released as
/// soon as this returns, so the (potentially slow) FFI call in `run_mpv` never
/// blocks other player commands.
fn current_player(state: &State<'_, AppState>) -> Result<Arc<PlayerInner>, String> {
    let guard = state.player.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "Player not initialised".to_string())
}

/// Run a blocking mpv call on a worker thread so the async command never ties
/// up the Tauri main thread (the window's event loop). Combined with
/// `current_player` holding no lock, a `pause`/`stop` issued during a slow
/// `loadfile` is serviced immediately — mpv's client API is thread-safe.
async fn run_mpv<F, T>(inner: Arc<PlayerInner>, f: F) -> Result<T, String>
where
    F: FnOnce(&MpvHandle) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(&inner.mpv))
        .await
        .map_err(|e| e.to_string())?
}

/// Directories to probe for libmpv, in priority order. Shared by the player
/// and the thumbnailer.
fn libmpv_search_dirs(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    // 1. Tauri resource dir (where `resources` config copies files in production)
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("lib"));
    }
    // 2. Next to the executable (common for bundled apps)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.to_path_buf());
            dirs.push(exe_dir.join("lib"));
        }
    }
    // 3. Source lib/ dir (for dev mode: src-tauri/lib/)
    dirs.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("lib"));
    dirs
}

// ---------------------------------------------------------------------------
// Seek-bar thumbnail preview
// ---------------------------------------------------------------------------
//
// A second, headless libmpv instance (vo=null, no audio) used only to grab the
// frame under the cursor while hovering the seek bar. It is created lazily
// (first hover) and torn down after the user stops hovering, so the extra
// decoder costs RAM *only* during active scrubbing — never while just watching.

// Real mpv_event_id values. NOTE: the shared `mpv::event_id` module has several
// incorrect constants (it works for the main player only because PROPERTY_CHANGE
// is right); use the correct values here.
const EV_FILE_LOADED: u32 = 8;
const EV_PLAYBACK_RESTART: u32 = 21;

struct ThumbReq {
    time: f64,
    resp: std::sync::mpsc::Sender<Result<Vec<u8>, String>>,
}

/// Handle to the live thumbnailer worker. Dropping it closes the request
/// channel, which ends the worker loop and destroys its mpv instance.
pub struct Thumbnailer {
    /// The file this instance is loaded with — lets us reuse it across hovers
    /// and rebuild only when the playing file changes.
    pub path: String,
    req_tx: std::sync::mpsc::Sender<ThumbReq>,
}

impl Thumbnailer {
    fn request(&self, time: f64) -> Result<std::sync::mpsc::Receiver<Result<Vec<u8>, String>>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.req_tx
            .send(ThumbReq { time, resp: tx })
            .map_err(|_| "thumbnailer stopped".to_string())?;
        Ok(rx)
    }
}

/// Build and load a headless mpv tuned for cheap single-frame grabs.
fn build_thumb_mpv(dirs: &[std::path::PathBuf], path: &str) -> Result<MpvHandle, String> {
    let dir_refs: Vec<&std::path::Path> = dirs.iter().map(|p| p.as_path()).collect();
    let mpv = MpvHandle::new(&dir_refs)?;

    // Lean, decode-only configuration. Errors on individual options are
    // non-fatal — defaults are acceptable.
    for (k, v) in [
        ("vo", "null"),                  // decode but discard frames (no window)
        ("ao", "null"),                  // no audio device
        ("aid", "no"),                   // don't even select an audio track
        ("sid", "no"),                   // skip subtitles
        ("hwdec", "no"),                 // keep frames in system memory for screenshots
        ("vf", "scale=480:-2"),          // pre-scale; final downscale happens in Rust
        ("keep-open", "yes"),
        ("idle", "yes"),
        ("pause", "yes"),
        ("cache", "no"),                 // minimise RAM
        ("demuxer-max-bytes", "32MiB"),  // bound the demuxer buffer
        ("osc", "no"),
        ("osd-level", "0"),
        ("screenshot-format", "jpg"),
    ] {
        let _ = mpv.set_option_string(k, v);
    }

    mpv.initialize()?;
    mpv.command(&["loadfile", path])?;
    Ok(mpv)
}

/// Block (up to `budget`) until mpv emits the given event id. Returns whether
/// the event was seen. Uses a short blocking poll so it doesn't busy-spin.
fn wait_for_event(mpv: &MpvHandle, want: u32, budget: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() >= budget {
            return false;
        }
        let ev = mpv.wait_event(0.05);
        if ev.event_id == want {
            return true;
        }
        if ev.event_id == mpv::event_id::SHUTDOWN {
            return false;
        }
    }
}

/// Seek to `time` and return a small JPEG of that frame.
fn grab_frame(mpv: &MpvHandle, time: f64, tmp: &std::path::Path) -> Result<Vec<u8>, String> {
    // `exact` forces a precise seek (decode up to the exact frame) so the
    // preview matches where the main player lands — it does a precise absolute
    // seek too. `keyframes` would snap to an earlier keyframe and look "behind".
    mpv.command(&["seek", &format!("{time:.3}"), "absolute+exact"])?;
    // Wait for the seek to settle so the screenshot captures the new frame,
    // not the one we were parked on. Exact seeks decode further, so allow more.
    wait_for_event(mpv, EV_PLAYBACK_RESTART, std::time::Duration::from_millis(2000));

    let tmp_s = tmp.to_string_lossy().to_string();
    mpv.command(&["screenshot-to-file", &tmp_s, "video"])?;

    let raw = std::fs::read(tmp).map_err(|e| e.to_string())?;
    // Normalise to a small, predictable payload regardless of source resolution.
    let img = image::load_from_memory(&raw).map_err(|e| e.to_string())?;
    let thumb = img.resize(320, u32::MAX, image::imageops::FilterType::Triangle);
    let mut out = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Owns the headless mpv and answers frame requests until the channel closes.
fn thumbnailer_worker(
    mpv: MpvHandle,
    tmp: std::path::PathBuf,
    rx: std::sync::mpsc::Receiver<ThumbReq>,
) {
    // Wait for the initial load so the first seek has a timeline to seek within.
    wait_for_event(&mpv, EV_FILE_LOADED, std::time::Duration::from_secs(10));

    while let Ok(mut req) = rx.recv() {
        // Coalesce: if the user moved on while we were busy, skip to the most
        // recent request and short-circuit the stale ones.
        while let Ok(newer) = rx.try_recv() {
            let _ = req.resp.send(Err("superseded".to_string()));
            req = newer;
        }
        let res = grab_frame(&mpv, req.time, &tmp);
        let _ = req.resp.send(res);
    }
    // Channel closed (Thumbnailer dropped) → mpv terminates as it drops here.
}

/// Start (or reuse) the thumbnailer for `path`. Called on first seek-bar hover.
#[tauri::command]
pub async fn thumbnailer_start(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    {
        let guard = state.thumbnailer.lock().map_err(|e| e.to_string())?;
        if guard.as_ref().map(|t| t.path == path).unwrap_or(false) {
            return Ok(()); // already running for this file
        }
    }
    // Tear down any existing instance first so we never hold two decoders.
    {
        *state.thumbnailer.lock().map_err(|e| e.to_string())? = None;
    }

    let dirs = libmpv_search_dirs(&app);
    let tmp = state.app_data_dir.join("thumb-preview.jpg");
    let build_path = path.clone();
    let mpv = tauri::async_runtime::spawn_blocking(move || build_thumb_mpv(&dirs, &build_path))
        .await
        .map_err(|e| e.to_string())??;

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || thumbnailer_worker(mpv, tmp, rx));

    *state.thumbnailer.lock().map_err(|e| e.to_string())? = Some(Thumbnailer { path, req_tx: tx });
    Ok(())
}

/// Grab the frame at `time` (seconds) as a JPEG. Returns raw bytes so the
/// frontend receives an ArrayBuffer rather than a bloated JSON number array.
#[tauri::command]
pub async fn thumbnail_at(
    state: State<'_, AppState>,
    time: f64,
) -> Result<tauri::ipc::Response, String> {
    let rx = {
        let guard = state.thumbnailer.lock().map_err(|e| e.to_string())?;
        let t = guard
            .as_ref()
            .ok_or_else(|| "thumbnailer not started".to_string())?;
        t.request(time)?
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Destroy the thumbnailer (frees the second decoder). Called after hovering ends.
#[tauri::command]
pub async fn thumbnailer_stop(state: State<'_, AppState>) -> Result<(), String> {
    *state.thumbnailer.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// Extract the native window handle as a string mpv understands for `wid`.
fn get_native_window_id(window: &tauri::WebviewWindow) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::HasWindowHandle;
        let handle = window.window_handle().map_err(|e| e.to_string())?;
        match handle.as_raw() {
            raw_window_handle::RawWindowHandle::Win32(h) => {
                Ok(format!("{}", h.hwnd.get() as isize))
            }
            _ => Err("Unexpected window handle type on Windows".into()),
        }
    }
    #[cfg(target_os = "linux")]
    {
        use raw_window_handle::HasWindowHandle;
        let handle = window.window_handle().map_err(|e| e.to_string())?;
        match handle.as_raw() {
            raw_window_handle::RawWindowHandle::Xlib(h) => Ok(format!("{}", h.window)),
            raw_window_handle::RawWindowHandle::Xcb(h) => Ok(format!("{}", h.window.get())),
            _ => Err("Unsupported Linux display server (Wayland not yet supported for mpv wid)".into()),
        }
    }
    #[cfg(target_os = "macos")]
    {
        use raw_window_handle::HasWindowHandle;
        let handle = window.window_handle().map_err(|e| e.to_string())?;
        match handle.as_raw() {
            raw_window_handle::RawWindowHandle::AppKit(h) => {
                Ok(format!("{}", h.ns_view.as_ptr() as usize))
            }
            _ => Err("Unexpected window handle type on macOS".into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Event loop — runs on a dedicated thread
// ---------------------------------------------------------------------------

fn event_loop(app: &AppHandle, inner: Arc<PlayerInner>) {
    // Owns its own Arc clone of the player, so it never touches the player
    // mutex — commands and the loop no longer contend. mpv stays alive until
    // this loop drops its Arc (after `destroy_player` flips the shutdown flag),
    // which also avoids tearing down the ctx while we're mid `wait_event`.

    // mpv fires `time-pos` many times per second during playback. Forwarding
    // every one to the webview floods the IPC bridge and re-renders the UI
    // dozens of times a second — wasteful, and over a long session the churn
    // grows the WebView2 renderer's memory unbounded. Throttle to ~5/sec; the
    // time label only shows whole seconds and the bar moves sub-pixel/sec, so
    // there's no visible difference.
    let mut last_timepos_emit: Option<std::time::Instant> = None;
    const TIMEPOS_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

    loop {
        if inner.shutdown.load(Ordering::SeqCst) {
            break;
        }

        // Non-blocking poll; we sleep between empty polls to avoid spinning.
        let event = inner.mpv.wait_event(0.0);

        match event.event_id {
            mpv::event_id::NONE => {
                std::thread::sleep(std::time::Duration::from_millis(4));
            }
            mpv::event_id::SHUTDOWN => {
                break;
            }
            mpv::event_id::PROPERTY_CHANGE => {
                if !event.data.is_null() {
                    let prop = unsafe { &*(event.data as *const mpv::MpvEventProperty) };
                    if prop.name.is_null() {
                        continue;
                    }
                    let name =
                        unsafe { CStr::from_ptr(prop.name).to_string_lossy().into_owned() };
                    // Rate-limit the high-frequency time-pos stream; let every
                    // other property (pause, duration, eof, …) through at once.
                    if name == "time-pos" {
                        let now = std::time::Instant::now();
                        if last_timepos_emit
                            .is_some_and(|t| now.duration_since(t) < TIMEPOS_MIN_INTERVAL)
                        {
                            continue;
                        }
                        last_timepos_emit = Some(now);
                    }
                    let value = property_value_to_json(prop);
                    let _ = app.emit(
                        "mpv-property-change",
                        serde_json::json!({ "name": name, "value": value }),
                    );
                }
            }
            mpv::event_id::END_FILE => {
                let reason = if !event.data.is_null() {
                    let ef = unsafe { &*(event.data as *const mpv::MpvEventEndFile) };
                    ef.reason as i32
                } else {
                    -1
                };
                let _ = app.emit("mpv-end-file", serde_json::json!({ "reason": reason }));
            }
            mpv::event_id::FILE_LOADED => {
                // Now that a file is loaded and playing, start observing pause
                let _ = inner.mpv.observe_property(3, "pause", mpv::MpvFormat::Flag);
                let _ = app.emit("mpv-file-loaded", ());
            }
            _ => {}
        }
    }
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
