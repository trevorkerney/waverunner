import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Windowing for a flat list of uniform-height rows (the Tracks page): only
 *  rows near the viewport mount; the list pads itself for the rest so the
 *  scrollbar and every offset still see the full height. The row height is
 *  read off the first mounted row (falling back to `estimateRowHeight`
 *  until one exists). The scroll container is found by walking up from the
 *  list element to the nearest ancestor that scrolls vertically, so pages
 *  don't need to thread their scroller's ref down. */
export interface ListWindow {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  /** Scroll so `index`'s row sits at the top (`start`) or middle (`center`)
   *  of the scroller. Exact — every row is the same height. */
  scrollToIndex: (index: number, block?: "start" | "center") => void;
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

export function useListWindow({
  listRef,
  count,
  estimateRowHeight,
  overscan = 12,
}: {
  listRef: RefObject<HTMLElement | null>;
  count: number;
  estimateRowHeight: number;
  overscan?: number;
}): ListWindow {
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const scRef = useRef<HTMLElement | null>(null);
  const rowHeightRef = useRef(estimateRowHeight);
  const rangeRef = useRef({ start: 0, end: 0 });

  const listTop = () => {
    const sc = scRef.current;
    const list = listRef.current;
    if (!sc || !list) return 0;
    return list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  };

  const computeRange = (): boolean => {
    const sc = scRef.current;
    const h = rowHeightRef.current;
    let start = 0;
    let end = 0;
    if (sc && count > 0 && h > 0) {
      const top = listTop();
      start = Math.max(0, Math.floor((sc.scrollTop - top) / h) - overscan);
      end = Math.min(count, Math.ceil((sc.scrollTop - top + sc.clientHeight) / h) + overscan);
      if (end < start) end = start;
    }
    const cur = rangeRef.current;
    if (cur.start === start && cur.end === end) return false;
    rangeRef.current = { start, end };
    return true;
  };

  const measureRow = (): boolean => {
    const list = listRef.current;
    const first = list?.children[0] as HTMLElement | undefined;
    if (!first) return false;
    const h = first.offsetHeight;
    if (h > 0 && h !== rowHeightRef.current) {
      rowHeightRef.current = h;
      return true;
    }
    return false;
  };

  const latestRef = useRef({ computeRange, measureRow });
  latestRef.current = { computeRange, measureRow };

  // Settle before paint: find the scroller, read the row height, place the
  // slice. Converges in a pass or two (state only moves when a value did).
  useLayoutEffect(() => {
    scRef.current = scrollParentOf(listRef.current);
    const a = measureRow();
    const b = computeRange();
    if (a || b) bump();
  });

  const boundRef = useRef<{ sc: HTMLElement; off: () => void } | null>(null);
  useLayoutEffect(() => {
    const sc = scRef.current;
    if (!sc) {
      boundRef.current?.off();
      boundRef.current = null;
      return;
    }
    if (boundRef.current?.sc === sc) return;
    boundRef.current?.off();
    const onScroll = () => {
      if (latestRef.current.computeRange()) bump();
    };
    const ro = new ResizeObserver(() => {
      const l = latestRef.current;
      const a = l.measureRow();
      const b = l.computeRange();
      if (a || b) bump();
    });
    sc.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(sc);
    boundRef.current = {
      sc,
      off: () => {
        sc.removeEventListener("scroll", onScroll);
        ro.disconnect();
      },
    };
  });
  useLayoutEffect(() => () => boundRef.current?.off(), []);

  const scrollToIndex = useCallback(
    (index: number, block: "start" | "center" = "start") => {
      const sc = scRef.current;
      if (!sc) return;
      const h = rowHeightRef.current;
      const y = listTop() + index * h;
      sc.scrollTop = block === "center" ? y - (sc.clientHeight - h) / 2 : y;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listRef],
  );

  const { start, end } = rangeRef.current;
  const h = rowHeightRef.current;
  const s = Math.min(start, count);
  const e = Math.min(end, count);
  return { start: s, end: e, padTop: s * h, padBottom: (count - e) * h, scrollToIndex };
}
