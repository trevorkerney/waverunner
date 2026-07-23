import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSortable } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Play, Folder, Pencil, ListPlus, ListX, Music2, ListStart, ListEnd } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";
import { TrackEditDialog } from "./EditDialogs";
import { PlayingIndicator } from "./PlayingIndicator";
import { LoveButton, LoveMenuItem } from "./LoveButton";
import { MediaEntry, MusicQueueItem, TrackQueueInfo } from "../../types";
import { fmtTrackTime, trackDisplayTitle } from "./musicQueue";
import { useDeselectOnBackgroundClick } from "./useTrackSelection";

// Must mirror MainContent's sortableIdFor so the shared DndContext machinery
// (reorder, drop-into-collection, move-up zone) works on rows unchanged.
// Duplicated (not imported) to avoid a MainContent ↔ this-file module cycle.
function sortableIdFor(entry: MediaEntry): string | number {
  if (entry.link_id != null) return `link-${entry.link_id}`;
  if (entry.entry_type === "playlist_collection") return `pc-${entry.id}`;
  return entry.id;
}

interface PlaylistTrackListProps {
  entries: MediaEntry[];
  getCoverUrl: (filePath: string) => string;
  onPlayQueue: (items: MusicQueueItem[], startIndex: number) => void;
  currentTrackId: number | null;
  playing?: boolean;
  /** Collection rows navigate into the collection. */
  onNavigate: (entry: MediaEntry) => void;
  onRemoveLink: (linkId: number) => void;
  onAddToPlaylist?: (track: { id: number; title: string }) => void;
  /** "Play next" / "Add to queue" context items. */
  onEnqueue?: (items: MusicQueueItem[], mode: "next" | "last") => void;
  onMetadataChanged?: () => void;
  onRenameCollection?: (entry: MediaEntry) => void;
  onDeleteCollection?: (entry: MediaEntry) => void;
}

function displayCover(covers: string[], selected: string | null): string | null {
  if (selected && covers.includes(selected)) return selected;
  return covers[0] ?? null;
}

/** One sortable row. Collection rows double as drop targets ("pc-drop-N",
 *  same id scheme as their grid cards) so tracks can be dragged into them. */
function Row({
  entry,
  selected,
  children,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  entry: MediaEntry;
  selected?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableIdFor(entry),
  });
  const isCollection = entry.entry_type === "playlist_collection";
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `pc-drop-${entry.id}`,
    disabled: !isCollection || isDragging,
  });
  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        if (isCollection) setDropRef(node);
      }}
      {...attributes}
      {...listeners}
      data-track-row
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group/track flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 text-sm ${
        selected ? "bg-accent" : "hover:bg-accent/50"
      } ${isDragging ? "opacity-40" : ""} ${isOver ? "bg-accent ring-1 ring-inset ring-primary" : ""}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  );
}

/** Music playlist contents as a flat track list (the cover grid reads as a
 *  wall of identical album art). Rows keep everything the grid had: drag
 *  reorder under Custom sort, drag-into-collection, the shared context menu
 *  actions, and play-from-row through the whole (current view's) list. */
export function PlaylistTrackList({
  entries,
  getCoverUrl,
  onPlayQueue,
  currentTrackId,
  playing,
  onNavigate,
  onRemoveLink,
  onAddToPlaylist,
  onEnqueue,
  onMetadataChanged,
  onRenameCollection,
  onDeleteCollection,
}: PlaylistTrackListProps) {
  // Row facts the hydrated entries lack (artists, album, duration, loved,
  // file paths for playback) — one batch fetch per view.
  const [infos, setInfos] = useState<Map<number, TrackQueueInfo> | null>(null);
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  // State (not a ref): the menu's items branch on the row's entry type.
  const [menuEntry, setMenuEntry] = useState<MediaEntry | null>(null);
  // Selection keyed by sortable id (a track linked twice = two selectable rows).
  const [selectedRowId, setSelectedRowId] = useState<string | number | null>(null);
  useDeselectOnBackgroundClick(useCallback(() => setSelectedRowId(null), []));

  const trackEntries = useMemo(() => entries.filter((e) => e.entry_type === "track"), [entries]);

  useEffect(() => {
    let cancelled = false;
    const ids = trackEntries.map((e) => e.id);
    if (ids.length === 0) {
      setInfos(new Map());
      return;
    }
    invoke<TrackQueueInfo[]>("get_track_queue_items", { trackIds: ids })
      .then((rows) => {
        if (!cancelled) setInfos(new Map(rows.map((r) => [r.track_id, r])));
      })
      .catch((e) => console.error("Failed to load playlist track info:", e));
    return () => {
      cancelled = true;
    };
  }, [trackEntries]);

  /** Row entry → playable queue item (null while infos load / track vanished). */
  const itemFor = (e: MediaEntry): MusicQueueItem | null => {
    const info = infos?.get(e.id);
    if (!info) return null;
    return {
      trackId: info.track_id,
      title: trackDisplayTitle(info.title, info.file_path),
      artistName: info.artist_name,
      artistId: info.artist_id,
      artists: info.artists.map((c) => ({ name: c.name, artistId: c.artist_id })),
      albumId: info.album_id,
      albumTitle: info.album_title,
      cover: displayCover(e.covers, e.selected_cover),
      path: info.file_path,
      durationSecs: info.duration_secs,
    };
  };

  // Queue every track in view order, starting from the clicked row.
  // Duplicate links queue twice; rows whose backing track vanished are skipped.
  const playFrom = (clicked: MediaEntry) => {
    if (!infos) return;
    const clickedIdx = trackEntries.indexOf(clicked);
    if (clickedIdx < 0) return;
    const items: MusicQueueItem[] = [];
    let startIndex = 0;
    trackEntries.forEach((e, i) => {
      const item = itemFor(e);
      if (!item) return;
      if (i === clickedIdx) startIndex = items.length;
      items.push(item);
    });
    if (items.length > 0) onPlayQueue(items, startIndex);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>
        {entries.map((e) => {
          if (e.entry_type === "playlist_collection") {
            const cover = displayCover(e.covers, e.selected_cover);
            return (
              <Row
                key={sortableIdFor(e)}
                entry={e}
                onClick={() => onNavigate(e)}
                onContextMenu={() => setMenuEntry(e)}
              >
                <span className="w-5 shrink-0" />
                <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-muted">
                  {cover ? (
                    <img src={getCoverUrl(cover)} alt="" className="size-full object-cover" draggable={false} />
                  ) : (
                    <Folder size={15} className="text-muted-foreground" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{e.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Collection · {e.child_count} {e.child_count === 1 ? "item" : "items"}
                  </span>
                </span>
              </Row>
            );
          }
          const info = infos?.get(e.id);
          const isCurrent = currentTrackId === e.id;
          const cover = displayCover(e.covers, e.selected_cover);
          const artists =
            info && info.artists.length > 0
              ? info.artists.map((c) => c.name).join(", ")
              : info?.artist_name ?? e.collection_display ?? "";
          return (
            <Row
              key={sortableIdFor(e)}
              entry={e}
              selected={selectedRowId === sortableIdFor(e)}
              onClick={() => setSelectedRowId(sortableIdFor(e))}
              onDoubleClick={() => playFrom(e)}
              onContextMenu={() => {
                setSelectedRowId(sortableIdFor(e));
                setMenuEntry(e);
              }}
            >
              <button
                onClick={(ev) => {
                  ev.stopPropagation();
                  playFrom(e);
                }}
                className={`flex w-5 shrink-0 items-center justify-center text-muted-foreground transition-opacity ${
                  isCurrent ? "opacity-100" : "opacity-0 group-hover/track:opacity-100"
                }`}
                title="Play"
              >
                <Play size={13} className="translate-x-px" />
              </button>
              <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-muted">
                {cover ? (
                  <img src={getCoverUrl(cover)} alt="" className="size-full object-cover" draggable={false} />
                ) : (
                  <Music2 size={15} className="text-muted-foreground" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className={`truncate ${isCurrent ? "font-medium text-primary" : e.title.trim() === "" ? "text-muted-foreground" : ""}`}>
                    {trackDisplayTitle(e.title, info?.file_path ?? "")}
                  </span>
                  {isCurrent && <PlayingIndicator paused={!playing} className="shrink-0" />}
                </span>
                {artists && (
                  <span className="block truncate text-xs text-muted-foreground">{artists}</span>
                )}
              </span>
              <span className="hidden min-w-0 max-w-[35%] shrink-0 truncate text-xs text-muted-foreground sm:block">
                {info?.album_title ?? ""}
              </span>
              <LoveButton trackId={e.id} loved={info?.loved ?? false} reveal="group-hover/track:opacity-100" />
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {fmtTrackTime(info?.duration_secs ?? null)}
              </span>
            </Row>
          );
        })}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuEntry?.entry_type === "track" && (
          <>
            {onEnqueue && (
              <>
                <ContextMenuItem
                  onClick={() => {
                    const item = menuEntry ? itemFor(menuEntry) : null;
                    if (item) onEnqueue([item], "next");
                  }}
                >
                  <ListStart size={14} />
                  Play next
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => {
                    const item = menuEntry ? itemFor(menuEntry) : null;
                    if (item) onEnqueue([item], "last");
                  }}
                >
                  <ListEnd size={14} />
                  Add to queue
                </ContextMenuItem>
              </>
            )}
            <ContextMenuItem onClick={() => menuEntry && setEditTrackId(menuEntry.id)}>
              <Pencil size={14} />
              Edit metadata
            </ContextMenuItem>
            <LoveMenuItem
              resolve={() =>
                menuEntry
                  ? { id: menuEntry.id, loved: infos?.get(menuEntry.id)?.loved ?? false }
                  : null
              }
            />
            {onAddToPlaylist && (
              <ContextMenuItem
                onClick={() => menuEntry && onAddToPlaylist({ id: menuEntry.id, title: menuEntry.title })}
              >
                <ListPlus size={14} />
                Add to playlist
              </ContextMenuItem>
            )}
            {menuEntry?.link_id != null && (
              <ContextMenuItem
                variant="destructive"
                onClick={() => menuEntry?.link_id != null && onRemoveLink(menuEntry.link_id)}
              >
                <ListX size={14} />
                Remove from playlist
              </ContextMenuItem>
            )}
          </>
        )}
        {menuEntry?.entry_type === "playlist_collection" && (
          <>
            {onRenameCollection && (
              <ContextMenuItem onClick={() => menuEntry && onRenameCollection(menuEntry)}>
                <Pencil size={14} />
                Rename
              </ContextMenuItem>
            )}
            {onDeleteCollection && (
              <ContextMenuItem
                variant="destructive"
                onClick={() => menuEntry && onDeleteCollection(menuEntry)}
              >
                <ListX size={14} />
                Delete collection
              </ContextMenuItem>
            )}
          </>
        )}
      </ContextMenuContent>
      <TrackEditDialog
        trackId={editTrackId}
        open={editTrackId !== null}
        onOpenChange={(o) => {
          if (!o) setEditTrackId(null);
        }}
        onSaved={() => onMetadataChanged?.()}
      />
    </ContextMenu>
  );
}
