import { MusicAlbumDetail, MusicRelease, MusicQueueItem } from "../../types";

/** Cover used for queue items / the now-playing bar (full-res convention). */
export function albumCover(detail: MusicAlbumDetail): string | null {
  if (detail.selected_cover && detail.covers.includes(detail.selected_cover)) {
    return detail.selected_cover;
  }
  return detail.covers[0] ?? null;
}

/** Build the play queue for one release of an album, in track order. */
export function queueFromRelease(detail: MusicAlbumDetail, release: MusicRelease): MusicQueueItem[] {
  const cover = albumCover(detail);
  return release.tracks.map((t) => ({
    trackId: t.id,
    title: trackDisplayTitle(t.title, t.file_path),
    artistName:
      t.credits.length > 0
        ? t.credits.map((c) => c.name).join(", ")
        : t.artist_name ?? detail.artist_title,
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
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtAlbumRuntime(secs: number): string {
  if (secs <= 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h > 0 ? `${h} hr ${m} min` : `${m} min`;
}
