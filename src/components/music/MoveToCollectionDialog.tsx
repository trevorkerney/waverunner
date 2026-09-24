import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { FolderPlus, Music2, Waves } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Skeleton, useSkeletonDelay } from "../ui/skeleton";
import { NameDialog } from "../NameDialog";

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

  // Skeleton rows only past 500ms — the list is local and usually instant.
  const showSkeleton = useSkeletonDelay(collections === null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Static: eight rows of collections; more scroll. The "new
          collection" row stays put under the list. */}
      <DialogContent size="sm" height="md">
        <DialogHeader>
          <DialogTitle className="truncate">
            Move “{track?.title ?? ""}” to…
          </DialogTitle>
        </DialogHeader>
        {collections === null ? (
          <DialogBody className="flex flex-col gap-0.5">
            {showSkeleton &&
              Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="size-3.5 rounded-sm" />
                  <Skeleton className="h-3.5 w-1/2" />
                </div>
              ))}
          </DialogBody>
        ) : (
          <DialogBody className="flex flex-col gap-0.5">
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
          </DialogBody>
        )}
        <div className="flex shrink-0 items-center gap-2">
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

/** Name-and-create dialog for an empty sound collection (Sounds page
 *  toolbar) — the one name form. */
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
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New collection"
      placeholder="Collection name"
      submitLabel="Create"
      onSubmit={async (title) => {
        if (!libraryId) return;
        try {
          await invoke("create_sound_collection", { libraryId, title });
          onCreated?.();
        } catch (e) {
          toast.error(String(e));
        }
      }}
    />
  );
}
