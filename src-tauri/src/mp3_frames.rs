//! MP3 frame sampling — is a file CBR or VBR? Every MPEG audio frame header
//! declares its own bitrate, so the answer is read off the file rather than
//! guessed: frames sampled from several points that all agree = CBR; any
//! disagreement = VBR. Lofty computes the average bitrate but doesn't expose
//! the frame-level picture, hence this small reader. Cost: six 32 KB reads
//! spread across the file — and the rescan stamp gate reuses the stored
//! answer for unchanged files, so it's paid once per file.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

// Bitrate tables (kbps) by MPEG version × layer; index 0 = free format and
// index 15 = reserved, both treated as invalid.
const BITRATES_V1_L1: [u32; 16] = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
const BITRATES_V1_L2: [u32; 16] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const BITRATES_V1_L3: [u32; 16] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L1: [u32; 16] = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
const BITRATES_V2_L23: [u32; 16] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES_V1: [u32; 4] = [44100, 48000, 32000, 0];
const SAMPLE_RATES_V2: [u32; 4] = [22050, 24000, 16000, 0];
const SAMPLE_RATES_V25: [u32; 4] = [11025, 12000, 8000, 0];

struct Frame {
    bitrate_kbps: u32,
    /// Whole frame length in bytes, header included — where the next one starts.
    len: usize,
}

/// Decode one 4-byte frame header. None = not a valid header at this offset.
fn parse_header(b: &[u8]) -> Option<Frame> {
    if b.len() < 4 || b[0] != 0xFF || (b[1] & 0xE0) != 0xE0 {
        return None;
    }
    let version = (b[1] >> 3) & 0x03; // 0 = MPEG 2.5, 1 = reserved, 2 = MPEG 2, 3 = MPEG 1
    let layer = (b[1] >> 1) & 0x03; // 1 = Layer III, 2 = Layer II, 3 = Layer I, 0 = reserved
    if version == 1 || layer == 0 {
        return None;
    }
    let br_idx = (b[2] >> 4) as usize;
    let sr_idx = ((b[2] >> 2) & 0x03) as usize;
    if br_idx == 0 || br_idx == 15 || sr_idx == 3 {
        return None;
    }
    let padding = ((b[2] >> 1) & 0x01) as usize;
    let v1 = version == 3;
    let bitrate = match (v1, layer) {
        (true, 3) => BITRATES_V1_L1[br_idx],
        (true, 2) => BITRATES_V1_L2[br_idx],
        (true, _) => BITRATES_V1_L3[br_idx],
        (false, 3) => BITRATES_V2_L1[br_idx],
        (false, _) => BITRATES_V2_L23[br_idx],
    };
    let sample_rate = match version {
        3 => SAMPLE_RATES_V1[sr_idx],
        2 => SAMPLE_RATES_V2[sr_idx],
        _ => SAMPLE_RATES_V25[sr_idx],
    };
    if bitrate == 0 || sample_rate == 0 {
        return None;
    }
    let bps = bitrate * 1000;
    let len = match layer {
        3 => ((12 * bps / sample_rate) as usize + padding) * 4,
        2 => (144 * bps / sample_rate) as usize + padding,
        _ if v1 => (144 * bps / sample_rate) as usize + padding,
        _ => (72 * bps / sample_rate) as usize + padding,
    };
    if len < 24 {
        return None;
    }
    Some(Frame { bitrate_kbps: bitrate, len })
}

/// Bitrates of consecutive frames found in `buf`, at most `max_frames`.
/// Resyncs first: a candidate header only counts when the header at the
/// offset it predicts is valid too — a lone sync pattern inside tag data or
/// album art is common, a chained pair is not.
fn frames_in(buf: &[u8], max_frames: usize) -> Vec<u32> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 <= buf.len() {
        if let Some(f) = parse_header(&buf[i..]) {
            let next = i + f.len;
            if next + 4 <= buf.len() && parse_header(&buf[next..]).is_some() {
                break;
            }
        }
        i += 1;
    }
    while i + 4 <= buf.len() && out.len() < max_frames {
        match parse_header(&buf[i..]) {
            Some(f) => {
                out.push(f.bitrate_kbps);
                i += f.len;
            }
            // Lost sync mid-walk: stop rather than resync into garbage.
            None => break,
        }
    }
    out
}

/// "cbr" or "vbr", read from the frames; None when too little of the file
/// parsed as MPEG audio to say either.
pub fn bitrate_mode(path: &Path) -> Option<&'static str> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    // Skip a leading ID3v2 tag (synchsafe size, optional footer) so the
    // first sample doesn't burn its budget on cover art.
    let mut head = [0u8; 10];
    let mut start = 0u64;
    if file.read_exact(&mut head).is_ok() && &head[0..3] == b"ID3" {
        let size = head[6..10]
            .iter()
            .fold(0u64, |acc, b| (acc << 7) | (u64::from(*b) & 0x7F));
        start = 10 + size + if head[5] & 0x10 != 0 { 10 } else { 0 };
    }
    if len <= start {
        return None;
    }
    const CHUNK: u64 = 32 * 1024;
    const POSITIONS: u64 = 6;
    let span = len - start;
    let mut seen: Vec<u32> = Vec::new();
    let mut sampled = 0usize;
    for k in 0..POSITIONS {
        let off = start + span * k / POSITIONS;
        if file.seek(SeekFrom::Start(off)).is_err() {
            break;
        }
        let mut buf = Vec::with_capacity(CHUNK as usize);
        if (&mut file).take(CHUNK).read_to_end(&mut buf).is_err() {
            break;
        }
        for br in frames_in(&buf, 200) {
            sampled += 1;
            if !seen.contains(&br) {
                seen.push(br);
            }
            if seen.len() > 1 {
                return Some("vbr");
            }
        }
    }
    // A handful of agreeing frames could be a silent VBR stretch; a few
    // dozen across six positions is a constant stream.
    if sampled >= 40 {
        Some("cbr")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// MPEG 1 Layer III, 44.1 kHz, no padding, at the given bitrate index.
    fn frame(br_idx: u8) -> Vec<u8> {
        let header = [0xFF, 0xFB, br_idx << 4, 0x00];
        let len = parse_header(&header).expect("valid header").len;
        let mut f = vec![0u8; len];
        f[..4].copy_from_slice(&header);
        f
    }

    #[test]
    fn constant_frames_read_as_one_bitrate() {
        let buf: Vec<u8> = (0..8).flat_map(|_| frame(14)).collect(); // 320 kbps
        let brs = frames_in(&buf, 100);
        assert_eq!(brs.len(), 8);
        assert!(brs.iter().all(|b| *b == 320));
    }

    #[test]
    fn mixed_frames_read_as_several_bitrates_and_junk_is_skipped() {
        let mut buf = vec![0xFF, 0xFB, 0x11, 0x22, 0x00, 0xFF]; // stray sync-ish junk
        buf.extend(frame(9)); // 128
        buf.extend(frame(14)); // 320
        buf.extend(frame(11)); // 192
        let brs = frames_in(&buf, 100);
        assert_eq!(brs, vec![128, 320, 192]);
    }
}
