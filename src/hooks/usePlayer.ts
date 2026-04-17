import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PlayerTrack, PlayerContext, EpisodeRef, ShowEpisodeFlat } from "../types";
import { TITLEBAR_HEIGHT } from "../components/Titlebar";

export interface PlayerState {
  isActive: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  audioTracks: PlayerTrack[];
  subtitleTracks: PlayerTrack[];
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
}

export interface PlayerActions {
  play: (path: string, title: string) => Promise<void>;
  playEpisode: (args: PlayEpisodeArgs) => Promise<void>;
  playNextEpisode: () => Promise<void>;
  playPreviousEpisode: () => Promise<void>;
  togglePause: () => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  seekAbsolute: (seconds: number) => Promise<void>;
  setVolume: (vol: number) => Promise<void>;
  toggleMute: () => Promise<void>;
  setAudioTrack: (id: number) => Promise<void>;
  setSubtitleTrack: (id: number) => Promise<void>;
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
  currentTime: 0,
  duration: 0,
  volume: 100,
  muted: false,
  audioTracks: [],
  subtitleTracks: [],
  isFullscreen: false,
  isMinimized: false,
  loading: false,
  title: "",
  context: { kind: "none" },
  autoPlayNext: true,
};

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
  const draggingRef = useRef<"seek" | "volume" | null>(null);
  const lastUserSeek = useRef(0);
  const lastUserVolume = useRef(0);
  const lastNonZeroVolume = useRef(100);
  const SUPPRESS_MS = 300;

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

  const refreshTracksInternal = useCallback(async () => {
    try {
      const json = await invoke<string>("get_player_tracks");
      const tracks: PlayerTrack[] = JSON.parse(json);
      setState((prev) => ({
        ...prev,
        audioTracks: tracks.filter((t) => t.type === "audio"),
        subtitleTracks: tracks.filter((t) => t.type === "sub"),
      }));
    } catch {
      // Player might not be ready yet
    }
  }, []);

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
      setState((prev) => ({
        ...prev,
        loading: true,
        isPlaying: true,
        title: episodeTitle(ctx.showTitle, ep),
        context: { ...ctx, index: newIndex },
      }));
      await invoke("play_file", { path });
    } catch (e) {
      setState((prev) => ({ ...prev, loading: false }));
      throw e;
    }
  }, []);

  // Set up event listeners when player becomes active
  useEffect(() => {
    if (!state.isActive) return;

    const setupListeners = async () => {
      const unlisten1 = await listen<{ name: string; value: unknown }>(
        "mpv-property-change",
        (event) => {
          const { name, value } = event.payload;
          setState((prev) => {
            switch (name) {
              case "time-pos":
                if (draggingRef.current === "seek" || Date.now() - lastUserSeek.current < SUPPRESS_MS) return prev;
                return { ...prev, currentTime: (value as number) ?? 0 };
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

      const unlisten2 = await listen("mpv-file-loaded", () => {
        setState((prev) => ({ ...prev, loading: false }));
        refreshTracksInternal();
      });

      const unlisten3 = await listen<{ reason: number }>("mpv-end-file", (event) => {
        // Only auto-advance on natural EOF (reason 0). STOP/QUIT/REDIRECT fire
        // whenever we replace the file (e.g. user clicks another episode).
        if (event.payload?.reason !== 0) return;
        const cur = stateRef.current;
        if (
          cur.autoPlayNext &&
          cur.context.kind === "episode" &&
          cur.context.index < cur.context.episodes.length - 1
        ) {
          playEpisodeAtIndex(cur.context.index + 1).catch(() => {
            setState((p) => ({ ...p, isPlaying: false }));
          });
        } else {
          setState((prev) => ({ ...prev, isPlaying: false }));
        }
      });

      unlistenRefs.current = [unlisten1, unlisten2, unlisten3];
    };

    setupListeners();

    return () => {
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current = [];
    };
  }, [state.isActive, refreshTracksInternal, playEpisodeAtIndex]);

  const play = useCallback(async (path: string, title: string) => {
    const wasActive = stateRef.current.isActive;
    setState((prev) => ({
      ...prev,
      loading: true,
      title,
      isActive: true,
      isPlaying: true,
      context: { kind: "movie" },
    }));
    try {
      if (!wasActive) {
        await invoke("init_player", { titlebarHeight: TITLEBAR_HEIGHT });
      }
      await invoke("play_file", { path });
    } catch (e) {
      setState((prev) => ({ ...prev, loading: false, isActive: wasActive, isPlaying: false }));
      throw e;
    }
  }, []);

  const playEpisode = useCallback(async (args: PlayEpisodeArgs) => {
    const { libraryId, showId, showTitle, startEpisodeId } = args;
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

    const title = episodeTitle(showTitle, ep);
    const ctx: PlayerContext = { kind: "episode", libraryId, showId, showTitle, episodes, index };

    const wasActive = stateRef.current.isActive;
    setState((prev) => ({
      ...prev,
      loading: true,
      title,
      isActive: true,
      isPlaying: true,
      context: ctx,
    }));

    try {
      if (!wasActive) {
        await invoke("init_player", { titlebarHeight: TITLEBAR_HEIGHT });
      }
      await invoke("play_file", { path });
    } catch (e) {
      setState((prev) => ({ ...prev, loading: false, isActive: wasActive }));
      throw e;
    }
  }, []);

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
    setState((prev) => ({
      ...prev,
      currentTime: Math.max(0, Math.min(prev.duration, prev.currentTime + seconds)),
    }));
    await invoke("player_command", {
      cmd: "seek",
      args: [seconds.toString(), "relative"],
    });
  }, []);

  const seekAbsolute = useCallback(async (seconds: number) => {
    lastUserSeek.current = Date.now();
    setState((prev) => ({ ...prev, currentTime: seconds }));
    await invoke("player_command", {
      cmd: "seek",
      args: [seconds.toString(), "absolute"],
    });
  }, []);

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
    try {
      await invoke("destroy_player");
    } catch {
      // Ignore — might already be destroyed
    }
    const appWindow = getCurrentWindow();
    if (await appWindow.isFullscreen()) {
      await appWindow.setFullscreen(false);
    }
    setState((prev) => ({ ...initialState, autoPlayNext: prev.autoPlayNext }));
  }, []);

  const setDragging = useCallback((field: "seek" | "volume" | null) => {
    draggingRef.current = field;
  }, []);

  const actions: PlayerActions = {
    play,
    playEpisode,
    playNextEpisode,
    playPreviousEpisode,
    togglePause,
    seek,
    seekAbsolute,
    setVolume,
    toggleMute,
    setAudioTrack,
    setSubtitleTrack,
    toggleSubtitles,
    toggleFullscreen,
    toggleMinimize,
    setPlayerRegion,
    toggleAutoPlayNext,
    close,
    setDragging,
  };

  return [state, actions];
}
