import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  Clapperboard,
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
  // Local volume drag value, so dragging only re-renders this overlay (not the
  // whole app) and the thumb tracks the cursor. Mirrors the seek bar.
  const [volumeDragValue, setVolumeDragValue] = useState<number | null>(null);
  const volumeDragRef = useRef<number | null>(null);

  // Live playback position from the isolated store — subscribing here means
  // only this overlay re-renders on position ticks, not the whole app.
  const currentTime = useSyncExternalStore(actions.subscribePosition, actions.getPosition);

  // --- Seek-bar thumbnail preview ------------------------------------------
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const thumbUrlRef = useRef<string | null>(null);
  const preparedRef = useRef(false);        // second decoder is up and ready
  const inFlightRef = useRef(false);         // a frame request is outstanding
  const pendingTimeRef = useRef<number | null>(null); // latest time while busy
  const lastBucketRef = useRef<number | null>(null);  // de-dupe per second
  const hoverTimeRef = useRef<number | null>(null);   // most recent hovered time
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showThumb = useCallback((buf: ArrayBuffer | null) => {
    if (!buf) return;
    const url = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
    if (thumbUrlRef.current) URL.revokeObjectURL(thumbUrlRef.current);
    thumbUrlRef.current = url;
    setThumbUrl(url);
  }, []);

  // Request a frame, coalescing rapid hover movement into one in-flight call
  // plus a single trailing request for the most recent position.
  const pumpThumb = useCallback(
    async (time: number) => {
      if (!preparedRef.current) return;
      if (inFlightRef.current) {
        pendingTimeRef.current = time;
        return;
      }
      inFlightRef.current = true;
      const buf = await actions.getThumbnail(time);
      showThumb(buf);
      inFlightRef.current = false;
      if (pendingTimeRef.current != null) {
        const next = pendingTimeRef.current;
        pendingTimeRef.current = null;
        pumpThumb(next);
      }
    },
    [actions, showThumb]
  );

  const handleSeekEnter = useCallback(() => {
    if (teardownTimerRef.current) {
      clearTimeout(teardownTimerRef.current);
      teardownTimerRef.current = null;
    }
    actions.prepareThumbnails().then((ok) => {
      preparedRef.current = ok;
      // Show a frame for where the cursor already is, even if it hasn't moved
      // since the decoder finished spinning up.
      if (ok && hoverTimeRef.current != null) {
        lastBucketRef.current = Math.round(hoverTimeRef.current * 4);
        pumpThumb(hoverTimeRef.current);
      }
    });
  }, [actions, pumpThumb]);

  const handleSeekLeaveThumb = useCallback(() => {
    setThumbUrl(null);
    if (thumbUrlRef.current) {
      URL.revokeObjectURL(thumbUrlRef.current);
      thumbUrlRef.current = null;
    }
    lastBucketRef.current = null;
    hoverTimeRef.current = null;
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    // Tear the decoder down after a short idle so a quick re-entry (or just
    // brushing past the bar) doesn't thrash the second mpv instance.
    if (teardownTimerRef.current) clearTimeout(teardownTimerRef.current);
    teardownTimerRef.current = setTimeout(() => {
      preparedRef.current = false;
      actions.endThumbnails();
    }, 2500);
  }, [actions]);

  // Clean up the object URL, pending teardown, and decoder on unmount.
  useEffect(() => {
    return () => {
      if (teardownTimerRef.current) clearTimeout(teardownTimerRef.current);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      if (thumbUrlRef.current) URL.revokeObjectURL(thumbUrlRef.current);
      if (preparedRef.current) actions.endThumbnails();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // Seek to the exact time the preview used (same source as the thumbnail),
      // not base-ui's separately-mapped slider value — otherwise the two can
      // land on adjacent frames. Fall back to the slider value if we somehow
      // have no hovered time.
      const target = hoverTimeRef.current ?? seekDragRef.current;
      actions.seekAbsolute(target);
      seekDragRef.current = null;
      setSeekDragValue(null);
    }
    actions.setDragging(null);
  }, [actions]);

  const handleVolume = useCallback(
    (value: number | readonly number[]) => {
      const v = Array.isArray(value) ? value[0] : value;
      volumeDragRef.current = v;
      setVolumeDragValue(v);
      actions.setVolumeLive(v); // audio follows now; global state commits on release
      onInteraction();
    },
    [actions, onInteraction]
  );

  const commitVolume = useCallback(() => {
    if (volumeDragRef.current !== null) {
      actions.setVolume(volumeDragRef.current);
      volumeDragRef.current = null;
      setVolumeDragValue(null);
    }
    actions.setDragging(null);
  }, [actions]);

  const handleMuteClick = useCallback(() => {
    actions.toggleMute();
    onInteraction();
  }, [actions, onInteraction]);

  // Interactive titles: the engine owns the timeline (jumping between graph
  // segments of one big concatenated file), so the seek bar and clock would
  // show meaningless positions — v1 policy is to hide them. Volume, tracks,
  // and fullscreen all still apply.
  const isInteractive = state.context.kind === "interactive";

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
        {!isInteractive && (
        <div
          className="relative mb-2"
          onPointerUp={handleSeekCommit}
          onPointerEnter={handleSeekEnter}
          onPointerLeave={() => {
            setHoverRatio(null);
            handleSeekCommit();
            handleSeekLeaveThumb();
          }}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const r = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setHoverRatio(r);
            if (state.duration > 0) {
              const t = r * state.duration;
              hoverTimeRef.current = t;
              // Refresh ~4x/sec of content so the preview tracks the cursor
              // closely; coalescing keeps at most one decode in flight.
              const bucket = Math.round(t * 4);
              if (preparedRef.current && bucket !== lastBucketRef.current) {
                lastBucketRef.current = bucket;
                pumpThumb(t);
              }
              // When the cursor settles, fetch the exact rest frame so the
              // preview matches precisely where a click will land.
              if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
              settleTimerRef.current = setTimeout(() => {
                if (preparedRef.current && hoverTimeRef.current != null) {
                  pumpThumb(hoverTimeRef.current);
                }
              }, 150);
            }
          }}
          onKeyDownCapture={(e) => {
            // The slider thumb is a native <input type="range">. Arrow keys
            // would (a) trigger the browser's built-in range-increment and
            // (b) fire base-ui's onKeyDown. Both need to be blocked so the
            // global player handler can do its 10s seek instead of the bar
            // drifting by 1 sec per press.
            switch (e.key) {
              case "ArrowLeft":
              case "ArrowRight":
              case "ArrowUp":
              case "ArrowDown":
              case "PageUp":
              case "PageDown":
              case "Home":
              case "End":
                e.preventDefault();
                e.stopPropagation();
                break;
            }
          }}
        >
          <Slider
            value={[seekDragValue ?? currentTime]}
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
          {hoverRatio !== null && thumbUrl && (
            <div
              className="pointer-events-none absolute bottom-full mb-3 w-40 -translate-x-1/2 overflow-hidden rounded-md border border-white/20 bg-black shadow-lg"
              style={{ left: `${hoverRatio * 100}%` }}
            >
              <img src={thumbUrl} alt="" className="block w-full" />
            </div>
          )}
        </div>
        )}

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
            onPointerUp={commitVolume}
            onPointerLeave={commitVolume}
          >
            <Slider
              value={[volumeDragValue ?? (state.muted ? 0 : state.volume)]}
              min={0}
              max={100}
              onValueChange={handleVolume}
            />
          </div>

          {/* Time — shows the hovered position while scrubbing the bar,
              otherwise the live playback position. */}
          {!isInteractive && (
            <span className="text-white/80 text-xs tabular-nums select-none">
              {formatTime(
                seekDragValue ??
                  (hoverRatio != null ? hoverRatio * state.duration : currentTime)
              )}{" "}
              / {formatTime(state.duration)}
            </span>
          )}

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

          {/* Video tracks (rare — only when a file carries more than one) */}
          {state.videoTracks.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger className="text-white/80 hover:text-white transition-colors">
                  <Clapperboard className="h-5 w-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-black/90 border-white/20">
                {state.videoTracks.map((track) => (
                  <DropdownMenuItem
                    key={track.id}
                    onClick={() => actions.setVideoTrack(track.id)}
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
