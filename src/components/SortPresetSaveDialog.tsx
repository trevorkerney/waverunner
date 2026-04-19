import { useEffect, useState } from "react";
import { toast } from "sonner";
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

interface SortPresetSaveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Throws with message "exists" on name collision; otherwise resolves. */
  onSave: (name: string, overwrite: boolean) => Promise<void>;
}

/**
 * Two-step save flow: first attempt passes overwrite=false. If the backend returns the
 * literal "exists" error string, the dialog swaps into confirm mode and retries with
 * overwrite=true. Prevents silent destructive overwrites while keeping the re-save flow
 * (save with the same name to update an existing preset) to two clicks.
 */
export function SortPresetSaveDialog({
  open,
  onOpenChange,
  onSave,
}: SortPresetSaveDialogProps) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setSaving(false);
      setConfirmingOverwrite(false);
    }
  }, [open]);

  async function handleSave(overwrite: boolean) {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onSave(trimmed, overwrite);
      onOpenChange(false);
    } catch (e) {
      const msg = String(e);
      // Backend signals name collision via the literal "exists" error.
      if (!overwrite && msg.includes("exists")) {
        setConfirmingOverwrite(true);
      } else {
        toast.error(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{confirmingOverwrite ? "Overwrite preset?" : "Save sort preset"}</DialogTitle>
        </DialogHeader>
        {confirmingOverwrite ? (
          <p className="text-sm text-muted-foreground">
            A preset named &ldquo;{name.trim()}&rdquo; already exists at this location. Overwrite it with the current order?
          </p>
        ) : (
          <div className="grid gap-3 py-2">
            <Label htmlFor="preset-name">Name</Label>
            <Input
              id="preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Chronological"
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(false); }}
              autoFocus
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          {confirmingOverwrite ? (
            <Button onClick={() => handleSave(true)} disabled={saving}>
              Overwrite
            </Button>
          ) : (
            <Button onClick={() => handleSave(false)} disabled={!name.trim() || saving}>
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
