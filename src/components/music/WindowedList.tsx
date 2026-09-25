import { Fragment, useRef, type ReactNode } from "react";
import { useGridWindow } from "@/hooks/useGridWindow";

/** A stacked list that mounts only the rows near the viewport. The
 *  Metadata page's lists run to hundreds of rows each (every unmatched
 *  artist, every unmatched album) and used to render in full — so any
 *  page-level state change (a radio, the busy key) re-rendered them all
 *  before the click could paint.
 *
 *  One element per item: the window measures each child as a row, so
 *  `renderRow` must return exactly one element (wrap multi-part rows in a
 *  div). Rows above and below the slice are stood in for by padding on
 *  the container, so the scrollbar sees the full height. `renderRow` gets
 *  the item's index in the FULL list (first-row styling). The scroller is
 *  found by the hook (the nearest scrolling ancestor). */
export function WindowedList<T>({
  items,
  keyOf,
  renderRow,
  className,
  estimateRowHeight = 34,
  resetKey,
}: {
  items: T[];
  keyOf: (item: T) => string | number;
  renderRow: (item: T, index: number) => ReactNode;
  className?: string;
  /** Height guess for rows never measured yet. */
  estimateRowHeight?: number;
  /** Forgets measured heights when it changes (a filter reorders rows). */
  resetKey: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const win = useGridWindow({
    gridRef: ref,
    count: items.length,
    estimateRowHeight,
    overscan: 12,
    resetKey,
  });
  return (
    <div ref={ref} className={className} style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
      {items.slice(win.start, win.end).map((item, j) => (
        <Fragment key={keyOf(item)}>{renderRow(item, win.start + j)}</Fragment>
      ))}
    </div>
  );
}
