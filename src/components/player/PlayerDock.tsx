import { useEffect, useRef, useState } from "react";
import { PlayerState, PlayerActions } from "../../hooks/usePlayer";
import { Play, Pause, SkipBack, SkipForward, Maximize2, X, Volume2, VolumeX } from "lucide-react";
import { Slider } from "../ui/slider";

interface PlayerDockProps {
  state: PlayerState;
  actions: PlayerActions;
}

const MARQUEE_PX_PER_SEC = 40;
const MARQUEE_PAUSE_MS = 2000;
const MARQUEE_GAP_PX = 40;

export function PlayerDock({ state, actions }: PlayerDockProps) {
  const videoRef = useRef<HTMLDivElement | null>(null);
  const titleContainerRef = useRef<HTMLDivElement | null>(null);
  const titleTextRef = useRef<HTMLSpanElement | null>(null);
  const titleTrackRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  // Measure overflow
  useEffect(() => {
    const container = titleContainerRef.current;
    const text = titleTextRef.current;
    if (!container || !text) return;
    const check = () => {
      setOverflow(text.offsetWidth > container.clientWidth);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(container);
    ro.observe(text);
    return () => ro.disconnect();
  }, [state.title]);

  // Marquee animation — CSS keyframes with a hold at the start, then constant-speed scroll
  useEffect(() => {
    const track = titleTrackRef.current;
    const text = titleTextRef.current;
    if (!track || !text) return;
    if (!overflow) {
      track.style.animation = "";
      track.style.transform = "translateX(0)";
      return;
    }
    const shift = text.offsetWidth + MARQUEE_GAP_PX;
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
  }, [overflow, state.title]);

  const ctx = state.context;
  const hasPrev = ctx.kind === "episode" && ctx.index > 0;
  const hasNext = ctx.kind === "episode" && ctx.index < ctx.episodes.length - 1;

  const lastVolumeRef = useRef(state.volume > 0 ? state.volume : 100);

  const handleVolume = (value: number | readonly number[]) => {
    const v = Array.isArray(value) ? value[0] : value;
    if (v > 0) lastVolumeRef.current = v;
    actions.setVolume(v);
    if (v > 0 && state.muted) actions.toggleMute();
  };

  const handleMuteClick = () => {
    const effective = state.muted ? 0 : state.volume;
    if (effective > 0) {
      lastVolumeRef.current = state.volume;
      actions.setVolume(0);
    } else {
      const restore = lastVolumeRef.current > 0 ? lastVolumeRef.current : 100;
      actions.setVolume(restore);
      if (state.muted) actions.toggleMute();
    }
  };

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const report = () => {
      const rect = el.getBoundingClientRect();
      const W = window.innerWidth;
      const H = window.innerHeight;
      if (W <= 0 || H <= 0) return;
      const left = rect.left / W;
      const right = Math.max(0, (W - rect.right) / W);
      const top = rect.top / H;
      const bottom = Math.max(0, (H - rect.bottom) / H);
      actions.setPlayerRegion({ left, right, top, bottom });
    };

    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [actions]);

  return (
    <div className="relative flex flex-col bg-transparent">
      {/* Top-edge border: bg-sidebar underlay + bg-border overlay for consistent
          color regardless of what sits behind the border pixel. */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 h-px bg-sidebar" />
      <div className="pointer-events-none absolute left-0 right-0 top-0 h-px bg-border" />
      <div className="flex items-center min-w-0 bg-sidebar px-2 py-2">
        <div ref={titleContainerRef} className="marquee flex-1 min-w-0 text-xs text-sidebar-foreground" title={state.title}>
          <div ref={titleTrackRef} className="inline-flex items-center will-change-transform" style={{ gap: overflow ? `${MARQUEE_GAP_PX}px` : 0 }}>
            <span ref={titleTextRef} className="inline-block">
              {state.title}
            </span>
            {overflow && (
              <span aria-hidden className="inline-block">
                {state.title}
              </span>
            )}
          </div>
        </div>
      </div>
      <div
        ref={videoRef}
        className="group relative w-full bg-transparent"
        style={{ aspectRatio: "16 / 9" }}
      >
        {/* Top-right: restore + close */}
        <div className="pointer-events-none absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => actions.toggleMinimize()}
            className="pointer-events-auto rounded bg-black/50 p-1 text-white hover:bg-black/70"
            title="Restore"
          >
            <Maximize2 size={14} />
          </button>
          <button
            onClick={() => actions.close()}
            className="pointer-events-auto rounded bg-black/50 p-1 text-white hover:bg-black/70"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
        {/* Centered transport */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-3 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => actions.playPreviousEpisode()}
            disabled={!hasPrev}
            className="pointer-events-auto rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70 disabled:opacity-30"
          >
            <SkipBack size={16} />
          </button>
          <button
            onClick={() => actions.togglePause()}
            className="pointer-events-auto rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
          >
            {state.isPlaying ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button
            onClick={() => actions.playNextEpisode()}
            disabled={!hasNext}
            className="pointer-events-auto rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70 disabled:opacity-30"
          >
            <SkipForward size={16} />
          </button>
        </div>
        {/* Bottom-left: volume */}
        <div className="pointer-events-none absolute bottom-1 left-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={handleMuteClick}
            className="pointer-events-auto rounded bg-black/50 p-1 text-white hover:bg-black/70"
            title={state.muted || state.volume === 0 ? "Unmute" : "Mute"}
          >
            {state.muted || state.volume === 0 ? (
              <VolumeX size={14} />
            ) : (
              <Volume2 size={14} />
            )}
          </button>
          <div
            className="pointer-events-auto w-16"
            onPointerDown={() => actions.setDragging("volume")}
            onPointerUp={() => actions.setDragging(null)}
            onPointerLeave={() => actions.setDragging(null)}
          >
            <Slider
              value={[state.muted ? 0 : state.volume]}
              min={0}
              max={100}
              onValueChange={handleVolume}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
