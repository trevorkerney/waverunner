import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogBody,
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

/** The two states' fade and the frame's resize: 200 / 200 / 200. */
const STEP_MS = 200;

/**
 * Two-step save flow: first attempt passes overwrite=false. If the backend returns the
 * literal "exists" error string, the dialog swaps into confirm mode and retries with
 * overwrite=true. Prevents silent destructive overwrites while keeping the re-save flow
 * (save with the same name to update an existing preset) to two clicks.
 *
 * The question behaves like a child of the name form: Cancel steps back to
 * the form (name kept), Overwrite finishes both. The swap is the modal
 * transition — everything fades out, the frame resizes, everything fades in.
 */
export function SortPresetSaveDialog({
  open,
  onOpenChange,
  onSave,
}: SortPresetSaveDialogProps) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  // The state asked for, and the state on screen (lags through the swap).
  const [confirming, setConfirming] = useState(false);
  const [shown, setShown] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (open) {
      setName("");
      setSaving(false);
      setConfirming(false);
      setShown(false);
      setVisible(true);
    }
  }, [open]);

  // Keyed on the REQUEST only: the swap itself changes `shown`, and having
  // that re-run the effect cancelled the fade-in timer (blank dialog).
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (confirming === shownRef.current) return;
    setVisible(false);
    // Fade out → swap content AND re-declare the frame (the shell resizes
    // it, content kept but invisible) → fade in.
    const t1 = window.setTimeout(() => setShown(confirming), STEP_MS);
    const t2 = window.setTimeout(() => setVisible(true), STEP_MS * 2);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [confirming]);

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
        setConfirming(true);
      } else {
        toast.error(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} dismiss="self">
      {/* Two static sizes: the name form's 194px (see NameDialog), and the
          question's 136 + two lines = 176px. */}
      <DialogContent size="sm" height={shown ? "11rem" : "12.125rem"}>
        <div
          className={`flex h-full min-h-0 flex-col gap-4 transition-opacity duration-200 ${
            visible ? "opacity-100" : "opacity-0"
          }`}
        >
          <DialogHeader>
            <DialogTitle>{shown ? "Overwrite preset?" : "Save sort preset"}</DialogTitle>
          </DialogHeader>
          <DialogBody className="-mx-1 px-1">
            {shown ? (
              <p className="text-sm text-muted-foreground">
                A preset named &ldquo;{name.trim()}&rdquo; already exists at this location. Overwrite it with the current order?
              </p>
            ) : (
              <div className="grid gap-2">
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
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => (shown ? setConfirming(false) : onOpenChange(false))}
              disabled={saving || !visible}
            >
              Cancel
            </Button>
            {shown ? (
              <Button onClick={() => handleSave(true)} disabled={saving || !visible}>
                Overwrite
              </Button>
            ) : (
              <Button onClick={() => handleSave(false)} disabled={!name.trim() || saving || !visible}>
                Save
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
