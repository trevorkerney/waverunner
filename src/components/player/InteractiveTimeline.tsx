import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { InteractiveHistoryEntry } from "../../types";
import { PlayerActions } from "../../hooks/usePlayer";

// "Previous choices" — the rewind timeline. Cards are the decision points of
// the current playthrough (oldest → newest); clicking one restores that
// moment's story state and seeks back to just before the choice re-presents.
// Rewinding discards nothing — the future is abandoned only when a different
// (or the same) choice is committed afterwards.
//
// Thumbnails are real frames grabbed from the video at each choice point via
// the seek-preview thumbnailer (no Netflix asset dependency). Playback pauses
// while the timeline is open and resumes on close/jump.

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    : `${m}:${sec.toString().padStart(2, "0")}`;
}

interface InteractiveTimelineProps {
  open: boolean;
  onClose: () => void;
  actions: PlayerActions;
  isPlaying: boolean;
}

export function InteractiveTimeline({ open, onClose, actions, isPlaying }: InteractiveTimelineProps) {
  const [entries, setEntries] = useState<InteractiveHistoryEntry[]>([]);
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  const [focusIndex, setFocusIndex] = useState(0);
  const pausedByUsRef = useRef(false);
  const thumbsRef = useRef<Map<number, string>>(new Map());
  const focusedCardRef = useRef<HTMLButtonElement | null>(null);

  const releaseThumbs = () => {
    thumbsRef.current.forEach((url) => URL.revokeObjectURL(url));
    thumbsRef.current = new Map();
    setThumbs(new Map());
  };

  const close = useCallback(
    async (resume: boolean) => {
      delete document.documentElement.dataset.wrOverlay;
      releaseThumbs();
      try {
        await actions.endThumbnails();
      } catch {
        // ignore
      }
      if (resume && pausedByUsRef.current) {
        await invoke("set_player_property", { name: "pause", value: "no" }).catch(() => {});
      }
      pausedByUsRef.current = false;
      onClose();
    },
    [actions, onClose]
  );

  const jump = useCallback(
    async (index: number) => {
      try {
        await invoke("interactive_rewind", { index });
      } catch (e) {
        console.error("rewind failed:", e);
      }
      // Always resume after a jump — the story is moving again.
      pausedByUsRef.current = true;
      close(true);
    },
    [close]
  );

  // Open: pause, flag the overlay (the app-level Escape handler defers to us),
  // load the decision list, then fill in frame thumbnails one by one.
  useEffect(() => {
    if (!open) return;
    let live = true;
    document.documentElement.dataset.wrOverlay = "timeline";
    (async () => {
      if (isPlaying) {
        pausedByUsRef.current = true;
        await invoke("set_player_property", { name: "pause", value: "yes" }).catch(() => {});
      }
      let list: InteractiveHistoryEntry[] = [];
      try {
        list = await invoke<InteractiveHistoryEntry[]>("interactive_history");
      } catch {
        list = [];
      }
      if (!live) return;
      setEntries(list);
      setFocusIndex(Math.max(0, list.length - 1));
      const ok = await actions.prepareThumbnails();
      if (!ok || !live) return;
      for (const entry of list) {
        if (!live) break;
        const buf = await actions.getThumbnail(entry.fileMs / 1000);
        if (!live || !buf) continue;
        const url = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
        thumbsRef.current.set(entry.index, url);
        setThumbs(new Map(thumbsRef.current));
      }
    })();
    return () => {
      // Also runs when the whole player unmounts mid-open: the root flag must
      // never outlive the overlay (it gates the app-level player keybinds).
      live = false;
      delete document.documentElement.dataset.wrOverlay;
      thumbsRef.current.forEach((url) => URL.revokeObjectURL(url));
      thumbsRef.current = new Map();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keyboard while open: ←/→ move, Enter jumps, Escape closes.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          close(true);
          break;
        case "ArrowLeft":
          e.preventDefault();
          setFocusIndex((i) => Math.max(0, i - 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          setFocusIndex((i) => Math.min(entries.length - 1, i + 1));
          break;
        case "Enter":
          e.preventDefault();
          if (entries[focusIndex]) jump(entries[focusIndex].index);
          break;
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [open, entries, focusIndex, close, jump]);

  useEffect(() => {
    focusedCardRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [focusIndex, entries.length]);

  if (!open) return null;

  return (
    <div
      // cursor-auto: the timeline swallows mousemove (so the controls' idle
      // timer doesn't run), which would otherwise inherit the player's
      // idle cursor-none while browsing cards.
      className="absolute inset-x-0 bottom-0 z-30 flex cursor-auto flex-col gap-3 bg-black/85 px-5 pb-5 pt-4 shadow-2xl ring-1 ring-white/10 backdrop-blur-md"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-white">Previous choices</h3>
          <span className="text-xs text-white/50">jump back and choose differently</span>
        </div>
        <button
          onClick={() => close(true)}
          className="rounded bg-white/10 p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-white/50">No choices made yet.</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {entries.map((entry, i) => {
            const focused = i === focusIndex;
            const picked = entry.selectedIndex;
            return (
              <button
                key={entry.index}
                ref={focused ? focusedCardRef : undefined}
                onClick={() => jump(entry.index)}
                onMouseEnter={() => setFocusIndex(i)}
                className={`w-44 shrink-0 overflow-hidden rounded-md text-left ring-1 transition-all ${
                  focused ? "ring-white/80" : "ring-white/15 hover:ring-white/40"
                }`}
              >
                <div className="aspect-video w-full bg-white/5">
                  {thumbs.get(entry.index) ? (
                    <img src={thumbs.get(entry.index)} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px] text-white/30">
                      {entry.segmentId}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-0.5 p-2">
                  <span className="text-[11px] tabular-nums text-white/50">{fmtMs(entry.storyMs)}</span>
                  <span className="truncate text-xs leading-snug">
                    {entry.choiceTexts.length > 0 ? (
                      entry.choiceTexts.map((t, ci) => (
                        <span
                          key={ci}
                          className={ci === picked ? "font-semibold text-white" : "text-white/40"}
                        >
                          {ci > 0 && <span className="text-white/25"> / </span>}
                          {t}
                        </span>
                      ))
                    ) : (
                      <span className="text-white/60">{entry.segmentId}</span>
                    )}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
