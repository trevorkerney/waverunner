import { useCallback, useRef, useState } from "react";
import { PlayerState, PlayerActions } from "../../hooks/usePlayer";
import { Slider } from "../ui/slider";
import {
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Minimize2,
  X,
  Subtitles,
  AudioLines,
} from "lucide-react";
import { Switch } from "../ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

interface ControlsOverlayProps {
  state: PlayerState;
  actions: PlayerActions;
  visible: boolean;
  onInteraction: () => void;
}

function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ControlsOverlay({
  state,
  actions,
  visible,
  onInteraction,
}: ControlsOverlayProps) {
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  const seekDragRef = useRef<number | null>(null);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  const handleSeekDrag = useCallback(
    (value: number | readonly number[]) => {
      const v = Array.isArray(value) ? value[0] : value;
      seekDragRef.current = v;
      setSeekDragValue(v);
      actions.setDragging("seek");
      onInteraction();
    },
    [actions, onInteraction]
  );

  const handleSeekCommit = useCallback(() => {
    if (seekDragRef.current !== null) {
      actions.seekAbsolute(seekDragRef.current);
      seekDragRef.current = null;
      setSeekDragValue(null);
    }
    actions.setDragging(null);
  }, [actions]);

  const handleVolume = useCallback(
    (value: number | readonly number[]) => {
      const v = Array.isArray(value) ? value[0] : value;
      actions.setVolume(v);
      onInteraction();
    },
    [actions, onInteraction]
  );

  const handleMuteClick = useCallback(() => {
    actions.toggleMute();
    onInteraction();
  }, [actions, onInteraction]);

  return (
    <div
      className={`absolute inset-0 flex flex-col justify-between transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0 pointer-events-none"
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-3 pb-6 bg-gradient-to-b from-black/70 to-transparent">
        <h2 className="text-white text-sm font-medium truncate max-w-[70%]">
          {state.title}
        </h2>
        <div className="flex items-center gap-2">
          {!state.isFullscreen && (
            <button
              onClick={() => {
                actions.toggleMinimize();
                onInteraction();
              }}
              className="rounded bg-black/50 p-1 text-white/80 hover:bg-black/70 hover:text-white transition-colors"
              title="Minimize"
            >
              <Minimize2 className="h-5 w-5" />
            </button>
          )}
          <button
            onClick={() => actions.close()}
            className="rounded bg-black/50 p-1 text-white/80 hover:bg-black/70 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Spacer — clicks pass through to PlayerView */}
      <div className="flex-1" style={{ pointerEvents: "none" }} />

      {/* Bottom bar */}
      <div className="px-4 pb-3 pt-6 bg-gradient-to-t from-black/70 to-transparent">
        {/* Seek bar */}
        <div
          className="relative mb-2"
          onPointerUp={handleSeekCommit}
          onPointerLeave={() => {
            setHoverRatio(null);
            handleSeekCommit();
          }}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const r = (e.clientX - rect.left) / rect.width;
            setHoverRatio(Math.max(0, Math.min(1, r)));
          }}
        >
          <Slider
            value={[seekDragValue ?? state.currentTime]}
            min={0}
            max={state.duration || 1}
            onValueChange={handleSeekDrag}
          />
          {hoverRatio !== null && (
            <div
              className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25"
              style={{ width: `${hoverRatio * 100}%` }}
            />
          )}
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3">
          {/* Volume */}
          <button
            onClick={handleMuteClick}
            className="text-white hover:text-white/80 transition-colors"
          >
            {state.muted || state.volume === 0 ? (
              <VolumeX className="h-5 w-5" />
            ) : (
              <Volume2 className="h-5 w-5" />
            )}
          </button>
          <div
            className="w-24"
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

          {/* Time */}
          <span className="text-white/80 text-xs tabular-nums select-none">
            {formatTime(seekDragValue ?? state.currentTime)} / {formatTime(state.duration)}
          </span>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Auto-play next (episodes only) */}
          {state.context.kind === "episode" && (
            <label className="flex items-center gap-2 mr-4 text-white/80 text-xs select-none cursor-pointer">
              <Switch
                checked={state.autoPlayNext}
                onCheckedChange={() => {
                  actions.toggleAutoPlayNext();
                  onInteraction();
                }}
              />
              Autoplay
            </label>
          )}

          {/* Audio tracks */}
          {state.audioTracks.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger className="text-white/80 hover:text-white transition-colors">
                  <AudioLines className="h-5 w-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-black/90 border-white/20">
                {state.audioTracks.map((track) => (
                  <DropdownMenuItem
                    key={track.id}
                    onClick={() => actions.setAudioTrack(track.id)}
                    className={`text-white/80 hover:text-white ${
                      track.selected ? "text-white font-medium" : ""
                    }`}
                  >
                    {track.title || track.lang || `Track ${track.id}`}
                    {track.selected && " *"}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Subtitle tracks */}
          {state.subtitleTracks.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger className="text-white/80 hover:text-white transition-colors">
                  <Subtitles className="h-5 w-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-black/90 border-white/20">
                <DropdownMenuItem
                  onClick={() => actions.toggleSubtitles()}
                  className="text-white/80 hover:text-white"
                >
                  Off
                </DropdownMenuItem>
                {state.subtitleTracks.map((track) => (
                  <DropdownMenuItem
                    key={track.id}
                    onClick={() => actions.setSubtitleTrack(track.id)}
                    className={`text-white/80 hover:text-white ${
                      track.selected ? "text-white font-medium" : ""
                    }`}
                  >
                    {track.title || track.lang || `Track ${track.id}`}
                    {track.selected && " *"}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Fullscreen */}
          <button
            onClick={() => actions.toggleFullscreen()}
            className="text-white/80 hover:text-white transition-colors"
          >
            {state.isFullscreen ? (
              <Minimize className="h-5 w-5" />
            ) : (
              <Maximize className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
