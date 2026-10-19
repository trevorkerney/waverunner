//! Shape hints — albums that look like ONE album.
//!
//! The scanner groups by tags, so a box ripped per film, a compilation whose
//! files name each track's group as ALBUMARTIST, or a two-disc set tagged
//! "(CD1)" / "(CD2)" lands as several albums. Nothing here changes that:
//! every hint is a suggestion the person confirms (or declines) from the
//! Albums page, which opens the ordinary Combine dialog with the group
//! picked. The detector runs at the end of every scan — full or scoped —
//! over facts the database already holds (no files, no network), and the
//! hints it finds are stored so the page reads them in one query.
//!
//! Three classes, each with its own evidence (user's framing, 2026-10-17):
//!
//! - `split_folder` — several albums whose files live in ONE folder and whose
//!   titles agree once punctuation and a disc tail are folded away. The
//!   folder is decisive: one folder, one title is as sure as tags get. Merge.
//! - `discs` — titles that differ only by a disc tail ("(CD1)", "[Disc 2]"),
//!   or sibling subfolders of one album-ish folder (its name isn't the
//!   artist's) sharing a title stem. Merge.
//! - `editions` — same artist, same title stem, an edition tail on at least
//!   one ("(Mono)", "(Deluxe)", "Bad 25"), in separate folders. Separate
//!   releases. Medium confidence by nature: this is also what two different
//!   works with one name look like, so two members matched to DIFFERENT
//!   MusicBrainz groups are never suggested (the So Far Gone lesson), and
//!   same title without a tail needs the same year.
//!
//! A hint is keyed on its MEMBER SET (sorted album ids): a dismissal ("keep
//! apart") answers exactly that group, and a different group — one more
//! fragment found, two of them merged by hand — is a new question.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;

use crate::commands::fold_for_sort;
use crate::AppState;

pub const KIND_SPLIT_FOLDER: &str = "split_folder";
pub const KIND_DISCS: &str = "discs";
pub const KIND_EDITIONS: &str = "editions";

/// MusicBrainz's name for a compilation's credit — what a split compilation
/// is suggested under.
pub const VARIOUS_ARTISTS: &str = "Various Artists";

// ---------------------------------------------------------------------------
// Facts (one per real album) and the pure detector over them
// ---------------------------------------------------------------------------

/// What the detector knows about an album. Built from the database by
/// `load_facts`; the tests build them by hand.
#[derive(Clone, Debug)]
pub(crate) struct Fact {
    pub id: i64,
    pub title: String,
    /// album.folder_path, lowercased, forward slashes, no trailing slash.
    pub folder: String,
    /// The same folder as written on disk (case kept) — for a title taken
    /// from a folder's name.
    pub folder_raw: String,
    pub year: Option<String>,
    /// Album-artist credit names in credit order.
    pub credits: Vec<String>,
    pub track_count: i64,
    /// (disc, track) of every numbered track — the merge collision test.
    pub slots: Vec<(i64, i64)>,
    /// Effective MusicBrainz release-group id (user tier, else mb).
    pub group: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Hint {
    /// Digest of the sorted member ids — what a dismissal is keyed on.
    pub key: String,
    pub kind: String,
    /// "merge" | "versions" — what the combine dialog opens on.
    pub mode: String,
    /// "high" | "medium".
    pub confidence: String,
    /// One line for the card: why these look like one album.
    pub reason: String,
    /// The album artist the combined album should carry, when the evidence
    /// names one (a shared main artist, or Various Artists). None = the
    /// keeper's own credit.
    pub album_artist: Option<String>,
    /// A title for the combined album when the members' titles don't name
    /// it — a box's discs each titled as their own album take the box
    /// folder's name. None = the combine dialog's own title vote.
    pub title: Option<String>,
    /// mode 'merge', when the members' discs would collide as tagged: the
    /// disc number each member's tracks take (from the folder order or the
    /// titles' disc tails), written with the combine. (album_id, disc).
    pub disc_map: Option<Vec<(i64, i64)>>,
    /// The folder the hint is about (shared folder, or the parent), for
    /// display.
    pub folder: String,
    pub member_ids: Vec<i64>,
}

/// Fold a title to its comparison form: punctuation and accents folded,
/// then everything that isn't a letter or digit becomes a space, runs
/// collapsed. "HIStory- Past, Present And Future, Book I (Disc 2)" and
/// "HIStory: Past, Present and Future, Book I (Disc 1)" meet here once the
/// disc tail is cut.
pub(crate) fn norm_key(s: &str) -> String {
    let folded = fold_for_sort(s);
    let mut out = String::with_capacity(folded.len());
    let mut space = true;
    for c in folded.chars() {
        if c.is_alphanumeric() {
            out.push(c);
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    out.trim_end().to_string()
}

fn leaf_of(folder: &str) -> &str {
    folder.rsplit('/').next().unwrap_or(folder)
}

fn parent_of(folder: &str) -> &str {
    match folder.rfind('/') {
        Some(i) => &folder[..i],
        None => "",
    }
}

/// "all eyez on me cd1" / "… cd 1" / "… disc 2" / "… disk 2" → (stem, n).
/// Only disc words — "Vol." and "Part" name separate works more often than
/// discs of one.
pub(crate) fn disc_split(norm: &str) -> Option<(String, u32)> {
    let toks: Vec<&str> = norm.split_whitespace().collect();
    let n = toks.len();
    let is_disc_word = |t: &str| matches!(t, "cd" | "disc" | "disk");
    // "… disc 2"
    if n >= 3 && is_disc_word(toks[n - 2]) {
        if let Ok(d) = toks[n - 1].parse::<u32>() {
            if d > 0 && d < 100 {
                return Some((toks[..n - 2].join(" "), d));
            }
        }
    }
    // "… cd2"
    if n >= 2 {
        let last = toks[n - 1];
        for w in ["disc", "disk", "cd"] {
            if let Some(rest) = last.strip_prefix(w) {
                if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
                    if let Ok(d) = rest.parse::<u32>() {
                        if d > 0 && d < 100 {
                            return Some((toks[..n - 1].join(" "), d));
                        }
                    }
                }
            }
        }
    }
    None
}

/// A trailing bracketed tail — "(Mono)", "[Remastered]", "(Live Wembley
/// July 16, 1988)" → (stem's comparison form, the tail as written). None
/// when the tail is a disc marker (that's `disc_split`'s) or there is no
/// bracket.
pub(crate) fn bracket_split(raw: &str) -> Option<(String, String)> {
    let t = raw.trim();
    let closers = [(')', '('), (']', '[')];
    for (close, open) in closers {
        if t.ends_with(close) {
            if let Some(i) = t.rfind(open) {
                let tail = t[i + 1..t.len() - 1].trim();
                let stem = t[..i].trim();
                if tail.is_empty() || stem.is_empty() {
                    return None;
                }
                let tail_norm = norm_key(tail);
                // A disc tail isn't an edition.
                if disc_split(&format!("x {tail_norm}")).is_some() || tail_norm.parse::<u32>().is_ok() {
                    return None;
                }
                return Some((norm_key(stem), tail.to_string()));
            }
        }
    }
    None
}

/// `bracket_split`, or a two-digit anniversary number ("Bad 25") →
/// (stem, "25"). The anniversary reading pairs ACROSS folders (editions);
/// inside one folder only the bracket counts — "Bad 25" and "Bad 25
/// (Bonus Material)" are one album there.
pub(crate) fn edition_split(raw: &str) -> Option<(String, String)> {
    if let Some(found) = bracket_split(raw) {
        return Some(found);
    }
    let t = raw.trim();
    // "Bad 25", "Thriller 40": a short number after the name.
    let norm = norm_key(t);
    let toks: Vec<&str> = norm.split_whitespace().collect();
    if toks.len() >= 2 {
        let last = toks[toks.len() - 1];
        if last.len() == 2 && last.chars().all(|c| c.is_ascii_digit()) {
            return Some((toks[..toks.len() - 1].join(" "), last.to_string()));
        }
    }
    None
}

/// "The Lady Sings: God Bless the Child" → "the lady sings". The part
/// before the first colon or spaced dash, when both halves have words.
pub(crate) fn colon_split(raw: &str) -> Option<String> {
    let folded = fold_for_sort(raw);
    let cut = folded.find(": ").or_else(|| folded.find(" - "));
    let i = cut?;
    let stem = norm_key(&folded[..i]);
    let rest = norm_key(&folded[i + 2..]);
    if stem.is_empty() || rest.is_empty() {
        return None;
    }
    Some(stem)
}

/// The words every title starts with, when that's at least two words and
/// not the whole of every title ("Star Wars Episode I…", "Star Wars Episode
/// II…" → "star wars episode"). None otherwise.
fn common_prefix(norms: &[String]) -> Option<String> {
    let first: Vec<&str> = norms.first()?.split_whitespace().collect();
    let mut n = first.len();
    for t in norms.iter().skip(1) {
        let toks: Vec<&str> = t.split_whitespace().collect();
        let mut k = 0;
        while k < n && k < toks.len() && toks[k] == first[k] {
            k += 1;
        }
        n = k;
        if n == 0 {
            return None;
        }
    }
    if n < 2 {
        return None;
    }
    let stem = first[..n].join(" ");
    if stem.len() < 6 {
        return None;
    }
    Some(stem)
}

/// A folder leaf's leading sequence number — "1 - Buffalo Springfield
/// (Mono)", "02. Episode II", "3_Something" — the disc-order convention
/// rippers use for a box's subfolders.
fn leading_number(leaf: &str) -> Option<u32> {
    let t = leaf.trim_start();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 2 {
        return None;
    }
    let rest = &t[digits.len()..];
    let sep = rest.trim_start();
    if sep.is_empty() || !sep.starts_with(['-', '.', '_', ')', ':', '–']) {
        return None;
    }
    digits.parse().ok()
}

/// A box folder's name as an album title: the artist prefix a ripper puts
/// first ("Buffalo Springfield - …") and the trailing bracket groups
/// ("(2018)", "[FLAC]", "{…}") cut, separators trimmed. None when nothing
/// readable is left.
pub(crate) fn box_title(leaf: &str, artist_names: &[String]) -> Option<String> {
    let mut t = leaf.trim().to_string();
    // Trailing "(…)" / "[…]" / "{…}" groups, as many as there are.
    loop {
        let trimmed = t.trim_end().to_string();
        let Some(last) = trimmed.chars().last() else { break };
        let open = match last {
            ')' => '(',
            ']' => '[',
            '}' => '{',
            _ => break,
        };
        match trimmed.rfind(open) {
            Some(i) => t = trimmed[..i].to_string(),
            None => break,
        }
    }
    // A leading artist name followed by a separator: the part before the
    // first " - " / " – " / ": " is the artist when it IS one of the credit
    // names, or the start of one ("Stevie Ray Vaughan" before "Stevie Ray
    // Vaughan & Double Trouble"), or one of them is the start of it. A
    // leading "The" is folded on both sides: a folder says "Smashing
    // Pumpkins –" for a credit "The Smashing Pumpkins" (2026-10-18 — the
    // prefix survived into the suggested title, which then outranked the
    // disc names the album titles offered).
    let lower = t.to_lowercase();
    let word_start = |whole: &str, part: &str| {
        whole == part || (whole.starts_with(part) && !whole[part.len()..].starts_with(|c: char| c.is_alphanumeric()))
    };
    let sans_the = |s: &str| s.strip_prefix("the ").map(str::trim_start).unwrap_or(s).to_string();
    let mut cut: Option<usize> = None;
    for sep in [" - ", " – ", " — ", ": ", "_-_"] {
        if let Some(i) = lower.find(sep) {
            let head = sans_the(lower[..i].trim());
            if head.is_empty() {
                continue;
            }
            let is_artist = artist_names.iter().any(|name| {
                let n = sans_the(&name.trim().to_lowercase());
                !n.is_empty() && (word_start(&n, &head) || word_start(&head, &n))
            });
            if is_artist {
                cut = Some(i + sep.len());
            }
            break;
        }
    }
    if let Some(i) = cut {
        t = t[i..].to_string();
    }
    let cleaned = t.trim().trim_matches(|c: char| c == '-' || c == '–' || c == '_' || c == ':' || c == ' ').trim();
    if cleaned.is_empty() || !cleaned.chars().any(|c| c.is_alphanumeric()) {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn is_various(name: &str) -> bool {
    matches!(norm_key(name).as_str(), "various artists" | "various" | "va" | "v a" | "various artist")
}

/// The credit key an edition pairing matches on: the first credit's
/// comparison form, every Various Artists spelling made one.
fn artist_key(f: &Fact) -> String {
    match f.credits.first() {
        Some(c) if is_various(c) => "various artists".to_string(),
        Some(c) => norm_key(c),
        None => String::new(),
    }
}

/// For a split folder: the album artist the merged album should carry. A
/// main artist every credit begins with ("Skrillex" under "Skrillex & The
/// Doors"), else Various Artists at three or more distinct credits, else
/// nothing (the keeper's credit stands).
fn suggested_artist(members: &[&Fact]) -> Option<String> {
    let firsts: Vec<(String, &str)> = members
        .iter()
        .filter_map(|f| f.credits.first().map(|c| (norm_key(c), c.as_str())))
        .filter(|(k, _)| !k.is_empty())
        .collect();
    if firsts.is_empty() {
        return None;
    }
    let distinct: HashSet<&str> = firsts.iter().map(|(k, _)| k.as_str()).collect();
    if distinct.len() <= 1 {
        return None;
    }
    // The shortest first credit, when every other starts with it as whole
    // words.
    let (short_key, short_name) = firsts.iter().min_by_key(|(k, _)| k.len()).cloned().unwrap();
    let all_start = firsts.iter().all(|(k, _)| {
        k == &short_key || k.starts_with(&format!("{short_key} "))
    });
    if all_start && !is_various(short_name) {
        return Some(short_name.to_string());
    }
    if distinct.len() >= 3 {
        return Some(VARIOUS_ARTISTS.to_string());
    }
    None
}

fn key_of(ids: &[i64]) -> String {
    let joined: Vec<String> = ids.iter().map(|i| i.to_string()).collect();
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(joined.join(",").as_bytes()))
}

/// Two members claim one (disc, track) slot — a merge would be refused.
/// `disc_map` reads the slots as they'd be after the discs it assigns: a
/// member's first disc lands on its number and the rest follow.
fn slots_collide(members: &[&Fact], disc_map: Option<&[(i64, i64)]>) -> bool {
    let mut seen: HashSet<(i64, i64)> = HashSet::new();
    for f in members {
        let shift = disc_map
            .and_then(|m| m.iter().find(|(id, _)| *id == f.id))
            .and_then(|(_, to)| first_disc(f).map(|from| to - from))
            .unwrap_or(0);
        let mut own: HashSet<(i64, i64)> = HashSet::new();
        for (d, n) in &f.slots {
            let s = (d + shift, *n);
            if own.insert(s) && !seen.insert(s) {
                return true;
            }
        }
    }
    false
}

/// The lowest disc a member's tracks sit on; None when none are numbered.
fn first_disc(f: &Fact) -> Option<i64> {
    f.slots.iter().map(|(d, _)| *d).min()
}

/// The disc each member's tracks sit on, when that is ONE disc.
fn single_disc(f: &Fact) -> Option<i64> {
    let discs: HashSet<i64> = f.slots.iter().map(|(d, _)| *d).collect();
    if discs.len() == 1 { discs.into_iter().next() } else { None }
}

/// A disc assignment from per-member numbers (folder order, disc tails):
/// where each member's first disc lands, listed only for the members that
/// would move. None when a member has no number to go by; empty when
/// nothing moves.
fn disc_assignment(members: &[&Fact], numbers: &[Option<i64>]) -> Option<Vec<(i64, i64)>> {
    let mut out = Vec::new();
    for (f, n) in members.iter().zip(numbers) {
        let n = (*n)?;
        let Some(own) = first_disc(f) else { continue };
        if own != n {
            out.push((f.id, n));
        }
    }
    Some(out)
}

/// Distinct MusicBrainz groups among the members — two or more means the
/// library already knows these are different albums.
fn distinct_groups(members: &[&Fact]) -> usize {
    members.iter().filter_map(|f| f.group.as_deref()).collect::<HashSet<_>>().len()
}

/// `discs`: an assignment that would number the members' discs, with a
/// word for where the numbers come from. Used only when the merge would
/// collide without it. When it collides even so, the hint still offers a
/// merge and carries the numbers as a starting point — the combine dialog
/// lets the person set each album's disc by hand (a box whose halves share
/// a folder number, 2026-10-18). With no numbers at all: separate releases.
fn make_hint(
    kind: &str,
    mode: &str,
    confidence: &str,
    reason: String,
    album_artist: Option<String>,
    title: Option<String>,
    discs: Option<(Vec<(i64, i64)>, &str)>,
    folder: &str,
    members: &[&Fact],
) -> Hint {
    let mut ids: Vec<i64> = members.iter().map(|f| f.id).collect();
    ids.sort_unstable();
    let mut disc_map = None;
    let (mode, confidence, reason) = if mode == "merge" && slots_collide(members, None) {
        match discs {
            Some((map, from)) if !map.is_empty() && !slots_collide(members, Some(&map)) => {
                let reason = format!("{reason} · discs numbered from {from}");
                disc_map = Some(map);
                ("merge".to_string(), confidence.to_string(), reason)
            }
            Some((map, from)) if !map.is_empty() => {
                let reason = format!(
                    "{reason} · disc numbers from {from} overlap — set each album's disc in the combine dialog"
                );
                disc_map = Some(map);
                ("merge".to_string(), "medium".to_string(), reason)
            }
            _ => (
                "versions".to_string(),
                "medium".to_string(),
                format!("{reason} · tracks share disc and track numbers, so a merge needs renumbering first"),
            ),
        }
    } else {
        (mode.to_string(), confidence.to_string(), reason)
    };
    Hint {
        key: key_of(&ids),
        kind: kind.to_string(),
        mode,
        confidence,
        reason,
        album_artist,
        title,
        disc_map,
        folder: folder.to_string(),
        member_ids: ids,
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The detector proper: pure over the facts, so it's testable and runs the
/// same whether a scan or a test calls it.
pub(crate) fn detect(facts: &[Fact]) -> Vec<Hint> {
    let mut hints: Vec<Hint> = Vec::new();
    let mut taken: HashSet<i64> = HashSet::new();
    // Members of a split-folder hint (A). The box rule (B2) may list them
    // too — a box whose Episode IV folder holds two half-albums shows all
    // nine from the start, with the halves' own pair hints beside it — so
    // those two kinds overlap; everything else keeps to one hint.
    let mut taken_by_a: HashSet<i64> = HashSet::new();
    let norm_of: HashMap<i64, String> = facts.iter().map(|f| (f.id, norm_key(&f.title))).collect();
    // The disc-less stem of a title (its own form when it has no disc tail).
    let stem_of: HashMap<i64, String> = facts
        .iter()
        .map(|f| {
            let n = &norm_of[&f.id];
            (f.id, disc_split(n).map(|(s, _)| s).unwrap_or_else(|| n.clone()))
        })
        .collect();

    // ── A. Several albums in one folder, one title ────────────────────
    // Inside ONE folder a bracketed tail folds too (one folder is one album,
    // the rule's own premise): a box whose discs are tagged "… (1951-1955)",
    // "… (1955-1957)" is one hint, and the tails become the disc names the
    // combine dialog suggests. Across folders a tail still marks an edition
    // (class C).
    let folder_stem = |f: &Fact| -> String {
        let base = bracket_split(&f.title).map(|(s, _)| s).unwrap_or_else(|| norm_of[&f.id].clone());
        disc_split(&base).map(|(s, _)| s).unwrap_or(base)
    };
    let mut by_folder: HashMap<&str, Vec<&Fact>> = HashMap::new();
    for f in facts {
        by_folder.entry(f.folder.as_str()).or_default().push(f);
    }
    let mut folders: Vec<(&str, Vec<&Fact>)> = by_folder.into_iter().filter(|(_, v)| v.len() >= 2).collect();
    folders.sort_by(|a, b| a.0.cmp(b.0));
    for (folder, albums) in folders {
        let mut by_stem: HashMap<String, Vec<&Fact>> = HashMap::new();
        for f in &albums {
            by_stem.entry(folder_stem(f)).or_default().push(f);
        }
        let mut stems: Vec<(String, Vec<&Fact>)> = by_stem.into_iter().filter(|(_, v)| v.len() >= 2).collect();
        stems.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, members) in stems {
            let members: Vec<&Fact> = members.into_iter().filter(|f| !taken.contains(&f.id)).collect();
            if members.len() < 2 {
                continue;
            }
            let credits: HashSet<String> = members.iter().map(|f| artist_key(f)).collect();
            let titles: HashSet<&str> = members.iter().map(|f| norm_of[&f.id].as_str()).collect();
            let title_part = if titles.len() == 1 {
                "tagged with one title in one folder".to_string()
            } else {
                // The tails that tell the titles apart, a few of them.
                let mut tails: Vec<String> = members
                    .iter()
                    .filter_map(|f| bracket_split(&f.title).map(|(_, t)| t))
                    .collect();
                tails.sort();
                tails.dedup();
                let shown: Vec<String> = tails.iter().take(4).map(|t| format!("“{t}”")).collect();
                if shown.is_empty() {
                    format!("in one folder, {} spellings of one title", titles.len())
                } else {
                    format!(
                        "in one folder, one title with tails {}{}",
                        shown.join(", "),
                        if tails.len() > 4 { ", …" } else { "" }
                    )
                }
            };
            let reason = if credits.len() > 1 {
                format!(
                    "{} {title_part}, under {} album-artist spellings",
                    plural(members.len(), "album", "albums"),
                    credits.len()
                )
            } else {
                format!("{} {title_part}", plural(members.len(), "album", "albums"))
            };
            let artist = suggested_artist(&members);
            for f in &members {
                taken.insert(f.id);
                taken_by_a.insert(f.id);
            }
            hints.push(make_hint(KIND_SPLIT_FOLDER, "merge", "high", reason, artist, None, None, folder, &members));
        }
    }

    // ── B1. Titles that say which disc they are ───────────────────────
    let mut by_disc_stem: HashMap<(String, String), Vec<(&Fact, u32)>> = HashMap::new();
    for f in facts {
        if taken.contains(&f.id) {
            continue;
        }
        if let Some((stem, d)) = disc_split(&norm_of[&f.id]) {
            by_disc_stem.entry((artist_key(f), stem)).or_default().push((f, d));
        }
    }
    let mut disc_groups: Vec<((String, String), Vec<(&Fact, u32)>)> =
        by_disc_stem.into_iter().filter(|(_, v)| v.len() >= 2).collect();
    disc_groups.sort_by(|a, b| a.0.cmp(&b.0));
    for ((_, _stem), mut members) in disc_groups {
        members.sort_by_key(|(_, d)| *d);
        let facts_only: Vec<&Fact> = members.iter().map(|(f, _)| *f).collect();
        if distinct_groups(&facts_only) >= 2 {
            continue;
        }
        let discs: Vec<String> = members.iter().map(|(_, d)| d.to_string()).collect();
        let reason = format!("Titles name discs {} of one set", discs.join(", "));
        let folder = parent_of(&facts_only[0].folder).to_string();
        // Files all tagged disc 1 under "(CD1)" / "(CD2)" titles: the tails
        // number them.
        let tail_numbers: Vec<Option<i64>> = members.iter().map(|(_, d)| Some(*d as i64)).collect();
        let discs_from_tails = disc_assignment(&facts_only, &tail_numbers).map(|m| (m, "the titles' disc tails"));
        for f in &facts_only {
            taken.insert(f.id);
        }
        hints.push(make_hint(KIND_DISCS, "merge", "high", reason, None, None, discs_from_tails, &folder, &facts_only));
    }

    // ── B2. Sibling subfolders of one album-ish folder ────────────────
    // An album AT the parent joins its subfolder siblings (a main folder
    // with a "Bonus Disc" inside it).
    let mut by_parent: HashMap<String, Vec<&Fact>> = HashMap::new();
    for f in facts {
        if taken.contains(&f.id) && !taken_by_a.contains(&f.id) {
            continue;
        }
        let p = parent_of(&f.folder);
        if !p.is_empty() {
            by_parent.entry(p.to_string()).or_default().push(f);
        }
        by_parent.entry(f.folder.clone()).or_default().push(f);
    }
    let mut parents: Vec<(String, Vec<&Fact>)> = by_parent
        .into_iter()
        .filter(|(p, v)| !p.is_empty() && v.len() >= 2)
        .collect();
    parents.sort_by(|a, b| a.0.cmp(&b.0));
    for (parent, albums) in parents {
        // Subfolders (or the album at the parent itself); members of a
        // split-folder pair stay eligible (see taken_by_a).
        let mut members: Vec<&Fact> = albums
            .into_iter()
            .filter(|f| !taken.contains(&f.id) || taken_by_a.contains(&f.id))
            .collect();
        members.sort_by_key(|f| f.id);
        members.dedup_by_key(|f| f.id);
        if members.len() < 2 {
            continue;
        }
        // Two albums in one subfolder (a split pair) are one disc folder:
        // the group needs at least two distinct folders to be a box.
        let distinct_folders: HashSet<&str> = members.iter().map(|f| f.folder.as_str()).collect();
        if distinct_folders.len() < 2 {
            continue;
        }
        // The parent is an album-ish folder, not an artist's: its name is
        // none of the members' credit names.
        let leaf = norm_key(leaf_of(&parent));
        if leaf.is_empty()
            || members.iter().any(|f| f.credits.iter().any(|c| norm_key(c) == leaf))
        {
            continue;
        }
        let norms: Vec<String> = members.iter().map(|f| stem_of[&f.id].clone()).collect();
        let all_same = norms.iter().all(|n| n == &norms[0]);
        let colon: Vec<Option<String>> = members.iter().map(|f| colon_split(&f.title)).collect();
        let colon_same = colon.iter().all(|c| c.is_some() && c == &colon[0]);
        let edition: Vec<Option<String>> =
            members.iter().map(|f| edition_split(&f.title).map(|(s, _)| s)).collect();
        let edition_same = edition.iter().all(|e| e.is_some() && e == &edition[0]);
        let prefix = common_prefix(&norms);
        // The files' own word: every member on ONE disc number, all of them
        // different — a box ripped per disc, whatever the discs are titled
        // ("Buffalo Springfield (Mono)" … "Last Time Around (Stereo)" under
        // "What's That Sound"). Numbered subfolders ("1 - …", "2 - …") say
        // the same with less certainty.
        let own_disc: Vec<Option<i64>> = members.iter().map(|f| single_disc(f)).collect();
        let discs_distinct = own_disc.iter().all(|d| d.is_some())
            && own_disc.iter().collect::<HashSet<_>>().len() == own_disc.len();
        // Folder numbers are per FOLDER: two half-albums in "04. Episode
        // IV" share the 4.
        let numbers: Vec<Option<i64>> =
            members.iter().map(|f| leading_number(leaf_of(&f.folder_raw)).map(i64::from)).collect();
        let numbered = numbers.iter().all(|n| n.is_some()) && {
            let by_folder: HashMap<&str, Option<i64>> =
                members.iter().zip(&numbers).map(|(f, n)| (f.folder.as_str(), *n)).collect();
            by_folder.values().collect::<HashSet<_>>().len() == by_folder.len()
        };
        let (stem, confidence, how) = if all_same {
            (Some(norms[0].clone()), "high", "one title")
        } else if colon_same {
            (colon[0].clone(), "high", "one title before the colon")
        } else if discs_distinct {
            (None, "high", "each subfolder on a disc number of its own")
        } else if edition_same {
            (edition[0].clone(), "medium", "one title with edition tails")
        } else if let Some(p) = prefix {
            (Some(p), "medium", "titles sharing their first words")
        } else if numbered {
            (None, "medium", "numbered subfolders")
        } else {
            continue;
        };
        if distinct_groups(&members) >= 2 {
            continue;
        }
        // The folder named after the stem is the stronger read.
        let confidence = if confidence == "medium" && stem.as_deref().is_some_and(|s| leaf.contains(s)) {
            "high"
        } else {
            confidence
        };
        let reason = format!(
            "{} inside one album folder (“{}”), {how}",
            plural(members.len(), "subfolder", "subfolders"),
            leaf_of(&parent)
        );
        // Titles that don't agree can't name the set — the box folder can.
        let title = if all_same {
            None
        } else {
            let names: Vec<String> = members.iter().flat_map(|f| f.credits.iter().cloned()).collect();
            let raw_leaf = members
                .iter()
                .map(|f| parent_of(&f.folder_raw))
                .find(|p| !p.is_empty())
                .map(leaf_of)
                .unwrap_or("");
            box_title(raw_leaf, &names)
        };
        // Numbered folders can number the discs when the files don't.
        let discs_from_folders = if numbered {
            disc_assignment(&members, &numbers).map(|m| (m, "the folder order"))
        } else {
            None
        };
        for f in &members {
            taken.insert(f.id);
        }
        hints.push(make_hint(KIND_DISCS, "merge", confidence, reason, None, title, discs_from_folders, &parent, &members));
    }

    // ── C. Editions: same artist, same stem, an edition tail ──────────
    let mut by_edition: HashMap<(String, String), Vec<(&Fact, Option<String>)>> = HashMap::new();
    for f in facts {
        if taken.contains(&f.id) {
            continue;
        }
        let (stem, tail) = match edition_split(&f.title) {
            Some((s, t)) => (s, Some(t)),
            None => (norm_of[&f.id].clone(), None),
        };
        if stem.is_empty() {
            continue;
        }
        by_edition.entry((artist_key(f), stem)).or_default().push((f, tail));
    }
    let mut edition_groups: Vec<((String, String), Vec<(&Fact, Option<String>)>)> =
        by_edition.into_iter().filter(|(k, v)| !k.0.is_empty() && v.len() >= 2).collect();
    edition_groups.sort_by(|a, b| a.0.cmp(&b.0));
    for ((_, _stem), members) in edition_groups {
        let facts_only: Vec<&Fact> = members.iter().map(|(f, _)| *f).collect();
        // Separate folders only — one folder is A's case.
        let folders: HashSet<&str> = facts_only.iter().map(|f| f.folder.as_str()).collect();
        if folders.len() < facts_only.len() {
            continue;
        }
        if distinct_groups(&facts_only) >= 2 {
            continue;
        }
        let tails: Vec<&str> = members.iter().filter_map(|(_, t)| t.as_deref()).collect();
        let years: HashSet<&str> = facts_only.iter().filter_map(|f| f.year.as_deref()).filter(|y| !y.is_empty()).collect();
        let same_year = years.len() == 1 && facts_only.iter().all(|f| f.year.as_deref().is_some_and(|y| !y.is_empty()));
        if tails.is_empty() && !same_year {
            continue;
        }
        let reason = if tails.is_empty() {
            format!("Same title and year ({}) in separate folders", years.iter().next().unwrap_or(&""))
        } else {
            let mut shown: Vec<String> = tails.iter().map(|t| format!("“{t}”")).collect();
            shown.sort();
            shown.dedup();
            format!("Same title with edition tails {}", shown.join(", "))
        };
        let folder = parent_of(&facts_only[0].folder).to_string();
        for f in &facts_only {
            taken.insert(f.id);
        }
        hints.push(make_hint(KIND_EDITIONS, "versions", "medium", reason, None, None, None, &folder, &facts_only));
    }

    hints
}

// ---------------------------------------------------------------------------
// Facts from the database, hints into it
// ---------------------------------------------------------------------------

fn folder_key(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

pub(crate) async fn load_facts(pool: &SqlitePool, library_id: &str) -> Result<Vec<Fact>, String> {
    let rows: Vec<(i64, String, String, Option<String>)> = sqlx::query_as(
        "SELECT al.id, al.title, al.folder_path, al.release_date FROM album al
         JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
           AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let credit_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT ac.album_id, ac.name FROM album_artist_credit ac
         JOIN media_entry me ON me.id = ac.album_id
         WHERE me.library_id = ? ORDER BY ac.album_id, ac.position",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credits: HashMap<i64, Vec<String>> = HashMap::new();
    for (id, name) in credit_rows {
        credits.entry(id).or_default().push(name);
    }
    let track_rows: Vec<(i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT me.parent_id, t.disc_number, t.track_number FROM track t
         JOIN media_entry me ON me.id = t.id
         WHERE me.library_id = ? AND me.parent_id IS NOT NULL",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut counts: HashMap<i64, i64> = HashMap::new();
    let mut slots: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    for (album_id, disc, track) in track_rows {
        *counts.entry(album_id).or_insert(0) += 1;
        if let Some(n) = track {
            slots.entry(album_id).or_default().push((disc.unwrap_or(1), n));
        }
    }
    let group_rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT fo.entity_id, fo.tier, fo.value FROM field_override fo
         JOIN album al ON al.id = fo.entity_id
         JOIN media_entry me ON me.id = al.id
         WHERE me.library_id = ? AND fo.field = 'mb_release_group_id'
           AND fo.tier IN ('user', 'mb') AND fo.value <> ''",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut groups: HashMap<i64, (String, String)> = HashMap::new();
    for (id, tier, value) in group_rows {
        let replace = match groups.get(&id) {
            Some((t, _)) => t != "user" && tier == "user",
            None => true,
        };
        if replace {
            groups.insert(id, (tier, value));
        }
    }
    Ok(rows
        .into_iter()
        .map(|(id, title, folder_path, release_date)| Fact {
            id,
            title,
            folder: folder_key(&folder_path),
            folder_raw: folder_path.replace('\\', "/").trim_end_matches('/').to_string(),
            year: release_date.map(|d| d.chars().take(4).collect()).filter(|y: &String| !y.is_empty()),
            credits: credits.remove(&id).unwrap_or_default(),
            track_count: counts.get(&id).copied().unwrap_or(0),
            slots: slots.remove(&id).unwrap_or_default(),
            group: groups.remove(&id).map(|(_, v)| v),
        })
        .collect())
}

/// Recompute the library's hints and bring the stored set in step: rows
/// whose member set is gone leave, new ones arrive, changed ones update in
/// place (their created_at stays). Runs at the end of every scan.
pub(crate) async fn refresh_hints(pool: &SqlitePool, library_id: &str) -> Result<usize, String> {
    let facts = load_facts(pool, library_id).await?;
    let hints = detect(&facts);
    let keep: HashSet<&str> = hints.iter().map(|h| h.key.as_str()).collect();
    let stored: Vec<(String,)> = sqlx::query_as("SELECT key FROM album_shape_hint WHERE library_id = ?")
        .bind(library_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    for (key,) in stored {
        if !keep.contains(key.as_str()) {
            sqlx::query("DELETE FROM album_shape_hint WHERE library_id = ? AND key = ?")
                .bind(library_id)
                .bind(&key)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    for h in &hints {
        let members = serde_json::to_string(&h.member_ids).map_err(|e| e.to_string())?;
        let disc_map = match &h.disc_map {
            Some(m) => Some(serde_json::to_string(m).map_err(|e| e.to_string())?),
            None => None,
        };
        sqlx::query(
            "INSERT INTO album_shape_hint (library_id, key, kind, mode, confidence, reason, album_artist, title, disc_map, folder, member_ids)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(library_id, key) DO UPDATE SET
               kind = excluded.kind, mode = excluded.mode, confidence = excluded.confidence,
               reason = excluded.reason, album_artist = excluded.album_artist,
               title = excluded.title, disc_map = excluded.disc_map,
               folder = excluded.folder, member_ids = excluded.member_ids",
        )
        .bind(library_id)
        .bind(&h.key)
        .bind(&h.kind)
        .bind(&h.mode)
        .bind(&h.confidence)
        .bind(&h.reason)
        .bind(&h.album_artist)
        .bind(&h.title)
        .bind(&disc_map)
        .bind(&h.folder)
        .bind(&members)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(hints.len())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ShapeCredit {
    pub name: String,
    /// The artist's page, when the library has one for the name.
    pub artist_id: Option<i64>,
}

#[derive(Serialize)]
pub struct ShapeMember {
    pub album_id: i64,
    pub title: String,
    /// The credit line as the card shows it (" · " between names).
    pub credit: String,
    /// The same credit, one entry per name, each linkable when it has a page.
    pub credits: Vec<ShapeCredit>,
    /// Folder leaf — tells same-titled members apart.
    pub folder: String,
    pub year: Option<String>,
    pub track_count: i64,
    /// Match-state dot (music_mb::album_dot_states), when known.
    pub mb_state: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiscAssignView {
    pub album_id: i64,
    pub disc_no: i64,
}

/// A hint without its members hydrated — what rides the Albums page's grid
/// payload (commands::EntriesResponse), so the banner and the card pills
/// render in the same commit as the cards. The page's entries carry the
/// members' titles; the review dialog fetches the full view when opened.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ShapeHintLite {
    pub key: String,
    pub kind: String,
    pub mode: String,
    pub confidence: String,
    pub reason: String,
    pub album_artist: Option<String>,
    pub title: Option<String>,
    pub disc_map: Option<Vec<DiscAssignView>>,
    pub member_ids: Vec<i64>,
}

/// The detector's rules, as a number. Bump it when a rule changes: stored
/// hints were computed by the old rules, and the next read recomputes them
/// instead of showing stale cards until a scan happens to run (seen
/// 2026-10-18: a rule change left the old two-member Bad 25 card up).
pub const DETECTOR_VERSION: i64 = 5;

/// Hint rows are computed at scan end; a library scanned before the
/// detector existed (or before its current rules) has none, or stale ones.
/// The first read at this detector version recomputes and remembers that
/// it did (library_setting), so the page never needs a rescan to catch up.
async fn ensure_computed(pool: &SqlitePool, library_id: &str) -> Result<(), String> {
    let done: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM library_setting WHERE library_id = ? AND key = 'shape_hints_computed'",
    )
    .bind(library_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let want = DETECTOR_VERSION.to_string();
    if done.is_some_and(|(v,)| v == want) {
        return Ok(());
    }
    refresh_hints(pool, library_id).await?;
    sqlx::query(
        "INSERT INTO library_setting (library_id, key, value) VALUES (?, 'shape_hints_computed', ?)
         ON CONFLICT(library_id, key) DO UPDATE SET value = excluded.value",
    )
    .bind(library_id)
    .bind(&want)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn parse_disc_map(s: Option<String>) -> Option<Vec<DiscAssignView>> {
    s.and_then(|s| {
        serde_json::from_str::<Vec<(i64, i64)>>(&s)
            .ok()
            .map(|m| m.into_iter().map(|(album_id, disc_no)| DiscAssignView { album_id, disc_no }).collect())
    })
}

/// The library's open hints, members as ids only. Likely first, then the
/// smaller group (the card pill shows the first hint an album is in).
pub(crate) async fn lite_hints(pool: &SqlitePool, library_id: &str) -> Result<Vec<ShapeHintLite>, String> {
    ensure_computed(pool, library_id).await?;
    let rows: Vec<(String, String, String, String, String, Option<String>, Option<String>, Option<String>, String)> =
        sqlx::query_as(
            "SELECT h.key, h.kind, h.mode, h.confidence, h.reason, h.album_artist, h.title, h.disc_map, h.member_ids
             FROM album_shape_hint h
             WHERE h.library_id = ?
               AND NOT EXISTS (SELECT 1 FROM album_shape_dismiss d WHERE d.library_id = h.library_id AND d.key = h.key)",
        )
        .bind(library_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut out: Vec<ShapeHintLite> = rows
        .into_iter()
        .map(|(key, kind, mode, confidence, reason, album_artist, title, disc_map, member_ids)| ShapeHintLite {
            key,
            kind,
            mode,
            confidence,
            reason,
            album_artist,
            title,
            disc_map: parse_disc_map(disc_map),
            member_ids: serde_json::from_str(&member_ids).unwrap_or_default(),
        })
        .filter(|h| h.member_ids.len() >= 2)
        .collect();
    out.sort_by(|a, b| {
        let rank = |c: &str| if c == "high" { 0 } else { 1 };
        rank(&a.confidence)
            .cmp(&rank(&b.confidence))
            .then_with(|| a.member_ids.len().cmp(&b.member_ids.len()))
            .then_with(|| a.member_ids.cmp(&b.member_ids))
    });
    Ok(out)
}

#[derive(Serialize)]
pub struct ShapeHintView {
    pub key: String,
    pub kind: String,
    pub mode: String,
    pub confidence: String,
    pub reason: String,
    pub album_artist: Option<String>,
    /// A title for the combined album (a box folder's name), when the
    /// members' titles can't supply one.
    pub title: Option<String>,
    /// mode 'merge': disc numbers the members' tracks take with the
    /// combine (see Hint::disc_map). None = the discs as tagged.
    pub disc_map: Option<Vec<DiscAssignView>>,
    /// Folder leaf the hint is about.
    pub folder: String,
    pub member_ids: Vec<i64>,
    pub members: Vec<ShapeMember>,
}

#[derive(Serialize)]
pub struct ShapeHints {
    pub hints: Vec<ShapeHintView>,
    /// Groups the person declined ("keep apart") — offered for reconsideration.
    pub dismissed: i64,
}

/// The library's open hints, high confidence first, members in title order.
#[tauri::command]
pub async fn get_album_shape_hints(state: State<'_, AppState>, library_id: String) -> Result<ShapeHints, String> {
    let pool = &state.app_db;
    ensure_computed(pool, &library_id).await?;
    let rows: Vec<(String, String, String, String, String, Option<String>, Option<String>, Option<String>, String, String)> = sqlx::query_as(
        "SELECT h.key, h.kind, h.mode, h.confidence, h.reason, h.album_artist, h.title, h.disc_map, h.folder, h.member_ids
         FROM album_shape_hint h
         WHERE h.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM album_shape_dismiss d WHERE d.library_id = h.library_id AND d.key = h.key)",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (dismissed,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM album_shape_dismiss d
         WHERE d.library_id = ? AND EXISTS (SELECT 1 FROM album_shape_hint h WHERE h.library_id = d.library_id AND h.key = d.key)",
    )
    .bind(&library_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let facts = load_facts(pool, &library_id).await?;
    let by_id: HashMap<i64, &Fact> = facts.iter().map(|f| (f.id, f)).collect();
    let dots = crate::music_mb::album_dot_states(pool, &library_id).await?;
    // The credit rows with their artist ids — the review list links names.
    let credit_rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT ac.album_id, ac.name, ac.artist_id FROM album_artist_credit ac
         JOIN media_entry me ON me.id = ac.album_id
         WHERE me.library_id = ? ORDER BY ac.album_id, ac.position",
    )
    .bind(&library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut credits_by_album: HashMap<i64, Vec<ShapeCredit>> = HashMap::new();
    for (album_id, name, artist_id) in credit_rows {
        credits_by_album.entry(album_id).or_default().push(ShapeCredit { name, artist_id });
    }
    let mut hints = Vec::with_capacity(rows.len());
    for (key, kind, mode, confidence, reason, album_artist, title, disc_map, folder, member_ids) in rows {
        let ids: Vec<i64> = serde_json::from_str(&member_ids).unwrap_or_default();
        let disc_map = parse_disc_map(disc_map);
        let mut members: Vec<ShapeMember> = ids
            .iter()
            .filter_map(|id| by_id.get(id))
            .map(|f| ShapeMember {
                album_id: f.id,
                title: f.title.clone(),
                credit: f.credits.join(" · "),
                credits: credits_by_album.remove(&f.id).unwrap_or_default(),
                folder: leaf_of(&f.folder).to_string(),
                year: f.year.clone(),
                track_count: f.track_count,
                mb_state: dots.get(&f.id).map(|s| s.to_string()),
            })
            .collect();
        if members.len() < 2 {
            continue; // a member vanished since the last scan — the next one drops the row
        }
        members.sort_by(|a, b| fold_for_sort(&a.title).cmp(&fold_for_sort(&b.title)).then(a.album_id.cmp(&b.album_id)));
        hints.push(ShapeHintView {
            key,
            kind,
            mode,
            confidence,
            reason,
            album_artist,
            title,
            disc_map,
            folder: leaf_of(&folder).to_string(),
            member_ids: ids,
            members,
        });
    }
    // Likely first, then the smaller group (a pair before the box that
    // also lists its members — the card pill shows the first hint an
    // album is in), then by title.
    hints.sort_by(|a, b| {
        let rank = |c: &str| if c == "high" { 0 } else { 1 };
        rank(&a.confidence)
            .cmp(&rank(&b.confidence))
            .then_with(|| a.members.len().cmp(&b.members.len()))
            .then_with(|| fold_for_sort(&a.members[0].title).cmp(&fold_for_sort(&b.members[0].title)))
    });
    Ok(ShapeHints { hints, dismissed })
}

/// "Keep apart": a standing no for exactly this group of albums.
#[tauri::command]
pub async fn dismiss_album_shape_hint(state: State<'_, AppState>, library_id: String, key: String) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO album_shape_dismiss (library_id, key) VALUES (?, ?)
         ON CONFLICT(library_id, key) DO UPDATE SET dismissed_at = datetime('now')",
    )
    .bind(&library_id)
    .bind(&key)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Forget every "keep apart" in the library — the dismissed groups come back.
#[tauri::command]
pub async fn restore_album_shape_hints(state: State<'_, AppState>, library_id: String) -> Result<i64, String> {
    let res = sqlx::query("DELETE FROM album_shape_dismiss WHERE library_id = ?")
        .bind(&library_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(res.rows_affected() as i64)
}

/// Recompute on demand (the review dialog's refresh): the same pass a scan
/// ends with.
#[tauri::command]
pub async fn refresh_album_shape_hints(state: State<'_, AppState>, library_id: String) -> Result<usize, String> {
    refresh_hints(&state.app_db, &library_id).await
}

// ---------------------------------------------------------------------------
// Tests — the detector over hand-built facts
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(id: i64, title: &str, folder: &str, year: &str, credits: &[&str], slots: &[(i64, i64)]) -> Fact {
        Fact {
            id,
            title: title.to_string(),
            folder: folder_key(folder),
            folder_raw: folder.replace('\\', "/"),
            year: if year.is_empty() { None } else { Some(year.to_string()) },
            credits: credits.iter().map(|c| c.to_string()).collect(),
            track_count: slots.len() as i64,
            slots: slots.to_vec(),
            group: None,
        }
    }

    fn slots(disc: i64, from: i64, to: i64) -> Vec<(i64, i64)> {
        (from..=to).map(|n| (disc, n)).collect()
    }

    #[test]
    fn disc_tails_parse() {
        assert_eq!(disc_split("all eyez on me cd1"), Some(("all eyez on me".to_string(), 1)));
        assert_eq!(disc_split("the complete commodore recordings disc 2"), Some(("the complete commodore recordings".to_string(), 2)));
        assert_eq!(disc_split("greatest hits vol 2"), None);
        assert_eq!(disc_split("cd 2"), None);
    }

    #[test]
    fn edition_tails_parse() {
        assert_eq!(edition_split("Buffalo Springfield (Mono)"), Some(("buffalo springfield".to_string(), "Mono".to_string())));
        assert_eq!(edition_split("Bad 25"), Some(("bad".to_string(), "25".to_string())));
        assert_eq!(edition_split("All Eyez On Me (CD1)"), None);
        assert_eq!(edition_split("Thriller"), None);
    }

    #[test]
    fn split_folder_with_shared_main_artist() {
        let f = "Skrillex/Bangarang EP";
        let facts = vec![
            fact(1, "Bangarang EP", f, "2012", &["Skrillex"], &[(1, 1), (1, 3), (1, 5)]),
            fact(2, "Bangarang EP", f, "2012", &["Skrillex & The Doors"], &[(1, 2)]),
            fact(3, "Bangarang EP", f, "2012", &["Skrillex & Wolfgang Gartner"], &[(1, 4)]),
            fact(4, "Bangarang EP", f, "2012", &["Skrillex, 12th Planet & Kill The Noise"], &[(1, 6)]),
        ];
        let hints = detect(&facts);
        assert_eq!(hints.len(), 1);
        let h = &hints[0];
        assert_eq!(h.kind, KIND_SPLIT_FOLDER);
        assert_eq!(h.mode, "merge");
        assert_eq!(h.confidence, "high");
        assert_eq!(h.member_ids, vec![1, 2, 3, 4]);
        assert_eq!(h.album_artist.as_deref(), Some("Skrillex"));
    }

    #[test]
    fn split_compilation_suggests_various_artists() {
        let f = "Various/The Doo Wop Box II";
        let facts = vec![
            fact(1, "The Doo Wop Box II: 101 More Vocal Group Gems (1951-1955)", f, "1996", &["The Cardinals"], &[(1, 1)]),
            fact(2, "The Doo Wop Box II: 101 More Vocal Group Gems (1951-1955)", f, "1996", &["The Clovers"], &[(1, 2)]),
            fact(3, "The Doo Wop Box II: 101 More Vocal Group Gems (1951-1955)", f, "1996", &["The Counts"], &[(1, 3)]),
        ];
        let hints = detect(&facts);
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].album_artist.as_deref(), Some(VARIOUS_ARTISTS));
        assert_eq!(hints[0].mode, "merge");
    }

    #[test]
    fn one_folder_folds_bracketed_tails_into_one_hint() {
        let f = "Various/The Doo Wop Box II [Rhino Records]";
        let t = |tail: &str| format!("The Doo Wop Box II: 101 More Vocal Group Gems ({tail})");
        let facts = vec![
            fact(1, &t("1951-1955"), f, "1996", &["The Cardinals"], &[(1, 1)]),
            fact(2, &t("1951-1955"), f, "1996", &["The Clovers"], &[(1, 2)]),
            fact(3, &t("1955-1957"), f, "1996", &["The Bobbettes"], &[(2, 1)]),
            fact(4, &t("1957-1960"), f, "1996", &["The Crests"], &[(3, 1)]),
            fact(5, &t("1960-1963"), f, "1996", &["The Chimes"], &[(4, 1)]),
        ];
        let hints = detect(&facts);
        assert_eq!(hints.len(), 1, "{hints:?}");
        let h = &hints[0];
        assert_eq!(h.kind, KIND_SPLIT_FOLDER);
        assert_eq!(h.mode, "merge");
        assert_eq!(h.member_ids, vec![1, 2, 3, 4, 5]);
        assert_eq!(h.album_artist.as_deref(), Some(VARIOUS_ARTISTS));
        assert!(h.reason.contains("1951-1955"), "{}", h.reason);
    }

    #[test]
    fn one_folder_keeps_the_plain_title_with_its_bracketed_siblings() {
        let f = "Michael Jackson/Michael Jackson - Bad 25 (2012) {EICP 1541~4} [FLAC]";
        let a = &["Michael Jackson"];
        let facts = vec![
            fact(1, "Bad", "Michael Jackson/Michael Jackson - Bad (1987)", "1987", a, &slots(1, 1, 11)),
            fact(2, "Bad 25", f, "2012", a, &slots(1, 1, 11)),
            fact(3, "Bad 25 (Bonus Material)", f, "2012", a, &slots(2, 1, 14)),
            fact(4, "Bad 25 (Live Wembley July 16, 1988)", f, "2012", a, &slots(3, 1, 16)),
        ];
        let hints = detect(&facts);
        assert_eq!(hints.len(), 1, "{hints:?}");
        let h = &hints[0];
        assert_eq!(h.kind, KIND_SPLIT_FOLDER);
        assert_eq!(h.mode, "merge");
        // The three in the box folder; "Bad" waits for the next recompute.
        assert_eq!(h.member_ids, vec![2, 3, 4]);
    }

    #[test]
    fn disc_titles_merge_even_in_separate_folders() {
        let facts = vec![
            fact(1, "All Eyez On Me (CD1)", "2Pac/All Eyez On Me/CD1", "1996", &["2Pac"], &slots(1, 1, 13)),
            fact(2, "All Eyez On Me (CD2)", "2Pac/All Eyez On Me/CD2", "1996", &["2Pac"], &slots(2, 1, 14)),
        ];
        let hints = detect(&facts);
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].kind, KIND_DISCS);
        assert_eq!(hints[0].mode, "merge");
        assert_eq!(hints[0].confidence, "high");
    }

    #[test]
    fn colon_subtitles_under_one_album_folder_are_discs() {
        let p = "Billie Holiday/The Lady Sings";
        let facts = vec![
            fact(1, "The Lady Sings: God Bless the Child", &format!("{p}/Disc A"), "2001", &["Billie Holiday"], &slots(1, 1, 10)),
            fact(2, "The Lady Sings: Lover Man", &format!("{p}/Disc B"), "2001", &["Billie Holiday"], &slots(1, 1, 10)),
            fact(3, "The Lady Sings: Strange Fruit", &format!("{p}/Disc C"), "2001", &["Billie Holiday"], &slots(1, 1, 10)),
        ];
        let hints = detect(&facts);
        assert_eq!(hints.len(), 1);
        let h = &hints[0];
        assert_eq!(h.kind, KIND_DISCS);
        // Every disc numbered 1 — a merge needs renumbering, so versions.
        assert_eq!(h.mode, "versions");
    }

    #[test]
    fn box_title_cleans_a_folder_name() {
        let names = vec!["Buffalo Springfield".to_string()];
        assert_eq!(
            box_title("Buffalo Springfield - What's That Sound - Complete Albums Collection (2018) [FLAC]", &names),
            Some("What's That Sound - Complete Albums Collection".to_string())
        );
        let srv = vec!["Stevie Ray Vaughan & Double Trouble".to_string(), "The Vaughan Brothers".to_string()];
        assert_eq!(
            box_title("Stevie Ray Vaughan – Texas Hurricane Boxset {2014 APO} (FLAC) [16-44]", &srv),
            Some("Texas Hurricane Boxset".to_string())
        );
        // A title that merely begins like the artist's name keeps its head.
        assert_eq!(
            box_title("Stevie Wonder - Songs", &srv),
            Some("Stevie Wonder - Songs".to_string())
        );
        assert_eq!(
            box_title("Star Wars. The Ultimate Soundtrack Collection (Sony Classical 88875167301, 2016)", &[]),
            Some("Star Wars. The Ultimate Soundtrack Collection".to_string())
        );
        assert_eq!(box_title("(2018) [FLAC]", &[]), None);
        // A leading "The" on either side doesn't keep the artist in the title.
        let sp = vec!["The Smashing Pumpkins".to_string()];
        assert_eq!(
            box_title("Smashing Pumpkins – Mellon Collie and the Infinite Sadness [Virgin Records America]", &sp),
            Some("Mellon Collie and the Infinite Sadness".to_string())
        );
        let doors = vec!["Doors".to_string()];
        assert_eq!(box_title("The Doors - Perception (2006)", &doors), Some("Perception".to_string()));
        assert_eq!(leading_number("1 - Buffalo Springfield (Mono)"), Some(1));
        assert_eq!(leading_number("02. Episode II"), Some(2));
        assert_eq!(leading_number("1999"), None);
    }

    #[test]
    fn a_box_ripped_per_disc_is_one_set_and_the_standalone_stays_out() {
        let bx = "Buffalo Springfield/Buffalo Springfield - What's That Sound - Complete Albums Collection (2018) [FLAC]";
        let a = &["Buffalo Springfield"];
        let facts = vec![
            fact(1, "Buffalo Springfield", "Buffalo Springfield/Buffalo Springfield - Buffalo Springfield [1997 ATCO Mono-Stereo Remaster]", "1966", a, &slots(1, 1, 24)),
            fact(2, "Buffalo Springfield (Mono)", &format!("{bx}/1 - Buffalo Springfield (Mono)"), "1966", a, &slots(1, 1, 13)),
            fact(3, "Buffalo Springfield (Stereo)", &format!("{bx}/2 - Buffalo Springfield (Stereo)"), "1966", a, &slots(2, 1, 12)),
            fact(4, "Buffalo Springfield Again (Mono)", &format!("{bx}/3 - Buffalo Springfield Again (Mono)"), "1967", a, &slots(3, 1, 10)),
            fact(5, "Buffalo Springfield Again (Stereo)", &format!("{bx}/4 - Buffalo Springfield Again (Stereo)"), "1967", a, &slots(4, 1, 10)),
            fact(6, "Last Time Around (Stereo)", &format!("{bx}/5 - Last Time Around (Stereo)"), "1968", a, &slots(5, 1, 12)),
        ];
        let hints = detect(&facts);
        assert_eq!(hints.len(), 1, "{hints:?}");
        let h = &hints[0];
        assert_eq!(h.kind, KIND_DISCS);
        assert_eq!(h.mode, "merge");
        assert_eq!(h.confidence, "high");
        assert_eq!(h.member_ids, vec![2, 3, 4, 5, 6]);
        assert_eq!(h.title.as_deref(), Some("What's That Sound - Complete Albums Collection"));
    }

    #[test]
    fn numbered_folders_number_the_discs_when_the_files_dont() {
        let bx = "Stevie Ray Vaughan/Stevie Ray Vaughan – Texas Hurricane Boxset {2014 APO} (FLAC) [16-44]";
        let a = &["Stevie Ray Vaughan & Double Trouble"];
        let facts = vec![
            fact(1, "Texas Flood (2014 AP Hybrid SACD)", &format!("{bx}/1. Texas Flood (1983) [SACD]"), "1983", a, &slots(1, 1, 15)),
            fact(2, "Couldn't Stand The Weather (2014 AP Hybrid SACD)", &format!("{bx}/2. Couldn't Stand The Weather (1984) [SACD]"), "1984", a, &slots(1, 1, 13)),
            fact(3, "Soul To Soul (2014 AP Hybrid SACD)", &format!("{bx}/3. Soul To Soul (1985) [SACD]"), "1985", a, &slots(1, 1, 13)),
        ];
        let hints = detect(&facts);
        assert_eq!(hints.len(), 1, "{hints:?}");
        let h = &hints[0];
        assert_eq!(h.kind, KIND_DISCS);
        assert_eq!(h.mode, "merge", "{}", h.reason);
        assert_eq!(h.title.as_deref(), Some("Texas Hurricane Boxset"));
        // Disc 1 stays as it is; the others move.
        assert_eq!(h.disc_map.as_deref(), Some(&[(2, 2), (3, 3)][..]));
        assert!(h.reason.contains("folder order"), "{}", h.reason);
    }

    #[test]
    fn a_box_lists_the_halves_a_split_pair_also_claims() {
        let bx = "John Williams/Star Wars. The Ultimate Soundtrack Collection (Sony Classical 88875167301, 2016)";
        let a = &["John Williams"];
        let facts = vec![
            fact(1, "Star Wars - Episode I The Phantom Menace", &format!("{bx}/01. Episode I"), "1999", a, &slots(1, 1, 17)),
            fact(2, "Star Wars Episode II: Attack Of The Clones", &format!("{bx}/02. Episode II"), "2002", a, &slots(1, 1, 13)),
            fact(3, "Star Wars, Episode IV: A New Hope", &format!("{bx}/04. Episode IV"), "1977", a, &slots(1, 1, 13)),
            fact(4, "Star Wars, Episode IV - A New Hope (OMPS)", &format!("{bx}/04. Episode IV"), "1977", a, &slots(2, 1, 11)),
            fact(5, "Interviews with John Williams and Harrison Ford", &format!("{bx}/07. Bonus Disc"), "2016", a, &slots(11, 1, 5)),
        ];
        let hints = detect(&facts);
        let pair = hints.iter().find(|h| h.kind == KIND_SPLIT_FOLDER).expect("the Episode IV pair");
        assert_eq!(pair.member_ids, vec![3, 4]);
        let bx_hint = hints.iter().find(|h| h.kind == KIND_DISCS).expect("the box");
        assert_eq!(bx_hint.member_ids, vec![1, 2, 3, 4, 5]);
        // The halves share folder 04 — both would take disc 4 and collide,
        // so the box offers a merge with the folder numbers as a starting
        // point for the dialog's per-album disc fields.
        assert_eq!(bx_hint.mode, "merge");
        assert_eq!(bx_hint.confidence, "medium");
        assert!(bx_hint.reason.contains("overlap"), "{}", bx_hint.reason);
        let map = bx_hint.disc_map.as_ref().expect("folder numbers carried");
        assert!(map.contains(&(4, 4)), "{map:?}"); // side 2 (disc 2) → 4
        assert!(map.contains(&(5, 7)), "{map:?}"); // bonus (disc 11) → 7
        assert_eq!(bx_hint.title.as_deref(), Some("Star Wars. The Ultimate Soundtrack Collection"));
    }

    #[test]
    fn editions_in_the_artist_root_are_versions() {
        let facts = vec![
            fact(1, "Buffalo Springfield (Mono)", "Buffalo Springfield/Buffalo Springfield (Mono)", "1966", &["Buffalo Springfield"], &slots(1, 1, 12)),
            fact(2, "Buffalo Springfield (Stereo)", "Buffalo Springfield/Buffalo Springfield (Stereo)", "1966", &["Buffalo Springfield"], &slots(1, 1, 12)),
            fact(3, "Buffalo Springfield", "Buffalo Springfield/Buffalo Springfield", "1966", &["Buffalo Springfield"], &slots(1, 1, 12)),
        ];
        let hints = detect(&facts);
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].kind, KIND_EDITIONS);
        assert_eq!(hints[0].mode, "versions");
        assert_eq!(hints[0].member_ids, vec![1, 2, 3]);
    }

    #[test]
    fn same_title_different_years_without_tails_is_left_alone() {
        let facts = vec![
            fact(1, "So Far Gone", "Drake/So Far Gone (2009)", "2009", &["Drake"], &slots(1, 1, 17)),
            fact(2, "So Far Gone", "Drake/So Far Gone (2019)", "2019", &["Drake"], &slots(1, 1, 18)),
        ];
        assert!(detect(&facts).is_empty());
    }

    #[test]
    fn different_musicbrainz_groups_are_never_paired() {
        let mut a = fact(1, "Thriller (Deluxe)", "MJ/Thriller (Deluxe)", "1982", &["Michael Jackson"], &slots(1, 1, 9));
        let mut b = fact(2, "Thriller", "MJ/Thriller", "1982", &["Michael Jackson"], &slots(1, 1, 9));
        a.group = Some("g1".to_string());
        b.group = Some("g2".to_string());
        assert!(detect(&[a, b]).is_empty());
    }

    #[test]
    fn key_is_the_member_set() {
        let a = detect(&[
            fact(5, "X (CD1)", "a/x", "", &["A"], &slots(1, 1, 2)),
            fact(9, "X (CD2)", "a/x", "", &["A"], &slots(2, 1, 2)),
        ]);
        let b = detect(&[
            fact(9, "X (CD2)", "a/x", "", &["A"], &slots(2, 1, 2)),
            fact(5, "X (CD1)", "a/x", "", &["A"], &slots(1, 1, 2)),
        ]);
        assert_eq!(a[0].key, b[0].key);
    }
}
