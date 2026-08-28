//! Content fingerprints for identity migration on rescan (music AND video).
//!
//! The hash covers the MEDIA REGION of a file, not the whole file, so
//! retagging never changes it: same content = same item, refiled — a new hash
//! means new media (different rip, re-encode), which genuinely is a new item.
//! Region location is pure container arithmetic (headers state their own
//! sizes); nothing is ever decoded. When a container can't be parsed cleanly
//! the WHOLE file is hashed instead — a weaker but never-wrong fallback that
//! just degrades a moved-and-retagged file to tie-breakers.
//!
//! Values are prefixed with their kind — "a:<hex>" (media region) or
//! "f:<hex>" (full file) — so two hashes only ever compare equal when they
//! measured the same thing. The hash is a reconciliation HINT, never
//! identity: presence is paths, and byte-identical duplicates are two items.
//!
//! Audio and video use different chunk sizes and are never compared to each
//! other, so the smaller video chunk costs nothing: length + 1 MiB from each
//! end already separates any two real files, and at 2.4k episodes the read
//! volume is what decides whether a rescan feels instant.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use xxhash_rust::xxh3::Xxh3;

/// Hash the first and last `CHUNK` bytes of the region (or all of it when
/// smaller) plus its length — a partial hash, so scan cost stays a few MB of
/// reads per file no matter how large the file is.
const AUDIO_CHUNK: u64 = 4 * 1024 * 1024;
/// Video files are big and there are a lot of them; 1 MiB each end keeps a
/// full-library backfill in the low gigabytes of reads instead of tens.
const VIDEO_CHUNK: u64 = 1024 * 1024;

/// Fingerprint a music file (4 MiB chunks).
pub fn hash_file(path: &Path) -> Option<String> {
    hash_with_chunk(path, AUDIO_CHUNK)
}

/// Fingerprint a video file (1 MiB chunks). Never compared against audio
/// hashes, so the differing chunk size is free.
pub fn hash_video_file(path: &Path) -> Option<String> {
    hash_with_chunk(path, VIDEO_CHUNK)
}

fn hash_with_chunk(path: &Path, chunk: u64) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len == 0 {
        return None;
    }
    match media_region(&mut f, len, path) {
        Some((start, end)) if end > start => {
            hash_region(&mut f, start, end, chunk).map(|h| format!("a:{h:016x}"))
        }
        _ => hash_region(&mut f, 0, len, chunk).map(|h| format!("f:{h:016x}")),
    }
}

/// Size + mtime of a file, for the rescan gate: unchanged pair means the
/// stored hash still describes the file and re-reading it would be waste.
pub fn file_stamp(path: &Path) -> Option<(i64, i64)> {
    let md = std::fs::metadata(path).ok()?;
    let size = md.len() as i64;
    let mtime = md
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((size, mtime))
}

fn hash_region(f: &mut File, start: u64, end: u64, chunk: u64) -> Option<u64> {
    let len = end - start;
    let mut hasher = Xxh3::new();
    hasher.update(&len.to_le_bytes());
    let mut buf = vec![0u8; chunk.min(len) as usize];
    f.seek(SeekFrom::Start(start)).ok()?;
    f.read_exact(&mut buf).ok()?;
    hasher.update(&buf);
    if len > chunk * 2 {
        f.seek(SeekFrom::Start(end - chunk)).ok()?;
        f.read_exact(&mut buf).ok()?;
        hasher.update(&buf);
    } else if len > chunk {
        // Middle files: hash the remainder too, so the whole region counts.
        let rest = (len - chunk) as usize;
        let mut tail = vec![0u8; rest];
        f.read_exact(&mut tail).ok()?;
        hasher.update(&tail);
    }
    Some(hasher.digest())
}

/// (start, end) byte offsets of the media data, per container. `None` =
/// unknown container or parse trouble → caller falls back to full-file.
/// mp4/m4a/mov/m4v all use the same box walk (the audio/video payload is
/// `mdat` either way); mkv/avi have no cheap equivalent, so they fall back.
fn media_region(f: &mut File, len: u64, path: &Path) -> Option<(u64, u64)> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    match ext.as_str() {
        "mp3" => mp3_region(f, len),
        "flac" => flac_region(f, len),
        "m4a" | "mp4" | "m4b" | "mov" | "m4v" => mp4_region(f, len),
        _ => None,
    }
}

/// MP3: skip a leading ID3v2 block (10-byte header, syncsafe size, optional
/// footer); stop before a trailing ID3v1 ("TAG", 128 bytes) and/or APEv2
/// footer (32 bytes stating the tag's full size).
fn mp3_region(f: &mut File, len: u64) -> Option<(u64, u64)> {
    let mut start = 0u64;
    let mut head = [0u8; 10];
    f.seek(SeekFrom::Start(0)).ok()?;
    f.read_exact(&mut head).ok()?;
    if &head[0..3] == b"ID3" {
        let size = syncsafe(&head[6..10]);
        let footer = if head[5] & 0x10 != 0 { 10 } else { 0 };
        start = 10 + size + footer;
    }
    let mut end = len;
    // ID3v1 at the very end.
    if end >= 128 {
        let mut tag = [0u8; 3];
        f.seek(SeekFrom::Start(end - 128)).ok()?;
        f.read_exact(&mut tag).ok()?;
        if &tag == b"TAG" {
            end -= 128;
        }
    }
    // APEv2 footer just before that.
    if end >= 32 {
        let mut ape = [0u8; 32];
        f.seek(SeekFrom::Start(end - 32)).ok()?;
        f.read_exact(&mut ape).ok()?;
        if &ape[0..8] == b"APETAGEX" {
            let tag_size = u32::from_le_bytes(ape[12..16].try_into().ok()?) as u64;
            let has_header = ape[23] & 0x80 != 0;
            let total = tag_size + if has_header { 32 } else { 0 };
            end = end.saturating_sub(total);
        }
    }
    (start < end && end <= len).then_some((start, end))
}

fn syncsafe(b: &[u8]) -> u64 {
    ((b[0] as u64 & 0x7f) << 21)
        | ((b[1] as u64 & 0x7f) << 14)
        | ((b[2] as u64 & 0x7f) << 7)
        | (b[3] as u64 & 0x7f)
}

/// FLAC: "fLaC" magic, then metadata blocks (1-byte type with last-block
/// flag + 24-bit big-endian length) — audio frames start after the last one.
fn flac_region(f: &mut File, len: u64) -> Option<(u64, u64)> {
    let mut magic = [0u8; 4];
    f.seek(SeekFrom::Start(0)).ok()?;
    f.read_exact(&mut magic).ok()?;
    // An ID3v2 block before fLaC exists in the wild — skip it first.
    let mut pos = 4u64;
    if &magic[0..3] == b"ID3" {
        let mut head = [0u8; 10];
        f.seek(SeekFrom::Start(0)).ok()?;
        f.read_exact(&mut head).ok()?;
        pos = 10 + syncsafe(&head[6..10]);
        f.seek(SeekFrom::Start(pos)).ok()?;
        f.read_exact(&mut magic).ok()?;
        pos += 4;
    }
    if &magic != b"fLaC" {
        return None;
    }
    loop {
        let mut head = [0u8; 4];
        f.seek(SeekFrom::Start(pos)).ok()?;
        f.read_exact(&mut head).ok()?;
        let last = head[0] & 0x80 != 0;
        let size = u32::from_be_bytes([0, head[1], head[2], head[3]]) as u64;
        pos += 4 + size;
        if pos >= len {
            return None;
        }
        if last {
            return Some((pos, len));
        }
    }
}

/// MP4/M4A: top-level boxes are self-describing (32-bit size + fourcc, size
/// 1 = 64-bit largesize follows). The audio is the `mdat` box's payload.
fn mp4_region(f: &mut File, len: u64) -> Option<(u64, u64)> {
    let mut pos = 0u64;
    while pos + 8 <= len {
        let mut head = [0u8; 8];
        f.seek(SeekFrom::Start(pos)).ok()?;
        f.read_exact(&mut head).ok()?;
        let size32 = u32::from_be_bytes(head[0..4].try_into().ok()?) as u64;
        let kind = &head[4..8];
        let (body_start, box_size) = if size32 == 1 {
            let mut big = [0u8; 8];
            f.read_exact(&mut big).ok()?;
            (pos + 16, u64::from_be_bytes(big))
        } else if size32 == 0 {
            // "To end of file."
            (pos + 8, len - pos)
        } else {
            (pos + 8, size32)
        };
        if box_size < 8 || pos + box_size > len {
            return None;
        }
        if kind == b"mdat" {
            return Some((body_start, pos + box_size));
        }
        pos += box_size;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(bytes: &[u8], name: &str, ext: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "wr_hash_test_{}_{name}.{ext}",
            std::process::id()
        ));
        File::create(&p).unwrap().write_all(bytes).unwrap();
        p
    }

    #[test]
    fn mp3_hash_survives_id3_retag() {
        // Fake "audio": arbitrary bytes. Build two files with different ID3v2
        // payloads around the same audio — the hashes must agree.
        let audio = vec![0xFFu8; 5000];
        let id3 = |tag_body: &[u8]| {
            let mut v = Vec::new();
            v.extend_from_slice(b"ID3");
            v.extend_from_slice(&[3, 0, 0]);
            let s = tag_body.len() as u64;
            v.extend_from_slice(&[
                ((s >> 21) & 0x7f) as u8,
                ((s >> 14) & 0x7f) as u8,
                ((s >> 7) & 0x7f) as u8,
                (s & 0x7f) as u8,
            ]);
            v.extend_from_slice(tag_body);
            v
        };
        let mut a = id3(&vec![1u8; 300]);
        a.extend_from_slice(&audio);
        let mut b = id3(&vec![2u8; 900]);
        b.extend_from_slice(&audio);
        // b also gets an ID3v1 trailer.
        let mut v1 = vec![0u8; 128];
        v1[0..3].copy_from_slice(b"TAG");
        b.extend_from_slice(&v1);
        let (pa, pb) = (tmp(&a, "m1", "mp3"), tmp(&b, "m2", "mp3"));
        let (ha, hb) = (hash_file(&pa).unwrap(), hash_file(&pb).unwrap());
        std::fs::remove_file(&pa).ok();
        std::fs::remove_file(&pb).ok();
        assert!(ha.starts_with("a:"), "expected audio-region hash, got {ha}");
        assert_eq!(ha, hb, "retagging must not change the audio hash");
    }

    #[test]
    fn different_audio_differs_and_unknown_ext_falls_back() {
        let a = tmp(&vec![7u8; 4000], "x1", "xyz");
        let b = tmp(&vec![8u8; 4000], "x2", "xyz");
        let (ha, hb) = (hash_file(&a).unwrap(), hash_file(&b).unwrap());
        std::fs::remove_file(&a).ok();
        std::fs::remove_file(&b).ok();
        assert!(ha.starts_with("f:"), "unknown container → full-file hash");
        assert_ne!(ha, hb);
    }

    #[test]
    fn flac_region_walks_metadata_blocks() {
        // fLaC + one non-last block (10 bytes) + one last block (4 bytes),
        // then "audio".
        let mut v = Vec::new();
        v.extend_from_slice(b"fLaC");
        v.extend_from_slice(&[0x00, 0, 0, 10]);
        v.extend_from_slice(&[0u8; 10]);
        v.extend_from_slice(&[0x84, 0, 0, 4]);
        v.extend_from_slice(&[0u8; 4]);
        let audio = vec![9u8; 2000];
        v.extend_from_slice(&audio);
        let base = v.clone();
        // Same audio, fatter metadata block.
        let mut v2 = Vec::new();
        v2.extend_from_slice(b"fLaC");
        v2.extend_from_slice(&[0x00, 0, 0, 50]);
        v2.extend_from_slice(&[3u8; 50]);
        v2.extend_from_slice(&[0x84, 0, 0, 4]);
        v2.extend_from_slice(&[0u8; 4]);
        v2.extend_from_slice(&audio);
        let (pa, pb) = (tmp(&base, "f1", "flac"), tmp(&v2, "f2", "flac"));
        let (ha, hb) = (hash_file(&pa).unwrap(), hash_file(&pb).unwrap());
        std::fs::remove_file(&pa).ok();
        std::fs::remove_file(&pb).ok();
        assert!(ha.starts_with("a:"));
        assert_eq!(ha, hb);
    }
}
