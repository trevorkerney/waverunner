import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Row windowing for a `repeat(auto-fill, minmax(W, 1fr))` card grid, or
 *  (with no `minColumnWidth`) a single-column list of variable-height
 *  rows: only the rows near the viewport mount; the rows above and below
 *  are stood in for by padding on the grid element itself, so the
 *  scrollbar, scroll offsets, and everything that measures the grid see
 *  the full height.
 *
 *  Row heights are measured from the rendered rows (every card in a grid
 *  row spans the same subgrid tracks, so one card per row is the row) and
 *  remembered; rows never rendered use the mean measured height as the
 *  estimate, which self-corrects as they scroll in. Column count follows
 *  the same arithmetic CSS uses for auto-fill, read off the live gap and
 *  width, so the slice always lines up with the rows CSS will lay out.
 *
 *  The mounted slice is React STATE: a scroll that moves it sets state,
 *  and measurement reads the slice the DOM actually reflects (the one
 *  last rendered), never a newer one still waiting to render.
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

interface RowRange {
  start: number;
  end: number;
}

function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
  }
  return null;
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
  /** The scroller. Omitted = the nearest scrolling ancestor of the grid,
   *  found on mount (lists deep in a page needn't thread the ref down). */
  scrollRef?: RefObject<HTMLElement | null>;
  gridRef: RefObject<HTMLElement | null>;
  count: number;
  /** The auto-fill column minimum. Omitted = a single-column list of
   *  variable-height rows (each child is a row). */
  minColumnWidth?: number;
  estimateRowHeight: number;
  overscan?: number;
  resetKey: string;
  enabled?: boolean;
  frozen?: boolean;
}): GridWindow {
  const foundScrollRef = useRef<HTMLElement | null>(null);
  const scrollEl = () => (scrollRef ? scrollRef.current : foundScrollRef.current);

  // The slice (rows) and the layout facts it was computed from. State so a
  // change always renders; refs only cache measurements.
  const [range, setRange] = useState<RowRange>({ start: 0, end: 0 });
  const [, setVersion] = useState(0);
  // The slice the DOM reflects — what `range` was on the last render.
  const renderedRangeRef = useRef(range);
  renderedRangeRef.current = range;

  const heightsRef = useRef<number[]>([]);
  // The estimate for rows never measured: the MEAN of measured rows (the
  // last measured row swung with every mount on rows of varying height,
  // re-estimating every unmeasured row above the viewport each pass and
  // shifting the content under the scroll position). A mean converges.
  const fallbackRef = useRef(estimateRowHeight);
  const measuredSumRef = useRef(0);
  const measuredCountRef = useRef(0);
  const columnsRef = useRef(1);
  const gapRef = useRef(0);
  const lastResetRef = useRef(resetKey);
  const forgetHeights = () => {
    heightsRef.current = [];
    fallbackRef.current = estimateRowHeight;
    measuredSumRef.current = 0;
    measuredCountRef.current = 0;
  };
  if (lastResetRef.current !== resetKey) {
    lastResetRef.current = resetKey;
    forgetHeights();
  }

  // Read live (not captured): the layout effect may have just changed the
  // column count in the same pass.
  const rowsNow = () => (enabled ? Math.ceil(count / Math.max(1, columnsRef.current)) : 0);
  const rowHeight = (r: number) => heightsRef.current[r] ?? fallbackRef.current;
  // The grid's top edge in the scroller's content coordinates — where row 0
  // begins (the padding sits inside the grid box, so its border top is the
  // origin whatever the padding is). For scrollToIndex only.
  const gridTop = () => {
    const sc = scrollEl();
    const grid = gridRef.current;
    if (!sc || !grid) return 0;
    return grid.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  };
  /** The part of the grid on screen, in grid coordinates (row 0 = 0):
   *  from bounding rects against the window, clipped to the scroller's box
   *  when one is known. Nothing here reads scrollTop, so it's right
   *  whichever element actually scrolls — the guessed scroll parent, an
   *  ancestor of it, or the document. */
  const visibleSpan = (): { top: number; bottom: number } | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const gridRect = grid.getBoundingClientRect();
    const sc = scrollEl();
    let clipTop = 0;
    let clipBottom = window.innerHeight;
    if (sc) {
      const r = sc.getBoundingClientRect();
      clipTop = Math.max(clipTop, r.top);
      clipBottom = Math.min(clipBottom, r.bottom);
    }
    return { top: clipTop - gridRect.top, bottom: clipBottom - gridRect.top };
  };

  /** The slice the scroll position calls for, or null when the current one
   *  still serves. Hysteresis: the slice only moves once the visible rows
   *  have eaten into half its overscan margin (or the row count changed) —
   *  one render per couple of rows scrolled, not one per row boundary. */
  const nextRange = (cur: RowRange): RowRange | null => {
    const rows = rowsNow();
    const span = visibleSpan();
    if (!span || rows === 0) return cur.start === 0 && cur.end === 0 ? null : { start: 0, end: 0 };
    const viewTop = span.top;
    const viewBottom = span.bottom;
    const gap = gapRef.current;
    let y = 0;
    let visStart = -1;
    let visEnd = rows;
    for (let r = 0; r < rows; r++) {
      const h = rowHeight(r);
      if (visStart < 0 && y + h > viewTop) visStart = r;
      if (y > viewBottom) {
        visEnd = r;
        break;
      }
      y += h + gap;
    }
    if (visStart < 0) visStart = Math.max(0, rows - 1);
    const slack = Math.max(1, Math.floor(overscan / 2));
    const serves =
      cur.end <= rows &&
      visStart >= cur.start &&
      visEnd <= cur.end &&
      (visStart - cur.start >= slack || cur.start === 0) &&
      (cur.end - visEnd >= slack || cur.end === rows);
    if (serves) return null;
    const start = Math.max(0, visStart - overscan);
    const end = Math.min(rows, Math.max(visEnd + overscan, start + 1));
    if (start === cur.start && end === cur.end) return null;
    return { start, end };
  };

  /** Read the live column count + gap off the grid; true when either changed. */
  const measureColumns = (): boolean => {
    const grid = gridRef.current;
    if (!grid) return false;
    const cs = getComputedStyle(grid);
    const gap = parseFloat(cs.rowGap) || 0;
    const colGap = parseFloat(cs.columnGap) || 0;
    const width = grid.clientWidth;
    const columns =
      minColumnWidth == null
        ? 1
        : width > 0
          ? Math.max(1, Math.floor((width + colGap) / (minColumnWidth + colGap)))
          : columnsRef.current;
    const changed = columns !== columnsRef.current || gap !== gapRef.current;
    if (columns !== columnsRef.current) forgetHeights(); // rows re-flow: every height is stale
    columnsRef.current = columns;
    gapRef.current = gap;
    return changed;
  };

  /** Row heights from the rendered rows (the slice the DOM reflects); true
   *  when any changed. */
  const measureRows = (): boolean => {
    const grid = gridRef.current;
    if (!grid) return false;
    const { start, end } = renderedRangeRef.current;
    const columns = columnsRef.current;
    const children = grid.children;
    let changed = false;
    for (let r = start; r < end; r++) {
      const child = children[(r - start) * columns] as HTMLElement | undefined;
      if (!child) break;
      const h = child.offsetHeight;
      const had = heightsRef.current[r];
      if (h > 0 && had !== h) {
        heightsRef.current[r] = h;
        if (had == null) {
          measuredCountRef.current++;
          measuredSumRef.current += h;
        } else {
          measuredSumRef.current += h - had;
        }
        fallbackRef.current = measuredSumRef.current / measuredCountRef.current;
        changed = true;
      }
    }
    return changed;
  };

  /** One settle pass: measure, then move the slice if the scroll position
   *  calls for it (or re-render for new measurements alone, so the padding
   *  reflects them). Shared by the layout effect and the DOM listeners. */
  const settle = (opts: { measure: boolean }) => {
    if (!enabled) return;
    let remeasured = false;
    if (opts.measure) {
      const a = measureColumns();
      const b = measureRows();
      remeasured = a || b;
    }
    const next = frozen ? null : nextRange(renderedRangeRef.current);
    if (next) setRange(next);
    else if (remeasured) setVersion((v) => v + 1);
  };

  // Keep the latest closure reachable from the DOM listeners without re-binding.
  const settleRef = useRef(settle);
  settleRef.current = settle;

  // After every render: measure what's mounted and settle the slice before
  // paint. Each pass only sets state when something moved, so it converges
  // in a pass or two; a pathological layout (a scrollbar flipping the column
  // count with every padding change) is capped per frame.
  const passesRef = useRef(0);
  useLayoutEffect(() => {
    if (!enabled) {
      if (range.start !== 0 || range.end !== 0) setRange({ start: 0, end: 0 });
      return;
    }
    if (!scrollRef) foundScrollRef.current = scrollParentOf(gridRef.current);
    if (passesRef.current++ === 0) requestAnimationFrame(() => (passesRef.current = 0));
    if (passesRef.current > 8) return;
    settle({ measure: true });
  });

  // Listeners. Scroll is heard at the document, capturing — scroll events
  // don't bubble, but capture sees every element's, so it doesn't matter
  // which ancestor is the one that scrolls. Resize watches the grid (its
  // width sets the columns, its height moves with the padding) and the
  // scroller's box when one is known. Re-bound when the ref lands on a
  // new element.
  const boundRef = useRef<{ sc: HTMLElement | null; grid: HTMLElement; off: () => void } | null>(null);
  useLayoutEffect(() => {
    if (!scrollRef) foundScrollRef.current = scrollParentOf(gridRef.current);
    const sc = scrollEl();
    const grid = gridRef.current;
    if (!enabled || !grid) {
      boundRef.current?.off();
      boundRef.current = null;
      return;
    }
    if (boundRef.current && boundRef.current.sc === sc && boundRef.current.grid === grid) return;
    boundRef.current?.off();
    // Scroll events outrun frames (wheel bursts, scrollbar drags); one
    // settle per frame is all a frame can show.
    let scrollFrame: number | null = null;
    const onScroll = () => {
      if (scrollFrame != null) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null;
        settleRef.current({ measure: false });
      });
    };
    const ro = new ResizeObserver(() => settleRef.current({ measure: true }));
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    if (sc) ro.observe(sc);
    ro.observe(grid);
    boundRef.current = {
      sc,
      grid,
      off: () => {
        document.removeEventListener("scroll", onScroll, { capture: true });
        if (scrollFrame != null) cancelAnimationFrame(scrollFrame);
        ro.disconnect();
      },
    };
  });
  // Unmount: unbind AND forget the binding — StrictMode (dev) runs this
  // teardown and then the effects again on mount, and a binding left on
  // record would make the rebind pass skip itself: a grid with no scroll
  // listener at all.
  useLayoutEffect(
    () => () => {
      boundRef.current?.off();
      boundRef.current = null;
    },
    [],
  );

  const scrollToIndex = useCallback(
    (index: number, delta = 0) => {
      const sc = scrollEl();
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
  const startRow = Math.min(range.start, rows);
  const endRow = Math.min(range.end, rows);
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
