import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Music2, Pencil } from "lucide-react";
import { Spinner } from "../ui/spinner";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";
import { TrackEditDialog, ArtistEditDialog } from "./EditDialogs";
import { MusicArtistDetail, MusicAlbumCard, MusicAlbumDetail, MusicQueueItem } from "../../types";
import { queueFromRelease, defaultRelease, trackDisplayTitle, fmtTrackTime } from "./musicQueue";

interface ArtistDetailPageProps {
  entryId: number;
  /** Grid thumbnail resolver (covers → covers_thumb), from App. */
  getCoverUrl: (filePath: string) => string;
  getFullCoverUrl: (filePath: string) => string;
  onOpenAlbum: (album: MusicAlbumCard) => void;
  onPlayQueue: (items: MusicQueueItem[], startIndex: number) => void;
  /** Metadata was edited — the host invalidates its grid caches. */
  onMetadataChanged?: () => void;
}

function displayCover(covers: string[], selected: string | null): string | null {
  if (selected && covers.includes(selected)) return selected;
  return covers[0] ?? null;
}

export function ArtistDetailPage({
  entryId,
  getCoverUrl,
  getFullCoverUrl,
  onOpenAlbum,
  onPlayQueue,
  onMetadataChanged,
}: ArtistDetailPageProps) {
  const [detail, setDetail] = useState<MusicArtistDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  const [editArtistOpen, setEditArtistOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const handleSaved = () => {
    setReloadKey((k) => k + 1);
    onMetadataChanged?.();
  };

  // Navigations clear the page (spinner); edit-triggered refetches are silent.
  const lastEntryRef = useRef(entryId);
  useEffect(() => {
    let cancelled = false;
    const navigated = lastEntryRef.current !== entryId;
    lastEntryRef.current = entryId;
    if (navigated) {
      setLoading(true);
      setDetail(null);
    }
    invoke<MusicArtistDetail>("get_artist_detail", { entryId })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => console.error("Failed to load artist:", e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, reloadKey]);

  const playAlbum = async (albumId: number) => {
    try {
      const album = await invoke<MusicAlbumDetail>("get_album_detail", { entryId: albumId });
      const release = defaultRelease(album);
      if (!release || release.tracks.length === 0) return;
      onPlayQueue(queueFromRelease(album, release), 0);
    } catch (e) {
      console.error("Failed to play album:", e);
    }
  };

  if (loading || !detail) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  const cover = displayCover(detail.covers, detail.selected_cover);

  return (
    <div className="px-6 pb-8">
      {/* Header */}
      <div className="flex items-end gap-5 py-6">
        {cover ? (
          <img
            src={getFullCoverUrl(cover)}
            alt=""
            className="h-36 w-36 shrink-0 rounded-full object-cover shadow-md"
            draggable={false}
          />
        ) : (
          <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Music2 size={48} />
          </div>
        )}
        <div className="min-w-0 pb-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Artist</p>
          <h1 className="group/title flex min-w-0 items-center gap-2 font-heading text-3xl font-bold">
            <span className="truncate">{detail.title}</span>
            <button
              onClick={() => setEditArtistOpen(true)}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100"
              title="Edit artist metadata"
            >
              <Pencil size={16} />
            </button>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[
              detail.album_count > 0
                ? `${detail.album_count} ${detail.album_count === 1 ? "album" : "albums"}`
                : null,
              detail.track_count > 0
                ? `${detail.track_count} ${detail.track_count === 1 ? "track" : "tracks"}`
                : null,
              detail.appears_on.length > 0
                ? `appears on ${detail.appears_on.length} ${detail.appears_on.length === 1 ? "album" : "albums"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {detail.biography && (
            <p className="mt-2 line-clamp-3 max-w-2xl whitespace-pre-line text-sm text-muted-foreground" title={detail.biography}>
              {detail.biography}
            </p>
          )}
        </div>
      </div>

      {/* Own albums */}
      {detail.albums.length > 0 && detail.appears_on.length > 0 && (
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Albums
        </p>
      )}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
      >
        {detail.albums.map((album) => {
          const albumCoverPath = displayCover(album.covers, album.selected_cover);
          return (
            <div key={album.id} className="group min-w-0">
              <div
                className="relative aspect-square cursor-pointer overflow-hidden rounded-md bg-muted shadow-sm"
                onClick={() => onOpenAlbum(album)}
              >
                {albumCoverPath ? (
                  <img
                    src={getCoverUrl(albumCoverPath)}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                    <Music2 size={40} />
                  </div>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    playAlbum(album.id);
                  }}
                  className="absolute bottom-2 right-2 rounded-full bg-black/60 p-2.5 text-white opacity-0 shadow transition-opacity hover:bg-black/80 group-hover:opacity-100"
                  title="Play album"
                >
                  <Play size={16} className="translate-x-px" />
                </button>
              </div>
              <button
                onClick={() => onOpenAlbum(album)}
                className="mt-1.5 block w-full truncate text-left text-sm font-medium hover:underline"
                title={album.title}
              >
                {album.title}
              </button>
              <p className="truncate text-xs text-muted-foreground">
                {[album.year, album.release_count > 1 ? `${album.release_count} versions` : null]
                  .filter(Boolean)
                  .join(" · ") || " "}
              </p>
            </div>
          );
        })}
      </div>

      {/* Loose tracks — album-less files credited to this artist. */}
      {detail.loose_tracks.length > 0 && (
        <>
          <p className={`mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground ${detail.albums.length > 0 ? "mt-6" : ""}`}>
            Tracks
          </p>
          <div className="overflow-hidden rounded-md border">
            {detail.loose_tracks.map((t, i) => {
              const queue: MusicQueueItem[] = detail.loose_tracks.map((lt) => ({
                trackId: lt.id,
                title: trackDisplayTitle(lt.title, lt.file_path),
                artistName:
                  lt.credits.length > 0
                    ? lt.credits.map((c) => c.name).join(", ")
                    : lt.artist_name ?? detail.title,
                albumId: null,
                albumTitle: null,
                cover: null,
                path: lt.file_path,
                durationSecs: lt.runtime_secs,
              }));
              return (
                <ContextMenu key={t.id}>
                  <ContextMenuTrigger
                    render={
                      <div
                        className={`group/track flex cursor-default items-center gap-3 px-3 py-1.5 text-sm hover:bg-accent/50 ${i > 0 ? "border-t" : ""}`}
                        onDoubleClick={() => onPlayQueue(queue, i)}
                      />
                    }
                  >
                  <button
                    onClick={() => onPlayQueue(queue, i)}
                    className="flex w-5 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/track:opacity-100"
                    title="Play"
                  >
                    <Play size={13} className="translate-x-px" />
                  </button>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{trackDisplayTitle(t.title, t.file_path)}</span>
                    {t.credits.length > 0 && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.credits.map((c) => c.name).join(", ")}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
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
        </>
      )}

      {/* Feature credits on other artists' albums — the whole page for
          feature-only artists. */}
      {detail.appears_on.length > 0 && (
        <>
          <p className={`mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground ${detail.albums.length > 0 || detail.loose_tracks.length > 0 ? "mt-6" : ""}`}>
            Appears On
          </p>
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
          >
            {detail.appears_on.map((album) => {
              const albumCoverPath = displayCover(album.covers, album.selected_cover);
              return (
                <div key={album.id} className="group min-w-0">
                  <div
                    className="relative aspect-square cursor-pointer overflow-hidden rounded-md bg-muted shadow-sm"
                    onClick={() => onOpenAlbum(album)}
                  >
                    {albumCoverPath ? (
                      <img
                        src={getCoverUrl(albumCoverPath)}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                        <Music2 size={40} />
                      </div>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        playAlbum(album.id);
                      }}
                      className="absolute bottom-2 right-2 rounded-full bg-black/60 p-2.5 text-white opacity-0 shadow transition-opacity hover:bg-black/80 group-hover:opacity-100"
                      title="Play album"
                    >
                      <Play size={16} className="translate-x-px" />
                    </button>
                  </div>
                  <button
                    onClick={() => onOpenAlbum(album)}
                    className="mt-1.5 block w-full truncate text-left text-sm font-medium hover:underline"
                    title={album.title}
                  >
                    {album.title}
                  </button>
                  <p className="truncate text-xs text-muted-foreground">
                    {[album.artist_title, album.year].filter(Boolean).join(", ") || " "}
                  </p>
                </div>
              );
            })}
          </div>
        </>
      )}
      <TrackEditDialog
        trackId={editTrackId}
        open={editTrackId !== null}
        onOpenChange={(o) => {
          if (!o) setEditTrackId(null);
        }}
        onSaved={handleSaved}
      />
      <ArtistEditDialog
        artistId={editArtistOpen ? entryId : null}
        open={editArtistOpen}
        onOpenChange={setEditArtistOpen}
        onSaved={handleSaved}
      />
    </div>
  );
}
