import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Library, MediaEntry } from "@/types";

/** Full delete-entry confirmation flow:
 *  - When `target` is set, shows the primary confirmation (with optional "delete from disk" toggle for managed libraries).
 *  - When `filesWarning` is set, shows the secondary warning dialog for deleting a collection that contains disk files.
 *  The parent owns both pieces of state and calls `onConfirm` once the user commits; dismissal handling lives here. */
export function DeleteEntryDialog({
  target,
  onTargetChange,
  filesWarning,
  onFilesWarningChange,
  selectedLibrary,
  onConfirm,
}: {
  target: MediaEntry | null;
  onTargetChange: (entry: MediaEntry | null) => void;
  filesWarning: MediaEntry | null;
  onFilesWarningChange: (entry: MediaEntry | null) => void;
  selectedLibrary: Library | null;
  onConfirm: (entryId: number, deleteFromDisk: boolean) => void;
}) {
  const [deleteFromDisk, setDeleteFromDisk] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const resetPrimary = () => {
    onTargetChange(null);
    setDeleteFromDisk(false);
    setDeleteConfirmText("");
  };

  return (
    <>
      {/* Delete Confirmation Dialog */}
      <Dialog open={target != null} onOpenChange={(open) => { if (!open) resetPrimary(); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Delete {target?.entry_type === "movie" ? "Movie" : target?.entry_type === "show" ? "Show" : "Entry"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete &ldquo;{target?.title}&rdquo;?
          </p>
          {selectedLibrary?.managed && (
            <div className="flex flex-col">
              <div className="flex items-center justify-between">
                <label className="text-sm">Delete from disk</label>
                <Switch
                  checked={deleteFromDisk}
                  onCheckedChange={(checked) => {
                    setDeleteFromDisk(checked);
                    setDeleteConfirmText("");
                  }}
                />
              </div>
              <div
                className="grid transition-[grid-template-rows] duration-200 ease-out"
                style={{ gridTemplateRows: deleteFromDisk ? "0fr" : "1fr" }}
              >
                <div className="overflow-hidden">
                  <p className="pt-2 text-xs text-muted-foreground">
                    The folder will remain on disk. A rescan will bring it back.
                  </p>
                </div>
              </div>
              <div
                className="grid transition-[grid-template-rows] duration-200 ease-out"
                style={{ gridTemplateRows: deleteFromDisk ? "1fr" : "0fr" }}
              >
                <div className="overflow-hidden">
                  <div className="flex flex-col gap-2 px-1 pb-1 pt-2">
                    <p className="text-xs text-muted-foreground">
                      Type &ldquo;
                      <ContextMenu>
                        <ContextMenuTrigger
                          render={<span />}
                          className="!inline !select-text cursor-text font-semibold text-foreground"
                        >
                          {target?.title}
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onClick={() => {
                              if (target) navigator.clipboard.writeText(target.title);
                            }}
                          >
                            Copy title
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                      &rdquo; to confirm.
                    </p>
                    <ContextMenu>
                      <ContextMenuTrigger className="w-full">
                        <Input
                          value={deleteConfirmText}
                          onChange={(e) => setDeleteConfirmText(e.target.value)}
                          placeholder={target?.title ?? ""}
                        />
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          onClick={async () => {
                            const text = await navigator.clipboard.readText();
                            setDeleteConfirmText(text);
                          }}
                        >
                          Paste
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={resetPrimary}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={selectedLibrary?.managed && deleteFromDisk && deleteConfirmText !== target?.title}
              onClick={() => {
                if (target) onConfirm(target.id, deleteFromDisk);
                resetPrimary();
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Empty Collection With Files Warning */}
      <Dialog
        open={filesWarning != null}
        onOpenChange={(open) => {
          if (!open) onFilesWarningChange(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Collection</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            &ldquo;{filesWarning?.title}&rdquo; contains files on disk. Are you sure you want to delete it?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => onFilesWarningChange(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (filesWarning) onConfirm(filesWarning.id, true);
                onFilesWarningChange(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
