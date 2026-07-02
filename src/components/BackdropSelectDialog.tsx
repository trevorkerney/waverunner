import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

interface BackdropSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryId: number;
  /** The backdrop currently shown on the hero (detail.backdrop). */
  current: string | null;
  /** Fired after a new backdrop is selected so the page can reload. */
  onChanged: () => void;
}

export function BackdropSelectDialog({
  open,
  onOpenChange,
  entryId,
  current,
  onChanged,
}: BackdropSelectDialogProps) {
  const [loading, setLoading] = useState(false);
  const [backdrops, setBackdrops] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    invoke<string[]>("get_backdrops", { entryId })
      .then(setBackdrops)
      .catch((e) => toast.error(String(e)))
      .finally(() => setLoading(false));
  }, [open, entryId]);

  const select = async (path: string) => {
    try {
      await invoke("set_selected_backdrop", { entryId, path });
      onChanged();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] w-[720px] max-w-[90vw] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Select Backdrop</DialogTitle>
        </DialogHeader>
        {loading && (
          <div className="flex justify-center py-10">
            <Spinner className="size-6" />
          </div>
        )}
        {!loading && backdrops.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground">
            No backdrops yet. Use "Add cover/backdrop from TMDB" to download
            some, or drop images into a "backdrops" folder inside the media
            folder and rescan.
          </p>
        )}
        {!loading && backdrops.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {backdrops.map((path) => (
              <button
                key={path}
                onClick={() => select(path)}
                className={`overflow-hidden rounded-md ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-primary/60 ${
                  path === current ? "ring-2 ring-primary" : "ring-1 ring-foreground/10"
                }`}
              >
                <img
                  src={convertFileSrc(path)}
                  alt=""
                  className="aspect-video w-full object-cover"
                  draggable={false}
                />
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
