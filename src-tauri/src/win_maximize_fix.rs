//! Windows-only fix for the chromeless-window "maximize crack."
//!
//! With `decorations: false` + `transparent: true`, Windows computes the maximized
//! rectangle as `[screen_rect inflated by resize-border width]`. For a borderless
//! window you can see the result as a gap along the taskbar seam (and the fullscreen
//! transition inherits the bad rect when fullscreen is entered from maximized).
//!
//! The proper fix is to subclass the main window's window proc and intercept
//! `WM_GETMINMAXINFO` — the message Windows sends to ask "what's your maximized size?".
//! We point it at the monitor's work area, so Windows never produces the overflow rect
//! in the first place.
//!
//! The same subclass also fixes a second DWM quirk: corners are (correctly) squared
//! while maximized, but DWM sometimes fails to re-round them when the window is
//! restored. On the transition back to the normal state we toggle the window's
//! corner preference, forcing DWM to re-evaluate.

use std::sync::atomic::{AtomicBool, Ordering};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::Manager;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT, DWMWCP_DONOTROUND,
    DWM_WINDOW_CORNER_PREFERENCE,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromRect, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongW, GetWindowRect, SetWindowPos, GWL_STYLE, MINMAXINFO, NCCALCSIZE_PARAMS,
    SIZE_RESTORED, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    SWP_NOZORDER, WM_GETMINMAXINFO, WM_NCCALCSIZE, WM_SIZE, WS_MAXIMIZE,
};

/// True once the rounding kick has run for the current stay in the normal
/// (restored, non-fullscreen) state. Any other state re-arms it.
static ROUNDING_ASSERTED: AtomicBool = AtomicBool::new(false);

unsafe fn set_corner_preference(hwnd: HWND, pref: DWM_WINDOW_CORNER_PREFERENCE) {
    let _ = DwmSetWindowAttribute(
        hwnd,
        DWMWA_WINDOW_CORNER_PREFERENCE,
        &pref as *const _ as *const core::ffi::c_void,
        std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
    );
}

/// Does the window currently cover its whole monitor (i.e. borderless fullscreen)?
unsafe fn covers_monitor(hwnd: HWND) -> bool {
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return false;
    }
    let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
        return false;
    }
    let m = mi.rcMonitor;
    rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uid: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_NCCALCSIZE if wparam.0 != 0 => {
            // Only intercept the MAXIMIZED case (snap the client rect to the work
            // area so the window doesn't bleed past the taskbar seam). Everything
            // else MUST fall through to tao's wndproc: tao implements the
            // undecorated-shadow client adjustment there, and swallowing those
            // messages leaves the window without its DWM border/rounded corners
            // after any frame recalc (e.g. restoring from maximized).
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            if style & WS_MAXIMIZE.0 != 0 {
                let params = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
                let proposed = params.rgrc[0];
                let hmon = MonitorFromRect(&proposed, MONITOR_DEFAULTTONEAREST);
                let mut mi = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if GetMonitorInfoW(hmon, &mut mi).as_bool() {
                    // Entering fullscreen from maximized keeps WS_MAXIMIZE but
                    // proposes exactly the full monitor rect — leave that alone,
                    // or fullscreen would stop at the taskbar. Anything else is a
                    // real maximize; snap it to the work area.
                    let mon = mi.rcMonitor;
                    let is_fullscreen = proposed.left == mon.left
                        && proposed.top == mon.top
                        && proposed.right == mon.right
                        && proposed.bottom == mon.bottom;
                    if !is_fullscreen {
                        params.rgrc[0] = mi.rcWork;
                    }
                }
                return LRESULT(0);
            }
            // Non-maximized: fall through to DefSubclassProc → tao.
        }
        WM_SIZE => {
            // DWM squares the corners for maximized/fullscreen windows but
            // sometimes fails to re-round them when the window returns to its
            // normal state (restore from maximize, exit from fullscreen). Kick it
            // once per stay in the normal state by toggling the corner preference.
            // Both calls land before the next composition pass, so the DONOTROUND
            // moment is never visible. DEFAULT (not ROUND) is the final value so
            // DWM keeps handling fullscreen/maximized squaring on its own.
            let normal = wparam.0 as u32 == SIZE_RESTORED && !covers_monitor(hwnd);
            if normal {
                if !ROUNDING_ASSERTED.swap(true, Ordering::Relaxed) {
                    set_corner_preference(hwnd, DWMWCP_DONOTROUND);
                    set_corner_preference(hwnd, DWMWCP_DEFAULT);
                    // SWP_FRAMECHANGED forces a full non-client recalc; without it
                    // DWM keeps the maximized frame state (no border, square
                    // corners) on the restored window.
                    let _ = SetWindowPos(
                        hwnd,
                        None,
                        0,
                        0,
                        0,
                        0,
                        SWP_FRAMECHANGED
                            | SWP_NOMOVE
                            | SWP_NOSIZE
                            | SWP_NOZORDER
                            | SWP_NOOWNERZORDER
                            | SWP_NOACTIVATE,
                    );
                }
            } else {
                ROUNDING_ASSERTED.store(false, Ordering::Relaxed);
            }
        }
        WM_GETMINMAXINFO => {
            let mmi = &mut *(lparam.0 as *mut MINMAXINFO);
            let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut mi = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(hmon, &mut mi).as_bool() {
                mmi.ptMaxPosition.x = mi.rcWork.left - mi.rcMonitor.left;
                mmi.ptMaxPosition.y = mi.rcWork.top - mi.rcMonitor.top;
                mmi.ptMaxSize.x = mi.rcWork.right - mi.rcWork.left;
                mmi.ptMaxSize.y = mi.rcWork.bottom - mi.rcWork.top;
                mmi.ptMaxTrackSize.x = mmi.ptMaxSize.x;
                mmi.ptMaxTrackSize.y = mmi.ptMaxSize.y;
            }
        }
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

pub fn install(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else { return };
    let Ok(handle) = window.window_handle() else { return };
    let hwnd = match handle.as_raw() {
        RawWindowHandle::Win32(w) => HWND(w.hwnd.get() as *mut _),
        _ => return,
    };
    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 1, 0);
    }
}
