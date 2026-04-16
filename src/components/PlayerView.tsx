import { useEffect, useCallback, useRef, useState } from "react";
import { PlayerState, PlayerActions } from "../hooks/usePlayer";
import { ControlsOverlay } from "./player/ControlsOverlay";
import { CenterTransport } from "./player/CenterTransport";
import { Loader2 } from "lucide-react";

interface PlayerViewProps {
  state: PlayerState;
  actions: PlayerActions;
}

const IDLE_MS = 3000;

export function PlayerView({ state, actions }: PlayerViewProps) {
  const [showControls, setShowControls] = useState(true);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      switch (e.key) {
        case " ":
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown":
        case "m":
        case "M":
          resetHideTimer();
          break;
      }
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
      className="relative flex-1 overflow-hidden"
      style={{ background: state.loading ? "black" : "transparent" }}
      onMouseMove={resetHideTimer}
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

      <ControlsOverlay
        state={state}
        actions={actions}
        visible={showControls}
        onInteraction={resetHideTimer}
      />

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
