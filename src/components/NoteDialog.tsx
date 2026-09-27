import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** The one note editor: a note on an artist, album, movie, show, video
 *  collection or person, or a playlist's description (the same thing under
 *  the name playlists use). Opened from the NoteBlock on the entity's page
 *  with the current text; Save hands the new text back and closes, Cancel /
 *  X / Escape close without saving. Ctrl+Enter saves — Enter is a newline,
 *  it's a textarea. Saving an emptied box is allowed: that removes the
 *  note. Never locked: a note is the user's remark, not library data. */
export function NoteDialog({
  open,
  onOpenChange,
  label,
  subject,
  initialValue,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: "note" | "description";
  /** What the note is on — the header's second line. */
  subject?: string;
  initialValue: string;
  /** Throw to keep the dialog open (the caller reports the error). */
  onSubmit: (text: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  // The first focus after opening is the shell's initial focus, not a
  // click: put the caret at the end, so an existing note continues rather
  // than starting over at the top. Later focuses (clicks) are left alone.
  const firstFocus = useRef(true);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setBusy(false);
    firstFocus.current = true;
  }, [open, initialValue]);

  const trimmed = value.trim();
  const canSubmit = !busy && trimmed !== initialValue.trim();

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch {
      // Reported by the caller; the text stays for another try.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} dismiss="self">
      {/* Static: 16 pad + 20 title + 8 + 20 subject + 16 gap + 236 body (the
          textarea fills it — eleven lines, then it scrolls) + 16 gap + 68
          footer = 400px. */}
      <DialogContent size="md" height="25rem">
        <DialogHeader>
          <DialogTitle>{label === "description" ? "Description" : "Note"}</DialogTitle>
          {subject && <DialogDescription>{subject}</DialogDescription>}
        </DialogHeader>
        {/* -m-1 p-1: the body is a scroll box and clips the focus ring on
            every side; the lane gives the ring room without moving anything. */}
        <DialogBody className="-m-1 flex flex-col p-1">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => {
              if (!firstFocus.current) return;
              firstFocus.current = false;
              const el = e.currentTarget;
              el.setSelectionRange(el.value.length, el.value.length);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            disabled={busy}
            placeholder={
              label === "description"
                ? "What this playlist is for…"
                : "Anything worth remembering about this…"
            }
            className="h-full w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            autoFocus
          />
        </DialogBody>
        <DialogFooter>
          <p className="mr-auto self-center text-[11px] text-muted-foreground">Ctrl+Enter saves</p>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
