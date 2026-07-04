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

use serde::{Deserialize, Serialize};
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

/// One decision point on the current path, captured just before its choice
/// window opened (state included, so restoring one is always consistent).
/// Feeds both resume and the "Previous choices" rewind timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChoiceSnapshot {
    pub segment_id: String,
    pub story_ms: i64,
    pub global: HashMap<String, Value>,
    pub persistent: HashMap<String, Value>,
    pub selected_index: Option<usize>,
    /// The options as shown (timeline card captions). Defaulted so resume
    /// payloads written before these fields existed still parse.
    #[serde(default)]
    pub choice_texts: Vec<String>,
    /// Absolute file ms of the window opening — where the timeline card's
    /// thumbnail is grabbed and where a rewind seeks back to (minus a beat).
    #[serde(default)]
    pub file_ms: i64,
    /// Traversal-path length when this snapshot was taken, so a rewind can
    /// truncate the path to match the restored position.
    #[serde(default)]
    pub path_len: usize,
}

/// Branch-jump measurements for the stats panel.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpMetrics {
    pub jumps: u32,
    pub seek_jumps: u32,
    pub last_from: Option<String>,
    pub last_to: Option<String>,
    pub last_latency_ms: Option<i64>,
}

/// Serialized session for interactive_resume — everything needed to put the
/// viewer back mid-story: playhead, story clock, both state scopes, the
/// traversal path, and the decision snapshots.
#[derive(Debug, Serialize, Deserialize)]
struct ResumePayload {
    segment: String,
    offset_ms: i64,
    story_ms: i64,
    global: HashMap<String, Value>,
    persistent: HashMap<String, Value>,
    path: Vec<String>,
    snapshots: Vec<ChoiceSnapshot>,
    pending_target: Option<String>,
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
    /// Story time at the current segment's entry (elapsed = this + in-segment
    /// offset). Advances on every transition; restored by resume.
    story_base_ms: i64,
    /// Segment ids visited this playthrough, in order.
    path: Vec<String>,
    /// Decision points passed this playthrough (see ChoiceSnapshot).
    snapshots: Vec<ChoiceSnapshot>,
    /// ±10s skip requested by the frontend; the driver applies the clamps
    /// (it has the bundle and the fired-moment context).
    skip_request: Option<f64>,
    /// Jump-back-to-snapshot request (index into `snapshots`).
    rewind_request: Option<usize>,
    /// Set after a rewind until its choice fires again — that commit is what
    /// truncates the abandoned future (rewinding alone discards nothing).
    rewound_index: Option<usize>,
    metrics: JumpMetrics,
    /// Current segment's file bounds, mirrored from the bundle (which lives on
    /// the driver thread) so commands can report timing without it.
    seg_start_ms: i64,
    seg_end_ms: Option<i64>,
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

/// Serialize the session for mid-story resume, and keep the title's recency
/// fresh in movie_watch. Fired every ~10s, on transitions, and on driver exit.
fn spawn_save_resume(pool: &SqlitePool, sh: &Shared, bundle: &InteractiveBundle, pos_ms: i64) {
    let seg_start = bundle
        .manifest
        .segments
        .get(&sh.current_segment)
        .map(|s| s.start_time_ms)
        .unwrap_or(pos_ms);
    let payload = ResumePayload {
        segment: sh.current_segment.clone(),
        offset_ms: (pos_ms - seg_start).max(0),
        story_ms: sh.story_base_ms + (pos_ms - seg_start).max(0),
        global: sh.global.clone(),
        persistent: sh.persistent.clone(),
        path: sh.path.clone(),
        snapshots: sh.snapshots.clone(),
        pending_target: sh.pending_target.clone(),
    };
    let Ok(json) = serde_json::to_string(&payload) else { return };
    let pool = pool.clone();
    let entry_id = sh.entry_id;
    tauri::async_runtime::spawn(async move {
        let _ = sqlx::query(
            "INSERT INTO interactive_resume (entry_id, resume_json, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(entry_id) DO UPDATE SET resume_json = excluded.resume_json, updated_at = excluded.updated_at",
        )
        .bind(entry_id)
        .bind(json)
        .execute(&pool)
        .await;
        let _ = sqlx::query(
            "INSERT INTO movie_watch (entry_id, watched, last_played_at) VALUES (?, 0, datetime('now'))
             ON CONFLICT(entry_id) DO UPDATE SET last_played_at = datetime('now')",
        )
        .bind(entry_id)
        .execute(&pool)
        .await;
    });
}

/// An ending was reached: the title counts as watched and the mid-story
/// resume is cleared (persistent story memory stays, by design).
fn spawn_mark_story_finished(pool: &SqlitePool, entry_id: i64) {
    let pool = pool.clone();
    tauri::async_runtime::spawn(async move {
        let _ = sqlx::query(
            "INSERT INTO movie_watch (entry_id, position_secs, watched, watched_at, last_played_at)
             VALUES (?, NULL, 1, datetime('now'), datetime('now'))
             ON CONFLICT(entry_id) DO UPDATE SET
                position_secs = NULL, watched = 1,
                watched_at = COALESCE(movie_watch.watched_at, datetime('now')),
                last_played_at = datetime('now')",
        )
        .bind(entry_id)
        .execute(&pool)
        .await;
        let _ = sqlx::query("DELETE FROM interactive_resume WHERE entry_id = ?")
            .bind(entry_id)
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
    let mut last_resume_save = Instant::now();
    let mut last_pos_ms: Option<i64> = None;
    let mut last_clock_emit = Instant::now();
    // A branch jump in flight: (from, to, issued-at) — resolved into metrics
    // once the seek settles, giving the stats panel real jump latency.
    let mut pending_jump: Option<(String, String, Instant)> = None;

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
        last_pos_ms = Some(pos_ms);

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
            if let Some((from, to, issued)) = pending_jump.take() {
                if let Ok(mut sh) = session.shared.lock() {
                    sh.metrics.last_from = Some(from);
                    sh.metrics.last_to = Some(to);
                    sh.metrics.last_latency_ms = Some(issued.elapsed().as_millis() as i64);
                }
            }
        }

        // 0. Frontend requests (rewind to a decision / bounded ±10s skip) —
        // handled before normal processing; a granted request seeks and skips
        // the rest of this tick.
        let request_seek = {
            let Ok(mut sh) = session.shared.lock() else { break };
            handle_requests(&app, &mut sh, &bundle, &pool, entry_id, pos_ms, &mut fired)
        };
        if let Some(target_ms) = request_seek {
            let _ = player
                .mpv
                .command(&["seek", &format!("{:.3}", target_ms as f64 / 1000.0), "absolute+exact"]);
            settling_until = Some((target_ms, Instant::now()));
            continue;
        }

        let mut seek_to: Option<i64> = None;
        let mut jump_meta: Option<(String, String)> = None;
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
                    // Decision point: snapshot the pre-impression state (a
                    // restore must be able to re-fire this moment cleanly).
                    if moment_is_choice(m) {
                        // Committing a choice after a rewind is what abandons
                        // the old future — the timeline forks here.
                        if let Some(idx) = sh.rewound_index.take() {
                            sh.snapshots.truncate(idx);
                        }
                        let story_ms = sh.story_base_ms + (pos_ms - seg.start_time_ms).max(0);
                        let snapshot = ChoiceSnapshot {
                            segment_id: current.clone(),
                            story_ms,
                            global: sh.global.clone(),
                            persistent: sh.persistent.clone(),
                            selected_index: None,
                            choice_texts: m
                                .choices
                                .as_deref()
                                .unwrap_or(&[])
                                .iter()
                                .map(|c| c.text.clone().unwrap_or_default())
                                .collect(),
                            file_ms: start,
                            path_len: sh.path.len(),
                        };
                        sh.snapshots.push(snapshot);
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
                if let Some(snap) = sh.snapshots.last_mut() {
                    if snap.selected_index.is_none() {
                        snap.selected_index = selected;
                    }
                }
                spawn_save_resume(&pool, &sh, &bundle, pos_ms);
                last_resume_save = Instant::now();
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
                            sh.metrics.jumps += 1;
                            if (target_start - end).abs() > CONTIGUOUS_MS {
                                seek_to = Some(target_start);
                                jump_meta = Some((current.clone(), next_id.clone()));
                                sh.metrics.seek_jumps += 1;
                            }
                            sh.story_base_ms += end - seg.start_time_ms;
                            sh.current_segment = next_id.clone();
                            if let Some(next_seg) = bundle.manifest.segments.get(&next_id) {
                                sh.seg_start_ms = next_seg.start_time_ms;
                                sh.seg_end_ms = next_seg.end_time_ms;
                            }
                            sh.path.push(next_id.clone());
                            sh.open = None;
                            fired.clear();
                            let _ = app.emit("interactive-segment", serde_json::json!({ "segmentId": next_id }));
                            // Terminal credits segments have no endTimeMs; the
                            // story has resolved — watched, resume forgotten.
                            let terminal = bundle
                                .manifest
                                .segments
                                .get(&sh.current_segment)
                                .map_or(false, |s| s.end_time_ms.is_none());
                            if terminal && !ended_emitted {
                                ended_emitted = true;
                                spawn_mark_story_finished(&pool, entry_id);
                                let _ = app.emit("interactive-ended", serde_json::json!({}));
                            } else if !ended_emitted {
                                spawn_save_resume(&pool, &sh, &bundle, target_start);
                                last_resume_save = Instant::now();
                            }
                        }
                        None => {
                            if !ended_emitted {
                                ended_emitted = true;
                                spawn_mark_story_finished(&pool, entry_id);
                                let _ = app.emit("interactive-ended", serde_json::json!({}));
                            }
                        }
                    }
                }
            }

            // 4. Periodic resume checkpoint (~10s of playback).
            if !ended_emitted && last_resume_save.elapsed() >= Duration::from_secs(10) {
                spawn_save_resume(&pool, &sh, &bundle, pos_ms);
                last_resume_save = Instant::now();
            }

            // 5. Story clock for the controls (elapsed along the chosen path).
            // Skipped on transition ticks — pos still belongs to the old segment.
            if sh.current_segment == current && last_clock_emit.elapsed() >= Duration::from_millis(500) {
                last_clock_emit = Instant::now();
                let story_ms = sh.story_base_ms + (pos_ms - seg.start_time_ms).max(0);
                let _ = app.emit("interactive-clock", serde_json::json!({ "storyMs": story_ms }));
            }
        } // shared lock released before the (slow) seek

        if let Some(target_ms) = seek_to {
            let _ = player
                .mpv
                .command(&["seek", &format!("{:.3}", target_ms as f64 / 1000.0), "absolute+exact"]);
            settling_until = Some((target_ms, Instant::now()));
            if let Some((from, to)) = jump_meta {
                pending_jump = Some((from, to, Instant::now()));
            }
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

    // Driver stopping (player closed / session replaced): one final checkpoint
    // so "come back later" resumes from the last frame watched, not up to 10s
    // earlier.
    if !ended_emitted {
        if let (Some(pos_ms), Ok(sh)) = (last_pos_ms, session.shared.lock()) {
            spawn_save_resume(&pool, &sh, &bundle, pos_ms);
        }
    }
}

/// Apply a queued rewind or ±skip request. Returns the absolute file ms to
/// seek to when one was granted.
///
/// Rewind restores a decision snapshot wholesale (both state scopes, story
/// clock, path) and lands a beat before the choice window so it re-presents.
/// The abandoned future is NOT discarded here — the next choice commit does
/// that (see the snapshot push in the driver).
///
/// Skips are strictly bounded to the current inter-choice span: -10 clamps at
/// the segment start and never crosses a boundary backward; +10 clamps at the
/// next unopened choice window (or the boundary, whose crossing then happens
/// through normal live resolution) and is dead while a choice is open. Skips
/// never re-open choices or rewind state; forward skips still apply the state
/// writes of any moment they jump over.
fn handle_requests(
    app: &AppHandle,
    sh: &mut Shared,
    bundle: &InteractiveBundle,
    pool: &SqlitePool,
    entry_id: i64,
    pos_ms: i64,
    fired: &mut HashSet<usize>,
) -> Option<i64> {
    if let Some(i) = sh.rewind_request.take() {
        sh.skip_request = None;
        let Some(snap) = sh.snapshots.get(i).cloned() else { return None };
        let Some(seg) = bundle.manifest.segments.get(&snap.segment_id) else { return None };
        sh.global = snap.global;
        sh.persistent = snap.persistent;
        sh.pending_target = None;
        sh.current_segment = snap.segment_id.clone();
        sh.rewound_index = Some(i);
        sh.open = None;
        sh.story_base_ms = snap.story_ms - (snap.file_ms - seg.start_time_ms).max(0);
        sh.seg_start_ms = seg.start_time_ms;
        sh.seg_end_ms = seg.end_time_ms;
        sh.path.truncate(snap.path_len.max(1));
        fired.clear();
        spawn_save_persistent(pool, entry_id, &sh.persistent);
        let _ = app.emit(
            "interactive-choice-closed",
            serde_json::json!({ "selectedIndex": null, "timedOut": false }),
        );
        let _ = app.emit("interactive-segment", serde_json::json!({ "segmentId": snap.segment_id }));
        return Some((snap.file_ms - 2_500).max(seg.start_time_ms));
    }

    let delta = sh.skip_request.take()?;
    // Dead while a choice is open (in either direction — the arrow keys
    // belong to the overlay then), including a window playback has entered
    // that simply hasn't fired yet this tick.
    if sh.open.is_some() {
        return None;
    }
    let delta_ms = (delta * 1000.0) as i64;
    let current = sh.current_segment.clone();
    let Some(seg) = bundle.manifest.segments.get(&current) else { return None };
    let moments = bundle.moments.moments_by_segment.get(&current);
    if let Some(moments) = moments {
        for (i, m) in moments.iter().enumerate() {
            if !fired.contains(&i) && moment_is_choice(m) {
                if let Some((start, end)) = moment_window(m) {
                    if pos_ms >= start && pos_ms < end {
                        return None;
                    }
                }
            }
        }
    }

    if delta_ms < 0 {
        // Backward: pure rewatching. Fired moments stay fired, so a decided
        // choice window replays without its overlay.
        let target = (pos_ms + delta_ms).max(seg.start_time_ms);
        return (target < pos_ms - 250).then_some(target);
    }

    let mut target = pos_ms + delta_ms;
    if let Some(end) = seg.end_time_ms {
        // Landing at the boundary epsilon lets normal live resolution cross it;
        // spamming +10 walks pass-through segments toward the next decision.
        target = target.min(end - BOUNDARY_EPS_MS);
    }
    if let Some(moments) = moments {
        for (i, m) in moments.iter().enumerate() {
            if !fired.contains(&i) && moment_is_choice(m) {
                if let Some((start, _)) = moment_window(m) {
                    if start > pos_ms {
                        target = target.min(start);
                    }
                }
            }
        }
        // Jumped-over state writes still happen — skipping content must not
        // skip the story's bookkeeping.
        if target > pos_ms {
            for (i, m) in moments.iter().enumerate() {
                if fired.contains(&i) || moment_is_choice(m) {
                    continue;
                }
                let Some((start, _)) = moment_window(m) else { continue };
                if start > pos_ms && start <= target {
                    fired.insert(i);
                    if sh.moment_passes(bundle, m) {
                        if let Some(imp) = &m.impression_data {
                            if sh.apply_impression(imp) {
                                spawn_save_persistent(pool, entry_id, &sh.persistent);
                            }
                        }
                    }
                }
            }
        }
    }
    (target > pos_ms + 250).then_some(target)
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
    fresh: Option<bool>,
) -> Result<(), String> {
    stop_session(&state);
    // "Play from beginning": forget the mid-story resume (persistent story
    // memory stays — Reset story is the bigger hammer).
    if fresh.unwrap_or(false) {
        let _ = sqlx::query("DELETE FROM interactive_resume WHERE entry_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await;
    }

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

    // A saved mid-story session wins (unless fresh cleared it); otherwise
    // start at the graph's initial segment with default state. Persistent
    // story memory survives playthroughs (DB over format defaults); global
    // resets every playthrough.
    let resume: Option<ResumePayload> = if fresh.unwrap_or(false) {
        None
    } else {
        sqlx::query_as::<_, (String,)>("SELECT resume_json FROM interactive_resume WHERE entry_id = ?")
            .bind(entry_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|(json,)| serde_json::from_str::<ResumePayload>(&json).ok())
            .filter(|r| bundle.manifest.segments.contains_key(&r.segment))
    };

    let shared = if let Some(resume) = resume {
        let seg = &bundle.manifest.segments[&resume.segment];
        let offset = resume.offset_ms.max(0);
        // Re-entry cushion (~4s of context), but never land somewhere that
        // re-opens a decided choice: a window that closed before the save
        // point — or one the save sat inside with a pick already committed —
        // is skipped past; an undecided mid-window save re-presents the
        // choice from its top instead.
        let mut land = (offset - 4_000).max(0);
        if let Some(moments) = bundle.moments.moments_by_segment.get(&resume.segment) {
            for m in moments.iter().filter(|m| moment_is_choice(m)) {
                if let Some((ws, we)) = moment_window(m) {
                    let (rs, re) = (ws - seg.start_time_ms, we - seg.start_time_ms);
                    if offset >= re {
                        land = land.max(re);
                    } else if offset >= rs {
                        land = if resume.pending_target.is_some() {
                            land.max(re)
                        } else {
                            (rs - 1_000).max(0)
                        };
                    }
                }
            }
        }
        let target_ms = seg.start_time_ms + land;
        let p = player.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            p.mpv.command(&["seek", &format!("{:.3}", target_ms as f64 / 1000.0), "absolute+exact"])
        })
        .await;
        Shared {
            entry_id,
            library_id,
            title,
            current_segment: resume.segment,
            pending_target: resume.pending_target,
            open: None,
            global: resume.global,
            persistent: resume.persistent,
            story_base_ms: resume.story_ms - offset,
            path: resume.path,
            snapshots: resume.snapshots,
            skip_request: None,
            rewind_request: None,
            rewound_index: None,
            metrics: JumpMetrics::default(),
            seg_start_ms: seg.start_time_ms,
            seg_end_ms: seg.end_time_ms,
        }
    } else {
        let defaults = bundle.moments.state_history.as_ref();
        let global: HashMap<String, Value> = defaults.map(|d| d.global.clone()).unwrap_or_default();
        let mut persistent: HashMap<String, Value> =
            defaults.map(|d| d.persistent.clone()).unwrap_or_default();
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
        Shared {
            entry_id,
            library_id,
            title,
            current_segment: initial.clone(),
            pending_target: None,
            open: None,
            global,
            persistent,
            story_base_ms: 0,
            path: vec![initial.clone()],
            snapshots: Vec::new(),
            skip_request: None,
            rewind_request: None,
            rewound_index: None,
            metrics: JumpMetrics::default(),
            seg_start_ms: initial_start,
            seg_end_ms: bundle.manifest.segments.get(&initial).and_then(|s| s.end_time_ms),
        }
    };

    let session = Arc::new(Session {
        shutdown: Arc::new(AtomicBool::new(false)),
        shared: Arc::new(Mutex::new(shared)),
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

fn current_session(state: &AppState) -> Result<Arc<Session>, String> {
    let guard = state.interactive.lock().map_err(|e| e.to_string())?;
    guard.as_ref().cloned().ok_or_else(|| "No interactive session".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub index: usize,
    pub segment_id: String,
    pub story_ms: i64,
    pub file_ms: i64,
    pub choice_texts: Vec<String>,
    pub selected_index: Option<usize>,
}

/// The decision points of the current playthrough, oldest first — the
/// "Previous choices" timeline.
#[tauri::command]
pub async fn interactive_history(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>, String> {
    let session = current_session(&state)?;
    let sh = session.shared.lock().map_err(|e| e.to_string())?;
    Ok(sh
        .snapshots
        .iter()
        .enumerate()
        .map(|(index, s)| HistoryEntry {
            index,
            segment_id: s.segment_id.clone(),
            story_ms: s.story_ms,
            file_ms: s.file_ms,
            choice_texts: s.choice_texts.clone(),
            selected_index: s.selected_index,
        })
        .collect())
}

/// Jump back to a past decision (timeline card click). The driver applies it
/// on its next tick.
#[tauri::command]
pub async fn interactive_rewind(state: State<'_, AppState>, index: usize) -> Result<(), String> {
    let session = current_session(&state)?;
    let mut sh = session.shared.lock().map_err(|e| e.to_string())?;
    if index >= sh.snapshots.len() {
        return Err("No such decision point".into());
    }
    sh.rewind_request = Some(index);
    Ok(())
}

/// Bounded ±skip (seconds). The driver enforces the inter-choice-span clamps.
#[tauri::command]
pub async fn interactive_skip(state: State<'_, AppState>, seconds: f64) -> Result<(), String> {
    if !seconds.is_finite() {
        return Err("Bad skip".into());
    }
    let session = current_session(&state)?;
    let mut sh = session.shared.lock().map_err(|e| e.to_string())?;
    sh.skip_request = Some(seconds.clamp(-60.0, 60.0));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveDebug {
    pub segment_id: String,
    pub segment_start_ms: i64,
    pub segment_end_ms: Option<i64>,
    pub story_ms: Option<i64>,
    pub pending_target: Option<String>,
    pub choice_open: bool,
    pub snapshot_count: usize,
    pub path_len: usize,
    pub persistent_set: usize,
    pub global_set: usize,
    pub metrics: JumpMetrics,
}

/// Stats-for-nerds: the engine's view of the session. Segment timing comes
/// from the session's own bookkeeping, not the bundle (which lives on the
/// driver thread).
#[tauri::command]
pub async fn interactive_debug(
    state: State<'_, AppState>,
) -> Result<Option<InteractiveDebug>, String> {
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
    let truthy_count = |m: &HashMap<String, Value>| m.values().filter(|v| truthy(v)).count();
    Ok(Some(InteractiveDebug {
        segment_id: sh.current_segment.clone(),
        segment_start_ms: sh.seg_start_ms,
        segment_end_ms: sh.seg_end_ms,
        story_ms: pos_ms.map(|p| sh.story_base_ms + (p - sh.seg_start_ms).max(0)),
        pending_target: sh.pending_target.clone(),
        choice_open: sh.open.is_some(),
        snapshot_count: sh.snapshots.len(),
        path_len: sh.path.len(),
        persistent_set: truthy_count(&sh.persistent),
        global_set: truthy_count(&sh.global),
        metrics: sh.metrics.clone(),
    }))
}

/// Forget the title's persistent story state AND any mid-story resume
/// ("Reset story" — the full fresh start). Applies to the next playthrough;
/// a running session keeps its in-memory state.
#[tauri::command]
pub async fn reset_interactive_story(state: State<'_, AppState>, entry_id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM interactive_state WHERE entry_id = ?")
        .bind(entry_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM interactive_resume WHERE entry_id = ?")
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
            story_base_ms: 0,
            path: vec![segment.into()],
            snapshots: Vec::new(),
            skip_request: None,
            rewind_request: None,
            rewound_index: None,
            metrics: JumpMetrics::default(),
            seg_start_ms: 0,
            seg_end_ms: None,
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
