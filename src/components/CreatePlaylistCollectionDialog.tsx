import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { ImageIcon, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CreatePlaylistCollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Exactly one of parent_playlist_id or parent_collection_id must be set. */
  parentPlaylistId: number | null;
  parentCollectionId: number | null;
  onCreated: (collectionId: number) => void;
}

export function CreatePlaylistCollectionDialog({
  open,
  onOpenChange,
  parentPlaylistId,
  parentCollectionId,
  onCreated,
}: CreatePlaylistCollectionDialogProps) {
  const [name, setName] = useState("");
  const [coverSource, setCoverSource] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setCoverSource(null);
      setCreating(false);
    }
  }, [open]);

  async function pickCover() {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
    });
    if (selected && typeof selected === "string") setCoverSource(selected);
  }

  async function handleCreate() {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const id = await invoke<number>("create_playlist_collection", {
        title: name.trim(),
        parentPlaylistId,
        parentCollectionId,
      });
      if (coverSource) {
        try {
          await invoke("add_playlist_collection_cover", { collectionId: id, sourcePath: coverSource });
        } catch (e) {
          toast.error(`Collection created but cover failed: ${e}`);
        }
      }
      onCreated(id);
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create collection</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <Label htmlFor="collection-name">Name</Label>
          <Input
            id="collection-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Star Wars"
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
            autoFocus
          />
          <Label>Cover (optional)</Label>
          <div className="flex items-center gap-3">
            {coverSource ? (
              <div className="relative">
                <img
                  src={convertFileSrc(coverSource)}
                  alt="Cover preview"
                  className="h-20 w-14 rounded object-cover"
                />
                <button
                  type="button"
                  onClick={() => setCoverSource(null)}
                  className="absolute -right-1 -top-1 rounded-full bg-background p-0.5 text-muted-foreground shadow hover:text-foreground"
                  aria-label="Remove cover"
                >
                  <X size={12} />
                </button>
              </div>
            ) : null}
            <Button variant="outline" size="sm" onClick={pickCover}>
              <ImageIcon size={14} />
              {coverSource ? "Change" : "Choose image"}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={!name.trim() || creating}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
