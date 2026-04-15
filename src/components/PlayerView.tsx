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

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          actions.togglePause();
          resetHideTimer();
          break;
        case "ArrowLeft":
          e.preventDefault();
          actions.seek(-10);
          resetHideTimer();
          break;
        case "ArrowRight":
          e.preventDefault();
          actions.seek(10);
          resetHideTimer();
          break;
        case "ArrowUp":
          e.preventDefault();
          actions.setVolume(Math.min(state.volume + 5, 100));
          resetHideTimer();
          break;
        case "ArrowDown":
          e.preventDefault();
          actions.setVolume(Math.max(state.volume - 5, 0));
          resetHideTimer();
          break;
        case "f":
        case "F":
          e.preventDefault();
          actions.toggleFullscreen();
          break;
        case "m":
        case "M":
          e.preventDefault();
          actions.toggleMute();
          resetHideTimer();
          break;
        case "Escape":
          e.preventDefault();
          if (state.isFullscreen) {
            actions.toggleFullscreen();
          } else {
            actions.close();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [state.volume, state.isFullscreen, actions, resetHideTimer]);

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
