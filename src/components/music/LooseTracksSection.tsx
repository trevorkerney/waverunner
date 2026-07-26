import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Music2, Pencil, ListPlus, ListStart, ListEnd } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";
import { TrackEditDialog } from "./EditDialogs";
import { AddToPlaylistDialog } from "../AddToPlaylistDialog";
import { LoveMenuItem } from "./LoveButton";
import { TrackRow } from "./TracksPage";
import { MoveToCollectionDialog } from "./MoveToCollectionDialog";
import { LibraryTrackRow, MusicQueueItem } from "../../types";
import { trackDisplayTitle } from "./musicQueue";

interface LooseTracksSectionProps {
  libraryId: string;
  onPlayQueue: (items: MusicQueueItem[], startIndex: number) => void;
  currentTrackId: number | null;
  playing: boolean;
  onEnqueue?: (items: MusicQueueItem[], mode: "next" | "last") => void;
  onPlaylistsChanged?: () => void;
  getCoverUrl: (filePath: string) => string;
  onNavigateToArtist?: (artistId: number, artistTitle: string) => void;
  /** Sounds page variant: lists the SOUND loose pool (base-root and misc-folder
   *  files) and offers "Add to collection…" instead of music-side items. */
  sounds?: boolean;
  /** A move created/changed collections — the host refreshes the grid behind. */
  onCollectionsChanged?: () => void;
}

/** Albums-page header section listing the library's loose (album-less)
 *  tracks — the files whose hidden containers never surface as album cards.
 *  Renders nothing when the library has none. Rows behave like the Tracks
 *  page: double-click plays from that row through the loose list. */
export function LooseTracksSection({
  libraryId,
  onPlayQueue,
  currentTrackId,
  playing,
  onEnqueue,
  onPlaylistsChanged,
  getCoverUrl,
  onNavigateToArtist,
  sounds = false,
  onCollectionsChanged,
}: LooseTracksSectionProps) {
  const [rows, setRows] = useState<LibraryTrackRow[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  const [playlistFor, setPlaylistFor] = useState<{ id: number; title: string } | null>(null);
  const [moveFor, setMoveFor] = useState<{ id: number; title: string } | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const menuTrackRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<LibraryTrackRow[]>("get_music_tracks", { libraryId, looseOnly: true, sounds })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => console.error("Failed to load loose tracks:", e));
    return () => {
      cancelled = true;
    };
  }, [libraryId, reloadKey, sounds]);

  // Rescans (and metadata-center applies) can promote/demote loose tracks —
  // refetch silently, same event the Tracks page listens for.
  useEffect(() => {
    const onRescanned = () => setReloadKey((k) => k + 1);
    window.addEventListener("waverunner:library-rescanned", onRescanned);
    return () => window.removeEventListener("waverunner:library-rescanned", onRescanned);
  }, []);

  const queue = useMemo<MusicQueueItem[]>(
    () =>
      (rows ?? []).map((r) => ({
        trackId: r.id,
        title: trackDisplayTitle(r.title, r.file_path),
        artistName:
          r.credits.length > 0 ? r.credits.map((c) => c.name).join(", ") : r.artist_name,
        artistId: r.credits.find((c) => c.artist_id != null)?.artist_id ?? r.artist_id,
        artists:
          r.credits.length > 0
            ? r.credits.map((c) => ({ name: c.name, artistId: c.artist_id }))
            : r.artist_name
              ? [{ name: r.artist_name, artistId: r.artist_id }]
              : [],
        albumId: r.album_id,
        albumTitle: r.album_title,
        cover: r.cover,
        path: r.file_path,
        durationSecs: r.runtime_secs,
      })),
    [rows],
  );

  const handlePlayAt = useCallback((index: number) => onPlayQueue(queue, index), [onPlayQueue, queue]);
  const handleSelect = useCallback((trackId: number) => setSelectedTrackId(trackId), []);
  const handleMenuTarget = useCallback((trackId: number) => {
    menuTrackRef.current = trackId;
    setSelectedTrackId(trackId);
  }, []);
  const handleOpenArtist = useCallback(
    (artistId: number, artistTitle: string) => onNavigateToArtist?.(artistId, artistTitle),
    [onNavigateToArtist],
  );
  const handleOpenAlbum = useCallback(() => {}, []); // loose rows have no album link

  if (!rows || rows.length === 0) return null;

  return (
    <div className="mb-5">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="mb-1 flex items-center gap-1.5 text-sm font-semibold"
      >
        <Music2 size={15} />
        Loose tracks
        <span className="font-normal text-muted-foreground">({rows.length})</span>
        <ChevronDown
          size={14}
          className={`text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>
      {!collapsed && (
        <ContextMenu>
          <ContextMenuTrigger render={<div />}>
            {rows.map((t, i) => {
              const isCurrent = currentTrackId === t.id;
              return (
                <TrackRow
                  key={t.id}
                  t={t}
                  index={i}
                  isCurrent={isCurrent}
                  isSelected={selectedTrackId === t.id}
                  playing={isCurrent ? playing : false}
                  onPlayAt={handlePlayAt}
                  onSelect={handleSelect}
                  onMenuTarget={handleMenuTarget}
                  getCoverUrl={getCoverUrl}
                  onOpenArtist={handleOpenArtist}
                  onOpenAlbum={handleOpenAlbum}
                  numWidthCh={Math.max(2, String(rows.length).length)}
                />
              );
            })}
          </ContextMenuTrigger>
          <ContextMenuContent>
            {onEnqueue && (
              <>
                <ContextMenuItem
                  onClick={() => {
                    const idx = rows.findIndex((r) => r.id === menuTrackRef.current);
                    if (idx >= 0) onEnqueue([queue[idx]], "next");
                  }}
                >
                  <ListStart size={14} />
                  Play next
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => {
                    const idx = rows.findIndex((r) => r.id === menuTrackRef.current);
                    if (idx >= 0) onEnqueue([queue[idx]], "last");
                  }}
                >
                  <ListEnd size={14} />
                  Add to queue
                </ContextMenuItem>
              </>
            )}
            {sounds && (
              <ContextMenuItem
                onClick={() => {
                  const t = rows.find((r) => r.id === menuTrackRef.current);
                  if (t) setMoveFor({ id: t.id, title: trackDisplayTitle(t.title, t.file_path) });
                }}
              >
                <ListPlus size={14} />
                Add to collection…
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => setEditTrackId(menuTrackRef.current)}>
              <Pencil size={14} />
              Edit metadata
            </ContextMenuItem>
            <LoveMenuItem
              resolve={() => {
                const t = rows.find((r) => r.id === menuTrackRef.current);
                return t ? { id: t.id, loved: t.loved } : null;
              }}
            />
            <ContextMenuItem
              onClick={() => {
                const t = rows.find((r) => r.id === menuTrackRef.current);
                if (t) setPlaylistFor({ id: t.id, title: trackDisplayTitle(t.title, t.file_path) });
              }}
            >
              <ListPlus size={14} />
              Add to playlist
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      <AddToPlaylistDialog
        open={playlistFor != null}
        onOpenChange={(o) => {
          if (!o) setPlaylistFor(null);
        }}
        libraryId={libraryId}
        entryId={playlistFor?.id ?? null}
        entryTitle={playlistFor?.title ?? null}
        onAdded={() => onPlaylistsChanged?.()}
      />
      <TrackEditDialog
        trackId={editTrackId}
        open={editTrackId !== null}
        onOpenChange={(o) => {
          if (!o) setEditTrackId(null);
        }}
        onSaved={() => setReloadKey((k) => k + 1)}
      />
      {sounds && (
        <MoveToCollectionDialog
          libraryId={libraryId}
          track={moveFor}
          open={moveFor != null}
          onOpenChange={(o) => {
            if (!o) setMoveFor(null);
          }}
          onMoved={() => {
            // The track left the loose pool (and a collection may be brand
            // new) — the host's refresh also fires the library-changed event,
            // which refetches this section.
            onCollectionsChanged?.();
          }}
        />
      )}
    </div>
  );
}
