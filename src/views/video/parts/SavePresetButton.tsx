import { Save } from "lucide-react";

/** Trivial icon-only button for opening the sort-preset save dialog. View decides when
 *  to render it (typically when sortMode === "custom" at a sortable scope with entries). */
export function SavePresetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      title="Save current order as a preset"
    >
      <Save size={14} />
    </button>
  );
}
