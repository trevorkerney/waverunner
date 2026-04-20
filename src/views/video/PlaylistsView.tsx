import { useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FolderPlus } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { PlaylistCard } from "@/components/cards/PlaylistCard";
import { CoverCarouselDialog } from "@/components/dialogs/CoverCarouselDialog";
import { CreatePlaylistDialog } from "@/components/CreatePlaylistDialog";
import { RenameDialog } from "@/components/RenameDialog";
import type { MediaEntry, PlaylistSummary } from "@/types";

export function PlaylistsView({
  libraryId,
  playlists,
  loading,
  breadcrumbBar,
  scrollContainerRef,
  onNavigateToPlaylist,
  onPlaylistChanged,
}: {
  libraryId: string;
  playlists: PlaylistSummary[] | null;
  loading: boolean;
  breadcrumbBar: ReactNode;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onNavigateToPlaylist: (p: PlaylistSummary) => void;
  onPlaylistChanged: (libraryId: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<PlaylistSummary | null>(null);
  const [coverDialog, setCoverDialog] = useState<{
    playlist: PlaylistSummary;
    mode: "select" | "delete";
  } | null>(null);

  async function handleDelete(p: PlaylistSummary) {
    if (!window.confirm(`Delete playlist "${p.title}"? The linked media will not be deleted.`))
      return;
    try {
      await invoke("delete_playlist", { playlistId: p.id });
      onPlaylistChanged(libraryId);
    } catch (e) {
      toast.error(String(e));
    }
  }

  async function handleAddCover(p: PlaylistSummary) {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("add_playlist_cover", { playlistId: p.id, sourcePath: selected });
      onPlaylistChanged(libraryId);
    } catch (e) {
      toast.error(String(e));
    }
  }

  // Synthesized MediaEntry passed to CoverCarouselDialog — only the fields it reads
  // (title, covers, selected_cover) need to be set.
  const dialogEntry: MediaEntry | null = coverDialog
    ? {
        id: coverDialog.playlist.id,
        title: coverDialog.playlist.title,
        year: null,
        end_year: null,
        folder_path: "",
        parent_id: null,
        entry_type: "playlist",
        covers: coverDialog.playlist.covers,
        selected_cover: coverDialog.playlist.selected_cover,
        child_count: 0,
        season_display: null,
        collection_display: null,
        tmdb_id: null,
        link_id: null,
      }
    : null;

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {breadcrumbBar}
      <ContextMenu>
        <ContextMenuTrigger
          render={<div ref={scrollContainerRef} className="flex-1 overflow-y-auto" />}
        >
          {loading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
          {!loading && playlists && playlists.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No playlists yet. Right-click here to create one.
            </p>
          )}
          {!loading && playlists && playlists.length > 0 && (
            <div
              className="grid gap-4 p-4"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
            >
              {playlists.map((pl) => (
                <PlaylistCard
                  key={pl.id}
                  playlist={pl}
                  onClick={() => onNavigateToPlaylist(pl)}
                  onRename={() => setRenameTarget(pl)}
                  onDelete={() => handleDelete(pl)}
                  onCreatePeer={() => setCreateOpen(true)}
                  onAddCover={() => handleAddCover(pl)}
                  onChangeCover={() => setCoverDialog({ playlist: pl, mode: "select" })}
                  onDeleteCover={() => setCoverDialog({ playlist: pl, mode: "delete" })}
                />
              ))}
            </div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setCreateOpen(true)}>
            <FolderPlus size={14} />
            Create playlist
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <CreatePlaylistDialog
        libraryId={libraryId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => onPlaylistChanged(libraryId)}
      />
      <RenameDialog
        open={renameTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null);
        }}
        title="Rename playlist"
        initialValue={renameTarget?.title ?? ""}
        onSubmit={async (newName) => {
          if (!renameTarget) return;
          try {
            await invoke("rename_playlist", {
              playlistId: renameTarget.id,
              newTitle: newName,
            });
            onPlaylistChanged(libraryId);
          } catch (e) {
            toast.error(String(e));
          }
        }}
      />
      {dialogEntry && coverDialog && (
        <CoverCarouselDialog
          entry={dialogEntry}
          mode={coverDialog.mode}
          open={coverDialog !== null}
          onOpenChange={(open) => {
            if (!open) setCoverDialog(null);
          }}
          onSelect={async (coverPath) => {
            try {
              await invoke("set_playlist_cover", {
                playlistId: coverDialog.playlist.id,
                coverPath,
              });
              onPlaylistChanged(libraryId);
            } catch (e) {
              toast.error(String(e));
            }
            setCoverDialog(null);
          }}
          onDelete={async (coverPath) => {
            const wasLast = coverDialog.playlist.covers.length <= 1;
            try {
              await invoke("delete_playlist_cover", {
                playlistId: coverDialog.playlist.id,
                coverPath,
              });
              onPlaylistChanged(libraryId);
            } catch (e) {
              toast.error(String(e));
            }
            if (wasLast) setCoverDialog(null);
          }}
        />
      )}
    </main>
  );
}
