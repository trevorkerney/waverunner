//! Thin FFI wrapper around libmpv, loaded dynamically via `libloading`.
//!
//! This keeps the app functional even when libmpv is not installed — the
//! library is resolved at runtime, not link time.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_double, c_int, c_void};
use std::path::Path;

use libloading::{Library, Symbol};

// ---------------------------------------------------------------------------
// mpv C‐API constants
// ---------------------------------------------------------------------------

/// mpv_format enum values (subset we need)
#[repr(C)]
#[allow(dead_code)]
pub enum MpvFormat {
    None = 0,
    String = 1,
    OsdString = 2,
    Flag = 3,
    Int64 = 4,
    Double = 5,
    Node = 6,
    NodeArray = 7,
    NodeMap = 8,
    ByteArray = 9,
}

/// mpv_event_id constants (subset we care about)
#[allow(dead_code)]
pub mod event_id {
    pub const NONE: u32 = 0;
    pub const SHUTDOWN: u32 = 1;
    pub const LOG_MESSAGE: u32 = 6;
    pub const GET_PROPERTY_REPLY: u32 = 8;
    pub const SET_PROPERTY_REPLY: u32 = 9;
    pub const COMMAND_REPLY: u32 = 10;
    pub const START_FILE: u32 = 16;
    pub const END_FILE: u32 = 17;
    pub const FILE_LOADED: u32 = 18;
    pub const PROPERTY_CHANGE: u32 = 22;
}

/// Mirrors `struct mpv_event` from the C API.
#[repr(C)]
pub struct MpvEvent {
    pub event_id: u32,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

/// Mirrors `struct mpv_event_property`.
#[repr(C)]
pub struct MpvEventProperty {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

/// Mirrors `struct mpv_event_end_file` — only the leading `reason` field is used.
#[repr(C)]
pub struct MpvEventEndFile {
    pub reason: c_int,
    pub error: c_int,
    // (other fields omitted — we never read them)
}

#[allow(dead_code)]
pub mod end_file_reason {
    pub const EOF: i32 = 0;
    pub const STOP: i32 = 2;
    pub const QUIT: i32 = 3;
    pub const ERROR: i32 = 4;
    pub const REDIRECT: i32 = 5;
}

// ---------------------------------------------------------------------------
// Function‐pointer type aliases
// ---------------------------------------------------------------------------

type FnMpvCreate = unsafe extern "C" fn() -> *mut c_void;
type FnMpvInitialize = unsafe extern "C" fn(ctx: *mut c_void) -> c_int;
type FnMpvTerminateDestroy = unsafe extern "C" fn(ctx: *mut c_void);
type FnMpvSetOptionString =
    unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char, data: *const c_char) -> c_int;
type FnMpvSetPropertyString =
    unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char, data: *const c_char) -> c_int;
type FnMpvGetPropertyString =
    unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char) -> *mut c_char;
type FnMpvSetProperty =
    unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char, format: c_int, data: *mut c_void) -> c_int;
type FnMpvGetProperty =
    unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char, format: c_int, data: *mut c_void) -> c_int;
type FnMpvCommand = unsafe extern "C" fn(ctx: *mut c_void, args: *const *const c_char) -> c_int;
type FnMpvObserveProperty = unsafe extern "C" fn(
    ctx: *mut c_void,
    reply_userdata: u64,
    name: *const c_char,
    format: c_int,
) -> c_int;
type FnMpvWaitEvent =
    unsafe extern "C" fn(ctx: *mut c_void, timeout: c_double) -> *const MpvEvent;
type FnMpvFree = unsafe extern "C" fn(data: *mut c_void);

// ---------------------------------------------------------------------------
// MpvHandle
// ---------------------------------------------------------------------------

/// Owns a loaded libmpv `Library` and an initialised `mpv_handle*`.
///
/// All public methods are `&self` — the caller is expected to hold this behind
/// a `Mutex` (or only call from one thread at a time for the handle).
pub struct MpvHandle {
    _lib: Library,
    ctx: *mut c_void,

    // Cached function pointers
    fn_initialize: FnMpvInitialize,
    fn_terminate_destroy: FnMpvTerminateDestroy,
    fn_set_option_string: FnMpvSetOptionString,
    fn_set_property_string: FnMpvSetPropertyString,
    fn_get_property_string: FnMpvGetPropertyString,
    fn_set_property: FnMpvSetProperty,
    fn_get_property: FnMpvGetProperty,
    fn_command: FnMpvCommand,
    fn_observe_property: FnMpvObserveProperty,
    fn_wait_event: FnMpvWaitEvent,
    fn_free: FnMpvFree,
}

// The mpv C API is thread-safe for property/command calls as long as we
// serialise through a Mutex, which player.rs does.
unsafe impl Send for MpvHandle {}
unsafe impl Sync for MpvHandle {}

impl MpvHandle {
    /// Try to load libmpv from the given search dirs first, then fall back
    /// to the system search path.
    pub fn new(search_dirs: &[&Path]) -> Result<Self, String> {
        let lib = Self::load_library(search_dirs)?;

        // Resolve every symbol we need up front.
        unsafe {
            let fn_create: Symbol<FnMpvCreate> =
                lib.get(b"mpv_create\0").map_err(|e| format!("mpv_create: {e}"))?;
            let fn_initialize: FnMpvInitialize =
                *lib.get::<FnMpvInitialize>(b"mpv_initialize\0").map_err(|e| format!("mpv_initialize: {e}"))?;
            let fn_terminate_destroy: FnMpvTerminateDestroy =
                *lib.get::<FnMpvTerminateDestroy>(b"mpv_terminate_destroy\0")
                    .map_err(|e| format!("mpv_terminate_destroy: {e}"))?;
            let fn_set_option_string: FnMpvSetOptionString =
                *lib.get::<FnMpvSetOptionString>(b"mpv_set_option_string\0")
                    .map_err(|e| format!("mpv_set_option_string: {e}"))?;
            let fn_set_property_string: FnMpvSetPropertyString =
                *lib.get::<FnMpvSetPropertyString>(b"mpv_set_property_string\0")
                    .map_err(|e| format!("mpv_set_property_string: {e}"))?;
            let fn_get_property_string: FnMpvGetPropertyString =
                *lib.get::<FnMpvGetPropertyString>(b"mpv_get_property_string\0")
                    .map_err(|e| format!("mpv_get_property_string: {e}"))?;
            let fn_set_property: FnMpvSetProperty =
                *lib.get::<FnMpvSetProperty>(b"mpv_set_property\0")
                    .map_err(|e| format!("mpv_set_property: {e}"))?;
            let fn_get_property: FnMpvGetProperty =
                *lib.get::<FnMpvGetProperty>(b"mpv_get_property\0")
                    .map_err(|e| format!("mpv_get_property: {e}"))?;
            let fn_command: FnMpvCommand =
                *lib.get::<FnMpvCommand>(b"mpv_command\0")
                    .map_err(|e| format!("mpv_command: {e}"))?;
            let fn_observe_property: FnMpvObserveProperty =
                *lib.get::<FnMpvObserveProperty>(b"mpv_observe_property\0")
                    .map_err(|e| format!("mpv_observe_property: {e}"))?;
            let fn_wait_event: FnMpvWaitEvent =
                *lib.get::<FnMpvWaitEvent>(b"mpv_wait_event\0")
                    .map_err(|e| format!("mpv_wait_event: {e}"))?;
            let fn_free: FnMpvFree =
                *lib.get::<FnMpvFree>(b"mpv_free\0")
                    .map_err(|e| format!("mpv_free: {e}"))?;

            // Create + initialise the handle
            let ctx = fn_create();
            if ctx.is_null() {
                return Err("mpv_create returned null".into());
            }

            let handle = Self {
                _lib: lib,
                ctx,
                fn_initialize,
                fn_terminate_destroy,
                fn_set_option_string,
                fn_set_property_string,
                fn_get_property_string,
                fn_set_property,
                fn_get_property,
                fn_command,
                fn_observe_property,
                fn_wait_event,
                fn_free,
            };

            // Don't initialise yet — caller sets options (like `wid`) first,
            // then calls `initialize()`.
            Ok(handle)
        }
    }

    /// Call `mpv_initialize`. Must be called after setting pre-init options
    /// (like `wid`) and before issuing commands.
    pub fn initialize(&self) -> Result<(), String> {
        let rc = unsafe { (self.fn_initialize)(self.ctx) };
        if rc < 0 {
            Err(format!("mpv_initialize failed: error {rc}"))
        } else {
            Ok(())
        }
    }

    /// Raw context pointer — needed by the event loop thread.
    pub fn ctx_ptr(&self) -> *mut c_void {
        self.ctx
    }

    // -- Options & properties -----------------------------------------------

    pub fn set_option_string(&self, name: &str, value: &str) -> Result<(), String> {
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        let c_value = CString::new(value).map_err(|e| e.to_string())?;
        let rc = unsafe { (self.fn_set_option_string)(self.ctx, c_name.as_ptr(), c_value.as_ptr()) };
        if rc < 0 {
            Err(format!("mpv_set_option_string({name}, {value}) = {rc}"))
        } else {
            Ok(())
        }
    }

    pub fn set_property_string(&self, name: &str, value: &str) -> Result<(), String> {
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        let c_value = CString::new(value).map_err(|e| e.to_string())?;
        let rc = unsafe { (self.fn_set_property_string)(self.ctx, c_name.as_ptr(), c_value.as_ptr()) };
        if rc < 0 {
            Err(format!("mpv_set_property_string({name}, {value}) = {rc}"))
        } else {
            Ok(())
        }
    }

    pub fn get_property_string(&self, name: &str) -> Option<String> {
        let c_name = CString::new(name).ok()?;
        unsafe {
            let ptr = (self.fn_get_property_string)(self.ctx, c_name.as_ptr());
            if ptr.is_null() {
                return None;
            }
            let val = CStr::from_ptr(ptr).to_string_lossy().into_owned();
            (self.fn_free)(ptr as *mut c_void);
            Some(val)
        }
    }

    pub fn set_property_double(&self, name: &str, value: f64) -> Result<(), String> {
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        let mut val = value;
        let rc = unsafe {
            (self.fn_set_property)(
                self.ctx,
                c_name.as_ptr(),
                MpvFormat::Double as c_int,
                &mut val as *mut f64 as *mut c_void,
            )
        };
        if rc < 0 {
            Err(format!("mpv_set_property({name}, {value}) = {rc}"))
        } else {
            Ok(())
        }
    }

    pub fn get_property_double(&self, name: &str) -> Option<f64> {
        let c_name = CString::new(name).ok()?;
        let mut val: f64 = 0.0;
        let rc = unsafe {
            (self.fn_get_property)(
                self.ctx,
                c_name.as_ptr(),
                MpvFormat::Double as c_int,
                &mut val as *mut f64 as *mut c_void,
            )
        };
        if rc < 0 { None } else { Some(val) }
    }

    pub fn set_property_flag(&self, name: &str, value: bool) -> Result<(), String> {
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        let mut flag: c_int = if value { 1 } else { 0 };
        let rc = unsafe {
            (self.fn_set_property)(
                self.ctx,
                c_name.as_ptr(),
                MpvFormat::Flag as c_int,
                &mut flag as *mut c_int as *mut c_void,
            )
        };
        if rc < 0 {
            Err(format!("mpv_set_property({name}, {value}) = {rc}"))
        } else {
            Ok(())
        }
    }

    pub fn get_property_flag(&self, name: &str) -> Option<bool> {
        let c_name = CString::new(name).ok()?;
        let mut flag: c_int = 0;
        let rc = unsafe {
            (self.fn_get_property)(
                self.ctx,
                c_name.as_ptr(),
                MpvFormat::Flag as c_int,
                &mut flag as *mut c_int as *mut c_void,
            )
        };
        if rc < 0 { None } else { Some(flag != 0) }
    }

    // -- Commands -----------------------------------------------------------

    pub fn command(&self, args: &[&str]) -> Result<(), String> {
        let c_args: Vec<CString> = args
            .iter()
            .map(|a| CString::new(*a).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut ptrs: Vec<*const c_char> = c_args.iter().map(|a| a.as_ptr()).collect();
        ptrs.push(std::ptr::null()); // null-terminated array

        let rc = unsafe { (self.fn_command)(self.ctx, ptrs.as_ptr()) };
        if rc < 0 {
            Err(format!("mpv_command({args:?}) = {rc}"))
        } else {
            Ok(())
        }
    }

    // -- Property observation -----------------------------------------------

    pub fn observe_property(
        &self,
        reply_userdata: u64,
        name: &str,
        format: MpvFormat,
    ) -> Result<(), String> {
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        let rc = unsafe {
            (self.fn_observe_property)(self.ctx, reply_userdata, c_name.as_ptr(), format as c_int)
        };
        if rc < 0 {
            Err(format!("mpv_observe_property({name}) = {rc}"))
        } else {
            Ok(())
        }
    }

    // -- Events -------------------------------------------------------------

    /// Blocks up to `timeout` seconds. Returns a pointer to an `MpvEvent`
    /// that is valid until the next call to `wait_event`.
    pub fn wait_event(&self, timeout: f64) -> &MpvEvent {
        unsafe { &*(self.fn_wait_event)(self.ctx, timeout) }
    }

    // -- Library loading ----------------------------------------------------

    fn load_library(search_dirs: &[&Path]) -> Result<Library, String> {
        // Platform-specific library names
        #[cfg(target_os = "windows")]
        let names: &[&str] = &["libmpv-2.dll", "mpv-2.dll"];
        #[cfg(target_os = "linux")]
        let names: &[&str] = &["libmpv.so.2", "libmpv.so"];
        #[cfg(target_os = "macos")]
        let names: &[&str] = &["libmpv.2.dylib", "libmpv.dylib"];

        // Try each search directory
        for dir in search_dirs {
            for name in names {
                let path = dir.join(name);
                if path.exists() {
                    match unsafe { Library::new(&path) } {
                        Ok(lib) => {
                            eprintln!("Loaded libmpv from: {}", path.display());
                            return Ok(lib);
                        }
                        Err(e) => {
                            eprintln!("Failed to load {}: {e}", path.display());
                        }
                    }
                }
            }
        }

        // Fall back to system search path
        for name in names {
            match unsafe { Library::new(name) } {
                Ok(lib) => {
                    eprintln!("Loaded libmpv from system: {name}");
                    return Ok(lib);
                }
                Err(_) => continue,
            }
        }

        Err(format!(
            "Could not load libmpv. Searched dirs {:?} and system paths for: {:?}",
            search_dirs, names
        ))
    }
}

impl Drop for MpvHandle {
    fn drop(&mut self) {
        if !self.ctx.is_null() {
            unsafe { (self.fn_terminate_destroy)(self.ctx) };
            self.ctx = std::ptr::null_mut();
        }
    }
}
