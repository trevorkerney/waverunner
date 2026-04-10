import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PlayerTrack } from "../types";
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
  loading: boolean;
  title: string;
  eofReached: boolean;
  seeking: boolean;
}

export interface PlayerActions {
  play: (path: string, title: string) => Promise<void>;
  playUrl: (url: string, title: string) => Promise<void>;
  togglePause: () => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  seekAbsolute: (seconds: number) => Promise<void>;
  setVolume: (vol: number) => Promise<void>;
  toggleMute: () => Promise<void>;
  setAudioTrack: (id: number) => Promise<void>;
  setSubtitleTrack: (id: number) => Promise<void>;
  toggleSubtitles: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  close: () => Promise<void>;
  refreshTracks: () => Promise<void>;
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
  loading: false,
  title: "",
  eofReached: false,
  seeking: false,
};

export function usePlayer(): [PlayerState, PlayerActions] {
  const [state, setState] = useState<PlayerState>(initialState);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const draggingRef = useRef<"seek" | "volume" | null>(null);
  // Timestamps of the last user-initiated change — suppress mpv events
  // for this field until mpv has had time to process the new value.
  const lastUserSeek = useRef(0);
  const lastUserVolume = useRef(0);
  const SUPPRESS_MS = 300;

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
              case "volume":
                if (draggingRef.current === "volume" || Date.now() - lastUserVolume.current < SUPPRESS_MS) return prev;
                return { ...prev, volume: (value as number) ?? 100 };
              case "mute":
                return { ...prev, muted: (value as boolean) ?? false };
              case "eof-reached":
                return { ...prev, eofReached: (value as boolean) ?? false };
              case "seeking":
                return { ...prev, seeking: (value as boolean) ?? false };
              case "track-list/count":
                // Track list changed — refresh
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

      const unlisten3 = await listen("mpv-end-file", () => {
        setState((prev) => ({ ...prev, eofReached: true, isPlaying: false }));
      });

      unlistenRefs.current = [unlisten1, unlisten2, unlisten3];
    };

    setupListeners();

    return () => {
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current = [];
    };
  }, [state.isActive]);

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

  const play = useCallback(async (path: string, title: string) => {
    setState((prev) => ({ ...prev, loading: true, title, isActive: true, isPlaying: true }));
    try {
      await invoke("init_player", { titlebarHeight: TITLEBAR_HEIGHT });
      await invoke("play_file", { path });
    } catch (e) {
      setState((prev) => ({ ...prev, loading: false, isActive: false, isPlaying: false }));
      throw e;
    }
  }, []);

  const playUrl = useCallback(async (url: string, title: string) => {
    setState((prev) => ({ ...prev, loading: true, title, isActive: true, isPlaying: true }));
    try {
      await invoke("init_player", { titlebarHeight: TITLEBAR_HEIGHT });
      await invoke("play_url", { url });
    } catch (e) {
      setState((prev) => ({ ...prev, loading: false, isActive: false }));
      throw e;
    }
  }, []);

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
    setState((prev) => ({ ...prev, volume: vol }));
    await invoke("set_player_property", {
      name: "volume",
      value: vol.toString(),
    });
  }, []);

  const toggleMute = useCallback(async () => {
    setState((prev) => ({ ...prev, muted: !prev.muted }));
    await invoke("player_command", { cmd: "cycle", args: ["mute"] });
  }, []);

  const setAudioTrack = useCallback(async (id: number) => {
    await invoke("set_player_property", {
      name: "aid",
      value: id.toString(),
    });
  }, []);

  const setSubtitleTrack = useCallback(async (id: number) => {
    await invoke("set_player_property", {
      name: "sid",
      value: id.toString(),
    });
  }, []);

  const toggleSubtitles = useCallback(async () => {
    await invoke("player_command", {
      cmd: "cycle",
      args: ["sub-visibility"],
    });
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const appWindow = getCurrentWindow();
    const isFs = await appWindow.isFullscreen();
    await appWindow.setFullscreen(!isFs);
    setState((prev) => ({ ...prev, isFullscreen: !isFs }));
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
    setState(initialState);
  }, []);

  const setDragging = useCallback((field: "seek" | "volume" | null) => {
    draggingRef.current = field;
  }, []);

  const actions: PlayerActions = {
    play,
    playUrl,
    togglePause,
    seek,
    seekAbsolute,
    setVolume,
    toggleMute,
    setAudioTrack,
    setSubtitleTrack,
    toggleSubtitles,
    toggleFullscreen,
    close,
    refreshTracks: refreshTracksInternal,
    setDragging,
  };

  return [state, actions];
}
