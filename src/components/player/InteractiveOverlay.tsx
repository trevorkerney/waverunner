import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { InteractiveChoiceOpen, InteractiveStatus } from "../../types";

// Renders the timed decision UI for interactive titles. Self-contained: it
// subscribes to the engine's events directly and reports picks back with
// interactive_choose. Mounted only while the player context is interactive.
//
// The countdown bar is driven by authoritative remaining-ms ticks from the
// Rust driver (~4/sec, video-time based so pausing pauses it), with a CSS
// linear transition smoothing the steps between ticks.

interface NotificationState {
  headerText: string | null;
  bodyText: string | null;
}

const TICK_MS = 250;

// Netflix choice-point sprites stack their visual states vertically:
// default / focused / selected. The format ships the default row's
// backgroundPosition; the other rows follow the standard CSS percentage
// spacing for a 3-frame sheet.
const SPRITE_ROWS = ["0%", "50%", "100%"];

/** Frame aspect ratio of a sprite sheet, from its natural size and the
 *  format's backgroundSize ("100.9% 303.2%" → ~3 frames tall). */
function frameAspect(natW: number, natH: number, size: string | null): number {
  const m = size?.match(/([\d.]+)%\s+([\d.]+)%/);
  if (!m) return 2.75;
  const fw = natW / (parseFloat(m[1]) / 100);
  const fh = natH / (parseFloat(m[2]) / 100);
  return fh > 0 ? fw / fh : 2.75;
}

export function InteractiveOverlay() {
  const [choice, setChoice] = useState<InteractiveChoiceOpen | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [closing, setClosing] = useState(false);
  const [notification, setNotification] = useState<NotificationState | null>(null);
  // Sprite-sheet frame aspect per image path (loaded lazily per choice open).
  const [aspects, setAspects] = useState<Map<string, number>>(new Map());
  const choiceRef = useRef<InteractiveChoiceOpen | null>(null);
  choiceRef.current = choice;
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;
  const focusRef = useRef(0);
  focusRef.current = focusIndex;
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openChoice = useCallback((payload: InteractiveChoiceOpen) => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setClosing(false);
    setChoice(payload);
    setRemaining(payload.remainingMs);
    setSelected(payload.selectedIndex);
    setFocusIndex(payload.selectedIndex ?? payload.defaultIndex ?? 0);
    // Measure any sprite sheets so their buttons reserve the right shape.
    for (const c of payload.choices) {
      const path = c.imagePath;
      if (!path) continue;
      const img = new Image();
      img.onload = () =>
        setAspects((prev) => {
          if (prev.has(path)) return prev;
          const next = new Map(prev);
          next.set(path, frameAspect(img.naturalWidth, img.naturalHeight, c.imageSize));
          return next;
        });
      img.src = convertFileSrc(path);
    }
  }, []);

  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let disposed = false;
    (async () => {
      // Rehydrate a window that opened before this overlay mounted (F5 mid-choice).
      try {
        const status = await invoke<InteractiveStatus | null>("interactive_status");
        if (!disposed && status?.choice) openChoice(status.choice);
      } catch {
        // No session — events will drive everything once one starts.
      }

      unlistens.push(
        await listen<InteractiveChoiceOpen>("interactive-choice-open", (e) => {
          openChoice(e.payload);
        }),
        await listen<{ remainingMs: number }>("interactive-choice-tick", (e) => {
          setRemaining(Math.max(0, e.payload.remainingMs));
        }),
        await listen<{ selectedIndex: number | null; timedOut: boolean }>(
          "interactive-choice-closed",
          (e) => {
            setRemaining(0);
            if (e.payload.selectedIndex != null) setSelected(e.payload.selectedIndex);
            // Hold the highlighted pick briefly (the scene is playing out), then fade.
            setClosing(true);
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
            closeTimerRef.current = setTimeout(() => {
              setChoice(null);
              setClosing(false);
              setSelected(null);
            }, 1600);
          }
        ),
        await listen<{ headerText: string | null; bodyText: string | null; remainingMs: number }>(
          "interactive-notification",
          (e) => {
            setNotification({ headerText: e.payload.headerText, bodyText: e.payload.bodyText });
            if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
            notifTimerRef.current = setTimeout(
              () => setNotification(null),
              Math.min(Math.max(e.payload.remainingMs, 2000), 10000)
            );
          }
        )
      );
    })();
    return () => {
      disposed = true;
      unlistens.forEach((fn) => fn());
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
    };
  }, [openChoice]);

  const pick = useCallback(async (index: number) => {
    if (selectedRef.current != null) return; // first pick wins
    setSelected(index);
    setFocusIndex(index);
    try {
      await invoke("interactive_choose", { index });
    } catch {
      // Window already closed on the engine side — its close event settles the UI.
    }
  }, []);

  // Keyboard: arrows move focus, Enter commits. Bubble phase so the App-level
  // player shortcuts (which skip seeking in interactive mode) aren't blocked.
  useEffect(() => {
    if (!choice || closing) return;
    const handleKey = (e: KeyboardEvent) => {
      const open = choiceRef.current;
      if (!open || selectedRef.current != null) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          setFocusIndex((i) => Math.max(0, i - 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          setFocusIndex((i) => Math.min(open.choices.length - 1, i + 1));
          break;
        case "Enter":
          e.preventDefault();
          pick(focusRef.current);
          break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [choice, closing, pick]);

  const ratio = choice && choice.totalMs > 0 ? Math.max(0, Math.min(1, remaining / choice.totalMs)) : 0;

  return (
    <>
      {notification && (
        <div className="pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2">
          <div className="rounded-lg bg-black/70 px-5 py-3 text-center shadow-lg ring-1 ring-white/15 backdrop-blur-sm">
            {notification.headerText && (
              <p className="text-sm font-semibold text-white">{notification.headerText}</p>
            )}
            {notification.bodyText && (
              <p className="mt-0.5 text-xs text-white/75">{notification.bodyText}</p>
            )}
          </div>
        </div>
      )}

      {choice && (
        <div
          className={`absolute inset-x-0 bottom-24 z-20 flex flex-col items-center gap-4 px-8 transition-opacity duration-500 ${
            closing && selected == null ? "opacity-0" : "opacity-100"
          }`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="flex max-w-full flex-wrap items-center justify-center gap-4">
            {choice.choices.map((c, i) => {
              const isSelected = selected === i;
              const dimmed = selected != null && !isSelected;
              // Image choice: the sprite sheet stacks default/focused/selected
              // rows — show the matching row, dim when another option won.
              if (c.imagePath) {
                const stateRow = isSelected ? 2 : focusIndex === i && selected == null ? 1 : 0;
                return (
                  <button
                    key={i}
                    onClick={() => pick(i)}
                    onMouseEnter={() => selected == null && setFocusIndex(i)}
                    disabled={selected != null}
                    aria-label={c.text}
                    title={c.text}
                    className={`w-64 max-w-[30vw] bg-no-repeat shadow-xl transition-all duration-200 ${
                      dimmed ? "opacity-40" : "cursor-pointer"
                    }`}
                    style={{
                      aspectRatio: `${aspects.get(c.imagePath) ?? 2.75}`,
                      // Quoted: convertFileSrc leaves parentheses unencoded
                      // (folder names like "(2018)"), and a bare url(...)
                      // terminates at the first `)`.
                      backgroundImage: `url("${convertFileSrc(c.imagePath)}")`,
                      backgroundSize: c.imageSize ?? "100% 300%",
                      backgroundPosition: `50% ${SPRITE_ROWS[stateRow]}`,
                    }}
                  />
                );
              }
              return (
                <button
                  key={i}
                  onClick={() => pick(i)}
                  onMouseEnter={() => selected == null && setFocusIndex(i)}
                  disabled={selected != null}
                  className={`min-w-40 max-w-md rounded-md px-8 py-4 text-center shadow-xl ring-1 backdrop-blur-sm transition-all duration-200 ${
                    isSelected
                      ? "bg-white text-black ring-white"
                      : dimmed
                        ? "bg-black/45 text-white/35 ring-white/10"
                        : focusIndex === i
                          ? "cursor-pointer bg-white/25 text-white ring-white/70"
                          : "cursor-pointer bg-black/55 text-white/90 ring-white/20 hover:bg-white/20"
                  }`}
                >
                  <span className="text-lg font-semibold tracking-wide">{c.text}</span>
                  {c.subText && <span className="mt-1 block text-xs opacity-70">{c.subText}</span>}
                </button>
              );
            })}
          </div>
          {/* Countdown — drains right-to-left symmetrically from the center */}
          <div className="h-1 w-full max-w-xl overflow-hidden rounded-full bg-white/20">
            <div
              className="mx-auto h-full rounded-full bg-white/90"
              style={{
                width: `${ratio * 100}%`,
                transition: `width ${TICK_MS + 50}ms linear`,
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
