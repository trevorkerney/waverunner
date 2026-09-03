import { useState, useRef, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, X, Music2, ChevronUp, ChevronDown, Shuffle, Repeat, Repeat1, ListMusic, Heart } from "lucide-react";
import { Slider } from "../ui/slider";
import { MusicPlayerState, MusicPlayerActions, currentMusicItem } from "../../hooks/useMusicPlayer";
import { useLoved } from "../music/LoveButton";
import type { LoveLevel } from "../../types";
import { UpNextPanel } from "./UpNextPanel";

const MARQUEE_PX_PER_SEC = 40;
const MARQUEE_PAUSE_MS = 2000;
const MARQUEE_GAP_PX = 40;

/** SoundCloud-style waveform seekbar: mirrored peak bars on a canvas, played
 *  portion at full alpha. Pointer drag/click seeks; the parent owns the
 *  drag-value plumbing so the time readout stays glued to the cursor exactly
 *  like the plain slider. */
function WaveformSeekbar({
  peaks,
  position,
  duration,
  onSeek,
  onCommit,
}: {
  peaks: number[];
  position: number;
  duration: number;
  onSeek: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Redraw every render — position updates arrive throttled (~5/s), and 480
  // rects is nothing. Canvas is sized to the device pixel ratio each pass.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w === 0 || h === 0) return;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const color = getComputedStyle(el).color; // text-primary — theme-aware
    const n = peaks.length;
    const frac = duration > 0 ? Math.min(position / duration, 1) : 0;
    const barW = w / n;
    const gap = barW > 2 ? 1 : 0;
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const amp = Math.max(peaks[i] / 255, 0.04); // silence still draws a hairline
      const bh = amp * (h - 2);
      ctx.globalAlpha = (i + 0.5) / n <= frac ? 1 : 0.3;
      ctx.fillRect(i * barW, (h - bh) / 2, Math.max(barW - gap, 1), bh);
    }
  });
  const valueAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    return f * duration;
  };
  return (
    <canvas
      ref={canvasRef}
      className="h-6 w-full cursor-pointer text-primary"
      onPointerDown={(e) => {
        dragRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onSeek(valueAt(e));
      }}
      onPointerMove={(e) => {
        if (dragRef.current) onSeek(valueAt(e));
      }}
      onPointerUp={(e) => {
        if (dragRef.current) {
          dragRef.current = false;
          onCommit(valueAt(e));
        }
      }}
    />
  );
}

/** Single-line text that marquee-scrolls when it overflows instead of
 *  truncating (same treatment as the minimized video dock's title). Hovering
 *  pauses the scroll where it is — the contents can be links. `children`
 *  renders richer content (link spans); `text` stays the plain string for
 *  overflow measurement and the tooltip, so keep them in sync. */
function MarqueeText({ text, children, className }: { text: string; children?: ReactNode; className?: string }) {
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

  const setPaused = (paused: boolean) => {
    if (trackRef.current) {
      trackRef.current.style.animationPlayState = paused ? "paused" : "running";
    }
  };

  return (
    <div
      ref={containerRef}
      className={`marquee min-w-0 ${className ?? ""}`}
      title={text}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div
        ref={trackRef}
        className="inline-flex items-center will-change-transform"
        style={{ gap: overflow ? `${MARQUEE_GAP_PX}px` : 0 }}
      >
        <span ref={textRef} className="inline-block whitespace-nowrap">
          {children ?? text}
        </span>
        {overflow && (
          <span aria-hidden className="inline-block whitespace-nowrap">
            {children ?? text}
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
  /** Title / album-name click → album page. With trackId, the page scrolls to
   *  that track and highlights it. */
  onOpenAlbum?: (albumId: number, albumTitle: string, trackId?: number) => void;
  /** Artist-name click → artist page. */
  onOpenArtist?: (artistId: number, artistName: string) => void;
  /** Cover art is parked in the sidebar; the bar's slot shows a grey stand-in
   *  and the hover button flips to a down arrow. */
  coverDocked?: boolean;
  onToggleCoverDock?: () => void;
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
export function NowPlayingBar({ state, actions, hidden, onOpenAlbum, onOpenArtist, coverDocked, onToggleCoverDock }: NowPlayingBarProps) {
  const position = useSyncExternalStore(actions.subscribePosition, actions.getPosition);
  // Local drag values keep both sliders glued to the cursor without waiting on
  // the backend round-trip (same pattern as the video player's overlays).
  const [seekDragValue, setSeekDragValue] = useState<number | null>(null);
  const [volumeDragValue, setVolumeDragValue] = useState<number | null>(null);
  const volumeDragRef = useRef<number | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);

  // Loved heart beside the title — display only. Queue items don't carry
  // loved state, so a per-track snapshot is fetched; the session override
  // store keeps it live when the track is (un)loved anywhere in the app.
  const currentTrackId = currentMusicItem(state)?.trackId ?? null;
  const [lovedSnapshot, setLovedSnapshot] = useState<LoveLevel>(null);
  useEffect(() => {
    let cancelled = false;
    setLovedSnapshot(null);
    if (currentTrackId != null) {
      invoke<LoveLevel>("get_track_loved", { trackId: currentTrackId })
        .then((v) => {
          if (!cancelled) setLovedSnapshot(v);
        })
        .catch(() => {
          /* heart is decorative — stay hidden on failure */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [currentTrackId]);
  const loved = useLoved(currentTrackId ?? -1, lovedSnapshot);

  // Waveform seekbar (Settings → Audio, default off): peaks fetched lazily
  // per track — the backend decodes once and caches, so the first play of a
  // track fades the shape in a moment late and every later play is instant.
  // null = plain slider (setting off, undecodable codec, or still loading).
  const [waveform, setWaveform] = useState<number[] | null>(null);
  // Saving Settings re-runs the fetch below, so flipping the waveform toggle
  // takes effect on the CURRENT track — no waiting for the next one. Keyed:
  // unrelated saves (volume, keybinds) must not blank and refetch the bar.
  const [settingsNonce, setSettingsNonce] = useState(0);
  useEffect(() => {
    const bump = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (!keys || keys.includes("music_waveform_seekbar")) {
        setSettingsNonce((n) => n + 1);
      }
    };
    window.addEventListener("waverunner:settings-saved", bump);
    return () => window.removeEventListener("waverunner:settings-saved", bump);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setWaveform(null);
    if (currentTrackId == null) return;
    (async () => {
      try {
        const settings = await invoke<Record<string, string>>("get_settings");
        if (cancelled || settings["music_waveform_seekbar"] !== "true") return;
        const peaks = await invoke<number[] | null>("get_track_waveform", {
          trackId: currentTrackId,
        });
        if (!cancelled && peaks && peaks.length > 0) setWaveform(peaks);
      } catch {
        /* the plain bar is always a fine answer */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentTrackId, settingsNonce]);

  if (!state.isActive || hidden) return null;

  const current = currentMusicItem(state);
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
    <div
      data-now-playing-bar
      className="relative z-10 flex h-[4.5rem] shrink-0 items-center gap-3 border-t bg-sidebar px-3"
    >
      {/* What's playing */}
      <div className="flex w-56 min-w-0 items-center gap-2.5">
        <div className="group/cover relative h-11 w-11 shrink-0">
          {current.cover ? (
            // Shown here even while docked — the art simply appears in both places.
            <img
              src={convertFileSrc(current.cover)}
              alt=""
              className="h-11 w-11 rounded object-cover"
              draggable={false}
            />
          ) : (
            <div className="flex h-11 w-11 items-center justify-center rounded bg-muted text-muted-foreground">
              <Music2 size={20} />
            </div>
          )}
          {/* Artless tracks dock too — the sidebar shows its no-cover
              placeholder, so the toggle can't depend on having art. */}
          {onToggleCoverDock && (
            <button
              onClick={onToggleCoverDock}
              // Docked: the down arrow is the grey slot's only content — always
              // visible. Undocked: the up arrow appears on cover hover only.
              className={`absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white shadow transition-opacity hover:bg-black/80 ${
                coverDocked ? "" : "opacity-0 group-hover/cover:opacity-100"
              }`}
              title={coverDocked ? "Bring cover back down" : "Show cover in sidebar"}
            >
              {coverDocked ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            </button>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {/* Heart AFTER the marquee container: short titles get it right
              beside the text, overflowing ones keep it pinned at the end
              while the title scrolls. Indicator only — not a button. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <MarqueeText text={current.title} className="text-sm font-medium">
              {current.albumId != null && onOpenAlbum ? (
                <span
                  role="link"
                  className="cursor-pointer hover:underline"
                  onClick={() =>
                    onOpenAlbum(current.albumId!, current.albumTitle ?? current.title, current.trackId)
                  }
                >
                  {current.title}
                </span>
              ) : (
                current.title
              )}
            </MarqueeText>
            {loved !== null && (
              // Nudged up 1px: flex centering aligns to the full line box
              // (descenders included), which reads visually low — this centers
              // the heart on the letterforms' cap/x-height band instead.
              // Filled = loved, outline = liked (same tiers as the row hearts).
              <Heart
                size={10}
                fill={loved === "loved" ? "currentColor" : "none"}
                className="shrink-0 -translate-y-px text-rose-500"
              />
            )}
          </div>
          {subtitle && (
            <MarqueeText text={subtitle} className="text-xs text-muted-foreground">
              {current.artistName
                ? // Each credited artist links to their own page; names the
                  // library doesn't know stay plain text. Old persisted queues
                  // without the artists array fall back to one link.
                  (current.artists && current.artists.length > 0
                    ? current.artists
                    : [{ name: current.artistName, artistId: current.artistId ?? null }]
                  ).map((a, i) => (
                    <span key={`${a.name}-${i}`}>
                      {i > 0 && ", "}
                      {a.artistId != null && onOpenArtist ? (
                        <span
                          role="link"
                          className="cursor-pointer hover:underline"
                          onClick={() => onOpenArtist(a.artistId!, a.name)}
                        >
                          {a.name}
                        </span>
                      ) : (
                        a.name
                      )}
                    </span>
                  ))
                : null}
              {current.artistName && current.albumTitle ? " — " : null}
              {current.albumTitle ? (
                current.albumId != null && onOpenAlbum ? (
                  <span
                    role="link"
                    className="cursor-pointer hover:underline"
                    onClick={() => onOpenAlbum(current.albumId!, current.albumTitle!)}
                  >
                    {current.albumTitle}
                  </span>
                ) : (
                  current.albumTitle
                )
              ) : null}
            </MarqueeText>
          )}
        </div>
      </div>

      {/* Transport + seek — tight gap; the column centers in the fixed-height
          bar, so the leftover space splits evenly above and below. */}
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5">
        {/* translate (not margin) drops the transport row toward the seek bar
            without reflowing it — the seek bar stays exactly where it was. */}
        <div className="flex translate-y-0.5 items-center gap-2">
          <button
            onClick={() => actions.toggleShuffle()}
            className={`rounded-full p-1.5 hover:text-foreground ${state.shuffle ? "text-primary" : "text-muted-foreground"}`}
            title={state.shuffle ? "Shuffle on" : "Shuffle off"}
          >
            <Shuffle size={14} />
          </button>
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
            disabled={
              state.explicitQueue.length === 0 &&
              state.index >= state.queue.length - 1 &&
              state.loop !== "all"
            }
            className="rounded-full p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
            title="Next"
          >
            <SkipForward size={16} fill="currentColor" />
          </button>
          <button
            onClick={() => actions.cycleLoop()}
            className={`rounded-full p-1.5 hover:text-foreground ${state.loop !== "off" ? "text-primary" : "text-muted-foreground"}`}
            title={state.loop === "off" ? "Loop off" : state.loop === "all" ? "Looping queue" : "Looping track"}
          >
            {state.loop === "one" ? <Repeat1 size={14} /> : <Repeat size={14} />}
          </button>
        </div>
        <div className="flex w-full max-w-2xl items-center gap-2">
          <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
            {fmtTime(shownPosition)}
          </span>
          <div className="flex-1">
            {waveform ? (
              <WaveformSeekbar
                peaks={waveform}
                position={Math.min(shownPosition, duration || shownPosition)}
                duration={duration}
                onSeek={(v) => setSeekDragValue(v)}
                onCommit={(v) => {
                  actions.seekAbsolute(v);
                  setSeekDragValue(null);
                }}
              />
            ) : (
              <Slider
                value={[Math.min(shownPosition, duration || shownPosition)]}
                min={0}
                max={Math.max(duration, 1)}
                step={0.1}
                onValueChange={handleSeek}
                onValueCommitted={commitSeek}
              />
            )}
          </div>
          <span className="w-10 shrink-0 font-mono text-[10px] text-muted-foreground">
            {fmtTime(duration)}
          </span>
        </div>
      </div>

      {/* Volume + queue position + close */}
      <div className="flex w-56 items-center justify-end gap-2">
        <span className="text-[10px] text-muted-foreground">
          {state.explicitCurrent ? "queue" : `${state.index + 1}/${state.queue.length}`}
        </span>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setQueueOpen((v) => !v)}
          className={`rounded p-1 hover:text-foreground ${queueOpen ? "text-primary" : "text-muted-foreground"}`}
          title="Up next"
        >
          <ListMusic size={16} />
        </button>
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

      {queueOpen && <UpNextPanel state={state} actions={actions} onClose={() => setQueueOpen(false)} />}
    </div>
  );
}
