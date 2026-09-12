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

/// Stored layout: LEFT peaks (BUCKETS bytes) then RIGHT peaks (BUCKETS
/// bytes) — the bar draws left above the midline, right below, the way every
/// DAW stacks a stereo file. Mono is both. Rows of the old single-channel
/// length are treated as missing and recomputed on the next request.
const STORED_LEN: usize = 2 * BUCKETS;

/// Which side(s) each channel of a layout feeds, in interleave order. Left-
/// and right-positioned channels go to their side, centres to both, LFE to
/// neither; a layout with no recognizable sides (or one channel) falls back
/// to both / index parity. Player convention, not DAW: a 5.1 file folds to
/// two halves rather than six lanes — a seekbar only has a top and a bottom.
fn channel_sides(channels: symphonia::core::audio::Channels) -> Vec<(bool, bool)> {
    use symphonia::core::audio::Channels as C;
    let left = C::FRONT_LEFT
        | C::REAR_LEFT
        | C::FRONT_LEFT_CENTRE
        | C::SIDE_LEFT
        | C::TOP_FRONT_LEFT
        | C::TOP_REAR_LEFT
        | C::REAR_LEFT_CENTRE
        | C::FRONT_LEFT_WIDE
        | C::FRONT_LEFT_HIGH;
    let right = C::FRONT_RIGHT
        | C::REAR_RIGHT
        | C::FRONT_RIGHT_CENTRE
        | C::SIDE_RIGHT
        | C::TOP_FRONT_RIGHT
        | C::TOP_REAR_RIGHT
        | C::REAR_RIGHT_CENTRE
        | C::FRONT_RIGHT_WIDE
        | C::FRONT_RIGHT_HIGH;
    let centre = C::FRONT_CENTRE
        | C::REAR_CENTRE
        | C::TOP_CENTRE
        | C::TOP_FRONT_CENTRE
        | C::TOP_REAR_CENTRE
        | C::FRONT_CENTRE_HIGH;
    let bits = channels.bits();
    let mut sides: Vec<(bool, bool)> = Vec::new();
    for b in 0..32 {
        let flag = 1u32 << b;
        if bits & flag == 0 {
            continue;
        }
        let ch = C::from_bits_truncate(flag);
        let l = left.contains(ch) || centre.contains(ch);
        let r = right.contains(ch) || centre.contains(ch);
        sides.push((l, r));
    }
    let count = sides.len().max(1);
    let any_side = sides.iter().any(|(l, r)| *l || *r);
    if count == 1 {
        return vec![(true, true)];
    }
    if !any_side {
        // Unknown positions: alternate, which is right for the common
        // unlabelled-stereo case and harmless beyond it.
        return (0..count).map(|i| (i % 2 == 0, i % 2 == 1)).collect();
    }
    sides
}

/// Decode the whole file and reduce it to STORED_LEN absolute-peak bytes —
/// left channel(s) then right — normalized to the track's own loudest sample
/// across both sides (display normalization — a quiet acoustic track still
/// draws a full-height shape, and a lopsided mix stays lopsided).
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

    // Coarse pass: absolute peak per side per fixed FRAME window, downsampled
    // to BUCKETS at the end. A 10-hour recording stays a few MB of f32s.
    const WINDOW: usize = 4096;
    let mut coarse_l: Vec<f32> = Vec::new();
    let mut coarse_r: Vec<f32> = Vec::new();
    let mut max_l = 0f32;
    let mut max_r = 0f32;
    let mut in_window = 0usize;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut buf_cap: u64 = 0;
    let mut sides: Vec<(bool, bool)> = Vec::new();
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
        if sides.is_empty() {
            sides = channel_sides(decoded.spec().channels);
        }
        let nch = sides.len().max(1);
        let buf = sample_buf.as_mut().unwrap();
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks(nch) {
            for (s, (l, r)) in frame.iter().zip(&sides) {
                let a = s.abs();
                if *l && a > max_l {
                    max_l = a;
                }
                if *r && a > max_r {
                    max_r = a;
                }
            }
            in_window += 1;
            if in_window >= WINDOW {
                coarse_l.push(max_l);
                coarse_r.push(max_r);
                max_l = 0.0;
                max_r = 0.0;
                in_window = 0;
            }
        }
    }
    if in_window > 0 {
        coarse_l.push(max_l);
        coarse_r.push(max_r);
    }
    if coarse_l.is_empty() {
        return Err("no audio decoded".to_string());
    }

    // One normalization across both sides: the loudest sample anywhere hits
    // full scale, and a channel imbalance shows as one.
    let overall = coarse_l
        .iter()
        .chain(coarse_r.iter())
        .cloned()
        .fold(0f32, f32::max)
        .max(1e-6);
    let reduce = |coarse: &[f32], out: &mut [u8]| {
        for (i, slot) in out.iter_mut().enumerate() {
            let a = i * coarse.len() / BUCKETS;
            let b = (((i + 1) * coarse.len()) / BUCKETS).max(a + 1).min(coarse.len());
            let m = coarse[a..b].iter().cloned().fold(0f32, f32::max);
            *slot = ((m / overall) * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    };
    let mut out = vec![0u8; STORED_LEN];
    let (left, right) = out.split_at_mut(BUCKETS);
    reduce(&coarse_l, left);
    reduce(&coarse_r, right);
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
    // A row of the pre-stereo length is a cache miss: it recomputes on this
    // request (and the preload walk refills the whole library).
    Ok(row.and_then(|(peaks, csize, cmtime)| {
        (csize == size && cmtime == mtime && peaks.len() == STORED_LEN).then_some(peaks)
    }))
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
// Opt-in whole-library backfill (Library settings): walks every music-library
// track through ensure_waveform — cached rows skip in a millisecond, the rest
// decode once. Politely paced, yields to matching passes, cancellable, and
// reports through the background-jobs registry (crate::jobs) so the sidebar
// shows the line and the progress window can reattach.

pub const PRELOAD_JOB_KIND: &str = "waveform-preload";

/// Start the backfill for ONE library (launched from its Library settings;
/// no-op if a run for that library is already going — the caller reattaches).
#[tauri::command]
pub async fn waveform_preload_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    let pool = state.app_db.clone();
    let ids: Vec<(i64,)> = sqlx::query_as(
        "SELECT t.id FROM track t
         JOIN media_entry me ON me.id = t.id
         WHERE me.library_id = ?
         ORDER BY t.id",
    )
    .bind(&library_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let total = ids.len();
    let Some(job) = crate::jobs::start(
        &app,
        format!("{PRELOAD_JOB_KIND}:{library_id}"),
        PRELOAD_JOB_KIND,
        "preloading waveforms",
        Some(library_id),
        total,
    ) else {
        return Ok(()); // already running — reattach
    };
    tauri::async_runtime::spawn(async move {
        let mut done = 0usize;
        for (id,) in ids {
            if job.cancelled() {
                break;
            }
            // A matching pass shares the DB and the CPU — wait it out.
            while crate::music_mb::pass_running() && !job.cancelled() {
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
            let byline = row.map(|(title, artist)| match artist {
                Some(a) if !a.trim().is_empty() => format!("{a} \u{2014} {title}"),
                _ => title,
            });
            job.progress(done, total, byline.clone());
            let _ = ensure_waveform(&pool, id).await; // failures just skip
            done += 1;
            job.progress(done, total, byline);
            // Politeness gap so playback and the UI never feel the walk.
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        }
        job.finish();
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
        assert_eq!(peaks.len(), STORED_LEN);
        assert_eq!(*peaks.iter().max().unwrap(), 255, "normalized to full scale");
        let distinct: std::collections::HashSet<u8> = peaks.iter().copied().collect();
        assert!(distinct.len() > 8, "waveform should vary, got {} levels", distinct.len());
        // Both sides carry signal on a real track.
        assert!(peaks[..BUCKETS].iter().any(|&p| p > 0), "left side empty");
        assert!(peaks[BUCKETS..].iter().any(|&p| p > 0), "right side empty");
    }

    #[test]
    fn channel_sides_fold_layouts_to_two_halves() {
        use symphonia::core::audio::Channels as C;
        assert_eq!(channel_sides(C::FRONT_LEFT), vec![(true, true)]);
        assert_eq!(
            channel_sides(C::FRONT_LEFT | C::FRONT_RIGHT),
            vec![(true, false), (false, true)]
        );
        // 5.1: L R C LFE Ls Rs → centre feeds both, LFE neither.
        assert_eq!(
            channel_sides(
                C::FRONT_LEFT | C::FRONT_RIGHT | C::FRONT_CENTRE | C::LFE1 | C::REAR_LEFT | C::REAR_RIGHT
            ),
            vec![(true, false), (false, true), (true, true), (false, false), (true, false), (false, true)]
        );
        // No recognizable sides → alternate by index.
        assert_eq!(channel_sides(C::LFE1 | C::LFE2), vec![(true, false), (false, true)]);
    }
}
