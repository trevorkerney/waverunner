import { useLayoutEffect, useRef } from "react";

/** FLIP for a container of `[data-flip-id]` children: when the SET/ORDER of
 *  ids changes between renders, each surviving child animates from its old
 *  layout position to its new one instead of snapping. Benign re-renders
 *  (selection, spinners, scrolling) only refresh the baseline.
 *
 *  Positions are offsetLeft/offsetTop — layout coordinates, immune to any
 *  in-flight CSS transforms (dnd-kit drags), unlike getBoundingClientRect.
 *
 *  `skip()` — return true to rebaseline WITHOUT animating this render; used
 *  around drag-drops, where dnd-kit runs its own settle animation and a FLIP
 *  on top would double-move the rows. */
export function useFlipList(
  containerRef: React.RefObject<HTMLElement | null>,
  opts?: { skip?: () => boolean },
) {
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const keysRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      positionsRef.current = new Map();
      keysRef.current = [];
      return;
    }
    const els = Array.from(container.querySelectorAll<HTMLElement>("[data-flip-id]"));
    const prev = positionsRef.current;
    const prevKeys = keysRef.current;
    const next = new Map<string, { x: number; y: number }>();
    const keys: string[] = [];
    for (const el of els) {
      const key = el.dataset.flipId!;
      keys.push(key);
      next.set(key, { x: el.offsetLeft, y: el.offsetTop });
    }
    const listChanged =
      prevKeys.length !== keys.length || keys.some((k, i) => prevKeys[i] !== k);
    if (listChanged && prev.size > 0 && !opts?.skip?.()) {
      const running: Animation[] = [];
      for (const el of els) {
        const old = prev.get(el.dataset.flipId!);
        if (!old) continue;
        const now = next.get(el.dataset.flipId!)!;
        const dx = old.x - now.x;
        const dy = old.y - now.y;
        if (dx !== 0 || dy !== 0) {
          running.push(
            el.animate(
              [
                { transform: `translate(${dx}px, ${dy}px)` },
                { transform: "translate(0px, 0px)" },
              ],
              { duration: 280, easing: "cubic-bezier(0.2, 0, 0, 1)" },
            ),
          );
        }
      }
      // Nothing in the list is clickable while it's in motion — a card
      // sliding under the cursor turns a decisive click into a misclick on
      // whatever arrived beneath it. Interaction returns when the slide ends.
      if (running.length > 0) {
        for (const el of els) el.style.pointerEvents = "none";
        void Promise.allSettled(running.map((a) => a.finished)).then(() => {
          for (const el of els) el.style.pointerEvents = "";
        });
      }
    }
    positionsRef.current = next;
    keysRef.current = keys;
  });
}
