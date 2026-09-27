import { memo, useEffect, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { useGridWindow, type GridWindow } from "@/hooks/useGridWindow";

/** The row-windowed card grid as a component of its own, so that the
 *  window's slice — React state that moves on every scrolled row — re-
 *  renders only this element and the cards entering it. It used to live in
 *  the page component, where each slice move re-rendered the whole page
 *  (169 hooks, every dialog) before React reached the grid: ~180ms of main
 *  thread per row in the dev build, which middle-click autoscroll (main-
 *  thread driven, velocity × elapsed time) turned into a jump per row
 *  (2026-09-26).
 *
 *  Without `minColumnWidth` it is a windowed LIST instead: one item per
 *  row, rows of any height (each measured as it mounts), no grid template
 *  imposed — the className decides the layout (a `divide-y` stack, say).
 *  The match dialog's discography and release lists use this.
 *
 *  A parent that reads the mounted cards (a FLIP effect, a scrubber) passes
 *  the grid element's ref; one that doesn't lets the grid keep its own.
 *  The scroller is passed, or found (the nearest scrolling ancestor). The
 *  window's scrollToIndex comes back through `windowRef`, cleared on
 *  unmount so a stale window is never scrolled. `renderItem` returns a
 *  keyed element per item; keep it and the other props stable, and a
 *  parent render that changes none of them leaves this grid alone. */
function WindowedGridInner<T>({
  items,
  renderItem,
  gridRef,
  scrollRef,
  minColumnWidth,
  estimateRowHeight,
  overscan = 3,
  resetKey,
  enabled = true,
  frozen = false,
  className,
  windowRef,
}: {
  items: T[];
  renderItem: (item: T) => ReactNode;
  gridRef?: RefObject<HTMLDivElement | null>;
  scrollRef?: RefObject<HTMLElement | null>;
  /** The auto-fill column minimum; omitted = a single-column list. */
  minColumnWidth?: number;
  estimateRowHeight: number;
  overscan?: number;
  resetKey: string;
  enabled?: boolean;
  frozen?: boolean;
  className: string;
  /** The parent's handle on the window (scrollToIndex), assigned each render. */
  windowRef?: MutableRefObject<GridWindow | null>;
}) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const ref = gridRef ?? ownRef;
  const gridWindow = useGridWindow({
    scrollRef,
    gridRef: ref,
    count: items.length,
    minColumnWidth,
    estimateRowHeight,
    overscan,
    resetKey,
    enabled,
    frozen,
  });
  if (windowRef) windowRef.current = gridWindow;
  useEffect(
    () => () => {
      if (windowRef) windowRef.current = null;
    },
    [windowRef],
  );
  return (
    <div
      ref={ref}
      className={className}
      style={{
        gridTemplateColumns:
          minColumnWidth != null ? `repeat(auto-fill, minmax(${minColumnWidth}px, 1fr))` : undefined,
        justifyItems: minColumnWidth != null ? "center" : undefined,
        // Windowing: the rows that aren't mounted are this padding.
        paddingTop: gridWindow.padTop,
        paddingBottom: gridWindow.padBottom,
      }}
    >
      {items.slice(gridWindow.start, gridWindow.end).map(renderItem)}
    </div>
  );
}

export const WindowedGrid = memo(WindowedGridInner) as typeof WindowedGridInner;
