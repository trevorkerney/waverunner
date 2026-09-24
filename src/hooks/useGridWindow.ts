import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Row windowing for a `repeat(auto-fill, minmax(W, 1fr))` card grid: only
 *  the rows near the viewport mount; the rows above and below are stood in
 *  for by padding on the grid element itself, so the scrollbar, scroll
 *  offsets, and everything that measures the grid see the full height.
 *
 *  Row heights are measured from the rendered cards (every card in a row
 *  spans the same subgrid tracks, so one card per row is the row) and
 *  remembered; rows never rendered use the last measured height as the
 *  estimate, which self-corrects as they scroll in. Column count follows
 *  the same arithmetic CSS uses for auto-fill, read off the live gap and
 *  width, so the slice always lines up with the rows CSS will lay out.
 *
 *  `enabled` false = no windowing (everything renders, no padding). Used
 *  while the ref points at a different kind of list than a card grid.
 *  `frozen` holds the current slice (drags: the active card must stay
 *  mounted). `resetKey` forgets measured heights (cover size, column
 *  count, navigation — anything that changes what a row is). */
export interface GridWindow {
  /** Item indices to render: [start, end). */
  start: number;
  end: number;
  columns: number;
  padTop: number;
  padBottom: number;
  /** Scroll the container so the row holding `index` sits `delta` px below
   *  the container's top edge. Callers fine-tune against the real element
   *  once it has rendered (estimated rows above make this approximate). */
  scrollToIndex: (index: number, delta?: number) => void;
}

export function useGridWindow({
  scrollRef,
  gridRef,
  count,
  minColumnWidth,
  estimateRowHeight,
  overscan = 2,
  resetKey,
  enabled = true,
  frozen = false,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  gridRef: RefObject<HTMLElement | null>;
  count: number;
  minColumnWidth: number;
  estimateRowHeight: number;
  overscan?: number;
  resetKey: string;
  enabled?: boolean;
  frozen?: boolean;
}): GridWindow {
  // Refs are the truth; `version` only asks React to re-read them.
  const [, setVersion] = useState(0);
  // Re-renders from the layout effect are synchronous, so a measurement
  // that never settles (a scrollbar flipping the column count with every
  // padding change, say) would recurse. Cap the passes per frame.
  const burstRef = useRef(0);
  const bump = useCallback(() => {
    if (burstRef.current++ >= 6) return;
    if (burstRef.current === 1) requestAnimationFrame(() => (burstRef.current = 0));
    setVersion((v) => v + 1);
  }, []);
  const heightsRef = useRef<number[]>([]);
  const fallbackRef = useRef(estimateRowHeight);
  const columnsRef = useRef(1);
  const gapRef = useRef(0);
  const rowRangeRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const lastResetRef = useRef(resetKey);
  if (lastResetRef.current !== resetKey) {
    lastResetRef.current = resetKey;
    heightsRef.current = [];
    fallbackRef.current = estimateRowHeight;
  }

  // Read live (not captured): the layout effect may have just changed the
  // column count in the same pass.
  const rowsNow = () => (enabled ? Math.ceil(count / Math.max(1, columnsRef.current)) : 0);
  const rowHeight = (r: number) => heightsRef.current[r] ?? fallbackRef.current;
  // The grid's top edge in the scroller's content coordinates — where row 0
  // begins (the padding sits inside the grid box, so its border top is the
  // origin whatever the padding is).
  const gridTop = () => {
    const sc = scrollRef.current;
    const grid = gridRef.current;
    if (!sc || !grid) return 0;
    return grid.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  };

  /** Recompute the visible row range from the scroll position. Returns true
   *  when it moved. */
  const computeRange = (): boolean => {
    const sc = scrollRef.current;
    const rows = rowsNow();
    if (!sc || rows === 0) {
      const changed = rowRangeRef.current.start !== 0 || rowRangeRef.current.end !== 0;
      rowRangeRef.current = { start: 0, end: 0 };
      return changed;
    }
    const top = gridTop();
    const viewTop = sc.scrollTop - top;
    const viewBottom = viewTop + sc.clientHeight;
    const gap = gapRef.current;
    let y = 0;
    let startRow = -1;
    let endRow = rows;
    for (let r = 0; r < rows; r++) {
      const h = rowHeight(r);
      if (startRow < 0 && y + h > viewTop) startRow = r;
      if (y > viewBottom) {
        endRow = r;
        break;
      }
      y += h + gap;
    }
    if (startRow < 0) startRow = Math.max(0, rows - 1);
    startRow = Math.max(0, startRow - overscan);
    endRow = Math.min(rows, Math.max(endRow + overscan, startRow + 1));
    const cur = rowRangeRef.current;
    if (cur.start === startRow && cur.end === endRow) return false;
    rowRangeRef.current = { start: startRow, end: endRow };
    return true;
  };

  /** Read the live column count + gap off the grid; true when either changed. */
  const measureColumns = (): boolean => {
    const grid = gridRef.current;
    if (!grid) return false;
    const cs = getComputedStyle(grid);
    const gap = parseFloat(cs.rowGap) || 0;
    const colGap = parseFloat(cs.columnGap) || 0;
    const width = grid.clientWidth;
    const columns = width > 0 ? Math.max(1, Math.floor((width + colGap) / (minColumnWidth + colGap))) : columnsRef.current;
    const changed = columns !== columnsRef.current || gap !== gapRef.current;
    if (columns !== columnsRef.current) heightsRef.current = []; // rows re-flow: every height is stale
    columnsRef.current = columns;
    gapRef.current = gap;
    return changed;
  };

  /** Row heights from the rendered cards; true when any changed. */
  const measureRows = (): boolean => {
    const grid = gridRef.current;
    if (!grid) return false;
    const { start, end } = rowRangeRef.current;
    const columns = columnsRef.current;
    const children = grid.children;
    let changed = false;
    for (let r = start; r < end; r++) {
      const child = children[(r - start) * columns] as HTMLElement | undefined;
      if (!child) break;
      const h = child.offsetHeight;
      if (h > 0 && heightsRef.current[r] !== h) {
        heightsRef.current[r] = h;
        fallbackRef.current = h;
        changed = true;
      }
    }
    return changed;
  };

  // Keep latest closures reachable from the DOM listeners without re-binding.
  const latestRef = useRef({ computeRange, measureColumns, measureRows, enabled, frozen });
  latestRef.current = { computeRange, measureColumns, measureRows, enabled, frozen };

  // After every render: measure what's mounted and settle the slice before
  // paint. State only changes when a value actually moved, so this converges
  // in one or two synchronous passes.
  useLayoutEffect(() => {
    if (!enabled) {
      if (rowRangeRef.current.start !== 0 || rowRangeRef.current.end !== 0) {
        rowRangeRef.current = { start: 0, end: 0 };
      }
      return;
    }
    const colsChanged = measureColumns();
    const rowsChanged = measureRows();
    const rangeChanged = frozen ? false : computeRange();
    if (colsChanged || rowsChanged || rangeChanged) bump();
  });

  // Scroll + resize listeners, re-bound whenever the ref lands on a new element.
  const boundRef = useRef<{ sc: HTMLElement; grid: HTMLElement; off: () => void } | null>(null);
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const grid = gridRef.current;
    if (!enabled || !sc || !grid) {
      boundRef.current?.off();
      boundRef.current = null;
      return;
    }
    if (boundRef.current && boundRef.current.sc === sc && boundRef.current.grid === grid) return;
    boundRef.current?.off();
    const onScroll = () => {
      const l = latestRef.current;
      if (!l.enabled || l.frozen) return;
      if (l.computeRange()) bump();
    };
    const ro = new ResizeObserver(() => {
      const l = latestRef.current;
      if (!l.enabled) return;
      const cols = l.measureColumns();
      const rowsChanged = l.measureRows();
      const range = l.frozen ? false : l.computeRange();
      if (cols || rowsChanged || range) bump();
    });
    sc.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(sc);
    ro.observe(grid);
    boundRef.current = {
      sc,
      grid,
      off: () => {
        sc.removeEventListener("scroll", onScroll);
        ro.disconnect();
      },
    };
  });
  useLayoutEffect(() => () => boundRef.current?.off(), []);

  const scrollToIndex = useCallback(
    (index: number, delta = 0) => {
      const sc = scrollRef.current;
      if (!sc) return;
      const columns = Math.max(1, columnsRef.current);
      const row = Math.max(0, Math.floor(index / columns));
      let y = 0;
      for (let i = 0; i < row; i++) y += (heightsRef.current[i] ?? fallbackRef.current) + gapRef.current;
      sc.scrollTop = gridTop() + y - delta;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollRef, gridRef],
  );

  if (!enabled) {
    return { start: 0, end: count, columns: columnsRef.current, padTop: 0, padBottom: 0, scrollToIndex };
  }
  const columns = Math.max(1, columnsRef.current);
  const rows = rowsNow();
  const { start: startRow, end: endRow } = rowRangeRef.current;
  const gap = gapRef.current;
  let padTop = 0;
  for (let r = 0; r < startRow; r++) padTop += rowHeight(r) + gap;
  let padBottom = 0;
  for (let r = endRow; r < rows; r++) padBottom += gap + rowHeight(r);
  return {
    start: Math.min(count, startRow * columns),
    end: Math.min(count, endRow * columns),
    columns,
    padTop,
    padBottom,
    scrollToIndex,
  };
}
