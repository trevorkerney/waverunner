//! Interactive (branching) title support — Netflix `interactiveVideoMoments` format.
//!
//! An interactive title is ONE video file (every branch concatenated) plus two JSON
//! files: a manifest (times every segment: startTimeMs/endTimeMs/defaultNext/next)
//! and an info file (the interactivity layer: momentsBySegment choices, precondition
//! expression trees, segmentGroups routing, persistent/global state).
//!
//! Filenames are NOT the contract — packs in the wild use `<viewableId>.json` etc.,
//! and the info payload may sit at the top level or nested inside a Falcor cache
//! (`jsonGraph.videos.<id>.interactiveVideoMoments.value`). Detection content-sniffs.
//!
//! Milestone 1 scope: parsing, bundle detection, graph validation. No playback.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Skip JSON candidates larger than this during detection (the real info.json is
/// ~1MB; anything huge next to the video is not interactive metadata).
const MAX_JSON_BYTES: u64 = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Manifest (segment skeleton)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct Manifest {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub segments: HashMap<String, ManifestSegment>,
    #[serde(rename = "initialSegment")]
    pub initial_segment: String,
    #[serde(rename = "viewableId")]
    pub viewable_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestSegment {
    #[serde(rename = "startTimeMs")]
    pub start_time_ms: i64,
    /// Absent on terminal segments (e.g. the credits ident) — play to EOF.
    #[serde(rename = "endTimeMs")]
    pub end_time_ms: Option<i64>,
    #[serde(rename = "defaultNext")]
    pub default_next: Option<String>,
    /// Possible successors with selection weights (used when no choice fires).
    pub next: Option<HashMap<String, NextEntry>>,
    pub ui: Option<SegmentUi>,
    /// Marks an ending (Bandersnatch has 39 of these).
    #[serde(rename = "storyEnd")]
    pub story_end: Option<bool>,
    pub credits: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct NextEntry {
    pub weight: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct SegmentUi {
    /// Absolute-ms windows during which choice interaction is live.
    #[serde(rename = "interactionZones")]
    pub interaction_zones: Option<Vec<Vec<i64>>>,
}

// ---------------------------------------------------------------------------
// Info (interactivity layer) — the `interactiveVideoMoments` value
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct MomentsValue {
    #[serde(rename = "momentsBySegment")]
    pub moments_by_segment: HashMap<String, Vec<Moment>>,
    /// Named boolean/arithmetic expression trees over state, e.g.
    /// `["not",["eql",["persistentState","p_8a"],true]]`. Evaluated in a later
    /// milestone; kept opaque here.
    #[serde(default)]
    pub preconditions: HashMap<String, Value>,
    /// Conditional routing tables: each entry is an ordered list of candidates —
    /// a bare segment id, a `{segment, precondition}` pair, or a nested
    /// `{segmentGroup}` reference. First candidate whose precondition passes wins.
    #[serde(rename = "segmentGroups", default)]
    pub segment_groups: HashMap<String, Vec<GroupItem>>,
    /// Initial values for the two state scopes.
    #[serde(rename = "stateHistory")]
    pub state_history: Option<StateHistory>,
    #[serde(rename = "audioLocale")]
    pub audio_locale: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StateHistory {
    #[serde(default)]
    pub global: HashMap<String, Value>,
    #[serde(default)]
    pub persistent: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum GroupItem {
    /// Bare segment id.
    Ref(String),
    /// Segment gated by a precondition (precondition absent = unconditional).
    Segment {
        segment: String,
        #[serde(default)]
        precondition: Option<String>,
    },
    /// Defer to another segment group.
    Group {
        #[serde(rename = "segmentGroup")]
        segment_group: String,
    },
}

/// One timed interactive event on a segment. Choice moments (`scene:*`) carry the
/// choice list; notification moments (tutorials, impressions) mostly carry state
/// writes and display text. Field casing varies across moment types in real data
/// (`uiHideMS` vs `uiHideMs`), hence the aliases.
#[derive(Debug, Deserialize)]
pub struct Moment {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub id: Option<String>,
    #[serde(rename = "startMs")]
    pub start_ms: Option<i64>,
    #[serde(rename = "endMs")]
    pub end_ms: Option<i64>,
    #[serde(rename = "uiDisplayMS", alias = "uiDisplayMs")]
    pub ui_display_ms: Option<i64>,
    #[serde(rename = "uiInteractionStartMS", alias = "uiInteractionStartMs")]
    pub ui_interaction_start_ms: Option<i64>,
    #[serde(rename = "uiHideMS", alias = "uiHideMs")]
    pub ui_hide_ms: Option<i64>,
    #[serde(rename = "choiceActivationThresholdMS", alias = "choiceActivationThresholdMs")]
    pub choice_activation_threshold_ms: Option<i64>,
    #[serde(rename = "activationWindow")]
    pub activation_window: Option<Vec<i64>>,
    #[serde(rename = "defaultChoiceIndex")]
    pub default_choice_index: Option<i64>,
    pub choices: Option<Vec<Choice>>,
    /// State writes applied when the moment is shown/selected.
    #[serde(rename = "impressionData")]
    pub impression_data: Option<Value>,
    #[serde(rename = "preconditionId")]
    pub precondition_id: Option<String>,
    /// Inline precondition expression (playbackImpression moments carry the
    /// tree directly rather than referencing the named `preconditions` map).
    pub precondition: Option<Value>,
    #[serde(rename = "layoutType")]
    pub layout_type: Option<String>,
    #[serde(rename = "headerText")]
    pub header_text: Option<String>,
    #[serde(rename = "bodyText")]
    pub body_text: Option<String>,
    #[serde(rename = "timeoutSegment")]
    pub timeout_segment: Option<TimeoutSegment>,
}

#[derive(Debug, Deserialize)]
pub struct Choice {
    pub id: Option<String>,
    pub text: Option<String>,
    #[serde(rename = "subText")]
    pub sub_text: Option<String>,
    /// Choice-point art: a 3-state sprite-sheet URL + CSS-ish styles. Some
    /// choices are image-ONLY (text is a bare space) — e.g. Bandersnatch's
    /// symbol decisions — so this is content, not decoration. Kept opaque;
    /// the session layer extracts what it renders.
    pub background: Option<Value>,
    #[serde(rename = "segmentId")]
    pub segment_id: Option<String>,
    /// Segment-group target (used by some titles instead of a direct segment).
    pub sg: Option<String>,
    /// The manifest startTimeMs of the target segment, duplicated here — a
    /// matched-pair cross-check between the two files.
    #[serde(rename = "startTimeMs")]
    pub start_time_ms: Option<i64>,
    #[serde(rename = "impressionData")]
    pub impression_data: Option<Value>,
    #[serde(rename = "preconditionId")]
    pub precondition_id: Option<String>,
    pub default: Option<Value>,
    pub overrides: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct TimeoutSegment {
    #[serde(rename = "segmentId")]
    pub segment_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Detection + loading
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct InteractiveBundle {
    pub manifest_path: PathBuf,
    pub info_path: PathBuf,
    pub manifest: Manifest,
    pub moments: MomentsValue,
    /// The video id keyed under `jsonGraph.videos` when the info file is a
    /// Falcor cache; cross-checked against manifest.viewableId.
    pub info_video_id: Option<String>,
}

/// Locate the `interactiveVideoMoments` payload wherever it nests: at the top
/// level, or inside a Falcor cache under `jsonGraph.videos.<id>`. Returns the
/// value node (unwrapping `.value` if present) and the video id when known.
fn extract_moments<'a>(root: &'a Value) -> Option<(&'a Value, Option<String>)> {
    let unwrap = |ivm: &'a Value| ivm.get("value").unwrap_or(ivm);
    if let Some(ivm) = root.get("interactiveVideoMoments") {
        return Some((unwrap(ivm), None));
    }
    let videos = root.get("jsonGraph")?.get("videos")?.as_object()?;
    videos
        .iter()
        .find_map(|(id, v)| v.get("interactiveVideoMoments").map(|ivm| (unwrap(ivm), Some(id.clone()))))
}

/// A manifest is any JSON with a string `initialSegment` and a `segments` map
/// whose entries carry `startTimeMs`.
fn looks_like_manifest(root: &Value) -> bool {
    if !root.get("initialSegment").map_or(false, Value::is_string) {
        return false;
    }
    match root.get("segments").and_then(Value::as_object) {
        Some(segs) => segs.values().next().map_or(false, |s| s.get("startTimeMs").is_some()),
        None => false,
    }
}

/// Content-sniff every root-level *.json in `dir` into (manifest, info)
/// candidates. Shared by the full loader and the scan-time detector.
fn classify_dir(dir: &Path) -> Result<(Option<(PathBuf, Value)>, Option<(PathBuf, Value)>), String> {
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension().and_then(|x| x.to_str()).map_or(false, |x| x.eq_ignore_ascii_case("json"))
                && p.metadata().map_or(false, |m| m.len() <= MAX_JSON_BYTES)
        })
        .collect();
    candidates.sort();

    let mut manifest: Option<(PathBuf, Value)> = None;
    let mut info: Option<(PathBuf, Value)> = None;
    for path in candidates {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(root) = serde_json::from_str::<Value>(&text) else { continue };
        if info.is_none() && extract_moments(&root).is_some() {
            info = Some((path, root));
        } else if manifest.is_none() && looks_like_manifest(&root) {
            manifest = Some((path, root));
        }
        if manifest.is_some() && info.is_some() {
            break;
        }
    }
    Ok((manifest, info))
}

/// Scan-time detection: does this folder hold a matched interactive pair?
/// Returns the two filenames (relative to `dir`) without keeping the parsed
/// JSON. A half-bundle (one file without the other) counts as not interactive.
pub fn detect_bundle_files(dir: &Path) -> Option<(String, String)> {
    let (manifest, info) = classify_dir(dir).ok()?;
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned());
    Some((name(&manifest?.0)?, name(&info?.0)?))
}

/// Load and parse the full bundle. Returns Ok(None) when the folder simply
/// isn't an interactive bundle; Err only for a broken half-bundle worth
/// surfacing.
pub fn load_bundle_from_dir(dir: &Path) -> Result<Option<InteractiveBundle>, String> {
    match classify_dir(dir)? {
        (None, None) => Ok(None),
        (Some(_), None) => Err("found an interactive manifest but no info file (interactiveVideoMoments)".into()),
        (None, Some(_)) => Err("found an interactive info file but no segment manifest".into()),
        (Some((manifest_path, mroot)), Some((info_path, iroot))) => {
            let manifest: Manifest = serde_json::from_value(mroot)
                .map_err(|e| format!("parse manifest {}: {e}", manifest_path.display()))?;
            let (moments_value, info_video_id) = extract_moments(&iroot).expect("re-sniff");
            let moments: MomentsValue = serde_json::from_value(moments_value.clone())
                .map_err(|e| format!("parse info {}: {e}", info_path.display()))?;
            Ok(Some(InteractiveBundle { manifest_path, info_path, manifest, moments, info_video_id }))
        }
    }
}

// ---------------------------------------------------------------------------
// Graph validation
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct ValidationReport {
    pub segment_count: usize,
    pub moment_segment_count: usize,
    pub moment_count: usize,
    pub choice_count: usize,
    pub precondition_count: usize,
    pub segment_group_count: usize,
    pub max_end_time_ms: i64,
    /// Structural problems that would break playback.
    pub errors: Vec<String>,
    /// Oddities worth logging that playback can survive.
    pub warnings: Vec<String>,
}

impl ValidationReport {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

/// Cross-check the two files as one graph: every reference (defaultNext, next,
/// choice target, segment group member, precondition id) must resolve, times must
/// be sane, and duplicated timestamps must agree between the files — disagreement
/// means the manifest and info come from different encodes (a mismatched pair).
pub fn validate(bundle: &InteractiveBundle) -> ValidationReport {
    let manifest = &bundle.manifest;
    let moments = &bundle.moments;
    let segs = &manifest.segments;
    let groups = &moments.segment_groups;
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if !segs.contains_key(&manifest.initial_segment) {
        errors.push(format!("initialSegment '{}' not in segments", manifest.initial_segment));
    }
    if let (Some(vid), Some(info_id)) = (manifest.viewable_id, bundle.info_video_id.as_deref()) {
        if vid.to_string() != info_id {
            warnings.push(format!("viewableId mismatch: manifest {vid} vs info {info_id}"));
        }
    }

    let mut max_end_time_ms = 0i64;
    for (id, seg) in segs {
        if seg.start_time_ms < 0 {
            errors.push(format!("segment '{id}' has negative startTimeMs {}", seg.start_time_ms));
        }
        match seg.end_time_ms {
            Some(end) if end <= seg.start_time_ms => {
                errors.push(format!("segment '{id}' has invalid time range {}..{end}", seg.start_time_ms));
            }
            None if seg.next.as_ref().map_or(false, |n| !n.is_empty()) || seg.default_next.is_some() => {
                errors.push(format!("segment '{id}' has successors but no endTimeMs"));
            }
            _ => {}
        }
        max_end_time_ms = max_end_time_ms.max(seg.end_time_ms.unwrap_or(seg.start_time_ms));
        if let Some(next) = &seg.default_next {
            if !segs.contains_key(next) {
                errors.push(format!("segment '{id}' defaultNext '{next}' unresolved"));
            }
        }
        for target in seg.next.iter().flat_map(|n| n.keys()) {
            if !segs.contains_key(target) {
                errors.push(format!("segment '{id}' next target '{target}' unresolved"));
            }
        }
    }

    // Segment groups: members must resolve to segments or other groups.
    for (gid, items) in groups {
        for item in items {
            match item {
                GroupItem::Ref(s) => {
                    if !segs.contains_key(s) && !groups.contains_key(s) {
                        errors.push(format!("segmentGroup '{gid}' member '{s}' unresolved"));
                    }
                }
                GroupItem::Segment { segment, precondition } => {
                    if !segs.contains_key(segment) {
                        errors.push(format!("segmentGroup '{gid}' member segment '{segment}' unresolved"));
                    }
                    if let Some(p) = precondition {
                        if !moments.preconditions.contains_key(p) {
                            errors.push(format!("segmentGroup '{gid}' precondition '{p}' unresolved"));
                        }
                    }
                }
                GroupItem::Group { segment_group } => {
                    if !groups.contains_key(segment_group) {
                        errors.push(format!("segmentGroup '{gid}' nested group '{segment_group}' unresolved"));
                    }
                }
            }
        }
    }

    let mut moment_count = 0usize;
    let mut choice_count = 0usize;
    for (sid, seg_moments) in &moments.moments_by_segment {
        let seg = segs.get(sid);
        if seg.is_none() {
            errors.push(format!("momentsBySegment key '{sid}' not in manifest segments"));
        }
        for m in seg_moments {
            moment_count += 1;
            let label = m.id.as_deref().unwrap_or("?");
            if let Some(p) = &m.precondition_id {
                if !moments.preconditions.contains_key(p) {
                    errors.push(format!("moment '{label}' on '{sid}' preconditionId '{p}' unresolved"));
                }
            }
            if let (Some(start), Some(end)) = (m.start_ms, m.end_ms) {
                if end <= start {
                    errors.push(format!("moment '{label}' on '{sid}' has invalid window {start}..{end}"));
                }
                if let Some(seg) = seg {
                    let seg_end = seg.end_time_ms.unwrap_or(i64::MAX);
                    if start < seg.start_time_ms || end > seg_end {
                        warnings.push(format!(
                            "moment '{label}' window {start}..{end} outside segment '{sid}' {}..{:?}",
                            seg.start_time_ms, seg.end_time_ms
                        ));
                    }
                }
            }
            if let Some(idx) = m.default_choice_index {
                let n = m.choices.as_ref().map_or(0, |c| c.len()) as i64;
                if idx < 0 || (n > 0 && idx >= n) {
                    errors.push(format!("moment '{label}' on '{sid}' defaultChoiceIndex {idx} out of range (choices: {n})"));
                }
            }
            if let Some(ts) = &m.timeout_segment {
                if let Some(t) = &ts.segment_id {
                    if !segs.contains_key(t) && !groups.contains_key(t) {
                        errors.push(format!("moment '{label}' on '{sid}' timeoutSegment '{t}' unresolved"));
                    }
                }
            }
            for c in m.choices.iter().flatten() {
                choice_count += 1;
                let cid = c.id.as_deref().or(c.text.as_deref()).unwrap_or("?");
                match (&c.segment_id, &c.sg) {
                    (Some(target), _) => {
                        if let Some(target_seg) = segs.get(target) {
                            if let Some(claimed) = c.start_time_ms {
                                if claimed != target_seg.start_time_ms {
                                    errors.push(format!(
                                        "choice '{cid}' on '{sid}': startTimeMs {claimed} disagrees with segment '{target}' start {} — files may be a mismatched pair",
                                        target_seg.start_time_ms
                                    ));
                                }
                            }
                        } else if !groups.contains_key(target) {
                            errors.push(format!("choice '{cid}' on '{sid}' target '{target}' unresolved"));
                        }
                    }
                    (None, Some(sg)) => {
                        if !groups.contains_key(sg) {
                            errors.push(format!("choice '{cid}' on '{sid}' segment group '{sg}' unresolved"));
                        }
                    }
                    (None, None) => {
                        // Choices with only state effects (no navigation) exist in
                        // some titles; note it but don't fail.
                        warnings.push(format!("choice '{cid}' on '{sid}' has no segment target"));
                    }
                }
                if let Some(p) = &c.precondition_id {
                    if !moments.preconditions.contains_key(p) {
                        errors.push(format!("choice '{cid}' on '{sid}' preconditionId '{p}' unresolved"));
                    }
                }
            }
        }
    }

    ValidationReport {
        segment_count: segs.len(),
        moment_segment_count: moments.moments_by_segment.len(),
        moment_count,
        choice_count,
        precondition_count: moments.preconditions.len(),
        segment_group_count: groups.len(),
        max_end_time_ms,
        errors,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// Tests — run against the real Bandersnatch pair when present, else skip.
// The content itself is never committed; set INTERACTIVE_TEST_DIR to point at
// any local bundle (a folder holding the video + the two JSONs).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> Option<PathBuf> {
        let dir = std::env::var("INTERACTIVE_TEST_DIR")
            .unwrap_or_else(|_| r"A:\public\media\movies\Black Mirror Bandersnatch (2018)".into());
        let path = PathBuf::from(dir);
        path.is_dir().then_some(path)
    }

    #[test]
    fn detects_and_validates_real_bundle() {
        let Some(dir) = test_dir() else {
            eprintln!("skipping: no local interactive test bundle");
            return;
        };
        let bundle = load_bundle_from_dir(&dir)
            .expect("bundle load should not error")
            .expect("folder should be detected as an interactive bundle");

        // Known Bandersnatch shape.
        assert_eq!(bundle.manifest.segments.len(), 250, "segment count");
        assert_eq!(bundle.moments.moments_by_segment.len(), 208, "moment segment count");
        assert!(bundle.manifest.segments.contains_key(&bundle.manifest.initial_segment));

        let report = validate(&bundle);
        eprintln!(
            "segments={} momentSegments={} moments={} choices={} preconditions={} groups={} maxEndMs={}",
            report.segment_count,
            report.moment_segment_count,
            report.moment_count,
            report.choice_count,
            report.precondition_count,
            report.segment_group_count,
            report.max_end_time_ms
        );
        for w in &report.warnings {
            eprintln!("warning: {w}");
        }
        assert!(report.ok(), "graph errors: {:#?}", report.errors);
        // ~5h17m of concatenated branches.
        assert!(report.max_end_time_ms > 5 * 60 * 60 * 1000, "max end time {}", report.max_end_time_ms);
    }

    #[test]
    fn scan_detection_returns_filenames() {
        let Some(dir) = test_dir() else {
            eprintln!("skipping: no local interactive test bundle");
            return;
        };
        let (manifest_file, info_file) = detect_bundle_files(&dir).expect("detected");
        // Content decided the classification; for this pack the conventional
        // names happen to hold.
        assert_eq!(manifest_file, "manifest.json");
        assert_eq!(info_file, "info.json");
    }

    #[test]
    fn non_interactive_folder_yields_none() {
        // The repo's own src dir has no interactive JSON.
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        assert!(matches!(load_bundle_from_dir(&dir), Ok(None)));
    }
}
