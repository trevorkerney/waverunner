import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ListMusic, FolderPlus } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton, useSkeletonDelay } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreatePlaylistDialog } from "@/components/CreatePlaylistDialog";
import type { PlaylistSummary, PlaylistsResponse } from "@/types";

interface AddToPlaylistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string | null;
  entryId: number | null;
  entryTitle: string | null;
  onAdded: () => void;
}

export function AddToPlaylistDialog({
  open,
  onOpenChange,
  libraryId,
  entryId,
  entryTitle,
  onAdded,
}: AddToPlaylistDialogProps) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Skeleton rows only past 500ms — the list is local and usually instant.
  const showSkeleton = useSkeletonDelay(loading);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState<number | null>(null);
  // When non-null, we're showing the "already in playlist" confirmation for this playlist.
  const [confirmDup, setConfirmDup] = useState<PlaylistSummary | null>(null);

  useEffect(() => {
    if (!open || !libraryId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await invoke<PlaylistsResponse>("get_playlists", { libraryId });
        if (!cancelled) setPlaylists(res.playlists);
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, libraryId, createOpen]);

  async function performAdd(playlistId: number) {
    if (entryId == null) return;
    setSubmitting(playlistId);
    try {
      await invoke("add_media_link", {
        targetEntryId: entryId,
        parentPlaylistId: playlistId,
        parentCollectionId: null,
      });
      toast.success("Added to playlist");
      onAdded();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSubmitting(null);
    }
  }

  async function handleAdd(pl: PlaylistSummary) {
    if (entryId == null || submitting != null) return;
    setSubmitting(pl.id);
    try {
      const dup = await invoke<boolean>("playlist_contains_target", {
        playlistId: pl.id,
        targetEntryId: entryId,
      });
      if (dup) {
        // Pause — show the confirmation; performAdd runs if the user confirms.
        setSubmitting(null);
        setConfirmDup(pl);
        return;
      }
    } catch (e) {
      toast.error(String(e));
      setSubmitting(null);
      return;
    }
    await performAdd(pl.id);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* Static: eight rows of playlists; more scroll. */}
        <DialogContent size="sm" height="md">
          <DialogHeader>
            <DialogTitle className="truncate">
              {entryTitle ? `Add "${entryTitle}" to playlist` : "Add to playlist"}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="py-2">
            {loading && showSkeleton && (
              <ul className="flex flex-col gap-0.5">
                {Array.from({ length: 5 }, (_, i) => (
                  <li key={i} className="flex items-center gap-2 px-3 py-2">
                    <Skeleton className="size-3.5 rounded-sm" />
                    <Skeleton className="h-3.5 w-2/3" />
                  </li>
                ))}
              </ul>
            )}
            {!loading && playlists && playlists.length === 0 && (
              <div className="flex flex-col items-center gap-3 p-4 text-sm text-muted-foreground">
                <p>No playlists yet.</p>
                <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                  <FolderPlus size={14} />
                  Create playlist
                </Button>
              </div>
            )}
            {!loading && playlists && playlists.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {playlists.map((pl) => (
                  <li key={pl.id}>
                    <button
                      onClick={() => handleAdd(pl)}
                      disabled={submitting != null}
                      className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-60"
                    >
                      <ListMusic size={14} className="text-muted-foreground" />
                      <span className="truncate">{pl.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
          <DialogFooter className="justify-between">
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
              <FolderPlus size={14} />
              New playlist
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CreatePlaylistDialog
        libraryId={libraryId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          // list reloads via `createOpen` dep in useEffect
        }}
      />
      <ConfirmDialog
        open={confirmDup != null}
        onOpenChange={(o) => { if (!o) setConfirmDup(null); }}
        title="Already in playlist"
        message={
          <>
            {entryTitle ? `"${entryTitle}" is already in "${confirmDup?.title}".` : `This is already in "${confirmDup?.title}".`} Add it again?
          </>
        }
        cancelLabel="Don't add"
        confirmLabel="Add anyways"
        destructive={false}
        lines={1}
        onConfirm={() => {
          const id = confirmDup?.id;
          if (id != null) void performAdd(id);
        }}
      />
    </>
  );
}
