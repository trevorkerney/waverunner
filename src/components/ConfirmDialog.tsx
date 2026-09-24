import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// App-styled confirmation. Replaces window.confirm, which WebView2 can't
// block on — it painted a native dialog and returned immediately, so the
// "confirmed" action ran before (and regardless of) the user's answer.
// Every yes/no box in the app is this one: destructive by default (red
// confirm), or a plain choice with `destructive={false}`.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  destructive = true,
  lines = 2,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** How many lines the message wraps to at this width (24rem): the frame
   *  is sized to exactly that — static, never to the text. */
  lines?: 1 | 2 | 3 | 4 | 5;
  onConfirm: () => void;
}) {
  // 136 (frame, see NameDialog) + 20 per line of text-sm.
  const height = `${(136 + 20 * lines) / 16}rem`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} dismiss="self">
      <DialogContent size="sm" height={height}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>{message}</DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
