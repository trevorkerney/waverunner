import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ListMusic, FolderPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CreatePlaylistDialog } from "@/components/CreatePlaylistDialog";
import type { PlaylistSummary } from "@/types";

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
        const res = await invoke<PlaylistSummary[]>("get_playlists", { libraryId });
        if (!cancelled) setPlaylists(res);
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
      setConfirmDup(null);
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
        <DialogContent className="flex max-h-[70vh] flex-col sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {entryTitle ? `Add "${entryTitle}" to playlist` : "Add to playlist"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto py-2">
            {loading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
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
          </div>
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
      <Dialog open={confirmDup != null} onOpenChange={(o) => { if (!o) setConfirmDup(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Already in playlist</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {entryTitle ? `"${entryTitle}" is already in "${confirmDup?.title}".` : `This is already in "${confirmDup?.title}".`} Add it again?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDup(null)} disabled={submitting != null}>
              Don't add
            </Button>
            <Button
              onClick={() => confirmDup && performAdd(confirmDup.id)}
              disabled={submitting != null}
            >
              Add anyways
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
