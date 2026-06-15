import { useCallback, useRef } from "react";

/** Vertical jump rail (A–Z letters, decades, …). Floats just INSIDE the scroll
 *  container's scrollbar (the scrollbar keeps the page edge) — parents add right
 *  padding to their content so nothing sits underneath it.
 *  Click or drag along the rail to jump between sections. */
export function ScrubberRail({
  labels,
  onJump,
}: {
  labels: string[];
  onJump: (label: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const labelFromPointer = useCallback(
    (clientY: number): string | null => {
      const list = listRef.current;
      if (!list || labels.length === 0) return null;
      const rect = list.getBoundingClientRect();
      const idx = Math.floor(((clientY - rect.top) / rect.height) * labels.length);
      return labels[Math.min(labels.length - 1, Math.max(0, idx))];
    },
    [labels],
  );

  return (
    <div
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const l = labelFromPointer(e.clientY);
        if (l) onJump(l);
      }}
      onPointerMove={(e) => {
        if ((e.buttons & 1) === 0) return;
        const l = labelFromPointer(e.clientY);
        if (l) onJump(l);
      }}
      className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 cursor-pointer touch-none select-none flex-col items-center rounded-md bg-background/70 px-0.5 py-1 backdrop-blur-sm"
    >
      <div ref={listRef} className="flex flex-col items-center">
        {labels.map((l) => (
          <span
            key={l}
            className="px-1 text-[10px] font-medium leading-[14px] text-muted-foreground hover:text-primary"
          >
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}
