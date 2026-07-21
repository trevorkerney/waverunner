import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, X, Music2 } from "lucide-react";
import { Slider } from "../ui/slider";
import { MusicPlayerState, MusicPlayerActions } from "../../hooks/useMusicPlayer";

const MARQUEE_PX_PER_SEC = 40;
const MARQUEE_PAUSE_MS = 2000;
const MARQUEE_GAP_PX = 40;

/** Single-line text that marquee-scrolls when it overflows instead of
 *  truncating (same treatment as the minimized video dock's title). */
function MarqueeText({ text, className }: { text: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;
    const check = () => setOverflow(textEl.offsetWidth > container.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(container);
    ro.observe(textEl);
    return () => ro.disconnect();
  }, [text]);

  // CSS keyframes: hold at the start, then constant-speed scroll one copy's
  // width — the duplicated text makes the loop seamless.
  useEffect(() => {
    const track = trackRef.current;
    const textEl = textRef.current;
    if (!track || !textEl) return;
    if (!overflow) {
      track.style.animation = "";
      track.style.transform = "translateX(0)";
      return;
    }
    const shift = textEl.offsetWidth + MARQUEE_GAP_PX;
    const scrollMs = (shift / MARQUEE_PX_PER_SEC) * 1000;
    const cycleMs = MARQUEE_PAUSE_MS + scrollMs;
    const pausePct = (MARQUEE_PAUSE_MS / cycleMs) * 100;
    const animName = `marquee-${Math.random().toString(36).slice(2, 9)}`;
    const styleEl = document.createElement("style");
    styleEl.textContent = `@keyframes ${animName} { 0%, ${pausePct}% { transform: translateX(0); } 100% { transform: translateX(-${shift}px); } }`;
    document.head.appendChild(styleEl);
    track.style.animation = `${animName} ${cycleMs}ms linear infinite`;
    return () => {
      styleEl.remove();
      track.style.animation = "";
    };
  }, [overflow, text]);

  return (
    <div ref={containerRef} className={`marquee min-w-0 ${className ?? ""}`} title={text}>
      <div
        ref={trackRef}
        className="inline-flex items-center will-change-transform"
        style={{ gap: overflow ? `${MARQUEE_GAP_PX}px` : 0 }}
      >
        <span ref={textRef} className="inline-block whitespace-nowrap">
          {text}
        </span>
        {overflow && (
          <span aria-hidden className="inline-block whitespace-nowrap">
            {text}
          </span>
        )}
      </div>
    </div>
  );
}

interface NowPlayingBarProps {
  state: MusicPlayerState;
  actions: MusicPlayerActions;
  /** Suppressed while the video player takes over the window. */
  hidden: boolean;
}

function fmtTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Persistent bottom bar for music playback. Mounts once in the app shell and
 *  shows whenever a queue is loaded — browsing continues above it. */
export function NowPlayingBar({ state, actions, hidden }: NowPlayingBarProps) {
  const position = useSyncExternalStore(actions.subscribePosition, actions.getPosition);
  // Local drag values keep both sliders glued to the cursor without waiting on
  // the backend round-trip (same pattern as the video player's overlays).
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  const [volumeDragValue, setVolumeDragValue] = useState<number | null>(null);
  const volumeDragRef = useRef<number | null>(null);

  if (!state.isActive || hidden) return null;

  const current = state.queue[state.index];
  if (!current) return null;

  const duration = state.duration > 0 ? state.duration : current.durationSecs ?? 0;
  const shownPosition = seekDragValue ?? position;

  // Commits ride the slider's own onValueCommitted (drag release / keyboard) —
  // pointer-leave commits fired mid-drag whenever the cursor slipped off the
  // small track box, snapping the thumb (and the volume) around.
  const handleSeek = (value: number | readonly number[]) => {
    const v = Array.isArray(value) ? value[0] : (value as number);
    setSeekDragValue(v);
  };
  const commitSeek = (value: number | readonly number[]) => {
    const v = Array.isArray(value) ? value[0] : (value as number);
    actions.seekAbsolute(v);
    setSeekDragValue(null);
  };

  const handleVolume = (value: number | readonly number[]) => {
    const v = Array.isArray(value) ? value[0] : (value as number);
    volumeDragRef.current = v;
    setVolumeDragValue(v);
    actions.setVolumeLive(v);
  };
  const commitVolume = (value: number | readonly number[]) => {
    const v = Array.isArray(value) ? value[0] : (value as number);
    actions.setVolume(v);
    volumeDragRef.current = null;
    setVolumeDragValue(null);
  };

  const subtitle = [current.artistName, current.albumTitle].filter(Boolean).join(" — ");

  return (
    <div className="relative z-10 flex h-[4.5rem] shrink-0 items-center gap-3 border-t bg-sidebar px-3">
      {/* What's playing */}
      <div className="flex w-56 min-w-0 items-center gap-2.5">
        {current.cover ? (
          <img
            src={convertFileSrc(current.cover)}
            alt=""
            className="h-11 w-11 shrink-0 rounded object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
            <Music2 size={20} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <MarqueeText text={current.title} className="text-sm font-medium" />
          {subtitle && <MarqueeText text={subtitle} className="text-xs text-muted-foreground" />}
        </div>
      </div>

      {/* Transport + seek — tight gap; the column centers in the fixed-height
          bar, so the leftover space splits evenly above and below. */}
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => actions.previous()}
            className="rounded-full p-1.5 text-muted-foreground hover:text-foreground"
            title="Previous"
          >
            <SkipBack size={16} fill="currentColor" />
          </button>
          <button
            onClick={() => actions.togglePause()}
            className="rounded-full p-1.5 text-foreground hover:text-foreground/80"
            title={state.isPlaying ? "Pause" : "Play"}
          >
            {state.isPlaying ? (
              <Pause size={18} fill="currentColor" />
            ) : (
              <Play size={18} fill="currentColor" className="translate-x-px" />
            )}
          </button>
          <button
            onClick={() => actions.next()}
            disabled={state.index >= state.queue.length - 1}
            className="rounded-full p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
            title="Next"
          >
            <SkipForward size={16} fill="currentColor" />
          </button>
        </div>
        <div className="flex w-full max-w-2xl items-center gap-2">
          <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
            {fmtTime(shownPosition)}
          </span>
          <div className="flex-1">
            <Slider
              value={[Math.min(shownPosition, duration || shownPosition)]}
              min={0}
              max={Math.max(duration, 1)}
              step={0.1}
              onValueChange={handleSeek}
              onValueCommitted={commitSeek}
            />
          </div>
          <span className="w-10 shrink-0 font-mono text-[10px] text-muted-foreground">
            {fmtTime(duration)}
          </span>
        </div>
      </div>

      {/* Volume + queue position + close */}
      <div className="flex w-56 items-center justify-end gap-2">
        <span className="text-[10px] text-muted-foreground">
          {state.index + 1}/{state.queue.length}
        </span>
        <button
          onClick={() => actions.toggleMute()}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title={state.muted || state.volume === 0 ? "Unmute" : "Mute"}
        >
          {state.muted || state.volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <div className="w-20">
          <Slider
            value={[volumeDragValue ?? (state.muted ? 0 : state.volume)]}
            min={0}
            max={100}
            onValueChange={handleVolume}
            onValueCommitted={commitVolume}
          />
        </div>
        <button
          onClick={() => actions.stop()}
          className="ml-1 rounded p-1 text-muted-foreground hover:text-foreground"
          title="Stop"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
