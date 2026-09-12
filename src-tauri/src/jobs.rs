//! Background jobs registry — long walks the user can keep browsing through
//! (waveform preload, MusicBrainz prefetches, whatever comes next). One
//! process-wide table of running jobs, one `background-jobs` event carrying
//! the whole list on every change, so the sidebar renders a line per job
//! under its library and any surface can reattach after a refresh.
//!
//! A job is: start → progress(…) as it goes → finish. Cancellation is a flag
//! the job polls (`cancelled()`); the UI flips it through
//! `background_job_cancel`. Starting an id that's already running is a no-op
//! (the caller just reattaches) — ids are `<kind>:<library>`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Debug)]
pub struct JobStatus {
    pub id: String,
    /// "waveform-preload" | "mb-prefetch-groups" | "mb-prefetch-releases" …
    pub kind: String,
    /// Sidebar line: "preloading waveforms".
    pub label: String,
    pub library_id: Option<String>,
    pub done: usize,
    pub total: usize,
    /// What's being worked on right now ("Artist — Track"), for a byline.
    pub detail: Option<String>,
}

struct Entry {
    status: JobStatus,
    cancel: Arc<AtomicBool>,
    last_emit: Instant,
}

static JOBS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();

fn table() -> &'static Mutex<HashMap<String, Entry>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

const EMIT_MIN_INTERVAL: Duration = Duration::from_millis(250);

pub fn snapshot() -> Vec<JobStatus> {
    let mut out: Vec<JobStatus> = table()
        .lock()
        .map(|t| t.values().map(|e| e.status.clone()).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn emit(app: &AppHandle) {
    let _ = app.emit("background-jobs", snapshot());
}

pub fn is_running(id: &str) -> bool {
    table().lock().map(|t| t.contains_key(id)).unwrap_or(false)
}

/// The running job's handle: progress goes through it, and dropping it (or
/// `finish`) removes the job — a panicking task can't leave a ghost line.
pub struct JobHandle {
    id: String,
    cancel: Arc<AtomicBool>,
    app: AppHandle,
}

/// Register and announce a job. None = that id is already running.
pub fn start(
    app: &AppHandle,
    id: impl Into<String>,
    kind: &str,
    label: &str,
    library_id: Option<String>,
    total: usize,
) -> Option<JobHandle> {
    let id = id.into();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut t = table().lock().ok()?;
        if t.contains_key(&id) {
            return None;
        }
        t.insert(
            id.clone(),
            Entry {
                status: JobStatus {
                    id: id.clone(),
                    kind: kind.to_string(),
                    label: label.to_string(),
                    library_id,
                    done: 0,
                    total,
                    detail: None,
                },
                cancel: cancel.clone(),
                last_emit: Instant::now() - EMIT_MIN_INTERVAL,
            },
        );
    }
    emit(app);
    Some(JobHandle { id, cancel, app: app.clone() })
}

impl JobHandle {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Update counts (and the byline); emits at most every 250ms, except a
    /// completed count, which always lands.
    pub fn progress(&self, done: usize, total: usize, detail: Option<String>) {
        let should_emit = {
            let Ok(mut t) = table().lock() else { return };
            let Some(e) = t.get_mut(&self.id) else { return };
            e.status.done = done;
            e.status.total = total;
            e.status.detail = detail;
            let due = e.last_emit.elapsed() >= EMIT_MIN_INTERVAL || done >= total;
            if due {
                e.last_emit = Instant::now();
            }
            due
        };
        if should_emit {
            emit(&self.app);
        }
    }

    pub fn finish(self) {
        // Drop does the work.
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        if let Ok(mut t) = table().lock() {
            t.remove(&self.id);
        }
        emit(&self.app);
    }
}

#[tauri::command]
pub async fn background_jobs() -> Result<Vec<JobStatus>, String> {
    Ok(snapshot())
}

#[tauri::command]
pub async fn background_job_cancel(id: String) -> Result<(), String> {
    if let Ok(t) = table().lock() {
        if let Some(e) = t.get(&id) {
            e.cancel.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}
