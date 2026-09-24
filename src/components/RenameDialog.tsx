import { NameDialog } from "@/components/NameDialog";

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initialValue: string;
  onSubmit: (newValue: string) => void | Promise<void>;
}

/** Rename anything — the one name form (NameDialog) with a pre-fill. */
export function RenameDialog({ open, onOpenChange, title, initialValue, onSubmit }: RenameDialogProps) {
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      initialValue={initialValue}
      submitLabel="Save"
      onSubmit={(name) => onSubmit(name)}
    />
  );
}
