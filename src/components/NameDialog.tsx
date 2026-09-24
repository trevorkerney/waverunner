import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ImageIcon, X } from "lucide-react";
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

/** The one name form: rename anything, create a collection, create a
 *  playlist (with its optional cover). Every "type a name" box in the app
 *  is this, so they all get one size and one behaviour.
 *  - Enter submits; the button disables on empty / unchanged / busy.
 *  - `dismiss="self"`: it's a small box over whatever opened it. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  initialValue = "",
  placeholder,
  submitLabel = "Save",
  withCover = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Pre-filled name (rename). Submitting the same value is disabled. */
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  /** Adds the "Cover (optional)" picker row — the file path comes back
   *  as the second argument. */
  withCover?: boolean;
  onSubmit: (name: string, coverSource: string | null) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [coverSource, setCoverSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setCoverSource(null);
    setBusy(false);
  }, [open, initialValue]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !busy && (initialValue === "" || trimmed !== initialValue);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit(trimmed, coverSource);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  async function pickCover() {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
    });
    if (selected && typeof selected === "string") setCoverSource(selected);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} dismiss="self">
      {/* Static, sized to the form exactly: 16 pad + 20 title + 16 gap +
          (14 label + 8 + 36 input) + 16 gap + 68 footer = 194px. The cover
          row adds 8 + 14 + 8 + 80 (the square preview, a placeholder until
          an image is picked) → 304px. */}
      <DialogContent size="sm" height={withCover ? "19rem" : "12.125rem"}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* -mx-1 px-1: the body is a scroll box, which clips sideways too —
            the input's focus ring needs a lane to spill into. */}
        <DialogBody className="-mx-1 grid content-start gap-2 px-1">
          <Label htmlFor="name-dialog-value">Name</Label>
          <Input
            id="name-dialog-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            autoFocus
          />
          {withCover && (
            <>
              <Label>Cover (optional)</Label>
              <div className="flex items-center gap-3">
                {/* The square slot is always there (playlist and collection
                    covers are square in both library kinds): a placeholder
                    until an image is picked, so nothing moves. */}
                <div className="relative">
                  {coverSource ? (
                    <img
                      src={convertFileSrc(coverSource)}
                      alt="Cover preview"
                      className="size-20 rounded object-cover"
                    />
                  ) : (
                    <div className="flex size-20 items-center justify-center rounded border border-dashed border-border bg-muted/40 text-muted-foreground">
                      <ImageIcon size={20} />
                    </div>
                  )}
                  {coverSource && (
                    <button
                      type="button"
                      onClick={() => setCoverSource(null)}
                      className="absolute -right-1 -top-1 rounded-full bg-background p-0.5 text-muted-foreground shadow hover:text-foreground"
                      aria-label="Remove cover"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={pickCover}>
                  <ImageIcon size={14} />
                  {coverSource ? "Change" : "Choose image"}
                </Button>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
