import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFlipList } from "../../hooks/useFlipList";
import { useListWindow } from "../../hooks/useListWindow";
import { invoke } from "@tauri-apps/api/core";
import { useSortable } from "@dnd-kit/sortable";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Play, Folder, Pencil, ListPlus, ListX, Music2, ListStart, ListEnd, Disc3 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";
import { TrackEditDialog } from "./EditDialogs";
import { MatchDialog } from "./MatchDialog";
import { PlayingIndicator } from "./PlayingIndicator";
import { LoveButton, LoveMenuItem } from "./LoveButton";
import { RevealMenuItem } from "./RevealMenuItem";
import { CodecBadge } from "./CodecBadge";
import { MediaEntry, MusicQueueItem, TrackQueueInfo } from "../../types";
import { fmtTrackTime, trackDisplayTitle } from "./musicQueue";
import { useDeselectOnBackgroundClick } from "./useTrackSelection";
import { useMbHidden } from "@/lib/mbVisibility";

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
  /** Row text becomes links: artist chips per credit, the album cell, and
   *  the track title (album focused at that track) — the now-playing bar's
   *  exact navigation recipe. */
  onOpenArtist?: (artistId: number, artistName: string) => void;
  onOpenAlbum?: (albumId: number, albumTitle: string, trackId?: number) => void;
  /** Owning library — gates the per-library hide-MB-outside-the-center flag. */
  libraryId?: string;
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
      data-flip-id={String(sortableIdFor(entry))}
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

/** A collection inside the playlist. Memoized (as every row here): a window
 *  slice move re-renders only the rows entering the list. */
const CollectionRow = memo(function CollectionRow({
  entry,
  getCoverUrl,
  onNavigate,
  onMenu,
}: {
  entry: MediaEntry;
  getCoverUrl: (filePath: string) => string;
  onNavigate: (entry: MediaEntry) => void;
  onMenu: (entry: MediaEntry) => void;
}) {
  const cover = displayCover(entry.covers, entry.selected_cover);
  return (
    <Row entry={entry} onClick={() => onNavigate(entry)} onContextMenu={() => onMenu(entry)}>
      <span className="w-5 shrink-0" />
      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-muted">
        {cover ? (
          <img src={getCoverUrl(cover)} alt="" loading="eager" decoding="async" className="size-full object-cover" draggable={false} />
        ) : (
          <Folder size={15} className="text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{entry.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          Collection · {entry.child_count} {entry.child_count === 1 ? "item" : "items"}
        </span>
      </span>
    </Row>
  );
});

/** A track row. `playing` is only ever true for the current row — stable
 *  false elsewhere keeps the memo hits. */
const TrackRow = memo(function TrackRow({
  entry,
  info,
  isCurrent,
  playing,
  selected,
  getCoverUrl,
  onSelectRow,
  onPlayFrom,
  onMenu,
  onOpenArtist,
  onOpenAlbum,
}: {
  entry: MediaEntry;
  info: TrackQueueInfo | undefined;
  isCurrent: boolean;
  playing: boolean;
  selected: boolean;
  getCoverUrl: (filePath: string) => string;
  onSelectRow: (entry: MediaEntry) => void;
  onPlayFrom: (entry: MediaEntry) => void;
  onMenu: (entry: MediaEntry) => void;
  onOpenArtist?: (artistId: number, artistName: string) => void;
  onOpenAlbum?: (albumId: number, albumTitle: string, trackId?: number) => void;
}) {
  const cover = displayCover(entry.covers, entry.selected_cover);
  // Credits render as individual chips so each resolvable artist is its own
  // link; unresolved names stay plain text between them.
  const creditChips =
    info && info.artists.length > 0
      ? info.artists
      : info?.artist_name
        ? [{ name: info.artist_name, artist_id: info.artist_id ?? null }]
        : entry.collection_display
          ? [{ name: entry.collection_display, artist_id: null }]
          : [];
  const title = trackDisplayTitle(entry.title, info?.file_path ?? "");
  const titleClass = isCurrent
    ? "font-medium text-primary"
    : entry.title.trim() === ""
      ? "text-muted-foreground"
      : "";
  return (
    <Row
      entry={entry}
      selected={selected}
      onClick={() => onSelectRow(entry)}
      onDoubleClick={() => onPlayFrom(entry)}
      onContextMenu={() => onMenu(entry)}
    >
      <button
        onClick={(ev) => {
          ev.stopPropagation();
          onPlayFrom(entry);
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
          <img src={getCoverUrl(cover)} alt="" loading="eager" decoding="async" className="size-full object-cover" draggable={false} />
        ) : (
          <Music2 size={15} className="text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          {/* Title links to its album, focused at this track — the
              bar-title recipe. Loose tracks have no album; plain. */}
          {onOpenAlbum && info?.album_id != null ? (
            <button
              onClick={(ev) => {
                ev.stopPropagation();
                onOpenAlbum(info.album_id!, info.album_title ?? "", entry.id);
              }}
              className={`truncate text-left hover:underline ${titleClass}`}
            >
              {title}
            </button>
          ) : (
            <span className={`truncate ${titleClass}`}>{title}</span>
          )}
          {isCurrent && <PlayingIndicator paused={!playing} className="shrink-0" />}
          <LoveButton
            trackId={entry.id}
            loved={info?.loved ?? null}
            reveal="group-hover/track:opacity-100"
            className="ml-1.5"
          />
        </span>
        {creditChips.length > 0 && (
          <span className="block truncate text-xs text-muted-foreground">
            {creditChips.map((c, i) => (
              <span key={i}>
                {i > 0 && ", "}
                {onOpenArtist && c.artist_id != null ? (
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onOpenArtist(c.artist_id!, c.name);
                    }}
                    className="hover:text-foreground hover:underline"
                  >
                    {c.name}
                  </button>
                ) : (
                  c.name
                )}
              </span>
            ))}
          </span>
        )}
      </span>
      {onOpenAlbum && info?.album_id != null ? (
        <button
          onClick={(ev) => {
            ev.stopPropagation();
            onOpenAlbum(info.album_id!, info.album_title ?? "");
          }}
          className="hidden min-w-0 max-w-[35%] shrink-0 truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline sm:block"
        >
          {info.album_title ?? ""}
        </button>
      ) : (
        <span className="hidden min-w-0 max-w-[35%] shrink-0 truncate text-xs text-muted-foreground sm:block">
          {info?.album_title ?? ""}
        </span>
      )}
      <CodecBadge codec={info?.codec} bitrate={info?.bitrate_kbps} mode={info?.bitrate_mode} />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {fmtTrackTime(info?.duration_secs ?? null)}
      </span>
    </Row>
  );
});

/** Music playlist contents as a flat track list (the cover grid reads as a
 *  wall of identical album art). Rows keep everything the grid had: drag
 *  reorder under Custom sort, drag-into-collection, the shared context menu
 *  actions, and play-from-row through the whole (current view's) list.
 *
 *  Windowed (2026-09-26): rows are uniform, so only the ones near the
 *  viewport mount and the list pads itself for the rest — a playlist of
 *  thousands mounts like one of fifty. The slice holds while a row is
 *  being dragged (it must stay mounted). */
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
  onOpenArtist,
  onOpenAlbum,
  libraryId,
}: PlaylistTrackListProps) {
  // Row facts the hydrated entries lack (artists, album, duration, loved,
  // file paths for playback) — one batch fetch per view.
  const [infos, setInfos] = useState<Map<number, TrackQueueInfo> | null>(null);
  // Per-library "hide MusicBrainz outside the center" (center map toggle).
  const mbHidden = useMbHidden(libraryId);
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  // Track being matched to MusicBrainz (its own dialog).
  const [matchTrack, setMatchTrack] = useState<number | null>(null);
  // State (not a ref): the menu's items branch on the row's entry type.
  const [menuEntry, setMenuEntry] = useState<MediaEntry | null>(null);
  // Selection keyed by sortable id (a track linked twice = two selectable rows).
  const [selectedRowId, setSelectedRowId] = useState<string | number | null>(null);
  useDeselectOnBackgroundClick(useCallback(() => setSelectedRowId(null), []));

  const trackEntries = useMemo(() => entries.filter((e) => e.entry_type === "track"), [entries]);

  // Sort-mode switches slide rows to their new order (shared FLIP recipe).
  // Skipped whenever any row carries an inline transform — that's dnd-kit
  // mid-drag/settle, which animates itself.
  const listRef = useRef<HTMLDivElement | null>(null);
  useFlipList(listRef, {
    skip: () => !!listRef.current?.querySelector('[data-track-row][style*="transform"]'),
  });

  // The window: held while a drag is live (the shared DndContext's active
  // item) so the dragged row stays mounted.
  const { active } = useDndContext();
  const listWindow = useListWindow({
    listRef,
    count: entries.length,
    estimateRowHeight: 48,
    frozen: active != null,
  });

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
  const itemFor = useCallback(
    (e: MediaEntry): MusicQueueItem | null => {
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
    },
    [infos],
  );

  // Queue every track in view order, starting from the clicked row.
  // Duplicate links queue twice; rows whose backing track vanished are skipped.
  const playFrom = useCallback(
    (clicked: MediaEntry) => {
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
    },
    [infos, trackEntries, itemFor, onPlayQueue],
  );

  // Row handlers, stable for the memo rows.
  const selectRow = useCallback((e: MediaEntry) => setSelectedRowId(sortableIdFor(e)), []);
  const menuTrack = useCallback((e: MediaEntry) => {
    setSelectedRowId(sortableIdFor(e));
    setMenuEntry(e);
  }, []);
  const menuCollection = useCallback((e: MediaEntry) => setMenuEntry(e), []);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={listRef}
            // The rows that aren't mounted are this padding.
            style={{ paddingTop: listWindow.padTop, paddingBottom: listWindow.padBottom }}
          />
        }
      >
        {entries.slice(listWindow.start, listWindow.end).map((e) => {
          if (e.entry_type === "playlist_collection") {
            return (
              <CollectionRow
                key={sortableIdFor(e)}
                entry={e}
                getCoverUrl={getCoverUrl}
                onNavigate={onNavigate}
                onMenu={menuCollection}
              />
            );
          }
          const isCurrent = currentTrackId === e.id;
          return (
            <TrackRow
              key={sortableIdFor(e)}
              entry={e}
              info={infos?.get(e.id)}
              isCurrent={isCurrent}
              playing={isCurrent ? (playing ?? false) : false}
              selected={selectedRowId === sortableIdFor(e)}
              getCoverUrl={getCoverUrl}
              onSelectRow={selectRow}
              onPlayFrom={playFrom}
              onMenu={menuTrack}
              onOpenArtist={onOpenArtist}
              onOpenAlbum={onOpenAlbum}
            />
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
            {/* Loose tracks only — album tracks match through their release pin. */}
            {!mbHidden && menuEntry && infos?.get(menuEntry.id)?.album_id == null && (
              <ContextMenuItem onClick={() => setMatchTrack(menuEntry.id)}>
                <Disc3 size={14} />
                Match to MusicBrainz…
              </ContextMenuItem>
            )}
            <LoveMenuItem
              resolve={() =>
                menuEntry
                  ? { id: menuEntry.id, loved: infos?.get(menuEntry.id)?.loved ?? null }
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
            <RevealMenuItem resolve={() => menuEntry?.id ?? null} />
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
        libraryId={libraryId}
        open={editTrackId !== null}
        onOpenChange={(o) => {
          if (!o) setEditTrackId(null);
        }}
        onSaved={() => onMetadataChanged?.()}
      />
      {matchTrack != null && (
        <MatchDialog
          kind="track"
          entityId={matchTrack}
          open={matchTrack != null}
          onOpenChange={(o) => !o && setMatchTrack(null)}
          onChanged={() => onMetadataChanged?.()}
        />
      )}
    </ContextMenu>
  );
}
