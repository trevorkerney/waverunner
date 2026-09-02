import { MusicAlbumDetail, MusicRelease, MusicQueueItem } from "../../types";

/** Cover used for queue items / the now-playing bar (full-res convention). */
export function albumCover(detail: MusicAlbumDetail): string | null {
  if (detail.selected_cover && detail.covers.includes(detail.selected_cover)) {
    return detail.selected_cover;
  }
  return detail.covers[0] ?? null;
}

/** STRICTLY a release's own art: its pick, else the first cover attributed
 *  to its folders, else nothing — releases don't pool, so an artless release
 *  shows the placeholder. The album-level cover only stands in while no
 *  release is resolved yet (loading). */
export function releaseCover(detail: MusicAlbumDetail, release: MusicRelease | null): string | null {
  if (release) {
    if (release.selected_cover && release.covers.includes(release.selected_cover)) {
      return release.selected_cover;
    }
    return release.covers[0] ?? null;
  }
  return albumCover(detail);
}

/** Build the play queue for one release of an album, in track order. */
export function queueFromRelease(detail: MusicAlbumDetail, release: MusicRelease): MusicQueueItem[] {
  const cover = releaseCover(detail, release);
  return release.tracks.map((t) => ({
    trackId: t.id,
    title: trackDisplayTitle(t.title, t.file_path),
    artistName:
      t.credits.length > 0
        ? t.credits.map((c) => c.name).join(", ")
        : t.artist_name ?? detail.artist_title,
    artistId: t.credits.find((c) => c.artist_id != null)?.artist_id ?? detail.artist_id,
    artists:
      t.credits.length > 0
        ? t.credits.map((c) => ({ name: c.name, artistId: c.artist_id }))
        : (t.artist_name ?? detail.artist_title)
          ? [{ name: (t.artist_name ?? detail.artist_title)!, artistId: detail.artist_id }]
          : [],
    albumId: detail.id,
    albumTitle: detail.title,
    cover,
    path: t.file_path,
    durationSecs: t.runtime_secs,
  }));
}

export function defaultRelease(detail: MusicAlbumDetail): MusicRelease | null {
  return detail.releases.find((r) => r.is_default) ?? detail.releases[0] ?? null;
}

/** Display titles drop "(feat. …)" / "[ft. …]" parentheticals — the credit
 *  line carries the features, so the suffix is redundant. Tags are untouched;
 *  this is presentation only. */
export function cleanTrackTitle(title: string): string {
  return title
    .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim() || title;
}

/** Untitled tracks show their file name — a display-only label (filenames are
 *  never parsed into metadata). */
export function trackDisplayTitle(title: string, filePath: string): string {
  if (title.trim()) return cleanTrackTitle(title);
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "Untitled";
}

export function fmtTrackTime(secs: number | null): string {
  if (secs == null || secs <= 0) return "–:––";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  // Hour-long tracks (10-hour rain recordings) read as 10:00:30, not 600:30.
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtAlbumRuntime(secs: number): string {
  if (secs <= 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h > 0 ? `${h} hr ${m} min` : `${m} min`;
}

/** "3 min ago"-style timestamps for history surfaces. SQLite writes UTC
 *  without a zone marker, so one is appended before parsing. */
export function fmtRelative(timestamp: string): string {
  const then = Date.parse(timestamp.replace(" ", "T") + "Z");
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString();
}
