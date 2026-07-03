//! Interactive playback engine — drives mpv through the branch graph parsed by
//! `interactive.rs`.
//!
//! A session is a dedicated thread that polls mpv's `time-pos` (~60Hz near
//! segment boundaries, ~30Hz otherwise) and:
//!   - fires the current segment's moments as playback enters their windows
//!     (choice overlays, tutorial notifications, playbackImpression state writes)
//!   - closes choice windows on timeout, applying the default choice
//!   - at each segment's endTimeMs resolves the next segment (selected choice →
//!     segmentGroup routing → defaultNext) and seeks unless it's contiguous
//!
//! State model: `globalState` lives for one playthrough; `persistentState`
//! survives across playthroughs ("remembers your choices") in the
//! interactive_state table, written through on every change. The choice UI is
//! React's; this module only emits events and accepts `interactive_choose`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, State};

use crate::interactive::{self, Choice, GroupItem, InteractiveBundle, Moment};
use crate::player::PlayerInner;
use crate::AppState;

/// Act this many ms before a segment's endTimeMs so a non-contiguous jump
/// never shows frames of the physically-next (wrong) segment. One PAL frame.
const BOUNDARY_EPS_MS: i64 = 24;
/// A jump target starting within this of the current end is contiguous — the
/// file just keeps playing, no seek.
const CONTIGUOUS_MS: i64 = 40;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/// One visible choice as the frontend renders it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceView {
    pub text: String,
    pub sub_text: Option<String>,
}

/// Payload for `interactive-choice-open` (and rehydration via
/// `interactive_status`). Times are video-absolute ms; `remaining_ms` is
/// computed at emit time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOpen {
    pub segment_id: String,
    pub choices: Vec<ChoiceView>,
    pub default_index: usize,
    pub remaining_ms: i64,
    pub total_ms: i64,
    pub layout_type: Option<String>,
    pub selected_index: Option<usize>,
}

/// A live choice window: the view plus what each pick does (jump target —
/// a segment id or segmentGroup name — and state writes).
struct OpenChoice {
    view: ChoiceOpen,
    targets: Vec<Option<String>>,
    impressions: Vec<Option<Value>>,
    window_end_ms: i64,
}

pub struct Shared {
    pub entry_id: i64,
    pub library_id: String,
    pub title: String,
    current_segment: String,
    /// Jump target committed by a choice (applied at segment end).
    pending_target: Option<String>,
    open: Option<OpenChoice>,
    global: HashMap<String, Value>,
    persistent: HashMap<String, Value>,
}

pub struct Session {
    pub shutdown: Arc<AtomicBool>,
    pub shared: Arc<Mutex<Shared>>,
}

/// Stop and drop the active session, if any. Safe to call from anywhere.
pub fn stop_session(state: &AppState) {
    let taken = state
        .interactive
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    if let Some(session) = taken {
        session.shutdown.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// State + precondition engine
// ---------------------------------------------------------------------------

/// Evaluate a precondition/arithmetic expression tree. Expressions are JSON
/// arrays `[op, ...args]`; anything else is a literal. Operand lookups:
/// `["persistentState", key]` / `["globalState", key]`.
fn eval_expr(expr: &Value, global: &HashMap<String, Value>, persistent: &HashMap<String, Value>) -> Value {
    let Value::Array(items) = expr else {
        return expr.clone();
    };
    let Some(op) = items.first().and_then(Value::as_str) else {
        return Value::Null;
    };
    let args = &items[1..];
    let ev = |e: &Value| eval_expr(e, global, persistent);
    let num = |e: &Value| ev(e).as_f64().unwrap_or(0.0);
    match op {
        "persistentState" => args
            .first()
            .and_then(Value::as_str)
            .and_then(|k| persistent.get(k))
            .cloned()
            .unwrap_or(Value::Null),
        "globalState" => args
            .first()
            .and_then(Value::as_str)
            .and_then(|k| global.get(k))
            .cloned()
            .unwrap_or(Value::Null),
        "not" => Value::Bool(!args.first().map_or(false, |a| truthy(&ev(a)))),
        "and" => Value::Bool(args.iter().all(|a| truthy(&ev(a)))),
        "or" => Value::Bool(args.iter().any(|a| truthy(&ev(a)))),
        "eql" => Value::Bool(args.len() == 2 && ev(&args[0]) == ev(&args[1])),
        "lt" => Value::Bool(args.len() == 2 && num(&args[0]) < num(&args[1])),
        "lte" => Value::Bool(args.len() == 2 && num(&args[0]) <= num(&args[1])),
        "gt" => Value::Bool(args.len() == 2 && num(&args[0]) > num(&args[1])),
        "gte" => Value::Bool(args.len() == 2 && num(&args[0]) >= num(&args[1])),
        "sum" => serde_json::json!(args.iter().map(|a| num(a)).sum::<f64>()),
        "mult" => serde_json::json!(args.iter().map(|a| num(a)).product::<f64>()),
        _ => Value::Null,
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Null => false,
        Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

impl Shared {
    /// Named precondition (from the info file's `preconditions` map). Unknown
    /// names pass — better to show a choice than to dead-end the story.
    fn precondition_by_id(&self, bundle: &InteractiveBundle, id: &str) -> bool {
        match bundle.moments.preconditions.get(id) {
            Some(expr) => truthy(&eval_expr(expr, &self.global, &self.persistent)),
            None => true,
        }
    }

    fn moment_passes(&self, bundle: &InteractiveBundle, m: &Moment) -> bool {
        if let Some(expr) = &m.precondition {
            if !truthy(&eval_expr(expr, &self.global, &self.persistent)) {
                return false;
            }
        }
        if let Some(id) = &m.precondition_id {
            if !self.precondition_by_id(bundle, id) {
                return false;
            }
        }
        true
    }

    /// Merge an impressionData blob (`{data: {global: {...}, persistent: {...}}}`)
    /// into the two state scopes. Returns whether persistent state changed.
    fn apply_impression(&mut self, impression: &Value) -> bool {
        let Some(data) = impression.get("data") else { return false };
        if let Some(g) = data.get("global").and_then(Value::as_object) {
            for (k, v) in g {
                self.global.insert(k.clone(), v.clone());
            }
        }
        let mut persistent_changed = false;
        if let Some(p) = data.get("persistent").and_then(Value::as_object) {
            for (k, v) in p {
                if self.persistent.get(k) != Some(v) {
                    self.persistent.insert(k.clone(), v.clone());
                    persistent_changed = true;
                }
            }
        }
        persistent_changed
    }

    /// Resolve a jump reference — a segment id, or a segmentGroup name routed
    /// by preconditions — to a concrete segment id. A name that is both reads
    /// as the segment (choice targets point at segments).
    fn resolve_ref(&self, bundle: &InteractiveBundle, name: &str, depth: u8) -> Option<String> {
        if bundle.manifest.segments.contains_key(name) {
            return Some(name.to_string());
        }
        self.resolve_group(bundle, name, depth)
    }

    /// First member of the named group whose precondition passes, resolved
    /// through nested groups.
    fn resolve_group(&self, bundle: &InteractiveBundle, name: &str, depth: u8) -> Option<String> {
        if depth == 0 {
            return None;
        }
        let group = bundle.moments.segment_groups.get(name)?;
        for item in group {
            match item {
                GroupItem::Ref(s) => {
                    if let Some(hit) = self.resolve_ref(bundle, s, depth - 1) {
                        return Some(hit);
                    }
                }
                GroupItem::Segment { segment, precondition } => {
                    let passes = precondition
                        .as_deref()
                        .map_or(true, |p| self.precondition_by_id(bundle, p));
                    if passes {
                        return Some(segment.clone());
                    }
                }
                GroupItem::Group { segment_group } => {
                    if let Some(hit) = self.resolve_group(bundle, segment_group, depth - 1) {
                        return Some(hit);
                    }
                }
            }
        }
        None
    }

    /// Where playback goes when the current segment ends: a committed choice
    /// wins, then segmentGroup routing keyed by the segment id (many segment
    /// ids double as group keys — the group is the router, so it must be
    /// consulted as a group, never re-read as the segment itself), then
    /// defaultNext, then the first `next` entry.
    fn resolve_next(&mut self, bundle: &InteractiveBundle) -> Option<String> {
        if let Some(target) = self.pending_target.take() {
            if let Some(hit) = self.resolve_ref(bundle, &target, 8) {
                return Some(hit);
            }
        }
        let current = self.current_segment.clone();
        if let Some(hit) = self.resolve_group(bundle, &current, 8) {
            return Some(hit);
        }
        let seg = bundle.manifest.segments.get(&current)?;
        if let Some(next) = &seg.default_next {
            return Some(next.clone());
        }
        seg.next
            .as_ref()
            .and_then(|n| n.keys().min().cloned())
    }
}

// ---------------------------------------------------------------------------
// Driver thread
// ---------------------------------------------------------------------------

fn moment_is_choice(m: &Moment) -> bool {
    m.kind.as_deref().map_or(false, |k| k.starts_with("scene:"))
        && m.choices.as_ref().map_or(false, |c| !c.is_empty())
}

/// Display window of a moment in video-absolute ms.
fn moment_window(m: &Moment) -> Option<(i64, i64)> {
    let start = m.ui_display_ms.or(m.start_ms)?;
    let end = m.ui_hide_ms.or(m.end_ms)?;
    (end > start).then_some((start, end))
}

fn choice_target(c: &Choice) -> Option<String> {
    c.segment_id.clone().or_else(|| c.sg.clone())
}

fn spawn_save_persistent(pool: &SqlitePool, entry_id: i64, persistent: &HashMap<String, Value>) {
    let json = serde_json::to_string(persistent).unwrap_or_else(|_| "{}".into());
    let pool = pool.clone();
    tauri::async_runtime::spawn(async move {
        let _ = sqlx::query(
            "INSERT INTO interactive_state (entry_id, persistent_json) VALUES (?, ?)
             ON CONFLICT(entry_id) DO UPDATE SET persistent_json = excluded.persistent_json",
        )
        .bind(entry_id)
        .bind(json)
        .execute(&pool)
        .await;
    });
}

fn driver_loop(
    app: AppHandle,
    player: Arc<PlayerInner>,
    pool: SqlitePool,
    bundle: InteractiveBundle,
    session: Arc<Session>,
) {
    // Moments already fired during the current segment visit (index-keyed;
    // cleared on segment entry so a revisit replays them).
    let mut fired: HashSet<usize> = HashSet::new();
    let mut last_tick = Instant::now();
    // After a jump seek, ignore stale positions until mpv lands (or times out).
    let mut settling_until: Option<(i64, Instant)> = None;
    let mut ended_emitted = false;

    let entry_id = {
        let Ok(sh) = session.shared.lock() else { return };
        let _ = app.emit("interactive-segment", serde_json::json!({ "segmentId": sh.current_segment }));
        sh.entry_id
    };

    loop {
        if session.shutdown.load(Ordering::SeqCst) || player.shutdown.load(Ordering::SeqCst) {
            break;
        }

        let Some(pos) = player.mpv.get_property_double("time-pos") else {
            std::thread::sleep(Duration::from_millis(30));
            continue;
        };
        let pos_ms = (pos * 1000.0) as i64;

        // Post-seek settling: mpv reports the old position until the seek
        // lands; acting on it would re-trigger the segment we just left.
        if let Some((expect_ms, started)) = settling_until {
            let landed = (pos_ms - expect_ms).abs() < 1500
                && !player.mpv.get_property_flag("seeking").unwrap_or(false);
            if !landed && started.elapsed() < Duration::from_secs(4) {
                std::thread::sleep(Duration::from_millis(8));
                continue;
            }
            settling_until = None;
        }

        let mut seek_to: Option<i64> = None;
        {
            let Ok(mut sh) = session.shared.lock() else { break };
            let current = sh.current_segment.clone();
            let Some(seg) = bundle.manifest.segments.get(&current) else { break };

            // 1. Fire moments whose window playback has entered.
            if let Some(moments) = bundle.moments.moments_by_segment.get(&current) {
                for (i, m) in moments.iter().enumerate() {
                    if fired.contains(&i) {
                        continue;
                    }
                    let Some((start, end)) = moment_window(m) else { continue };
                    if pos_ms < start || pos_ms >= end {
                        continue;
                    }
                    fired.insert(i);
                    if !sh.moment_passes(&bundle, m) {
                        continue;
                    }
                    if let Some(imp) = &m.impression_data {
                        if sh.apply_impression(imp) {
                            spawn_save_persistent(&pool, entry_id, &sh.persistent);
                        }
                    }
                    if moment_is_choice(m) {
                        open_choice(&app, &mut sh, &bundle, m, &current, pos_ms, start, end);
                    } else if m.kind.as_deref() == Some("notification:inlineTutorial") {
                        let _ = app.emit(
                            "interactive-notification",
                            serde_json::json!({
                                "headerText": m.header_text,
                                "bodyText": m.body_text,
                                "remainingMs": end - pos_ms,
                            }),
                        );
                    }
                    // notification:playbackImpression is pure state (handled
                    // above); notification:action (exitToPostPlay) is a
                    // Netflix-app concern — playback just continues.
                }
            }

            // 2. Choice window countdown / timeout.
            let mut close_payload: Option<(Option<usize>, bool)> = None;
            if let Some(open) = &mut sh.open {
                if pos_ms >= open.window_end_ms {
                    let timed_out = open.view.selected_index.is_none();
                    if timed_out {
                        let idx = open.view.default_index.min(open.view.choices.len().saturating_sub(1));
                        open.view.selected_index = Some(idx);
                    }
                    close_payload = Some((open.view.selected_index, timed_out));
                } else if last_tick.elapsed() >= Duration::from_millis(200) {
                    last_tick = Instant::now();
                    let _ = app.emit(
                        "interactive-choice-tick",
                        serde_json::json!({ "remainingMs": open.window_end_ms - pos_ms }),
                    );
                }
            }
            if let Some((selected, timed_out)) = close_payload {
                if let Some(open) = sh.open.take() {
                    if timed_out {
                        if let Some(idx) = selected {
                            if let Some(imp) = open.impressions.get(idx).and_then(|o| o.as_ref()) {
                                if sh.apply_impression(imp) {
                                    spawn_save_persistent(&pool, entry_id, &sh.persistent);
                                }
                            }
                            if let Some(target) = open.targets.get(idx).and_then(|t| t.clone()) {
                                sh.pending_target = Some(target);
                            }
                        }
                    }
                }
                let _ = app.emit(
                    "interactive-choice-closed",
                    serde_json::json!({ "selectedIndex": selected, "timedOut": timed_out }),
                );
            }

            // 3. Segment boundary.
            if let Some(end) = seg.end_time_ms {
                if pos_ms >= end - BOUNDARY_EPS_MS {
                    match sh.resolve_next(&bundle) {
                        Some(next_id) => {
                            let target_start = bundle
                                .manifest
                                .segments
                                .get(&next_id)
                                .map(|t| t.start_time_ms)
                                .unwrap_or(end);
                            if (target_start - end).abs() > CONTIGUOUS_MS {
                                seek_to = Some(target_start);
                            }
                            sh.current_segment = next_id.clone();
                            sh.open = None;
                            fired.clear();
                            let _ = app.emit("interactive-segment", serde_json::json!({ "segmentId": next_id }));
                            // Terminal credits segments have no endTimeMs; tell
                            // the UI the story has resolved.
                            let terminal = bundle
                                .manifest
                                .segments
                                .get(&sh.current_segment)
                                .map_or(false, |s| s.end_time_ms.is_none());
                            if terminal && !ended_emitted {
                                ended_emitted = true;
                                let _ = app.emit("interactive-ended", serde_json::json!({}));
                            }
                        }
                        None => {
                            if !ended_emitted {
                                ended_emitted = true;
                                let _ = app.emit("interactive-ended", serde_json::json!({}));
                            }
                        }
                    }
                }
            }
        } // shared lock released before the (slow) seek

        if let Some(target_ms) = seek_to {
            let _ = player
                .mpv
                .command(&["seek", &format!("{:.3}", target_ms as f64 / 1000.0), "absolute+exact"]);
            settling_until = Some((target_ms, Instant::now()));
            continue;
        }

        // Adaptive cadence: tight near a boundary, relaxed elsewhere.
        let near_boundary = {
            let seg_end = session
                .shared
                .lock()
                .ok()
                .and_then(|sh| bundle.manifest.segments.get(&sh.current_segment).and_then(|s| s.end_time_ms));
            seg_end.map_or(false, |end| end - pos_ms < 120)
        };
        std::thread::sleep(Duration::from_millis(if near_boundary { 4 } else { 15 }));
    }
}

/// Build the visible choice list (precondition-filtered), store the live
/// window, and notify the frontend.
#[allow(clippy::too_many_arguments)]
fn open_choice(
    app: &AppHandle,
    sh: &mut Shared,
    bundle: &InteractiveBundle,
    m: &Moment,
    segment_id: &str,
    pos_ms: i64,
    window_start: i64,
    window_end: i64,
) {
    let all = m.choices.as_deref().unwrap_or(&[]);
    let mut views = Vec::new();
    let mut targets = Vec::new();
    let mut impressions = Vec::new();
    let mut default_index = 0usize;
    let raw_default = m.default_choice_index.unwrap_or(0).max(0) as usize;
    for (raw_idx, c) in all.iter().enumerate() {
        if let Some(p) = &c.precondition_id {
            if !sh.precondition_by_id(bundle, p) {
                continue;
            }
        }
        if raw_idx == raw_default {
            default_index = views.len();
        }
        views.push(ChoiceView {
            text: c.text.clone().unwrap_or_default(),
            sub_text: c.sub_text.clone(),
        });
        targets.push(choice_target(c));
        impressions.push(c.impression_data.clone());
    }
    if views.is_empty() {
        return;
    }
    let view = ChoiceOpen {
        segment_id: segment_id.to_string(),
        choices: views,
        default_index,
        remaining_ms: window_end - pos_ms,
        total_ms: window_end - window_start,
        layout_type: m.layout_type.clone(),
        selected_index: None,
    };
    let _ = app.emit("interactive-choice-open", &view);
    sh.open = Some(OpenChoice { view, targets, impressions, window_end_ms: window_end });
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn fmt_ms(ms: i64) -> String {
    let total = ms / 1000;
    format!("{}:{:02}:{:02}", total / 3600, (total / 60) % 60, total % 60)
}

/// Load an interactive title into the (already initialised) player and start
/// driving it. Refuses with a clear error when the video and metadata are not
/// a matched pair.
#[tauri::command]
pub async fn interactive_start(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
    entry_id: i64,
) -> Result<(), String> {
    stop_session(&state);

    let (folder, video, title) =
        crate::commands::movie_playback_info(&state.app_db, &library_id, entry_id).await?;

    let bundle = tauri::async_runtime::spawn_blocking(move || interactive::load_bundle_from_dir(&folder))
        .await
        .map_err(|e| e.to_string())??
        .ok_or("This title has no interactive metadata")?;

    let report = interactive::validate(&bundle);
    if !report.ok() {
        return Err(format!(
            "Interactive metadata failed validation: {}",
            report.errors.first().cloned().unwrap_or_default()
        ));
    }

    let player = {
        let guard = state.player.lock().map_err(|e| e.to_string())?;
        guard.as_ref().cloned().ok_or("Player not initialised")?
    };

    // Load the video (same semantics as play_file).
    {
        let p = player.clone();
        let path = video.to_string_lossy().into_owned();
        tauri::async_runtime::spawn_blocking(move || {
            p.mpv.command(&["loadfile", &path])?;
            p.mpv.set_property_string("pause", "no")
        })
        .await
        .map_err(|e| e.to_string())??;
    }

    // Wait for mpv to know the duration, then check the pair actually matches:
    // the graph's timestamps are authored against one specific encode, and a
    // mismatched video makes every choice fire at the wrong time.
    let mut duration_ms = 0i64;
    for _ in 0..600 {
        if session_cancelled(&state) {
            return Err("Playback stopped".into());
        }
        if let Some(d) = player.mpv.get_property_double("duration") {
            if d > 0.0 {
                duration_ms = (d * 1000.0) as i64;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if duration_ms == 0 {
        return Err("Could not read the video's duration".into());
    }
    if duration_ms + 2_000 < report.max_end_time_ms {
        let p = player.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || p.mpv.command(&["stop"])).await;
        return Err(format!(
            "Video/metadata mismatch: the branch graph runs to {} but the video only lasts {}. The video and JSON files must come from the same source.",
            fmt_ms(report.max_end_time_ms),
            fmt_ms(duration_ms)
        ));
    }

    // Story state: persistent survives playthroughs (DB over format defaults);
    // global resets every playthrough.
    let defaults = bundle.moments.state_history.as_ref();
    let global: HashMap<String, Value> = defaults.map(|d| d.global.clone()).unwrap_or_default();
    let mut persistent: HashMap<String, Value> = defaults.map(|d| d.persistent.clone()).unwrap_or_default();
    let saved: Option<(String,)> =
        sqlx::query_as("SELECT persistent_json FROM interactive_state WHERE entry_id = ?")
            .bind(entry_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    if let Some((json,)) = saved {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&json) {
            for (k, v) in map {
                persistent.insert(k, v);
            }
        }
    }

    // Enter the graph at its initial segment.
    let initial = bundle.manifest.initial_segment.clone();
    let initial_start = bundle
        .manifest
        .segments
        .get(&initial)
        .map(|s| s.start_time_ms)
        .unwrap_or(0);
    if initial_start > 100 {
        let p = player.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            p.mpv.command(&["seek", &format!("{:.3}", initial_start as f64 / 1000.0), "absolute+exact"])
        })
        .await;
    }

    let session = Arc::new(Session {
        shutdown: Arc::new(AtomicBool::new(false)),
        shared: Arc::new(Mutex::new(Shared {
            entry_id,
            library_id,
            title,
            current_segment: initial,
            pending_target: None,
            open: None,
            global,
            persistent,
        })),
    });

    {
        let mut guard = state.interactive.lock().map_err(|e| e.to_string())?;
        *guard = Some(session.clone());
    }

    let pool = state.app_db.clone();
    std::thread::spawn(move || driver_loop(app, player, pool, bundle, session));
    Ok(())
}

/// True when the session slot was cleared while we were still starting up
/// (user closed the player mid-load).
fn session_cancelled(state: &AppState) -> bool {
    state
        .player
        .lock()
        .map(|guard| guard.is_none())
        .unwrap_or(true)
}

/// The viewer picked a choice. State writes apply immediately; the jump
/// commits when the segment ends (Netflix pacing — the scene plays out).
#[tauri::command]
pub async fn interactive_choose(state: State<'_, AppState>, index: usize) -> Result<(), String> {
    let session = {
        let guard = state.interactive.lock().map_err(|e| e.to_string())?;
        guard.as_ref().cloned().ok_or("No interactive session")?
    };
    let mut sh = session.shared.lock().map_err(|e| e.to_string())?;
    let entry_id = sh.entry_id;
    let Some(open) = &mut sh.open else {
        return Err("No choice is open".into());
    };
    if index >= open.view.choices.len() {
        return Err("Choice index out of range".into());
    }
    if open.view.selected_index.is_some() {
        return Ok(()); // already committed; first pick wins
    }
    open.view.selected_index = Some(index);
    let target = open.targets.get(index).and_then(|t| t.clone());
    let impression = open.impressions.get(index).and_then(|o| o.clone());
    if let Some(imp) = impression {
        if sh.apply_impression(&imp) {
            spawn_save_persistent(&state.app_db, entry_id, &sh.persistent);
        }
    }
    if let Some(t) = target {
        sh.pending_target = Some(t);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveStatus {
    pub entry_id: i64,
    pub library_id: String,
    pub title: String,
    pub segment_id: String,
    pub choice: Option<ChoiceOpen>,
}

/// Snapshot of the live session for webview-refresh rehydration (mirrors
/// get_player_status): the driver thread survives an F5, the React overlay
/// doesn't.
#[tauri::command]
pub async fn interactive_status(state: State<'_, AppState>) -> Result<Option<InteractiveStatus>, String> {
    let session = {
        let guard = state.interactive.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(s) => s.clone(),
            None => return Ok(None),
        }
    };
    let pos_ms = {
        let guard = state.player.lock().map_err(|e| e.to_string())?;
        guard
            .as_ref()
            .and_then(|p| p.mpv.get_property_double("time-pos"))
            .map(|s| (s * 1000.0) as i64)
    };
    let sh = session.shared.lock().map_err(|e| e.to_string())?;
    let choice = sh.open.as_ref().map(|open| {
        let mut view = open.view.clone();
        if let Some(pos) = pos_ms {
            view.remaining_ms = (open.window_end_ms - pos).max(0);
        }
        view
    });
    Ok(Some(InteractiveStatus {
        entry_id: sh.entry_id,
        library_id: sh.library_id.clone(),
        title: sh.title.clone(),
        segment_id: sh.current_segment.clone(),
        choice,
    }))
}

/// Stop driving (does not stop playback — callers close the player separately).
#[tauri::command]
pub async fn interactive_stop(state: State<'_, AppState>) -> Result<(), String> {
    stop_session(&state);
    Ok(())
}

/// Forget the title's persistent story state ("Reset story"). Applies to the
/// next playthrough; a running session keeps its in-memory state.
#[tauri::command]
pub async fn reset_interactive_story(state: State<'_, AppState>, entry_id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM interactive_state WHERE entry_id = ?")
        .bind(entry_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mini_bundle() -> InteractiveBundle {
        let manifest = serde_json::from_value(json!({
            "segments": {
                "A": { "startTimeMs": 0, "endTimeMs": 1000, "defaultNext": "B" },
                "B": { "startTimeMs": 1000, "endTimeMs": 2000, "next": { "C": {"weight": 1} } },
                "C": { "startTimeMs": 5000, "endTimeMs": 6000, "defaultNext": "END" },
                "END": { "startTimeMs": 9000 }
            },
            "initialSegment": "A"
        }))
        .unwrap();
        let moments = serde_json::from_value(json!({
            "momentsBySegment": {},
            "preconditions": {
                "sawIt": ["eql", ["persistentState", "p_x"], true],
                "notSeen": ["not", ["eql", ["persistentState", "p_x"], true]],
                "both": ["and", ["eql", ["persistentState", "p_x"], true], ["eql", ["globalState", "g_y"], "n"]]
            },
            "segmentGroups": {
                "A": [ { "segment": "C", "precondition": "sawIt" }, "B" ],
                "outer": [ { "segmentGroup": "inner" } ],
                "inner": [ { "segment": "END", "precondition": "notSeen" }, "C" ]
            },
            "stateHistory": { "global": {}, "persistent": {} }
        }))
        .unwrap();
        InteractiveBundle {
            manifest_path: std::path::PathBuf::new(),
            info_path: std::path::PathBuf::new(),
            manifest,
            moments,
            info_video_id: None,
        }
    }

    fn shared_on(segment: &str) -> Shared {
        Shared {
            entry_id: 1,
            library_id: "lib".into(),
            title: "t".into(),
            current_segment: segment.into(),
            pending_target: None,
            open: None,
            global: HashMap::new(),
            persistent: HashMap::new(),
        }
    }

    #[test]
    fn evaluator_handles_bandersnatch_ops() {
        let g: HashMap<String, Value> = [("g_y".to_string(), json!("n"))].into();
        let p: HashMap<String, Value> = [("p_x".to_string(), json!(true))].into();
        let ev = |e: Value| eval_expr(&e, &g, &p);
        assert_eq!(ev(json!(["eql", ["persistentState", "p_x"], true])), json!(true));
        assert_eq!(ev(json!(["not", ["eql", ["persistentState", "p_x"], true]])), json!(false));
        assert_eq!(ev(json!(["and", true, ["eql", ["globalState", "g_y"], "n"]])), json!(true));
        assert_eq!(ev(json!(["or", false, false])), json!(false));
        // Missing keys read as null → eql false, not a panic.
        assert_eq!(ev(json!(["eql", ["persistentState", "nope"], true])), json!(false));
    }

    #[test]
    fn choice_target_beats_group_routing() {
        let bundle = mini_bundle();
        let mut sh = shared_on("A");
        sh.pending_target = Some("C".into());
        assert_eq!(sh.resolve_next(&bundle), Some("C".into()));
        // Consumed — the next resolution falls through to routing.
        assert!(sh.pending_target.is_none());
    }

    #[test]
    fn group_routing_respects_preconditions() {
        let bundle = mini_bundle();
        // Segment A is also a group key: [C if sawIt, else B].
        let mut sh = shared_on("A");
        assert_eq!(sh.resolve_next(&bundle), Some("B".into()), "precondition fails → fallback member");
        sh.persistent.insert("p_x".into(), json!(true));
        sh.current_segment = "A".into();
        assert_eq!(sh.resolve_next(&bundle), Some("C".into()), "precondition passes → gated member");
    }

    #[test]
    fn default_next_and_next_map_fallbacks() {
        let bundle = mini_bundle();
        let mut sh = shared_on("C");
        assert_eq!(sh.resolve_next(&bundle), Some("END".into()), "defaultNext");
        let mut sh = shared_on("B");
        assert_eq!(sh.resolve_next(&bundle), Some("C".into()), "no defaultNext → next map");
        let mut sh = shared_on("END");
        assert_eq!(sh.resolve_next(&bundle), None, "terminal");
    }

    #[test]
    fn nested_group_resolution() {
        let bundle = mini_bundle();
        let sh = shared_on("A");
        // outer → inner → END (notSeen passes on empty state)
        assert_eq!(sh.resolve_ref(&bundle, "outer", 8), Some("END".into()));
        let mut sh2 = shared_on("A");
        sh2.persistent.insert("p_x".into(), json!(true));
        assert_eq!(sh2.resolve_ref(&bundle, "outer", 8), Some("C".into()));
    }

    /// Play the real Bandersnatch graph hands-off (every choice times out to
    /// its default), exactly as the driver would: fire each segment's passing
    /// moments, apply impressions, commit the default choice's target, resolve
    /// the next segment. Must reach a terminal (credits) segment without ever
    /// dead-ending. Skips when the local bundle isn't present.
    #[test]
    fn default_path_walks_real_bandersnatch_to_credits() {
        let dir = std::env::var("INTERACTIVE_TEST_DIR")
            .unwrap_or_else(|_| r"A:\public\media\movies\Black Mirror Bandersnatch (2018)".into());
        let dir = std::path::PathBuf::from(dir);
        if !dir.is_dir() {
            eprintln!("skipping: no local interactive test bundle");
            return;
        }
        let bundle = crate::interactive::load_bundle_from_dir(&dir)
            .expect("load")
            .expect("detected");

        let defaults = bundle.moments.state_history.as_ref();
        let mut sh = shared_on(&bundle.manifest.initial_segment);
        sh.global = defaults.map(|d| d.global.clone()).unwrap_or_default();
        sh.persistent = defaults.map(|d| d.persistent.clone()).unwrap_or_default();

        let mut path: Vec<String> = vec![sh.current_segment.clone()];
        for _ in 0..500 {
            let current = sh.current_segment.clone();
            if let Some(moments) = bundle.moments.moments_by_segment.get(&current) {
                for m in moments {
                    if !sh.moment_passes(&bundle, m) {
                        continue;
                    }
                    if let Some(imp) = &m.impression_data {
                        sh.apply_impression(imp);
                    }
                    if moment_is_choice(m) {
                        let choices = m.choices.as_deref().unwrap_or(&[]);
                        let idx = (m.default_choice_index.unwrap_or(0).max(0) as usize)
                            .min(choices.len().saturating_sub(1));
                        let c = &choices[idx];
                        if let Some(imp) = &c.impression_data {
                            sh.apply_impression(imp);
                        }
                        if let Some(t) = choice_target(c) {
                            sh.pending_target = Some(t);
                        }
                    }
                }
            }
            let seg = bundle.manifest.segments.get(&current).expect("segment exists");
            if seg.end_time_ms.is_none() {
                eprintln!("terminal '{current}' reached after {} segments", path.len());
                return; // credits — the story resolved
            }
            let next = sh
                .resolve_next(&bundle)
                .unwrap_or_else(|| panic!("dead end at '{current}' after {:?}", path));
            path.push(next.clone());
            sh.current_segment = next;
        }
        panic!("no terminal segment within 500 hops; tail: {:?}", &path[path.len().saturating_sub(25)..]);
    }

    #[test]
    fn impression_merges_and_reports_persistent_changes() {
        let mut sh = shared_on("A");
        let imp = json!({ "data": { "global": { "g_a": 1 }, "persistent": { "p_b": true } }, "type": "userState" });
        assert!(sh.apply_impression(&imp), "first write dirties persistent");
        assert_eq!(sh.global.get("g_a"), Some(&json!(1)));
        assert_eq!(sh.persistent.get("p_b"), Some(&json!(true)));
        assert!(!sh.apply_impression(&imp), "same values → not dirty");
        let global_only = json!({ "data": { "global": { "g_a": 2 } } });
        assert!(!sh.apply_impression(&global_only), "global writes never dirty persistence");
    }
}
