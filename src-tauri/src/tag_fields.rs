//! The tag field registry — the ONE place a track field is declared.
//!
//! Every per-track value waverunner holds in its own tier of tags (the user's
//! layer over the files, see `field_override`) is a row of `FIELDS`: what it
//! is called, how it is shaped, which file tag it reads from and writes to,
//! whether it changes how tracks group into albums, and how far an album- or
//! release-level edit fans out. The scanner's reader, the overlay that puts
//! the user's values in before grouping, the tier store, the edit dialogs,
//! the Sources view and the tag writer all walk this list instead of each
//! carrying its own. Adding a field is adding a row here (plus the accessor
//! arms below, which map the key onto `ScannedTrack`).
//!
//! Stored form: every value is text — lists as JSON arrays, numbers as
//! decimal, "" = none. That is what the tier store holds and what crosses
//! to the frontend.

use std::collections::HashMap;

use lofty::tag::ItemKey;
use serde::Serialize;

use crate::music::ScannedTrack;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    Text,
    LongText,
    List,
    Int,
}

/// How far an edit made at a higher level fans out. `Album`: every track of
/// the album (genres, album artists). `Release`: the tracks of one release
/// (album title as tagged, date, label, catalogue number). `Disc`: the
/// tracks of one disc. `Track`: just the one.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Track,
    Disc,
    Release,
    Album,
}

/// How the scanner reads a field from a file. `Special` fields have their
/// own arm in `read_track` (parsed credits, the album-artist fallback, the
/// disc-folder fallback, the date ladder). The second key of a Text/Int is
/// a fallback frame (LABEL, else PUBLISHER).
pub enum Read {
    Special,
    Text(ItemKey, Option<ItemKey>),
    /// Multi-value frames, each split on ';' as well (the convention the
    /// reader has always used for genres and artists).
    List(ItemKey),
    Int(ItemKey, Option<ItemKey>),
}

/// How the tag writer puts a field into a file. `Special` fields have an
/// arm in `music_tagwrite::apply_intents`.
pub enum Write {
    None,
    Special,
    Text(ItemKey),
    /// Joined with "; " into one frame (the reader splits it back).
    List(ItemKey),
    Int(ItemKey),
}

pub struct FieldDef {
    pub key: &'static str,
    pub label: &'static str,
    pub shape: Shape,
    pub scope: Scope,
    pub read: Read,
    pub write: Write,
    /// No file tag at all — waverunner's own fact (release membership, the
    /// album identity token). Never stored at the tag tier, never written.
    pub app_only: bool,
    /// A change regroups: which album the track lands in, or which release
    /// of it. The scanner re-derives structure from these.
    pub grouping: bool,
    /// Offered in the editors. Ids and app-only fields are set by matching
    /// and by structural actions, not typed.
    pub editable: bool,
    /// A MusicBrainz id (shown shortened).
    pub id: bool,
}

/// Flags, in declaration order: app_only, grouping, editable, id. (Struct
/// update syntax can't build these in a const — ItemKey has a destructor —
/// so the flagged entries spell all four out.)
const fn with_flags(
    key: &'static str,
    label: &'static str,
    shape: Shape,
    scope: Scope,
    read: Read,
    write: Write,
    app_only: bool,
    grouping: bool,
    editable: bool,
    id: bool,
) -> FieldDef {
    FieldDef { key, label, shape, scope, read, write, app_only, grouping, editable, id }
}

/// A plain file-backed, editable, non-grouping field.
const fn f(
    key: &'static str,
    label: &'static str,
    shape: Shape,
    scope: Scope,
    read: Read,
    write: Write,
) -> FieldDef {
    with_flags(key, label, shape, scope, read, write, false, false, true, false)
}

pub const FIELDS: &[FieldDef] = &[
    f("title", "Title", Shape::Text, Scope::Track, Read::Special, Write::Special),
    f("credits", "Artists", Shape::List, Scope::Track, Read::Special, Write::Special),
    with_flags(
        "album_artists",
        "Album artists",
        Shape::List,
        Scope::Album,
        Read::Special,
        Write::List(ItemKey::AlbumArtist),
        false,
        true,
        true,
        false,
    ),
    with_flags("album", "Album", Shape::Text, Scope::Release, Read::Special, Write::Special, false, true, true, false),
    f("track_number", "Track number", Shape::Int, Scope::Track, Read::Special, Write::Special),
    f("disc_number", "Disc number", Shape::Int, Scope::Track, Read::Special, Write::Special),
    f(
        "date",
        "Date",
        Shape::Text,
        Scope::Release,
        Read::Special,
        Write::Text(ItemKey::RecordingDate),
    ),
    f("genres", "Genres", Shape::List, Scope::Album, Read::List(ItemKey::Genre), Write::List(ItemKey::Genre)),
    f(
        "disc_subtitle",
        "Disc name",
        Shape::Text,
        Scope::Disc,
        Read::Text(ItemKey::SetSubtitle, None),
        Write::Text(ItemKey::SetSubtitle),
    ),
    f("comment", "Comment", Shape::LongText, Scope::Track, Read::Text(ItemKey::Comment, None), Write::Text(ItemKey::Comment)),
    f("lyrics", "Lyrics", Shape::LongText, Scope::Track, Read::Text(ItemKey::Lyrics, None), Write::Text(ItemKey::Lyrics)),
    f("composer", "Composer", Shape::List, Scope::Track, Read::List(ItemKey::Composer), Write::List(ItemKey::Composer)),
    f(
        "label",
        "Label",
        Shape::Text,
        Scope::Release,
        Read::Text(ItemKey::Label, Some(ItemKey::Publisher)),
        Write::Text(ItemKey::Label),
    ),
    f(
        "catalog_number",
        "Catalogue number",
        Shape::Text,
        Scope::Release,
        Read::Text(ItemKey::CatalogNumber, None),
        Write::Text(ItemKey::CatalogNumber),
    ),
    f("bpm", "BPM", Shape::Int, Scope::Track, Read::Int(ItemKey::Bpm, Some(ItemKey::IntegerBpm)), Write::Int(ItemKey::Bpm)),
    with_flags(
        "mb_recording_id",
        "MusicBrainz recording",
        Shape::Text,
        Scope::Track,
        Read::Text(ItemKey::MusicBrainzRecordingId, None),
        Write::Text(ItemKey::MusicBrainzRecordingId),
        false,
        false,
        false,
        true,
    ),
    with_flags(
        "mb_release_id",
        "MusicBrainz release",
        Shape::Text,
        Scope::Release,
        Read::Text(ItemKey::MusicBrainzReleaseId, None),
        Write::Text(ItemKey::MusicBrainzReleaseId),
        false,
        false,
        false,
        true,
    ),
    with_flags(
        "mb_release_group_id",
        "MusicBrainz release group",
        Shape::Text,
        Scope::Album,
        Read::Text(ItemKey::MusicBrainzReleaseGroupId, None),
        Write::Text(ItemKey::MusicBrainzReleaseGroupId),
        false,
        true,
        false,
        true,
    ),
    with_flags("release_key", "Release", Shape::Text, Scope::Track, Read::Special, Write::None, true, true, false, false),
    with_flags(
        "identity_key",
        "Album identity",
        Shape::Text,
        Scope::Track,
        Read::Special,
        Write::None,
        true,
        true,
        false,
        false,
    ),
];

pub fn field(key: &str) -> Option<&'static FieldDef> {
    FIELDS.iter().find(|d| d.key == key)
}

/// Every key the tier store may hold for a track.
pub fn keys() -> impl Iterator<Item = &'static str> {
    FIELDS.iter().map(|d| d.key)
}

/// Keys that have a file tag (stored at the tag tier, written by the writer).
pub fn tag_keys() -> impl Iterator<Item = &'static str> {
    FIELDS.iter().filter(|d| !d.app_only).map(|d| d.key)
}

/// Keys the editors offer.
pub fn editable_keys() -> impl Iterator<Item = &'static str> {
    FIELDS.iter().filter(|d| d.editable).map(|d| d.key)
}

/// The registry as the frontend sees it (get_tag_fields).
#[derive(Serialize)]
pub struct FieldInfo {
    pub key: &'static str,
    pub label: &'static str,
    pub shape: Shape,
    pub scope: Scope,
    pub app_only: bool,
    pub grouping: bool,
    pub editable: bool,
    pub id: bool,
}

pub fn infos() -> Vec<FieldInfo> {
    FIELDS
        .iter()
        .map(|d| FieldInfo {
            key: d.key,
            label: d.label,
            shape: d.shape,
            scope: d.scope,
            app_only: d.app_only,
            grouping: d.grouping,
            editable: d.editable,
            id: d.id,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Stored-form helpers
// ---------------------------------------------------------------------------

pub fn list_to_stored(list: &[String]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".to_string())
}

pub fn stored_to_list(s: &str) -> Vec<String> {
    if s.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<String>>(s)
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

pub fn stored_to_int(s: &str) -> Option<i64> {
    s.trim().parse::<i64>().ok().filter(|n| *n > 0)
}

/// Normalize a value the frontend sent (any JSON) into the stored form of
/// the field — lists from arrays or ';'-separated text, ints from numbers or
/// digits, text trimmed. Unknown keys are refused.
pub fn stored_from_json(key: &str, value: &serde_json::Value) -> Result<String, String> {
    let def = field(key).ok_or_else(|| format!("Unknown track field: {key}"))?;
    Ok(match def.shape {
        Shape::List => {
            let list: Vec<String> = match value {
                serde_json::Value::Array(a) => a
                    .iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
                serde_json::Value::String(s) => s
                    .split(';')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect(),
                _ => Vec::new(),
            };
            list_to_stored(&list)
        }
        Shape::Int => match value {
            serde_json::Value::Number(n) => n.as_i64().filter(|n| *n > 0).map(|n| n.to_string()).unwrap_or_default(),
            serde_json::Value::String(s) => stored_to_int(s).map(|n| n.to_string()).unwrap_or_default(),
            _ => String::new(),
        },
        Shape::Text | Shape::LongText => match value {
            serde_json::Value::String(s) => {
                if def.shape == Shape::LongText {
                    s.trim_end().to_string()
                } else {
                    s.trim().to_string()
                }
            }
            serde_json::Value::Null => String::new(),
            other => other.to_string(),
        },
    })
}

// ---------------------------------------------------------------------------
// ScannedTrack accessors — key ↔ the typed fields the scanner's logic uses
// ---------------------------------------------------------------------------

/// The stored-form value of one field on a scanned track. "" = none.
pub fn get(t: &ScannedTrack, key: &str) -> String {
    match key {
        "title" => t.title.clone(),
        "credits" => list_to_stored(&t.credits),
        "album_artists" => list_to_stored(&album_artists_of(t)),
        "album" => t.album.clone(),
        "track_number" => t.track_number.map(|n| n.to_string()).unwrap_or_default(),
        "disc_number" => t.disc_number.to_string(),
        "date" => t.date.clone().unwrap_or_default(),
        "genres" => list_to_stored(&t.genres),
        "disc_subtitle" => t.disc_subtitle.clone().unwrap_or_default(),
        "mb_recording_id" => t.mb_recording_id.clone().unwrap_or_default(),
        "mb_release_id" => t.mb_release_id.clone().unwrap_or_default(),
        "mb_release_group_id" => t.mb_release_group_id.clone().unwrap_or_default(),
        "release_key" => t.release_key.clone().unwrap_or_default(),
        "identity_key" => t.identity_key.clone().unwrap_or_default(),
        other => t.extra.get(other).cloned().unwrap_or_default(),
    }
}

/// The album-artist list as the field sees it: the full joint list when
/// there is one, else the single album artist, else nothing.
pub fn album_artists_of(t: &ScannedTrack) -> Vec<String> {
    if t.album_artist_credits.len() >= 2 {
        t.album_artist_credits.clone()
    } else if t.album_artist.is_empty() {
        Vec::new()
    } else {
        vec![t.album_artist.clone()]
    }
}

/// Set one field from its stored form. Lists arrive as JSON, numbers as
/// decimal, "" clears.
pub fn set(t: &mut ScannedTrack, key: &str, stored: &str) {
    let opt = |s: &str| if s.trim().is_empty() { None } else { Some(s.trim().to_string()) };
    match key {
        "title" => t.title = stored.trim().to_string(),
        "credits" => t.credits = stored_to_list(stored),
        "album_artists" => {
            let list = stored_to_list(stored);
            t.album_artist = list.first().cloned().unwrap_or_default();
            t.album_artist_credits = if list.len() >= 2 { list } else { Vec::new() };
        }
        "album" => t.album = stored.trim().to_string(),
        "track_number" => t.track_number = stored_to_int(stored),
        "disc_number" => t.disc_number = stored_to_int(stored).unwrap_or(1),
        "date" => t.date = opt(stored),
        "genres" => t.genres = stored_to_list(stored),
        "disc_subtitle" => t.disc_subtitle = opt(stored),
        "mb_recording_id" => t.mb_recording_id = opt(stored),
        "mb_release_id" => t.mb_release_id = opt(stored),
        "mb_release_group_id" => t.mb_release_group_id = opt(stored),
        "release_key" => t.release_key = opt(stored),
        "identity_key" => t.identity_key = opt(stored),
        other => {
            if let Some(def) = field(other) {
                let v = match def.shape {
                    Shape::List => list_to_stored(&stored_to_list(stored)),
                    Shape::Int => stored_to_int(stored).map(|n| n.to_string()).unwrap_or_default(),
                    Shape::LongText => stored.trim_end().to_string(),
                    Shape::Text => stored.trim().to_string(),
                };
                if v.is_empty() {
                    t.extra.remove(def.key);
                } else {
                    t.extra.insert(def.key, v);
                }
            }
        }
    }
}

/// The tag tier of a freshly read track: every file-backed field in stored
/// form, taken BEFORE the overlay so it records what the file says.
pub fn snapshot(t: &ScannedTrack) -> Vec<(&'static str, String)> {
    tag_keys().map(|k| (k, get(t, k))).collect()
}

/// Read the registry's generic fields off a tag (the Special ones are read
/// by hand in `read_track`). Lists split on ';' per frame; the first key of
/// a Text/Int ladder with a value wins.
pub fn read_generic(tag: Option<&lofty::tag::Tag>, t: &mut ScannedTrack) {
    let Some(tag) = tag else { return };
    let text = |k: &ItemKey| tag.get_string(k).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    for def in FIELDS {
        match &def.read {
            Read::Special => {}
            Read::Text(key, fallback) => {
                let v = text(key).or_else(|| fallback.as_ref().and_then(text));
                if let Some(v) = v {
                    set(t, def.key, &v);
                }
            }
            Read::List(key) => {
                let list: Vec<String> = tag
                    .get_strings(key)
                    .flat_map(|s| s.split(';'))
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !list.is_empty() {
                    set(t, def.key, &list_to_stored(&list));
                }
            }
            Read::Int(key, fallback) => {
                let int = |k: &ItemKey| {
                    tag.get_string(k)
                        .and_then(|s| s.trim().parse::<f64>().ok())
                        .map(|n| n.round() as i64)
                        .filter(|n| *n > 0)
                };
                let v = int(key).or_else(|| fallback.as_ref().and_then(int));
                if let Some(v) = v {
                    set(t, def.key, &v.to_string());
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The overlay — the layer a scan puts on before grouping
// ---------------------------------------------------------------------------

/// What the store holds for one file, keyed by path, loaded once per scan.
/// `tag` carries the stored tag tier for the fields that have an upper tier
/// (the stale check needs nothing more) plus `title` always — its presence
/// is the "this track was scanned before" stamp.
#[derive(Default, Clone)]
pub struct PathLayer {
    pub track_id: i64,
    pub tag: HashMap<String, String>,
    pub mb: HashMap<String, String>,
    pub user: HashMap<String, String>,
}

impl PathLayer {
    fn stamped(&self) -> bool {
        self.tag.contains_key("title")
    }
}

#[derive(Default)]
pub struct ScanLayer {
    pub by_path: HashMap<String, PathLayer>,
}

/// Put the track's upper tiers onto its freshly read values: user, else a
/// non-empty MusicBrainz value. A field whose FILE tag changed since the
/// last scan keeps the file's value — the store drops that field's upper
/// tiers when the track is written (store_tag_tier), and this keeps the
/// grouping that runs in between consistent with that outcome.
pub fn overlay(t: &mut ScannedTrack, layer: &PathLayer) {
    let stamped = layer.stamped();
    for def in FIELDS {
        let key = def.key;
        let upper = layer
            .user
            .get(key)
            .cloned()
            .or_else(|| layer.mb.get(key).filter(|v| !v.is_empty()).cloned());
        let Some(value) = upper else { continue };
        if !def.app_only && stamped {
            let raw = get(t, key);
            let prev = layer.tag.get(key).cloned().unwrap_or_default();
            if prev != raw {
                continue; // the file moved underneath — its new value wins
            }
        }
        set(t, key, &value);
    }
}
