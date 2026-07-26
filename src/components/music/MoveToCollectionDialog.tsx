import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { FolderPlus, Music2, Waves } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

export interface SoundCollectionRow {
  id: number;
  title: string;
}

/** Pick (or create) the sound collection a track moves into. Fully virtual —
 *  the move writes a rescan-proof directive; source files never move. */
export function MoveToCollectionDialog({
  libraryId,
  track,
  open,
  onOpenChange,
  allowLoose = false,
  onMoved,
}: {
  libraryId: string;
  track: { id: number; title: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Offer "Loose tracks" as a destination (hidden when the track is already loose). */
  allowLoose?: boolean;
  onMoved?: () => void;
}) {
  const [collections, setCollections] = useState<SoundCollectionRow[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCollections(null);
    setNewName("");
    invoke<SoundCollectionRow[]>("list_sound_collections", { libraryId })
      .then(setCollections)
      .catch((e) => toast.error(String(e)));
  }, [open, libraryId]);

  const moveTo = async (collectionId: number | null) => {
    if (!track) return;
    setBusy(true);
    try {
      await invoke("move_sound_track", { trackId: track.id, collectionId });
      onMoved?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const createAndMove = async () => {
    const name = newName.trim();
    if (!name || !track) return;
    setBusy(true);
    try {
      const id = await invoke<number>("create_sound_collection", { libraryId, title: name });
      await invoke("move_sound_track", { trackId: track.id, collectionId: id });
      onMoved?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="truncate">
            Move “{track?.title ?? ""}” to…
          </DialogTitle>
        </DialogHeader>
        {collections === null ? (
          <div className="flex justify-center py-6">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
            {allowLoose && (
              <button
                disabled={busy}
                onClick={() => moveTo(null)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <Music2 size={14} className="text-muted-foreground" />
                Loose tracks
              </button>
            )}
            {collections.map((c) => (
              <button
                key={c.id}
                disabled={busy}
                onClick={() => moveTo(c.id)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <Waves size={14} className="text-muted-foreground" />
                <span className="truncate">{c.title}</span>
              </button>
            ))}
            {collections.length === 0 && !allowLoose && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">No collections yet.</p>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createAndMove();
            }}
            placeholder="New collection…"
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5"
            disabled={busy || newName.trim().length === 0}
            onClick={() => void createAndMove()}
          >
            {busy && <Spinner className="size-3" />}
            <FolderPlus size={13} />
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Name-and-create dialog for an empty sound collection (Sounds page toolbar). */
export function NewSoundCollectionDialog({
  libraryId,
  open,
  onOpenChange,
  onCreated,
}: {
  libraryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const create = async () => {
    const title = name.trim();
    if (!title || !libraryId) return;
    setBusy(true);
    try {
      await invoke("create_sound_collection", { libraryId, title });
      onCreated?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New collection</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder="Collection name"
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={busy || name.trim().length === 0}
            onClick={() => void create()}
          >
            {busy && <Spinner className="size-3" />}
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
