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
    let shutdown_clone = shutdown.clone();
    let app = window.app_handle().clone();

    std::thread::spawn(move || {
        event_loop(&app, &shutdown_clone);
    });

    *guard = Some(PlayerInner { mpv, shutdown });
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
pub fn play_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    with_mpv(&state, |mpv| mpv.command(&["loadfile", &path]))
}

#[tauri::command]
pub fn play_url(state: State<'_, AppState>, url: String) -> Result<(), String> {
    with_mpv(&state, |mpv| mpv.command(&["loadfile", &url]))
}

#[tauri::command]
pub fn player_command(
    state: State<'_, AppState>,
    cmd: String,
    args: Vec<String>,
) -> Result<(), String> {
    with_mpv(&state, |mpv| {
        let mut all: Vec<&str> = vec![&cmd];
        all.extend(args.iter().map(|s| s.as_str()));
        mpv.command(&all)
    })
}

#[tauri::command]
pub fn set_player_property(
    state: State<'_, AppState>,
    name: String,
    value: String,
) -> Result<(), String> {
    with_mpv(&state, |mpv| mpv.set_property_string(&name, &value))
}

#[tauri::command]
pub fn get_player_property(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<String>, String> {
    let guard = state.player.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(inner) => Ok(inner.mpv.get_property_string(&name)),
        None => Err("Player not initialised".into()),
    }
}

#[tauri::command]
pub fn set_player_region(
    state: State<'_, AppState>,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
) -> Result<(), String> {
    let clamp = |v: f64| v.max(0.0).min(1.0);
    with_mpv(&state, |mpv| {
        mpv.set_property_string("video-margin-ratio-left", &format!("{:.6}", clamp(left)))?;
        mpv.set_property_string("video-margin-ratio-right", &format!("{:.6}", clamp(right)))?;
        mpv.set_property_string("video-margin-ratio-top", &format!("{:.6}", clamp(top)))?;
        mpv.set_property_string("video-margin-ratio-bottom", &format!("{:.6}", clamp(bottom)))?;
        Ok(())
    })
}

/// Get all audio/subtitle tracks as JSON array.
#[tauri::command]
pub fn get_player_tracks(state: State<'_, AppState>) -> Result<String, String> {
    let guard = state.player.lock().map_err(|e| e.to_string())?;
    let mpv = &guard.as_ref().ok_or("Player not initialised")?.mpv;

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn with_mpv<F, T>(state: &State<'_, AppState>, f: F) -> Result<T, String>
where
    F: FnOnce(&MpvHandle) -> Result<T, String>,
{
    let guard = state.player.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(inner) => f(&inner.mpv),
        None => Err("Player not initialised".into()),
    }
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

fn event_loop(app: &AppHandle, shutdown: &AtomicBool) {
    // Access the mpv handle through AppState on each iteration. This avoids
    // sending raw pointers across thread boundaries.

    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }

        let state: State<'_, AppState> = app.state();
        let guard = match state.player.lock() {
            Ok(g) => g,
            Err(_) => break,
        };

        let inner = match guard.as_ref() {
            Some(inner) => inner,
            None => break,
        };

        // Non-blocking poll: keep the lock hold time minimal so UI commands
        // (set_player_region while dragging the sidebar, etc.) don't stall.
        let event = inner.mpv.wait_event(0.0);

        match event.event_id {
            mpv::event_id::NONE => {
                drop(guard);
                std::thread::sleep(std::time::Duration::from_millis(4));
                continue;
            }
            mpv::event_id::SHUTDOWN => {
                drop(guard);
                break;
            }
            mpv::event_id::PROPERTY_CHANGE => {
                if !event.data.is_null() {
                    let prop = unsafe { &*(event.data as *const mpv::MpvEventProperty) };
                    let name = if !prop.name.is_null() {
                        unsafe { CStr::from_ptr(prop.name).to_string_lossy().into_owned() }
                    } else {
                        drop(guard);
                        continue;
                    };

                    let value = property_value_to_json(prop);
                    drop(guard);

                    let _ = app.emit(
                        "mpv-property-change",
                        serde_json::json!({ "name": name, "value": value }),
                    );
                } else {
                    drop(guard);
                }
            }
            mpv::event_id::END_FILE => {
                let reason = if !event.data.is_null() {
                    let ef = unsafe { &*(event.data as *const mpv::MpvEventEndFile) };
                    ef.reason as i32
                } else {
                    -1
                };
                drop(guard);
                let _ = app.emit("mpv-end-file", serde_json::json!({ "reason": reason }));
            }
            mpv::event_id::FILE_LOADED => {
                // Now that a file is loaded and playing, start observing pause
                let _ = inner.mpv.observe_property(3, "pause", mpv::MpvFormat::Flag);
                drop(guard);
                let _ = app.emit("mpv-file-loaded", ());
            }
            _ => {
                drop(guard);
            }
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
