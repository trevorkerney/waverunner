import type { ReactNode } from "react";

/** Pure layout shell for grid toolbars. Takes any children — each view composes its own
 *  toolbar contents (search input, sort dropdown, save button, size slider, etc). No
 *  view-kind awareness, no configuration props. */
export function GridToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-2">
      {children}
    </div>
  );
}
