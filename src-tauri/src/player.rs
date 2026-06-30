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
    let mut search_dirs: Vec<std::path::PathBuf> = Vec::new();

    // 1. Tauri resource dir (where `resources` config copies files in production)
    if let Ok(res) = window.app_handle().path().resource_dir() {
        search_dirs.push(res.join("lib"));
    }

    // 2. Next to the executable (common for bundled apps)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            search_dirs.push(exe_dir.to_path_buf());
            search_dirs.push(exe_dir.join("lib"));
        }
    }

    // 3. Source lib/ dir (for dev mode: src-tauri/lib/)
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    search_dirs.push(manifest_dir.join("lib"));

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

#[tauri::command]
pub fn destroy_player(state: State<'_, AppState>) -> Result<(), String> {
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

            tracks.push(serde_json::json!({
                "id": id.parse::<i64>().unwrap_or(0),
                "type": kind,
                "title": title,
                "lang": lang,
                "selected": selected,
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
