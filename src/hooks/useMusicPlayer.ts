import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MusicQueueItem } from "../types";

/**
 * Music playback — a second, audio-only mpv instance behind the persistent
 * now-playing bar. The queue lives HERE (the backend plays one file at a time
 * and reports progress/EOF); play-history logging is entirely backend-side.
 *
 * Video and music never play at once: the backend pauses the other player on
 * every start, and the resulting pause property-change keeps both UIs honest.
 */

export interface MusicPlayerState {
  /** A queue is loaded and the bar should be visible. */
  isActive: boolean;
  isPlaying: boolean;
  duration: number;
  volume: number;
  muted: boolean;
  queue: MusicQueueItem[];
  index: number;
}

export interface MusicPlayerActions {
  playQueue: (items: MusicQueueItem[], startIndex: number) => Promise<void>;
  togglePause: () => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seekAbsolute: (secs: number) => Promise<void>;
  setVolume: (v: number) => Promise<void>;
  setVolumeLive: (v: number) => void;
  toggleMute: () => Promise<void>;
  stop: () => Promise<void>;
  jumpTo: (index: number) => Promise<void>;
  subscribePosition: (cb: () => void) => () => void;
  getPosition: () => number;
}

const initialState: MusicPlayerState = {
  isActive: false,
  isPlaying: false,
  duration: 0,
  volume: 50,
  muted: false,
  queue: [],
  index: 0,
};

const SESSION_KEY = "music_session";

export function useMusicPlayer(): [MusicPlayerState, MusicPlayerActions] {
  const [state, setState] = useState<MusicPlayerState>(initialState);

  // High-frequency position lives outside React state (same pattern as the
  // video player) — the bar subscribes via useSyncExternalStore.
  const positionRef = useRef(0);
  const positionListenersRef = useRef(new Set<() => void>());
  const setPosition = useCallback((pos: number) => {
    positionRef.current = pos;
    positionListenersRef.current.forEach((cb) => cb());
  }, []);
  const subscribePosition = useCallback((cb: () => void) => {
    positionListenersRef.current.add(cb);
    return () => {
      positionListenersRef.current.delete(cb);
    };
  }, []);
  const getPosition = useCallback(() => positionRef.current, []);

  // Refs mirrored for event handlers (queue advance happens off-render).
  const queueRef = useRef<MusicQueueItem[]>([]);
  const indexRef = useRef(0);
  const activeRef = useRef(false);
  const volumeAppliedRef = useRef(false);

  const persistSession = useCallback(() => {
    try {
      if (activeRef.current) {
        sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ queue: queueRef.current, index: indexRef.current })
        );
      } else {
        sessionStorage.removeItem(SESSION_KEY);
      }
    } catch {
      // session snapshot is best-effort
    }
  }, []);

  // Guards the eof-advance path against double-firing (eof-reached can emit
  // more than once while the next loadfile is in flight).
  const loadingRef = useRef(false);

  const loadTrackAt = useCallback(
    async (index: number) => {
      const item = queueRef.current[index];
      if (!item) return;
      indexRef.current = index;
      setPosition(0);
      setState((s) => ({ ...s, index, isActive: true, isPlaying: true, duration: item.durationSecs ?? 0 }));
      await invoke("music_play_track", { trackId: item.trackId, path: item.path });
      // First play of the session: the BACKEND created the instance at the
      // configured default volume (applied before the file loads, so there is
      // no loud blip) — sync the bar to what it actually is.
      if (!volumeAppliedRef.current) {
        volumeAppliedRef.current = true;
        try {
          const status = await invoke<{ volume: number; muted: boolean } | null>("music_get_status");
          if (status) setState((s) => ({ ...s, volume: status.volume, muted: status.muted }));
        } catch {
          // default volume stands
        }
      }
      persistSession();
    },
    [persistSession, setPosition]
  );

  const stop = useCallback(async () => {
    activeRef.current = false;
    queueRef.current = [];
    indexRef.current = 0;
    setPosition(0);
    setState((s) => ({ ...initialState, volume: s.volume, muted: s.muted }));
    persistSession();
    try {
      await invoke("music_stop");
    } catch {
      // never created — nothing to stop
    }
  }, [persistSession, setPosition]);

  const advance = useCallback(
    async (delta: number) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        const next = indexRef.current + delta;
        if (next < 0 || next >= queueRef.current.length) {
          await stop();
          return;
        }
        await loadTrackAt(next);
      } finally {
        loadingRef.current = false;
      }
    },
    [loadTrackAt, stop]
  );
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  const playQueue = useCallback(
    async (items: MusicQueueItem[], startIndex: number) => {
      if (items.length === 0) return;
      const start = Math.min(Math.max(startIndex, 0), items.length - 1);
      activeRef.current = true;
      queueRef.current = items;
      setState((s) => ({ ...s, queue: items, isActive: true }));
      await loadTrackAt(start);
    },
    [loadTrackAt]
  );

  const jumpTo = useCallback(
    async (index: number) => {
      if (index < 0 || index >= queueRef.current.length) return;
      await loadTrackAt(index);
    },
    [loadTrackAt]
  );

  const togglePause = useCallback(async () => {
    await invoke("music_command", { cmd: "cycle", args: ["pause"] });
  }, []);

  const next = useCallback(async () => {
    await advance(1);
  }, [advance]);

  // Spotify convention: early in the track goes to the previous one, later
  // restarts the current one.
  const previous = useCallback(async () => {
    if (positionRef.current > 3 && indexRef.current >= 0) {
      await invoke("music_command", { cmd: "seek", args: ["0", "absolute"] });
      setPosition(0);
      return;
    }
    if (indexRef.current === 0) {
      await invoke("music_command", { cmd: "seek", args: ["0", "absolute"] });
      setPosition(0);
      return;
    }
    await advance(-1);
  }, [advance, setPosition]);

  const seekAbsolute = useCallback(
    async (secs: number) => {
      setPosition(secs);
      await invoke("music_command", { cmd: "seek", args: [String(secs), "absolute"] });
    },
    [setPosition]
  );

  // Bar adjustments last for the session (mpv keeps the property across
  // tracks); the startup default lives in Settings → Audio Player.
  const setVolume = useCallback(async (v: number) => {
    setState((s) => ({ ...s, volume: v }));
    await invoke("music_set_property", { name: "volume", value: String(v) });
  }, []);

  // Drag path: push to mpv only, no React state churn — and throttled with a
  // trailing send, so a fast drag doesn't flood the mpv command queue (the
  // flood is what made live volume feel laggy and steppy).
  const liveVolumeRef = useRef<{ pending: number | null; timer: number | null }>({
    pending: null,
    timer: null,
  });
  const setVolumeLive = useCallback((v: number) => {
    const live = liveVolumeRef.current;
    live.pending = v;
    if (live.timer != null) return;
    live.timer = window.setTimeout(() => {
      live.timer = null;
      const val = live.pending;
      live.pending = null;
      if (val != null) {
        invoke("music_set_property", { name: "volume", value: String(val) }).catch(() => {});
      }
    }, 40);
  }, []);

  const toggleMute = useCallback(async () => {
    await invoke("music_command", { cmd: "cycle", args: ["mute"] });
  }, []);

  // ── Backend events ─────────────────────────────────────────────────────────
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];

    unlisteners.push(
      listen<{ name: string; value: unknown }>("music-property-change", (event) => {
        const { name, value } = event.payload;
        switch (name) {
          case "time-pos":
            if (typeof value === "number") setPosition(value);
            break;
          case "duration":
            if (typeof value === "number") setState((s) => ({ ...s, duration: value }));
            break;
          case "pause":
            setState((s) => ({ ...s, isPlaying: !(value as boolean) }));
            break;
          // "volume" is deliberately NOT mirrored into state: mpv echoes every
          // set back as a property-change, and during a drag those echoes
          // arrive late and fight the slider (the jumpiness). The frontend is
          // the only volume writer, so its own state is already correct.
          case "mute":
            setState((s) => ({ ...s, muted: !!value }));
            break;
          case "eof-reached":
            // keep-open=yes means natural EOF never fires END_FILE — mpv holds
            // the file and flips this property instead. This is the queue-advance
            // signal.
            if (value === true && activeRef.current) {
              advanceRef.current(1);
            }
            break;
        }
      })
    );

    unlisteners.push(
      listen<{ reason: number }>("music-end-file", (event) => {
        // Belt and braces: reason 0 (EOF) shouldn't occur under keep-open, but
        // if it ever does, advance rather than stall.
        if (event.payload.reason === 0 && activeRef.current) {
          advanceRef.current(1);
        }
      })
    );

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, [setPosition]);

  // ── F5 rehydration ─────────────────────────────────────────────────────────
  // mpv is native and keeps playing across a webview refresh; restore the bar
  // from the session snapshot + live status.
  useEffect(() => {
    (async () => {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const session = JSON.parse(raw) as { queue: MusicQueueItem[]; index: number };
        const status = await invoke<{
          path: string | null;
          paused: boolean;
          position: number;
          duration: number;
          volume: number;
          muted: boolean;
        } | null>("music_get_status");
        if (!status || !status.path || !session.queue.length) {
          sessionStorage.removeItem(SESSION_KEY);
          return;
        }
        activeRef.current = true;
        queueRef.current = session.queue;
        indexRef.current = session.index;
        volumeAppliedRef.current = true;
        setPosition(status.position);
        setState({
          isActive: true,
          isPlaying: !status.paused,
          duration: status.duration,
          volume: status.volume,
          muted: status.muted,
          queue: session.queue,
          index: session.index,
        });
      } catch {
        // no live music session — clean slate
      }
    })();
  }, [setPosition]);

  return [
    state,
    {
      playQueue,
      togglePause,
      next,
      previous,
      seekAbsolute,
      setVolume,
      setVolumeLive,
      toggleMute,
      stop,
      jumpTo,
      subscribePosition,
      getPosition,
    },
  ];
}
