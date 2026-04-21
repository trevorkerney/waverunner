import { useCallback, useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import {
  Film,
  Tv,
  Folder,
  Pencil,
  Image as ImageIcon,
  Trash2,
  ListPlus,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { Spinner } from "@/components/ui/spinner";
import { useCoverUrl } from "@/context/CoverUrlContext";
import type { MediaEntry } from "@/types";

export function getDisplayCover(entry: MediaEntry): string | null {
  if (entry.selected_cover && entry.covers.includes(entry.selected_cover)) {
    return entry.selected_cover;
  }
  return entry.covers[0] || null;
}

export function SortableCoverCard({
  entry,
  size,
  onNavigate,
  onRename,
  onChangeCover,
  onAddCover,
  onAddCoverFromTmdb,
  onDeleteCover,
  onDelete,
  onAddToPlaylist,
  onRemoveLink,
  onRenamePlaylistCollection,
  onDeletePlaylistCollection,
  onEditCharacterName,
  sortableId,
  isDragActive,
  sortMode,
  deletingId,
  readOnly,
  hideYear,
}: {
  entry: MediaEntry;
  size: number;
  onNavigate: (entry: MediaEntry) => void;
  onRename: (entryId: number, newTitle: string) => Promise<string | null>;
  onChangeCover: () => void;
  onAddCover: () => void;
  onAddCoverFromTmdb: () => void;
  onDeleteCover: () => void;
  onDelete: (entry: MediaEntry) => Promise<void>;
  onAddToPlaylist?: (entry: MediaEntry) => void;
  onRemoveLink?: (linkId: number) => void;
  onRenamePlaylistCollection?: (entry: MediaEntry) => void;
  onDeletePlaylistCollection?: (entry: MediaEntry) => void;
  /** Person-detail Actor section uses this. Allowed to render even when `readOnly` is
   *  true — same exemption pattern as `onAddToPlaylist`. Director/Composer sections
   *  simply omit the prop. */
  onEditCharacterName?: (entry: MediaEntry) => void;
  /** Overrides the useSortable id. Playlist views need string ids so links and
   *  nested playlist_collections don't collide with each other or with real
   *  media_entry ids. Library views can omit this and the card falls back to entry.id. */
  sortableId?: string | number;
  isDragActive: boolean;
  sortMode: string;
  deletingId: number | null;
  /** Hides every mutating context-menu option on this card — used by person-detail where
   *  library-level edits don't belong. `onAddToPlaylist` and `onEditCharacterName` are
   *  the documented exceptions. */
  readOnly?: boolean;
  /** When true, omit the year/year-range from the secondary line. Used by person-detail
   *  cards so the involvement label ("as Walter White") shows without trailing year info.
   *  Year is still on the entry for client-side date sorting; just not rendered. */
  hideYear?: boolean;
}) {
  const { getCoverUrl } = useCoverUrl();
  const {
    attributes,
    listeners,
    setNodeRef: setSortRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId ?? entry.id });

  const isCollection = entry.entry_type === "collection";
  const isPlaylistCollection = entry.entry_type === "playlist_collection";
  const isDropTarget = isCollection || isPlaylistCollection;
  // Different prefixes so the drag-end handler knows which backend to call.
  const dropId = isPlaylistCollection
    ? `pc-drop-${entry.id}`
    : `collection-${entry.id}`;
  const { setNodeRef: setCollectionDropRef, isOver } = useDroppable({
    id: dropId,
    disabled: !isDropTarget || isDragging,
  });

  const setRef = useCallback(
    (node: HTMLElement | null) => {
      setSortRef(node);
      if (isDropTarget) setCollectionDropRef(node);
    },
    [setSortRef, setCollectionDropRef, isDropTarget]
  );

  // Only show sort shift animation in custom sort mode
  const style = {
    transform: sortMode === "custom" ? CSS.Transform.toString(transform) : undefined,
    transition: sortMode === "custom" ? transition : undefined,
  };

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const isDeleting = deletingId === entry.id;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (isRenaming) {
      submittedRef.current = false;
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const startRename = () => {
    setRenameValue(entry.title);
    setIsRenaming(true);
  };

  const submitRename = async () => {
    if (submittedRef.current) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === entry.title) {
      setIsRenaming(false);
      return;
    }
    submittedRef.current = true;
    setRenameLoading(true);
    const error = await onRename(entry.id, trimmed);
    setRenameLoading(false);
    setIsRenaming(false);
    if (error) {
      toast.error(error);
    }
  };

  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getCoverUrl(coverPath) : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={setRef}
            {...attributes}
            {...listeners}
            onClick={() => !isRenaming && !isDragging && onNavigate(entry)}
          />
        }
        className={`group flex flex-col items-center gap-2 rounded-md p-2 text-left hover:bg-accent ${
          isDragging ? "opacity-0" : ""
        } ${isOver && isDragActive ? "ring-2 ring-primary ring-offset-2" : ""}`}
        style={{ ...style, maxWidth: size }}
      >
        <div className="relative overflow-hidden rounded-sm bg-muted">
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={entry.title}
              className="pointer-events-none w-full"
              style={{ maxHeight: size * 2 }}
              draggable={false}
            />
          ) : (
            <div
              className="flex items-center justify-center"
              style={{ height: size * 1.5, width: size - 16 }}
            >
              {entry.entry_type === "movie" ? (
                <Film size={size * 0.3} className="text-muted-foreground" />
              ) : entry.entry_type === "show" ? (
                <Tv size={size * 0.3} className="text-muted-foreground" />
              ) : (
                <Folder size={size * 0.3} className="text-muted-foreground" />
              )}
            </div>
          )}
          {isCollection && (
            <div className="absolute bottom-1 right-1 rounded-sm bg-black/60 px-1.5 py-0.5 text-xs text-white">
              Collection
            </div>
          )}
        </div>
        <div className="w-full">
          {isDeleting ? (
            <div className="flex items-center gap-1.5 px-1">
              <Spinner className="size-3" />
              <span className="truncate text-sm text-muted-foreground">{entry.title}</span>
            </div>
          ) : renameLoading ? (
            <div className="flex items-center gap-1.5 px-1">
              <Spinner className="size-3" />
              <span className="truncate text-sm text-muted-foreground">{renameValue}</span>
            </div>
          ) : isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") {
                  submittedRef.current = true;
                  setIsRenaming(false);
                }
              }}
              onBlur={submitRename}
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded bg-transparent px-1 text-sm font-medium outline-none ring-1 ring-primary"
              style={{ userSelect: "text" }}
            />
          ) : (
            <>
              <p className="text-sm font-medium">{entry.title}</p>
              {(entry.season_display || entry.collection_display || (!hideYear && entry.year)) && (
                <p className="text-xs text-muted-foreground">{[entry.season_display || entry.collection_display, !hideYear && entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`].filter(Boolean).join(", ")}</p>
              )}
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {entry.entry_type === "playlist_collection" ? (
          <>
            {onRenamePlaylistCollection && (
              <ContextMenuItem onClick={() => onRenamePlaylistCollection(entry)}>
                <Pencil size={14} />
                Rename
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={onAddCover}>
              <ImageIcon size={14} />
              Add local cover
            </ContextMenuItem>
            <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
              <ImageIcon size={14} />
              Change cover
            </ContextMenuItem>
            <ContextMenuItem onClick={onDeleteCover} disabled={entry.covers.length < 1}>
              <Trash2 size={14} />
              Delete cover
            </ContextMenuItem>
            {onDeletePlaylistCollection && (
              <ContextMenuItem
                onClick={() => onDeletePlaylistCollection(entry)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={14} />
                Delete collection
              </ContextMenuItem>
            )}
          </>
        ) : (
          <>
            {!readOnly && entry.link_id == null && (
              <ContextMenuItem onClick={startRename}>
                <Pencil size={14} />
                Rename
              </ContextMenuItem>
            )}
            {/* Add/Delete cover mutate the target media_entry (shared with the library),
                which we don't want from inside a playlist — only the per-link cover
                override (Change cover) is offered there. person-detail hides them too. */}
            {!readOnly && entry.link_id == null && (
              <>
                <ContextMenuItem onClick={onAddCover}>
                  <ImageIcon size={14} />
                  Add local cover
                </ContextMenuItem>
                <ContextMenuItem onClick={onAddCoverFromTmdb} disabled={entry.entry_type === "collection" || !entry.tmdb_id}>
                  <ImageIcon size={14} />
                  Add cover from TMDB
                </ContextMenuItem>
              </>
            )}
            {!readOnly && (
              <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
                <ImageIcon size={14} />
                Change cover
              </ContextMenuItem>
            )}
            {!readOnly && entry.link_id == null && (
              <ContextMenuItem onClick={onDeleteCover} disabled={entry.covers.length < 1}>
                <Trash2 size={14} />
                Delete cover
              </ContextMenuItem>
            )}
            {onEditCharacterName && (
              // Label swaps between Add/Edit based on whether the card already shows a
              // character name. The label lives in `season_display` and starts with
              // `as ` when a name is set.
              <ContextMenuItem onClick={() => onEditCharacterName(entry)}>
                <Pencil size={14} />
                {entry.season_display?.startsWith("as ") ? "Edit character name" : "Add character name"}
              </ContextMenuItem>
            )}
            {onAddToPlaylist && entry.link_id == null && (entry.entry_type === "movie" || entry.entry_type === "show") && (
              <ContextMenuItem onClick={() => onAddToPlaylist(entry)}>
                <ListPlus size={14} />
                Add to playlist
              </ContextMenuItem>
            )}
            {onRemoveLink && entry.link_id != null && (
              <ContextMenuItem
                onClick={() => onRemoveLink(entry.link_id!)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={14} />
                Remove from playlist
              </ContextMenuItem>
            )}
            {!readOnly && entry.link_id == null && !(entry.entry_type === "collection" && entry.child_count > 0) && (
              <ContextMenuItem onClick={() => onDelete(entry)} className="text-destructive focus:text-destructive">
                <Trash2 size={14} />
                {entry.entry_type === "collection" ? "Delete collection" : "Delete media"}
              </ContextMenuItem>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
