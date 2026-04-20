import { ArrowUpDown, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export type SortOption = {
  id: string;
  label: string;
  onClick: () => void;
  /** When provided, renders a trash icon on the right of the item. Used for savable
   *  presets that can be deleted from the dropdown directly. */
  onDelete?: () => void;
};

/** Pure, view-agnostic sort dropdown. Each view builds its own options list and passes
 *  the currently-selected label. No internal branching on view kind — if a view doesn't
 *  want a Date option, it simply doesn't include it in `options`. */
export function SortDropdown({
  triggerLabel,
  options,
  separatorBeforeIndex,
}: {
  triggerLabel: string;
  options: SortOption[];
  /** Optional — when set, a visual separator renders between options[separatorBeforeIndex - 1]
   *  and options[separatorBeforeIndex]. Typically used to separate built-in sorts from presets. */
  separatorBeforeIndex?: number;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
        <ArrowUpDown size={12} />
        {triggerLabel}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((opt, i) => (
          <div key={opt.id}>
            {separatorBeforeIndex != null && i === separatorBeforeIndex && (
              <DropdownMenuSeparator />
            )}
            <DropdownMenuItem
              onClick={opt.onClick}
              className={
                opt.onDelete
                  ? "flex items-center justify-between gap-2"
                  : undefined
              }
            >
              <span className="truncate">{opt.label}</span>
              {opt.onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    opt.onDelete!();
                  }}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${opt.label}`}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
