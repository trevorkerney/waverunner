import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Pencil,
  Image as ImageIcon,
  Trash2,
  FolderPlus,
  ListMusic,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import type { PlaylistSummary } from "@/types";

export function PlaylistCard({
  playlist,
  onClick,
  onRename,
  onDelete,
  onCreatePeer,
  onAddCover,
  onChangeCover,
  onDeleteCover,
}: {
  playlist: PlaylistSummary;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCreatePeer: () => void;
  onAddCover: () => void;
  onChangeCover: () => void;
  onDeleteCover: () => void;
}) {
  const coverSrc = playlist.selected_cover ? convertFileSrc(playlist.selected_cover) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            onClick={onClick}
            onContextMenu={(e) => e.stopPropagation()}
            className="flex flex-col gap-2 rounded-md text-left transition-colors hover:bg-accent/40 focus:bg-accent/60 focus:outline-none"
          />
        }
      >
        <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-muted">
          {coverSrc ? (
            <img src={coverSrc} alt={playlist.title} className="h-full w-full object-cover" draggable={false} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <ListMusic size={36} />
            </div>
          )}
        </div>
        <p className="line-clamp-2 px-1 text-sm font-medium">{playlist.title}</p>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRename}>
          <Pencil size={14} />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={onAddCover}>
          <ImageIcon size={14} />
          Add local cover
        </ContextMenuItem>
        <ContextMenuItem onClick={onChangeCover} disabled={playlist.covers.length <= 1}>
          <ImageIcon size={14} />
          Change cover
        </ContextMenuItem>
        <ContextMenuItem onClick={onDeleteCover} disabled={playlist.covers.length < 1}>
          <Trash2 size={14} />
          Delete cover
        </ContextMenuItem>
        <ContextMenuItem onClick={onCreatePeer}>
          <FolderPlus size={14} />
          Create playlist
        </ContextMenuItem>
        <ContextMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
          <Trash2 size={14} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
