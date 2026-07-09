import { useEffect, useCallback, useRef, useState } from "react";
import { actionForKey } from "../lib/playerKeybinds";
import { PlayerState, PlayerActions } from "../hooks/usePlayer";
import { ControlsOverlay } from "./player/ControlsOverlay";
import { CenterTransport } from "./player/CenterTransport";
import { InteractiveOverlay } from "./player/InteractiveOverlay";
import { InteractiveTimeline } from "./player/InteractiveTimeline";
import { StatsPanel } from "./player/StatsPanel";
import { Loader2 } from "lucide-react";

interface PlayerViewProps {
  state: PlayerState;
  actions: PlayerActions;
}

const IDLE_MS = 1000;

export function PlayerView({ state, actions }: PlayerViewProps) {
  const [showControls, setShowControls] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last mouse position (viewport coords) — where the fade-out cursor stand-in
  // is drawn. The OS cursor can't fade (cursor:none is binary), so when the
  // idle timer fires we hide the real cursor and fade a lookalike at its
  // frozen spot; it never needs to track movement, because movement is
  // exactly what dismisses it.
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);

  // Auto-hide after IDLE_MS of no mouse movement, regardless of playing/paused.
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => setShowControls(false), IDLE_MS);
  }, []);

  useEffect(() => {
    resetHideTimer();
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [resetHideTimer]);

  // Reveal the controls when the user uses any player keyboard shortcut so
  // they get visual feedback for arrow-seek / volume / pause without needing
  // to wiggle the mouse. Action handling itself lives at the App level.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Any bound player shortcut reveals the overlay (rebinds included).
      if (actionForKey(e.key)) resetHideTimer();
    };
    // Capture phase so the slider wrapper's stopPropagation can't suppress
    // this — we still want pressing arrow keys with the seek bar focused to
    // reveal the overlay.
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [resetHideTimer]);

  const ctx = state.context;
  const hasPrev = ctx.kind === "episode" && ctx.index > 0;
  const hasNext = ctx.kind === "episode" && ctx.index < ctx.episodes.length - 1;

  return (
    <div
      className={`relative flex-1 overflow-hidden ${showControls ? "" : "cursor-none"}`}
      style={{ background: state.loading ? "black" : "transparent" }}
      onMouseMove={(e) => {
        mousePosRef.current = { x: e.clientX, y: e.clientY };
        resetHideTimer();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          actions.togglePause();
          resetHideTimer();
        }
      }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) {
          actions.toggleFullscreen();
        }
      }}
    >
      {state.loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-12 w-12 animate-spin text-white" />
        </div>
      )}

      {/* Cursor stand-in: fades out in step with the controls (300ms), pinned
          where the real (now hidden) cursor stopped. */}
      {!showControls && mousePosRef.current && (
        <div
          className="pointer-events-none fixed z-50 animate-[wr-cursor-fade_300ms_ease-out_forwards]"
          style={{ left: mousePosRef.current.x - 2, top: mousePosRef.current.y - 2 }}
          aria-hidden
        >
          <svg width="18" height="24" viewBox="0 0 18 24">
            <path
              d="M2 1 L2 19 L6.6 15.2 L9.4 22 L12.6 20.7 L9.8 14 L15.6 14 Z"
              fill="white"
              stroke="black"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}

      <ControlsOverlay
        state={state}
        actions={actions}
        visible={showControls}
        onInteraction={resetHideTimer}
        showStats={showStats}
        onToggleStats={() => setShowStats((s) => !s)}
        onOpenTimeline={ctx.kind === "interactive" ? () => setTimelineOpen(true) : undefined}
      />

      {showStats && <StatsPanel interactive={ctx.kind === "interactive"} />}

      {/* Branching-title decision UI — its own layer, never auto-hidden with
          the controls (a choice must stay visible while its timer runs). */}
      {ctx.kind === "interactive" && <InteractiveOverlay />}
      {ctx.kind === "interactive" && (
        <InteractiveTimeline
          open={timelineOpen}
          onClose={() => setTimelineOpen(false)}
          actions={actions}
          isPlaying={state.isPlaying}
        />
      )}

      <CenterTransport
        isPlaying={state.isPlaying}
        hasPrev={hasPrev}
        hasNext={hasNext}
        visible={showControls && !state.loading}
        onPrev={() => {
          actions.playPreviousEpisode();
          resetHideTimer();
        }}
        onPlayPause={() => {
          actions.togglePause();
          resetHideTimer();
        }}
        onNext={() => {
          actions.playNextEpisode();
          resetHideTimer();
        }}
      />
    </div>
  );
}
