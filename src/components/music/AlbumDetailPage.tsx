import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Music2, Disc3, Pencil } from "lucide-react";
import { Spinner } from "../ui/spinner";
import { MusicAlbumDetail, MusicRelease, MusicQueueItem, MusicTrack } from "../../types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";
import { TrackEditDialog, AlbumEditDialog } from "./EditDialogs";
import { albumCover, queueFromRelease, defaultRelease, fmtTrackTime, fmtAlbumRuntime, trackDisplayTitle } from "./musicQueue";

interface AlbumDetailPageProps {
  entryId: number;
  getFullCoverUrl: (filePath: string) => string;
  onNavigateToArtist: (artistId: number, artistTitle: string) => void;
  onPlayQueue: (items: MusicQueueItem[], startIndex: number) => void;
  /** Track id currently in the now-playing bar, for row highlighting. */
  currentTrackId: number | null;
  /** Metadata was edited — the host invalidates its grid caches. */
  onMetadataChanged?: () => void;
}

function releaseLabel(r: MusicRelease): string {
  const label = r.label ?? "Original";
  return r.year ? `${label} (${r.year})` : label;
}

export function AlbumDetailPage({
  entryId,
  getFullCoverUrl,
  onNavigateToArtist,
  onPlayQueue,
  currentTrackId,
  onMetadataChanged,
}: AlbumDetailPageProps) {
  const [detail, setDetail] = useState<MusicAlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [releaseId, setReleaseId] = useState<number | null>(null);
  // Single click selects a row; double click (or the hover play button) plays.
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  const [editAlbumOpen, setEditAlbumOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Navigations clear the page (spinner); edit-triggered refetches are silent
  // and keep the selected release when it still exists.
  const lastEntryRef = useRef(entryId);
  useEffect(() => {
    let cancelled = false;
    const navigated = lastEntryRef.current !== entryId;
    lastEntryRef.current = entryId;
    if (navigated) {
      setLoading(true);
      setDetail(null);
      setReleaseId(null);
      setSelectedTrackId(null);
    }
    invoke<MusicAlbumDetail>("get_album_detail", { entryId })
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setReleaseId((prev) =>
          !navigated && prev != null && d.releases.some((r) => r.id === prev)
            ? prev
            : defaultRelease(d)?.id ?? null,
        );
      })
      .catch((e) => console.error("Failed to load album:", e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, reloadKey]);

  const handleSaved = () => {
    setReloadKey((k) => k + 1);
    onMetadataChanged?.();
  };

  const release = useMemo(
    () => detail?.releases.find((r) => r.id === releaseId) ?? null,
    [detail, releaseId]
  );

  const discs = useMemo(() => {
    if (!release) return [];
    const byDisc = new Map<number, MusicTrack[]>();
    for (const t of release.tracks) {
      const d = t.disc_number ?? 1;
      if (!byDisc.has(d)) byDisc.set(d, []);
      byDisc.get(d)!.push(t);
    }
    return [...byDisc.entries()].sort((a, b) => a[0] - b[0]);
  }, [release]);

  if (loading || !detail) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  const cover = albumCover(detail);
  const totalSecs = release?.tracks.reduce((acc, t) => acc + (t.runtime_secs ?? 0), 0) ?? 0;
  const playFrom = (index: number) => {
    if (!release) return;
    onPlayQueue(queueFromRelease(detail, release), index);
  };

  return (
    <div className="px-6 pb-8">
      {/* Header */}
      <div className="flex items-end gap-5 py-6">
        {cover ? (
          <img
            src={getFullCoverUrl(cover)}
            alt=""
            className="h-48 w-48 shrink-0 rounded-md object-cover shadow-md"
            draggable={false}
          />
        ) : (
          <div className="flex h-48 w-48 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Music2 size={56} />
          </div>
        )}
        <div className="min-w-0 pb-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Album</p>
          <h1 className="group/title flex min-w-0 items-center gap-2 font-heading text-3xl font-bold">
            <span className="truncate">{detail.title}</span>
            <button
              onClick={() => setEditAlbumOpen(true)}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100"
              title="Edit album metadata"
            >
              <Pencil size={16} />
            </button>
          </h1>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {detail.artist_id != null && detail.artist_title != null && (
              <button
                className="font-medium text-foreground hover:underline"
                onClick={() => onNavigateToArtist(detail.artist_id!, detail.artist_title!)}
              >
                {detail.artist_title}
              </button>
            )}
            {(() => {
              const parts = [
                detail.year,
                release ? `${release.tracks.length} tracks` : null,
                fmtAlbumRuntime(totalSecs) || null,
              ].filter(Boolean);
              // No leading separator on artist-less albums.
              return detail.artist_id != null && detail.artist_title != null
                ? parts.map((part) => ` · ${part}`).join("")
                : parts.join(" · ");
            })()}
          </p>
          {detail.genres.length > 0 && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail.genres.join(", ")}</p>
          )}
          <div className="mt-3 flex items-center gap-2.5">
            <button
              onClick={() => playFrom(0)}
              disabled={!release || release.tracks.length === 0}
              className="flex items-center gap-2 rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
            >
              <Play size={15} className="translate-x-px" />
              Play
            </button>
            {detail.releases.length > 1 && release && (
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <Disc3 size={13} />
                  {releaseLabel(release)}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {detail.releases.map((r) => (
                    <DropdownMenuItem key={r.id} onClick={() => setReleaseId(r.id)}>
                      {releaseLabel(r)}
                      {r.is_default && (
                        <span className="ml-auto pl-3 text-xs text-muted-foreground">default</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>

      {/* Track list */}
      {discs.map(([discNo, tracks]) => (
        <div key={discNo} className="mb-4">
          {(release?.disc_count ?? 1) > 1 && (
            <p className="mb-1 flex items-center gap-1.5 px-2 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Disc3 size={13} /> Disc {discNo}
            </p>
          )}
          <div>
            {tracks.map((t) => {
              const queueIndex = release!.tracks.indexOf(t);
              const isCurrent = currentTrackId === t.id;
              const isSelected = selectedTrackId === t.id;
              // Every row names its artist — even when it's the album artist.
              const trackArtist = t.artist_name ?? detail.artist_title;
              return (
                <ContextMenu key={t.id}>
                  <ContextMenuTrigger
                    render={
                      <button
                        onClick={() => setSelectedTrackId(t.id)}
                        onDoubleClick={() => playFrom(queueIndex)}
                        className={`group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left ${
                          isSelected ? "bg-accent" : "hover:bg-accent/50"
                        }`}
                      />
                    }
                  >
                  <span className="relative w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
                    <span className="group-hover:invisible">{t.track_number ?? "–"}</span>
                    {/* The hover play button still plays on a single click. */}
                    <Play
                      size={13}
                      onClick={(e) => {
                        e.stopPropagation();
                        playFrom(queueIndex);
                      }}
                      className="invisible absolute right-0 top-1/2 -translate-y-1/2 group-hover:visible"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${isCurrent ? "font-semibold" : ""}`}>
                      {trackDisplayTitle(t.title, t.file_path)}
                    </span>
                    {/* Full credit list, comma-separated, no "feat." framing —
                        names the library knows as artists link to their pages. */}
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.credits.length > 0
                        ? t.credits.map((c, i) => (
                            <span key={`${c.name}-${i}`}>
                              {i > 0 && ", "}
                              {c.artist_id != null ? (
                                <span
                                  role="link"
                                  className="cursor-pointer hover:underline"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onNavigateToArtist(c.artist_id!, c.name);
                                  }}
                                  onDoubleClick={(e) => e.stopPropagation()}
                                >
                                  {c.name}
                                </span>
                              ) : (
                                c.name
                              )}
                            </span>
                          ))
                        : trackArtist}
                    </span>
                  </span>
                  {t.play_count > 0 && (
                    <span className="shrink-0 text-[10px] text-muted-foreground" title="Play count">
                      {t.play_count}×
                    </span>
                  )}
                  <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">
                    {fmtTrackTime(t.runtime_secs)}
                  </span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => setEditTrackId(t.id)}>
                      <Pencil size={14} />
                      Edit metadata
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </div>
      ))}
      <TrackEditDialog
        trackId={editTrackId}
        open={editTrackId !== null}
        onOpenChange={(o) => {
          if (!o) setEditTrackId(null);
        }}
        onSaved={handleSaved}
      />
      <AlbumEditDialog
        albumId={editAlbumOpen ? entryId : null}
        open={editAlbumOpen}
        onOpenChange={setEditAlbumOpen}
        onSaved={handleSaved}
      />
    </div>
  );
}
