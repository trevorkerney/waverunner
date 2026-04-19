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

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::Manager;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongW, GWL_STYLE, MINMAXINFO, NCCALCSIZE_PARAMS, WM_GETMINMAXINFO,
    WM_NCCALCSIZE, WS_MAXIMIZE,
};

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
            // tao keeps WS_THICKFRAME on borderless windows so edge-resize cursors work.
            // That in turn makes Windows deduct the invisible ~8px frame from the client
            // rect on every NCCALCSIZE — including when maximized, producing the crack.
            //
            // Returning 0 with WPARAM=TRUE tells Windows "keep client area == window area"
            // (no frame deduction). For the maximized case, we additionally snap the
            // client rect to the monitor work area so the window doesn't bleed past the
            // taskbar seam.
            let params = &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS);
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            if style & WS_MAXIMIZE.0 != 0 {
                let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                let mut mi = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if GetMonitorInfoW(hmon, &mut mi).as_bool() {
                    params.rgrc[0] = mi.rcWork;
                }
            }
            return LRESULT(0);
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
