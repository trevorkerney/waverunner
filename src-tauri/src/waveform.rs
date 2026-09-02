//! Waveform peaks for the music seekbar — computed LAZILY on the first
//! request for a track (a background decode, seconds at most), then cached in
//! `track_waveform` behind a (size, mtime) stamp: once per file, ever. No
//! library-wide scan phase — a track that never plays never costs a decode.
//! Undecodable codecs (OPUS has no symphonia decoder) return None and the bar
//! quietly keeps its plain slider.

use sqlx::SqlitePool;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;
use tauri::State;

use crate::AppState;

/// Horizontal resolution of the stored waveform. 480 bars ≈ one per couple of
/// pixels at the bar's rendered width; stored as one normalized byte each.
const BUCKETS: usize = 480;

/// Decode the whole file and reduce it to BUCKETS absolute-peak bytes,
/// normalized to the track's own loudest sample (display normalization — a
/// quiet acoustic track still draws a full-height shape).
pub(crate) fn compute_peaks(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &Default::default(), &Default::default())
        .map_err(|e| e.to_string())?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("no audio track")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &Default::default())
        .map_err(|e| e.to_string())?;

    // Coarse pass: absolute peak per fixed sample window, downsampled to
    // BUCKETS at the end. A 10-hour recording stays a few MB of f32s.
    const WINDOW: usize = 4096;
    let mut coarse: Vec<f32> = Vec::new();
    let mut cur_max = 0f32;
    let mut in_window = 0usize;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut buf_cap: u64 = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break, // EOF (or a tail error) — use what decoded
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue, // one bad packet shouldn't kill the shape
        };
        let cap = decoded.capacity() as u64;
        if sample_buf.is_none() || cap > buf_cap {
            sample_buf = Some(SampleBuffer::new(cap, *decoded.spec()));
            buf_cap = cap;
        }
        let buf = sample_buf.as_mut().unwrap();
        buf.copy_interleaved_ref(decoded);
        for &s in buf.samples() {
            let a = s.abs();
            if a > cur_max {
                cur_max = a;
            }
            in_window += 1;
            if in_window >= WINDOW {
                coarse.push(cur_max);
                cur_max = 0.0;
                in_window = 0;
            }
        }
    }
    if in_window > 0 {
        coarse.push(cur_max);
    }
    if coarse.is_empty() {
        return Err("no audio decoded".to_string());
    }

    let overall = coarse.iter().cloned().fold(0f32, f32::max).max(1e-6);
    let mut out = vec![0u8; BUCKETS];
    for (i, slot) in out.iter_mut().enumerate() {
        let a = i * coarse.len() / BUCKETS;
        let b = (((i + 1) * coarse.len()) / BUCKETS).max(a + 1).min(coarse.len());
        let m = coarse[a..b].iter().cloned().fold(0f32, f32::max);
        *slot = ((m / overall) * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    Ok(out)
}

async fn cached_peaks(
    pool: &SqlitePool,
    track_id: i64,
    size: i64,
    mtime: i64,
) -> Result<Option<Vec<u8>>, String> {
    let row: Option<(Vec<u8>, i64, i64)> = sqlx::query_as(
        "SELECT peaks, content_size, content_mtime FROM track_waveform WHERE track_id = ?",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(peaks, csize, cmtime)| (csize == size && cmtime == mtime).then_some(peaks)))
}

/// The one entry point: cached peaks instantly, else decode-and-cache. None =
/// no waveform possible (track/file gone, or codec undecodable) — plain bar.
pub(crate) async fn ensure_waveform(
    pool: &SqlitePool,
    track_id: i64,
) -> Result<Option<Vec<u8>>, String> {
    let Some(abs) = crate::music_player::fresh_track_path(pool, track_id).await else {
        return Ok(None);
    };
    let Ok(meta) = std::fs::metadata(&abs) else {
        return Ok(None);
    };
    let size = meta.len() as i64;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if let Some(peaks) = cached_peaks(pool, track_id, size, mtime).await? {
        return Ok(Some(peaks));
    }
    let abs_owned = abs.clone();
    let computed = tauri::async_runtime::spawn_blocking(move || {
        compute_peaks(Path::new(&abs_owned))
    })
    .await
    .map_err(|e| e.to_string())?;
    let peaks = match computed {
        Ok(p) => p,
        Err(_) => return Ok(None), // undecodable — the plain bar is the answer
    };
    sqlx::query(
        "INSERT INTO track_waveform (track_id, peaks, content_size, content_mtime)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(track_id) DO UPDATE SET peaks = excluded.peaks,
             content_size = excluded.content_size, content_mtime = excluded.content_mtime",
    )
    .bind(track_id)
    .bind(&peaks)
    .bind(size)
    .bind(mtime)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(Some(peaks))
}

#[tauri::command]
pub async fn get_track_waveform(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<Option<Vec<u8>>, String> {
    ensure_waveform(&state.app_db, track_id).await
}

// ── Preload ────────────────────────────────────────────────────────────────
// Opt-in whole-library backfill (Settings → Audio): walks every music-library
// track through ensure_waveform — cached rows skip in a millisecond, the rest
// decode once. Politely paced, yields to matching passes, cancellable, and
// reports progress via the `waveform-preload` event so the UI can minimize
// and reattach like a rescan.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

static PRELOAD_RUNNING: AtomicBool = AtomicBool::new(false);
static PRELOAD_CANCEL: AtomicBool = AtomicBool::new(false);
static PRELOAD_DONE: AtomicUsize = AtomicUsize::new(0);
static PRELOAD_TOTAL: AtomicUsize = AtomicUsize::new(0);
/// Title of the track currently decoding — the progress window's byline.
static PRELOAD_TRACK: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// Which library this run walks — the sidebar hangs the progress line there.
static PRELOAD_LIB: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[derive(serde::Serialize, Clone)]
pub struct PreloadStatus {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub track: Option<String>,
    pub library_id: Option<String>,
}

fn preload_status_now() -> PreloadStatus {
    PreloadStatus {
        running: PRELOAD_RUNNING.load(Ordering::SeqCst),
        done: PRELOAD_DONE.load(Ordering::SeqCst),
        total: PRELOAD_TOTAL.load(Ordering::SeqCst),
        track: PRELOAD_TRACK.lock().ok().and_then(|g| g.clone()),
        library_id: PRELOAD_LIB.lock().ok().and_then(|g| g.clone()),
    }
}

/// Reattach point for the UI (app restart, reopened progress window).
#[tauri::command]
pub async fn waveform_preload_status() -> Result<PreloadStatus, String> {
    Ok(preload_status_now())
}

#[tauri::command]
pub async fn waveform_preload_cancel() -> Result<(), String> {
    PRELOAD_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

/// Start the backfill for ONE library (launched from its Library settings;
/// no-op if a run is already going — the caller just reattaches).
#[tauri::command]
pub async fn waveform_preload_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    if PRELOAD_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    PRELOAD_CANCEL.store(false, Ordering::SeqCst);
    if let Ok(mut l) = PRELOAD_LIB.lock() {
        *l = Some(library_id.clone());
    }
    let pool = state.app_db.clone();
    let ids: Vec<(i64,)> = match sqlx::query_as(
        "SELECT t.id FROM track t
         JOIN media_entry me ON me.id = t.id
         WHERE me.library_id = ?
         ORDER BY t.id",
    )
    .bind(&library_id)
    .fetch_all(&pool)
    .await
    {
        Ok(ids) => ids,
        Err(e) => {
            PRELOAD_RUNNING.store(false, Ordering::SeqCst);
            if let Ok(mut l) = PRELOAD_LIB.lock() {
                *l = None;
            }
            return Err(e.to_string());
        }
    };
    PRELOAD_TOTAL.store(ids.len(), Ordering::SeqCst);
    PRELOAD_DONE.store(0, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let mut last_emit = std::time::Instant::now();
        for (id,) in ids {
            if PRELOAD_CANCEL.load(Ordering::SeqCst) {
                break;
            }
            // A matching pass shares the DB and the CPU — wait it out.
            while crate::music_mb::pass_running() && !PRELOAD_CANCEL.load(Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            // "Artist — Track" byline: main credit first, track_meta's display
            // artist as the fallback, bare title when neither exists.
            let row: Option<(String, Option<String>)> = sqlx::query_as(
                "SELECT t.title,
                        COALESCE((SELECT tc.name FROM track_credit tc
                                  WHERE tc.track_id = t.id ORDER BY tc.position LIMIT 1),
                                 (SELECT tm.artist_name FROM track_meta tm
                                  WHERE tm.track_id = t.id))
                 FROM track t WHERE t.id = ?",
            )
            .bind(id)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();
            if let Ok(mut t) = PRELOAD_TRACK.lock() {
                *t = row.map(|(title, artist)| match artist {
                    Some(a) if !a.trim().is_empty() => format!("{a} \u{2014} {title}"),
                    _ => title,
                });
            }
            let _ = ensure_waveform(&pool, id).await; // failures just skip
            PRELOAD_DONE.fetch_add(1, Ordering::SeqCst);
            if last_emit.elapsed().as_millis() >= 250 {
                last_emit = std::time::Instant::now();
                let _ = app.emit("waveform-preload", preload_status_now());
            }
            // Politeness gap so playback and the UI never feel the walk.
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        }
        PRELOAD_RUNNING.store(false, Ordering::SeqCst);
        if let Ok(mut t) = PRELOAD_TRACK.lock() {
            *t = None;
        }
        if let Ok(mut l) = PRELOAD_LIB.lock() {
            *l = None;
        }
        let _ = app.emit("waveform-preload", preload_status_now());
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode a real track from the dev library (skipped when the drive is
    /// absent): the peaks must fill every bucket, hit full scale somewhere
    /// (normalization), and actually vary — a flat shape means the decode
    /// silently produced garbage.
    #[test]
    fn real_track_produces_a_shape() {
        let base = Path::new(r"A:\public\media\music");
        if !base.exists() {
            eprintln!("skipping: dev library not mounted");
            return;
        }
        // First audio file found under the base, walking shallowly.
        fn find_audio(dir: &Path, depth: usize) -> Option<std::path::PathBuf> {
            let mut dirs = Vec::new();
            for e in std::fs::read_dir(dir).ok()?.flatten() {
                let p = e.path();
                if p.is_dir() {
                    dirs.push(p);
                } else if matches!(
                    p.extension().and_then(|x| x.to_str()).map(|x| x.to_lowercase()).as_deref(),
                    Some("flac") | Some("mp3")
                ) {
                    return Some(p);
                }
            }
            if depth == 0 {
                return None;
            }
            dirs.into_iter().find_map(|d| find_audio(&d, depth - 1))
        }
        let Some(file) = find_audio(base, 3) else {
            eprintln!("skipping: no audio file found");
            return;
        };
        let peaks = compute_peaks(&file).expect("decode should succeed");
        assert_eq!(peaks.len(), BUCKETS);
        assert_eq!(*peaks.iter().max().unwrap(), 255, "normalized to full scale");
        let distinct: std::collections::HashSet<u8> = peaks.iter().copied().collect();
        assert!(distinct.len() > 8, "waveform should vary, got {} levels", distinct.len());
    }
}
