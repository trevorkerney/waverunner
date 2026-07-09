import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PlayerTrack, PlayerContext, EpisodeRef, ShowEpisodeFlat, InteractiveStatus } from "../types";
import { TITLEBAR_HEIGHT } from "../components/Titlebar";
import { applySubtitleStyleToPlayer } from "../lib/subtitleStyle";

export interface PlayerState {
  isActive: boolean;
  isPlaying: boolean;
  /** mpv has presented at least one frame of the current file. The player
   *  backdrop stays black until then — going transparent any earlier flashes
   *  whatever is behind the window. */
  presenting: boolean;
  // NOTE: the high-frequency playback position is intentionally NOT here — it
  // lives in an isolated store (subscribePosition/getPosition) so position
  // ticks don't re-render the whole app. Read it with useSyncExternalStore.
  duration: number;
  volume: number;
  muted: boolean;
  audioTracks: PlayerTrack[];
  subtitleTracks: PlayerTrack[];
  videoTracks: PlayerTrack[];
  isFullscreen: boolean;
  isMinimized: boolean;
  loading: boolean;
  title: string;
  context: PlayerContext;
  autoPlayNext: boolean;
}

export interface PlayEpisodeArgs {
  libraryId: string;
  showId: number;
  showTitle: string;
  startEpisodeId: number;
  /** Resume point (raw seconds); the player backs up a few seconds of context. */
  startSecs?: number;
}

export interface PlayInteractiveArgs {
  libraryId: string;
  entryId: number;
  title: string;
  /** Discard the mid-story resume and start over (persistent memory stays). */
  fresh?: boolean;
}

/** Watch-history attribution for a played file (omit for untracked extras). */
export interface PlayWatchTarget {
  kind: "movie" | "episode";
  id: number;
}

export interface PlayOptions {
  watch?: PlayWatchTarget;
  /** Resume point (raw seconds); the player backs up a few seconds of context. */
  startSecs?: number;
}

export interface PlayerActions {
  play: (path: string, title: string, opts?: PlayOptions) => Promise<void>;
  playInteractive: (args: PlayInteractiveArgs) => Promise<void>;
  playEpisode: (args: PlayEpisodeArgs) => Promise<void>;
  playNextEpisode: () => Promise<void>;
  playPreviousEpisode: () => Promise<void>;
  togglePause: () => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  seekAbsolute: (seconds: number) => Promise<void>;
  /** Step one frame forward/back; mpv pauses playback as a side effect. */
  frameStep: () => Promise<void>;
  frameBackStep: () => Promise<void>;
  /** Bounded ±skip inside an interactive title (the engine enforces the
   *  inter-choice-span clamps). */
  interactiveSkip: (seconds: number) => Promise<void>;
  /** Isolated playback-position store — subscribe for live currentTime without
   *  re-rendering the rest of the app on every tick. */
  subscribePosition: (cb: () => void) => () => void;
  getPosition: () => number;
  setVolume: (vol: number) => Promise<void>;
  setVolumeLive: (vol: number) => Promise<void>;
  toggleMute: () => Promise<void>;
  setAudioTrack: (id: number) => Promise<void>;
  setSubtitleTrack: (id: number) => Promise<void>;
  setVideoTrack: (id: number) => Promise<void>;
  prepareThumbnails: () => Promise<boolean>;
  getThumbnail: (time: number) => Promise<ArrayBuffer | null>;
  endThumbnails: () => Promise<void>;
  toggleSubtitles: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  toggleMinimize: () => Promise<void>;
  setPlayerRegion: (rect: { left: number; right: number; top: number; bottom: number }) => Promise<void>;
  toggleAutoPlayNext: () => Promise<void>;
  close: () => Promise<void>;
  setDragging: (field: "seek" | "volume" | null) => void;
}

const initialState: PlayerState = {
  isActive: false,
  isPlaying: false,
  presenting: false,
  duration: 0,
  volume: 100,
  muted: false,
  audioTracks: [],
  subtitleTracks: [],
  videoTracks: [],
  isFullscreen: false,
  isMinimized: false,
  loading: false,
  title: "",
  context: { kind: "none" },
  autoPlayNext: true,
};

// Rehydration snapshot for webview refreshes (F5): mpv is native and survives
// the reload, but every bit of React state driving its UI is lost. The
// snapshot carries what mpv can't tell us back (title, episode context, which
// UI mode the player was in). sessionStorage persists across reloads of the
// same window and dies with it — a stale entry is ignored unless the live
// player's path matches.
const PLAYER_SESSION_KEY = "player_session";

interface PlayerSessionSnapshot {
  path: string | null;
  title: string;
  context: PlayerContext;
  isMinimized: boolean;
  isFullscreen: boolean;
  autoPlayNext: boolean;
}

interface PlayerStatus {
  path: string | null;
  paused: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
}

function episodeTitle(show: string, ep: EpisodeRef): string {
  const s = ep.seasonNumber;
  const e = ep.episodeNumber;
  const prefix =
    s != null && e != null ? `S${s}E${e}` : e != null ? `E${e}` : "";
  const name = ep.title ? ep.title : "";
  if (prefix && name) return `${show} — ${prefix}: ${name}`;
  if (prefix) return `${show} — ${prefix}`;
  if (name) return `${show} — ${name}`;
  return show;
}

export function usePlayer(): [PlayerState, PlayerActions] {
  const [state, setState] = useState<PlayerState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const unlistenRefs = useRef<UnlistenFn[]>([]);
  // Path of the file currently loaded — used to start the seek-bar thumbnailer.
  const currentPathRef = useRef<string | null>(null);
  // Resume point (already cushioned) applied once the pending file loads —
  // seeking before FILE_LOADED lands in the void, so it waits for the event.
  const pendingStartRef = useRef<number | null>(null);
  const draggingRef = useRef<"seek" | "volume" | null>(null);
  const lastUserSeek = useRef(0);
  const lastUserVolume = useRef(0);
  const lastNonZeroVolume = useRef(100);
  const SUPPRESS_MS = 300;

  // Isolated playback-position store. mpv reports the position several times a
  // second; routing that through React state would re-render the entire app on
  // every tick. Instead it lives here and only components that read it (the seek
  // bar / time label, via useSyncExternalStore) re-render.
  const positionRef = useRef(0);
  const positionListeners = useRef(new Set<() => void>());
  const setPosition = useCallback((t: number) => {
    positionRef.current = t;
    positionListeners.current.forEach((cb) => cb());
  }, []);
  const subscribePosition = useCallback((cb: () => void) => {
    positionListeners.current.add(cb);
    return () => {
      positionListeners.current.delete(cb);
    };
  }, []);
  const getPosition = useCallback(() => positionRef.current, []);

  // Load persisted autoPlayNext
  useEffect(() => {
    (async () => {
      try {
        const settings = await invoke<Record<string, string>>("get_settings");
        if (settings["auto_play_next"] === "false") {
          setState((p) => ({ ...p, autoPlayNext: false }));
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  // Keep the rehydration snapshot current while a player is open (see
  // PLAYER_SESSION_KEY). context changes on every episode advance, so the
  // stored path stays in step with what mpv is actually playing.
  useEffect(() => {
    if (!state.isActive) {
      sessionStorage.removeItem(PLAYER_SESSION_KEY);
      return;
    }
    const snapshot: PlayerSessionSnapshot = {
      path: currentPathRef.current,
      title: state.title,
      context: state.context,
      isMinimized: state.isMinimized,
      isFullscreen: state.isFullscreen,
      autoPlayNext: state.autoPlayNext,
    };
    try {
      sessionStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(snapshot));
    } catch {
      // Storage unavailable — refresh restore just degrades to basics.
    }
  }, [state.isActive, state.title, state.context, state.isMinimized, state.isFullscreen, state.autoPlayNext]);

  // Webview refresh recovery: if a live mpv instance exists on mount, the app
  // was reloaded mid-playback — rebuild the player UI around it instead of
  // orphaning it (video hidden behind the opaque webview, audio still going).
  // mpv still holds its render region and margins from before the reload, and
  // the snapshot restores the matching UI mode, so the two line up.
  useEffect(() => {
    (async () => {
      try {
        const status = await invoke<PlayerStatus | null>("get_player_status");
        if (!status?.path) return;
        // The interactive driver thread also survives an F5 — when one is
        // live, it is the authority on title/context (the snapshot is only a
        // fallback for UI mode).
        let interactive: InteractiveStatus | null = null;
        try {
          interactive = await invoke<InteractiveStatus | null>("interactive_status");
        } catch {
          interactive = null;
        }
        let snap: PlayerSessionSnapshot | null = null;
        try {
          snap = JSON.parse(sessionStorage.getItem(PLAYER_SESSION_KEY) ?? "null");
        } catch {
          snap = null;
        }
        const matched = snap != null && snap.path === status.path;
        const fallbackTitle = status.path.split(/[\\/]/).pop() ?? status.path;
        currentPathRef.current = status.path;
        if (status.volume > 0) lastNonZeroVolume.current = status.volume;
        setPosition(status.position);
        setState((prev) => ({
          ...prev,
          isActive: true,
          isPlaying: !status.paused,
          // The surviving mpv instance is already rendering — no black holdback.
          presenting: true,
          loading: false,
          duration: status.duration,
          volume: Math.round(status.volume),
          muted: status.muted,
          title: interactive ? interactive.title : matched && snap ? snap.title : fallbackTitle,
          context: interactive
            ? { kind: "interactive", libraryId: interactive.libraryId, entryId: interactive.entryId }
            : matched && snap
              ? snap.context
              : { kind: "movie" },
          isMinimized: matched && snap ? snap.isMinimized : true,
          isFullscreen: matched && snap ? snap.isFullscreen : false,
          autoPlayNext: matched && snap ? snap.autoPlayNext : prev.autoPlayNext,
        }));
        refreshTracksInternal();
      } catch {
        // No live player (normal launch) — nothing to restore.
      }
    })();
    // Mount-only: this races nothing — play() can't have run yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshTracksInternal = useCallback(async () => {
    try {
      const json = await invoke<string>("get_player_tracks");
      const tracks: PlayerTrack[] = JSON.parse(json);
      setState((prev) => ({
        ...prev,
        audioTracks: tracks.filter((t) => t.type === "audio"),
        subtitleTracks: tracks.filter((t) => t.type === "sub"),
        // Exclude attached-picture streams (embedded covers/backdrops) — they
        // report as video tracks but aren't real selectable video.
        videoTracks: tracks.filter((t) => t.type === "video" && !t.albumart),
      }));
    } catch {
      // Player might not be ready yet
    }
  }, []);

  // True while an auto-advance is in flight, so eof-reached and mpv-end-file
  // (which can both signal the same EOF) never double-trigger.
  const advancingRef = useRef(false);

  const playEpisodeAtIndex = useCallback(async (newIndex: number) => {
    const ctx = stateRef.current.context;
    if (ctx.kind !== "episode") return;
    if (newIndex < 0 || newIndex >= ctx.episodes.length) return;
    const ep = ctx.episodes[newIndex];
    try {
      const path = await invoke<string>("get_episode_file_path", {
        libraryId: ctx.libraryId,
        episodeId: ep.episodeId,
      });
      currentPathRef.current = path;
      setPosition(0);
      setState((prev) => ({
        ...prev,
        loading: true,
        presenting: false,
        isPlaying: true,
        title: episodeTitle(ctx.showTitle, ep),
        context: { ...ctx, index: newIndex },
      }));
      await invoke("set_watch_target", { kind: "episode", id: ep.episodeId }).catch(() => {});
      await invoke("play_file", { path });
    } catch (e) {
      setState((prev) => ({ ...prev, loading: false }));
      throw e;
    }
  }, [setPosition]);

  // Natural end of the current file. With keep-open=yes mpv signals this via
  // the eof-reached property (END_FILE does not fire), pausing on the last frame.
  const handleNaturalEnd = useCallback(() => {
    if (advancingRef.current) return;
    const cur = stateRef.current;
    if (
      cur.autoPlayNext &&
      cur.context.kind === "episode" &&
      cur.context.index < cur.context.episodes.length - 1
    ) {
      advancingRef.current = true;
      playEpisodeAtIndex(cur.context.index + 1)
        .catch(() => {
          setState((p) => ({ ...p, isPlaying: false }));
        })
        .finally(() => {
          advancingRef.current = false;
        });
    } else {
      setState((prev) => ({ ...prev, isPlaying: false }));
    }
  }, [playEpisodeAtIndex]);

  // Set up event listeners when player becomes active
  useEffect(() => {
    if (!state.isActive) return;

    const setupListeners = async () => {
      const unlisten1 = await listen<{ name: string; value: unknown }>(
        "mpv-property-change",
        (event) => {
          const { name, value } = event.payload;
          if (name === "eof-reached") {
            if (value === true) handleNaturalEnd();
            return;
          }
          if (name === "time-pos") {
            // Goes to the isolated store, NOT React state, so this high-frequency
            // update doesn't re-render the app.
            if (draggingRef.current === "seek" || Date.now() - lastUserSeek.current < SUPPRESS_MS) return;
            setPosition((value as number) ?? 0);
            return;
          }
          setState((prev) => {
            switch (name) {
              case "duration":
                return { ...prev, duration: (value as number) ?? 0 };
              case "pause":
                return { ...prev, isPlaying: !(value as boolean) };
              case "volume": {
                const val = (value as number) ?? 100;
                if (val > 0) lastNonZeroVolume.current = val;
                if (draggingRef.current === "volume" || Date.now() - lastUserVolume.current < SUPPRESS_MS) return prev;
                return { ...prev, volume: val };
              }
              case "mute":
                return { ...prev, muted: (value as boolean) ?? false };
              case "track-list/count":
                refreshTracksInternal();
                return prev;
              default:
                return prev;
            }
          });
        }
      );

      const unlistenRestart = await listen("mpv-playback-restart", () => {
        setState((prev) => (prev.presenting ? prev : { ...prev, presenting: true }));
      });

      const unlisten2 = await listen("mpv-file-loaded", () => {
        setState((prev) => ({ ...prev, loading: false }));
        // Resume: jump to the stored position now that a timeline exists.
        if (pendingStartRef.current != null) {
          const t = pendingStartRef.current;
          pendingStartRef.current = null;
          setPosition(t);
          invoke("player_command", { cmd: "seek", args: [t.toString(), "absolute+exact"] }).catch(() => {});
        }
        refreshTracksInternal();
      });

      const unlisten3 = await listen<{ reason: number }>("mpv-end-file", (event) => {
        // Only auto-advance on natural EOF (reason 0). STOP/QUIT/REDIRECT fire
        // whenever we replace the file (e.g. user clicks another episode).
        // With keep-open=yes this rarely fires for EOF (eof-reached covers it),
        // but it's kept as a fallback; handleNaturalEnd dedupes.
        if (event.payload?.reason !== 0) return;
        handleNaturalEnd();
      });

      unlistenRefs.current = [unlisten1, unlisten2, unlisten3, unlistenRestart];
    };

    setupListeners();

    return () => {
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current = [];
    };
  }, [state.isActive, refreshTracksInternal, handleNaturalEnd, setPosition]);

  // Apply the user's configured default volume (settings, default 50%) and subtitle
  // styling at the start of a freshly-opened video. Not used for in-player
  // next/prev/auto-next, so a binge keeps whatever volume you set (subtitle styling
  // persists on the mpv instance anyway).
  const applyStartupSettings = useCallback(async () => {
    try {
      const settings = await invoke<Record<string, string>>("get_settings");
      const raw = parseInt(settings["default_volume"] ?? "", 10);
      const vol = Number.isNaN(raw) ? 50 : Math.max(0, Math.min(100, raw));
      await invoke("set_player_property", { name: "volume", value: vol.toString() });
      setState((prev) => ({ ...prev, volume: vol, muted: false }));
      await applySubtitleStyleToPlayer(settings);
    } catch {
      // Player not ready or settings unreadable — leave volume as-is.
    }
  }, []);

  /** Resume cushion: land a few seconds before the stored position for context. */
  const cushioned = (startSecs: number | undefined) =>
    startSecs != null && startSecs > 0 ? Math.max(0, startSecs - 4) : null;

  const play = useCallback(async (path: string, title: string, opts?: PlayOptions) => {
    const wasActive = stateRef.current.isActive;
    currentPathRef.current = path;
    pendingStartRef.current = cushioned(opts?.startSecs);
    setPosition(pendingStartRef.current ?? 0);
    setState((prev) => ({
      ...prev,
      loading: true,
      presenting: false,
      title,
      isActive: true,
      isPlaying: true,
      context: { kind: "movie" },
    }));
    try {
      if (!wasActive) {
        await invoke("init_player", { titlebarHeight: TITLEBAR_HEIGHT });
      }
      // Attribute (or explicitly un-attribute — extras) progress recording.
      await invoke("set_watch_target", {
        kind: opts?.watch?.kind ?? null,
        id: opts?.watch?.id ?? null,
      }).catch(() => {});
      await invoke("play_file", { path });
      await applyStartupSettings();
    } catch (e) {
      pendingStartRef.current = null;
      setState((prev) => ({ ...prev, loading: false, isActive: wasActive, isPlaying: false }));
      throw e;
    }
  }, [applyStartupSettings, setPosition]);

  // Interactive titles: the Rust engine loads the file itself (it must
  // validate the video against the branch graph first) and then drives all
  // segment jumps; the UI plays the same role as for a movie minus seeking.
  const playInteractive = useCallback(async (args: PlayInteractiveArgs) => {
    const wasActive = stateRef.current.isActive;
    pendingStartRef.current = null; // the engine owns all seeking
    setPosition(0);
    setState((prev) => ({
      ...prev,
      loading: true,
      presenting: false,
      title: args.title,
      isActive: true,
      isPlaying: true,
      context: { kind: "interactive", libraryId: args.libraryId, entryId: args.entryId },
    }));
    try {
      if (!wasActive) {
        await invoke("init_player", { titlebarHeight: TITLEBAR_HEIGHT });
      }
      // The interactive driver records its own resume; the linear watch
      // recorder must not attribute this playback to anything.
      await invoke("set_watch_target", { kind: null, id: null }).catch(() => {});
      await invoke("interactive_start", {
        libraryId: args.libraryId,
        entryId: args.entryId,
        fresh: args.fresh ?? false,
      });
      // The engine resolved the video path — mirror it for the F5 snapshot.
      const status = await invoke<PlayerStatus | null>("get_player_status");
      if (status?.path) currentPathRef.current = status.path;
      await applyStartupSettings();
    } catch (e) {
      // A validation refusal (mismatched pair) lands here after loadfile has
      // already replaced whatever was playing — the player has nothing valid
      // to show either way, so tear it down entirely.
      currentPathRef.current = null;
      try {
        await invoke("destroy_player");
      } catch {
        // ignore
      }
      setState((prev) => ({ ...initialState, autoPlayNext: prev.autoPlayNext }));
      throw e;
    }
  }, [applyStartupSettings, setPosition]);

  const playEpisode = useCallback(async (args: PlayEpisodeArgs) => {
    const { libraryId, showId, showTitle, startEpisodeId, startSecs } = args;
    const flat = await invoke<ShowEpisodeFlat[]>("get_show_episodes", {
      showId,
    });
    const episodes: EpisodeRef[] = flat.map((f) => ({
      episodeId: f.episode_id,
      seasonId: f.season_id,
      seasonNumber: f.season_number,
      episodeNumber: f.episode_number,
      title: f.title,
    }));

    const index = episodes.findIndex((e) => e.episodeId === startEpisodeId);
    if (index < 0) throw new Error("Episode not found in show");
    const ep = episodes[index];

    const path = await invoke<string>("get_episode_file_path", {
      libraryId,
      episodeId: ep.episodeId,
    });
    currentPathRef.current = path;

    const title = episodeTitle(showTitle, ep);
    const ctx: PlayerContext = { kind: "episode", libraryId, showId, showTitle, episodes, index };

    const wasActive = stateRef.current.isActive;
    pendingStartRef.current = cushioned(startSecs);
    setPosition(pendingStartRef.current ?? 0);
    setState((prev) => ({
      ...prev,
      loading: true,
      presenting: false,
      title,
      isActive: true,
      isPlaying: true,
      context: ctx,
    }));

    try {
      if (!wasActive) {
        await invoke("init_player", { titlebarHeight: TITLEBAR_HEIGHT });
      }
      await invoke("set_watch_target", { kind: "episode", id: ep.episodeId }).catch(() => {});
      await invoke("play_file", { path });
      await applyStartupSettings();
    } catch (e) {
      pendingStartRef.current = null;
      setState((prev) => ({ ...prev, loading: false, isActive: wasActive }));
      throw e;
    }
  }, [applyStartupSettings, setPosition]);

  const playNextEpisode = useCallback(async () => {
    const ctx = stateRef.current.context;
    if (ctx.kind !== "episode") return;
    if (ctx.index >= ctx.episodes.length - 1) return;
    await playEpisodeAtIndex(ctx.index + 1);
  }, [playEpisodeAtIndex]);

  const playPreviousEpisode = useCallback(async () => {
    const ctx = stateRef.current.context;
    if (ctx.kind !== "episode") return;
    if (ctx.index <= 0) return;
    await playEpisodeAtIndex(ctx.index - 1);
  }, [playEpisodeAtIndex]);

  const togglePause = useCallback(async () => {
    setState((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
    await invoke("player_command", { cmd: "cycle", args: ["pause"] });
  }, []);

  const seek = useCallback(async (seconds: number) => {
    lastUserSeek.current = Date.now();
    const dur = stateRef.current.duration;
    setPosition(Math.max(0, Math.min(dur, positionRef.current + seconds)));
    await invoke("player_command", {
      cmd: "seek",
      args: [seconds.toString(), "relative"],
    });
  }, [setPosition]);

  const seekAbsolute = useCallback(async (seconds: number) => {
    lastUserSeek.current = Date.now();
    setPosition(seconds);
    // `exact` forces a precise (non-keyframe) seek so we land on the same frame
    // the hover thumbnail shows, which also seeks with `absolute+exact`.
    await invoke("player_command", {
      cmd: "seek",
      args: [seconds.toString(), "absolute+exact"],
    });
  }, [setPosition]);

  const setVolume = useCallback(async (vol: number) => {
    lastUserVolume.current = Date.now();
    if (vol > 0) lastNonZeroVolume.current = vol;
    const wasMuted = stateRef.current.muted;
    setState((prev) => ({
      ...prev,
      volume: vol,
      muted: vol > 0 ? false : prev.muted,
    }));
    await invoke("set_player_property", {
      name: "volume",
      value: vol.toString(),
    });
    if (vol > 0 && wasMuted) {
      await invoke("player_command", { cmd: "cycle", args: ["mute"] });
    }
  }, []);

  // Live volume update while dragging: push to mpv so audio follows immediately,
  // but DON'T touch global React state — otherwise the whole app tree re-renders
  // on every pixel and the thumb lags. The slider's thumb is driven by a
  // component-local drag value; `setVolume` commits to global state on release.
  const setVolumeLive = useCallback(async (vol: number) => {
    lastUserVolume.current = Date.now();
    if (vol > 0) lastNonZeroVolume.current = vol;
    await invoke("set_player_property", { name: "volume", value: vol.toString() });
  }, []);

  const toggleMute = useCallback(async () => {
    const cur = stateRef.current;
    const effective = cur.muted ? 0 : cur.volume;
    lastUserVolume.current = Date.now();
    if (effective > 0) {
      if (cur.volume > 0) lastNonZeroVolume.current = cur.volume;
      setState((prev) => ({ ...prev, volume: 0 }));
      await invoke("set_player_property", { name: "volume", value: "0" });
    } else {
      const restore = lastNonZeroVolume.current > 0 ? lastNonZeroVolume.current : 100;
      setState((prev) => ({ ...prev, volume: restore, muted: false }));
      await invoke("set_player_property", { name: "volume", value: restore.toString() });
      if (cur.muted) {
        await invoke("player_command", { cmd: "cycle", args: ["mute"] });
      }
    }
  }, []);

  const setAudioTrack = useCallback(async (id: number) => {
    await invoke("set_player_property", { name: "aid", value: id.toString() });
  }, []);

  const setSubtitleTrack = useCallback(async (id: number) => {
    await invoke("set_player_property", { name: "sid", value: id.toString() });
  }, []);

  const setVideoTrack = useCallback(async (id: number) => {
    await invoke("set_player_property", { name: "vid", value: id.toString() });
  }, []);

  // Seek-bar thumbnails. The second decoder is spun up lazily on first hover
  // (prepareThumbnails) and torn down once hovering stops (endThumbnails), so
  // it only consumes RAM while actively scrubbing.
  const prepareThumbnails = useCallback(async (): Promise<boolean> => {
    const path = currentPathRef.current;
    if (!path) return false;
    try {
      await invoke("thumbnailer_start", { path });
      return true;
    } catch {
      return false;
    }
  }, []);

  const getThumbnail = useCallback(async (time: number): Promise<ArrayBuffer | null> => {
    try {
      return await invoke<ArrayBuffer>("thumbnail_at", { time });
    } catch {
      return null;
    }
  }, []);

  const endThumbnails = useCallback(async () => {
    try {
      await invoke("thumbnailer_stop");
    } catch {
      // ignore
    }
  }, []);

  const toggleSubtitles = useCallback(async () => {
    await invoke("player_command", { cmd: "cycle", args: ["sub-visibility"] });
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const appWindow = getCurrentWindow();
    const isFs = await appWindow.isFullscreen();
    const goingFullscreen = !isFs;
    await appWindow.setFullscreen(goingFullscreen);
    setState((prev) => ({ ...prev, isFullscreen: goingFullscreen }));

    if (goingFullscreen) {
      await invoke("set_player_property", { name: "video-margin-ratio-top", value: "0" });
    } else {
      const size = await appWindow.innerSize();
      if (size.height > 0) {
        const ratio = TITLEBAR_HEIGHT / size.height;
        await invoke("set_player_property", { name: "video-margin-ratio-top", value: ratio.toFixed(6) });
      }
    }
  }, []);

  const setPlayerRegion = useCallback(async (rect: { left: number; right: number; top: number; bottom: number }) => {
    try {
      await invoke("set_player_region", rect);
    } catch {
      // ignore
    }
  }, []);

  const toggleMinimize = useCallback(async () => {
    const cur = stateRef.current;
    const goingMinimized = !cur.isMinimized;
    // If we're currently fullscreen and minimizing, exit fullscreen first
    if (goingMinimized && cur.isFullscreen) {
      const appWindow = getCurrentWindow();
      await appWindow.setFullscreen(false);
      setState((prev) => ({ ...prev, isFullscreen: false }));
    }
    setState((prev) => ({ ...prev, isMinimized: goingMinimized }));
    if (!goingMinimized) {
      // Restoring full takeover — clear margins (titlebar margin re-applied below)
      await invoke("set_player_property", { name: "video-margin-ratio-left", value: "0" });
      await invoke("set_player_property", { name: "video-margin-ratio-right", value: "0" });
      await invoke("set_player_property", { name: "video-margin-ratio-bottom", value: "0" });
      const appWindow = getCurrentWindow();
      const size = await appWindow.innerSize();
      if (size.height > 0) {
        const ratio = TITLEBAR_HEIGHT / size.height;
        await invoke("set_player_property", { name: "video-margin-ratio-top", value: ratio.toFixed(6) });
      }
    }
  }, []);

  const toggleAutoPlayNext = useCallback(async () => {
    const next = !stateRef.current.autoPlayNext;
    setState((prev) => ({ ...prev, autoPlayNext: next }));
    try {
      await invoke("set_setting", { key: "auto_play_next", value: next ? "true" : "false" });
    } catch {
      // ignore
    }
  }, []);

  const close = useCallback(async () => {
    currentPathRef.current = null;
    try {
      await invoke("thumbnailer_stop");
    } catch {
      // ignore
    }
    try {
      await invoke("destroy_player");
    } catch {
      // Ignore — might already be destroyed
    }
    const appWindow = getCurrentWindow();
    if (await appWindow.isFullscreen()) {
      await appWindow.setFullscreen(false);
    }
    setPosition(0);
    setState((prev) => ({ ...initialState, autoPlayNext: prev.autoPlayNext }));
  }, [setPosition]);

  const setDragging = useCallback((field: "seek" | "volume" | null) => {
    draggingRef.current = field;
  }, []);

  // mpv pauses on frame-step; the "pause" property event syncs isPlaying.
  const frameStep = useCallback(async () => {
    await invoke("player_command", { cmd: "frame-step", args: [] });
  }, []);

  const frameBackStep = useCallback(async () => {
    await invoke("player_command", { cmd: "frame-back-step", args: [] });
  }, []);

  const interactiveSkip = useCallback(async (seconds: number) => {
    try {
      await invoke("interactive_skip", { seconds });
    } catch {
      // No session / clamped away — nothing to do.
    }
  }, []);

  const actions: PlayerActions = {
    play,
    playInteractive,
    playEpisode,
    playNextEpisode,
    playPreviousEpisode,
    togglePause,
    seek,
    seekAbsolute,
    subscribePosition,
    getPosition,
    setVolume,
    setVolumeLive,
    toggleMute,
    setAudioTrack,
    setSubtitleTrack,
    setVideoTrack,
    prepareThumbnails,
    getThumbnail,
    endThumbnails,
    toggleSubtitles,
    toggleFullscreen,
    toggleMinimize,
    setPlayerRegion,
    toggleAutoPlayNext,
    close,
    setDragging,
    frameStep,
    frameBackStep,
    interactiveSkip,
  };

  return [state, actions];
}
