import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MusicQueueItem } from "../types";

/**
 * Music playback — a second, audio-only mpv instance behind the persistent
 * now-playing bar. The queue lives HERE (the backend plays one file at a time
 * and reports progress/EOF); play-history logging is entirely backend-side.
 *
 * Two queue layers, one playback order:
 *  - CONTEXT: the list the user played from (album, playlist, Tracks page) —
 *    `queue` + `index`. "Up next" is simply its remainder.
 *  - EXPLICIT queue: tracks the user queued deliberately ("Play next" /
 *    "Add to queue"). They play after the current track, FIFO, WITHOUT moving
 *    the context — when they drain, the context resumes where it left off.
 *  Playback order: current → explicit queue → rest of context.
 *
 * Shuffle reorders only the context (the explicit queue was asked for in
 * order); the pre-shuffle order is stashed so toggling off restores it. Loop
 * is the standard tri-state; "one" repeats on natural track end only — manual
 * next always moves on.
 *
 * Video and music never play at once: the backend pauses the other player on
 * every start, and the resulting pause property-change keeps both UIs honest.
 */

export type LoopMode = "off" | "all" | "one";

export interface MusicPlayerState {
  /** A queue is loaded and the bar should be visible. */
  isActive: boolean;
  isPlaying: boolean;
  duration: number;
  volume: number;
  muted: boolean;
  /** The context: the list playback came from. */
  queue: MusicQueueItem[];
  index: number;
  /** Playing from the explicit queue right now (context index untouched). */
  explicitCurrent: MusicQueueItem | null;
  explicitQueue: MusicQueueItem[];
  /** Where the context came from ("Lateralus") — the Up Next section header. */
  contextLabel: string | null;
  shuffle: boolean;
  loop: LoopMode;
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
  /** Front of the explicit queue ("Play next"). Idle player → just plays. */
  enqueueNext: (items: MusicQueueItem[]) => void;
  /** Back of the explicit queue ("Add to queue"). Idle player → just plays. */
  enqueueLast: (items: MusicQueueItem[]) => void;
  removeQueuedAt: (i: number) => void;
  /** Reorder within the explicit queue (drag in the Up Next panel). */
  moveQueued: (from: number, to: number) => void;
  clearExplicitQueue: () => void;
  /** Play explicit-queue entry i now, dropping the entries before it. */
  playQueuedAt: (i: number) => Promise<void>;
  toggleShuffle: () => void;
  cycleLoop: () => void;
  subscribePosition: (cb: () => void) => () => void;
  getPosition: () => number;
}

/** The track in the bar right now — explicit-queue track wins. */
export function currentMusicItem(s: MusicPlayerState): MusicQueueItem | null {
  return s.explicitCurrent ?? s.queue[s.index] ?? null;
}

/** What plays next: repeat-one replays current, else explicit head, else the
 *  context remainder (wrapping under loop-all). */
type NextTarget =
  | { kind: "repeat"; item: MusicQueueItem }
  | { kind: "explicit"; item: MusicQueueItem }
  | { kind: "context"; index: number; item: MusicQueueItem };

const initialState: MusicPlayerState = {
  isActive: false,
  isPlaying: false,
  duration: 0,
  volume: 50,
  muted: false,
  queue: [],
  index: 0,
  explicitCurrent: null,
  explicitQueue: [],
  contextLabel: null,
  shuffle: false,
  loop: "off",
};

const SESSION_KEY = "music_session";

function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Header label for a fresh context: the shared album title when the whole
 *  list is one album, else nothing (mixed lists like Tracks/playlists). */
function labelForContext(items: MusicQueueItem[]): string | null {
  const first = items[0]?.albumTitle ?? null;
  if (!first) return null;
  return items.every((i) => i.albumTitle === first) ? first : null;
}

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
  const explicitCurrentRef = useRef<MusicQueueItem | null>(null);
  const explicitQueueRef = useRef<MusicQueueItem[]>([]);
  const labelRef = useRef<string | null>(null);
  const shuffleRef = useRef(false);
  const loopRef = useRef<LoopMode>("off");
  /** Pre-shuffle context order, for restoring when shuffle turns off. */
  const originalOrderRef = useRef<MusicQueueItem[] | null>(null);
  const activeRef = useRef(false);
  const volumeAppliedRef = useRef(false);

  const currentItem = useCallback(
    (): MusicQueueItem | null =>
      explicitCurrentRef.current ?? queueRef.current[indexRef.current] ?? null,
    []
  );

  const manualNext = useCallback((): NextTarget | null => {
    const eq = explicitQueueRef.current;
    if (eq.length > 0) return { kind: "explicit", item: eq[0] };
    const ni = indexRef.current + 1;
    if (ni < queueRef.current.length) return { kind: "context", index: ni, item: queueRef.current[ni] };
    if (loopRef.current === "all" && queueRef.current.length > 0) {
      return { kind: "context", index: 0, item: queueRef.current[0] };
    }
    return null;
  }, []);

  // Natural track end: repeat-one wins; otherwise same order as manual.
  const naturalNext = useCallback((): NextTarget | null => {
    if (loopRef.current === "one") {
      const c = currentItem();
      return c ? { kind: "repeat", item: c } : null;
    }
    return manualNext();
  }, [currentItem, manualNext]);

  const persistSession = useCallback(() => {
    try {
      if (activeRef.current) {
        sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({
            queue: queueRef.current,
            index: indexRef.current,
            explicitCurrent: explicitCurrentRef.current,
            explicitQueue: explicitQueueRef.current,
            label: labelRef.current,
            shuffle: shuffleRef.current,
            loop: loopRef.current,
            originalOrder: originalOrderRef.current,
          })
        );
      } else {
        sessionStorage.removeItem(SESSION_KEY);
      }
    } catch {
      // session snapshot is best-effort
    }
  }, []);

  // Guards the advance paths against double-firing (eof-reached can emit
  // more than once while the next loadfile is in flight).
  const loadingRef = useRef(false);

  // The target whose file has been appended to mpv's INTERNAL playlist for
  // gapless advance (null = nothing prefetched). While set, mpv advances
  // natively and eof-reached is not trusted. Any mutation of what-plays-next
  // (enqueue, shuffle, loop, removals) must re-arm via rearmPrefetch().
  const prefetchedRef = useRef<NextTarget | null>(null);

  /** Applies a target's state transition (refs + React state). The file is
   *  already playing (native advance) or about to be loaded by the caller. */
  const applyTargetState = useCallback((t: NextTarget) => {
    if (t.kind === "explicit") {
      const eq = explicitQueueRef.current;
      // Head should be t.item under re-arm discipline; drop by identity to be safe.
      const at = eq.indexOf(t.item);
      explicitQueueRef.current = at >= 0 ? [...eq.slice(0, at), ...eq.slice(at + 1)] : eq.slice(1);
      explicitCurrentRef.current = t.item;
    } else if (t.kind === "context") {
      explicitCurrentRef.current = null;
      indexRef.current = t.index;
    }
    // repeat: nothing moves.
    setState((s) => ({
      ...s,
      index: indexRef.current,
      explicitCurrent: explicitCurrentRef.current,
      explicitQueue: explicitQueueRef.current,
      isActive: true,
      isPlaying: true,
      duration: t.item.durationSecs ?? 0,
    }));
  }, []);

  // Append what plays next inside mpv so back-to-back songs (Parabol →
  // Parabola) transition without a frontend round-trip. The backend verifies
  // the current path so a stale in-flight prefetch can't queue a wrong file.
  const prefetchNext = useCallback(async () => {
    const cur = currentItem();
    const t = naturalNext();
    if (!cur || !t) {
      prefetchedRef.current = null;
      return;
    }
    prefetchedRef.current = t;
    try {
      const status = await invoke<string>("music_prefetch_next", {
        currentPath: cur.path,
        path: t.item.path,
      });
      if (status !== "appended" && prefetchedRef.current === t) {
        prefetchedRef.current = null;
        // The track ended while the prefetch was in flight (keep-open hold) —
        // advance the ordinary way rather than stalling.
        if (status === "eof" && activeRef.current) void autoAdvanceRef.current();
      }
    } catch {
      if (prefetchedRef.current === t) prefetchedRef.current = null;
    }
  }, [currentItem, naturalNext]);

  const prefetchNextRef = useRef(prefetchNext);
  prefetchNextRef.current = prefetchNext;

  /** Load and play a target via loadfile (manual moves + non-gapless ends). */
  const loadTarget = useCallback(
    async (t: NextTarget) => {
      prefetchedRef.current = null; // loadfile replaces mpv's playlist
      setPosition(0);
      applyTargetState(t);
      await invoke("music_play_track", { trackId: t.item.trackId, path: t.item.path });
      void prefetchNext();
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
    [persistSession, setPosition, prefetchNext, applyTargetState]
  );

  const loadContextAt = useCallback(
    async (index: number) => {
      const item = queueRef.current[index];
      if (!item) return;
      await loadTarget({ kind: "context", index, item });
    },
    [loadTarget]
  );

  const stop = useCallback(async () => {
    activeRef.current = false;
    queueRef.current = [];
    indexRef.current = 0;
    explicitCurrentRef.current = null;
    explicitQueueRef.current = [];
    labelRef.current = null;
    originalOrderRef.current = null;
    setPosition(0);
    setState((s) => ({
      ...initialState,
      volume: s.volume,
      muted: s.muted,
      shuffle: s.shuffle,
      loop: s.loop,
    }));
    persistSession();
    try {
      await invoke("music_stop");
    } catch {
      // never created — nothing to stop
    }
  }, [persistSession, setPosition]);

  /** Natural-order advance without a prefetched entry (fallback paths). */
  const autoAdvance = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const t = naturalNext();
      if (!t) {
        await stop();
        return;
      }
      await loadTarget(t);
    } finally {
      loadingRef.current = false;
    }
  }, [naturalNext, loadTarget, stop]);
  const autoAdvanceRef = useRef(autoAdvance);
  autoAdvanceRef.current = autoAdvance;

  /** Drop mpv's pending internal entry and re-prefetch — called whenever the
   *  what-plays-next answer may have changed. */
  const rearmPrefetch = useCallback(async () => {
    if (!activeRef.current) return;
    prefetchedRef.current = null;
    try {
      await invoke("music_command", { cmd: "playlist-clear", args: [] });
    } catch {
      /* best-effort */
    }
    void prefetchNextRef.current();
  }, []);

  const playQueue = useCallback(
    async (items: MusicQueueItem[], startIndex: number) => {
      if (items.length === 0) return;
      let start = Math.min(Math.max(startIndex, 0), items.length - 1);
      let queue = items;
      if (shuffleRef.current) {
        // Shuffle stays on across contexts (Spotify behavior): the picked
        // track plays first, the rest of the new context shuffles behind it.
        originalOrderRef.current = items;
        queue = [items[start], ...shuffled(items.filter((_, i) => i !== start))];
        start = 0;
      } else {
        originalOrderRef.current = null;
      }
      activeRef.current = true;
      labelRef.current = labelForContext(items);
      queueRef.current = queue;
      // The explicit queue deliberately SURVIVES a context switch.
      setState((s) => ({ ...s, queue, contextLabel: labelRef.current, isActive: true }));
      await loadContextAt(start);
    },
    [loadContextAt]
  );

  const jumpTo = useCallback(
    async (index: number) => {
      if (index < 0 || index >= queueRef.current.length) return;
      await loadContextAt(index);
    },
    [loadContextAt]
  );

  const togglePause = useCallback(async () => {
    await invoke("music_command", { cmd: "cycle", args: ["pause"] });
  }, []);

  const next = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const t = manualNext();
      if (!t) {
        await stop();
        return;
      }
      await loadTarget(t);
    } finally {
      loadingRef.current = false;
    }
  }, [manualNext, loadTarget, stop]);

  // Spotify convention: early in the track goes to the previous one, later
  // restarts the current one. From an explicit-queue track, "previous" lands
  // on the context track that played before the queued run.
  const previous = useCallback(async () => {
    if (positionRef.current > 3) {
      await invoke("music_command", { cmd: "seek", args: ["0", "absolute"] });
      setPosition(0);
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      if (explicitCurrentRef.current) {
        await loadContextAt(indexRef.current);
        return;
      }
      if (indexRef.current === 0) {
        await invoke("music_command", { cmd: "seek", args: ["0", "absolute"] });
        setPosition(0);
        return;
      }
      await loadContextAt(indexRef.current - 1);
    } finally {
      loadingRef.current = false;
    }
  }, [loadContextAt, setPosition]);

  // ── Explicit queue ─────────────────────────────────────────────────────────

  const enqueue = useCallback(
    (items: MusicQueueItem[], mode: "next" | "last") => {
      if (items.length === 0) return;
      if (!activeRef.current) {
        // Nothing playing — queueing just plays it.
        void playQueue(items, 0);
        return;
      }
      explicitQueueRef.current =
        mode === "next"
          ? [...items, ...explicitQueueRef.current]
          : [...explicitQueueRef.current, ...items];
      setState((s) => ({ ...s, explicitQueue: explicitQueueRef.current }));
      persistSession();
      void rearmPrefetch();
    },
    [playQueue, persistSession, rearmPrefetch]
  );

  const enqueueNext = useCallback((items: MusicQueueItem[]) => enqueue(items, "next"), [enqueue]);
  const enqueueLast = useCallback((items: MusicQueueItem[]) => enqueue(items, "last"), [enqueue]);

  const removeQueuedAt = useCallback(
    (i: number) => {
      const eq = explicitQueueRef.current;
      if (i < 0 || i >= eq.length) return;
      explicitQueueRef.current = [...eq.slice(0, i), ...eq.slice(i + 1)];
      setState((s) => ({ ...s, explicitQueue: explicitQueueRef.current }));
      persistSession();
      if (i === 0) void rearmPrefetch();
    },
    [persistSession, rearmPrefetch]
  );

  const moveQueued = useCallback(
    (from: number, to: number) => {
      const eq = explicitQueueRef.current;
      if (from === to || from < 0 || from >= eq.length || to < 0 || to >= eq.length) return;
      const next = [...eq];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      explicitQueueRef.current = next;
      setState((s) => ({ ...s, explicitQueue: next }));
      persistSession();
      // Only a changed HEAD affects what plays next (and the armed prefetch).
      if (from === 0 || to === 0) void rearmPrefetch();
    },
    [persistSession, rearmPrefetch]
  );

  const clearExplicitQueue = useCallback(() => {
    if (explicitQueueRef.current.length === 0) return;
    explicitQueueRef.current = [];
    setState((s) => ({ ...s, explicitQueue: [] }));
    persistSession();
    void rearmPrefetch();
  }, [persistSession, rearmPrefetch]);

  const playQueuedAt = useCallback(
    async (i: number) => {
      const eq = explicitQueueRef.current;
      const item = eq[i];
      if (!item) return;
      // Entries before the clicked one are dropped (they were skipped over).
      explicitQueueRef.current = eq.slice(i);
      setState((s) => ({ ...s, explicitQueue: explicitQueueRef.current }));
      await loadTarget({ kind: "explicit", item });
    },
    [loadTarget]
  );

  // ── Shuffle / loop ─────────────────────────────────────────────────────────

  const toggleShuffle = useCallback(() => {
    const on = !shuffleRef.current;
    shuffleRef.current = on;
    if (queueRef.current.length > 0) {
      const cur = queueRef.current[indexRef.current] ?? null;
      if (on) {
        originalOrderRef.current = queueRef.current;
        const rest = queueRef.current.filter((_, i) => i !== indexRef.current);
        queueRef.current = cur ? [cur, ...shuffled(rest)] : shuffled(rest);
        indexRef.current = 0;
      } else if (originalOrderRef.current) {
        const orig = originalOrderRef.current;
        originalOrderRef.current = null;
        queueRef.current = orig;
        const found = cur ? orig.indexOf(cur) : -1;
        indexRef.current = found >= 0 ? found : 0;
      }
    }
    setState((s) => ({
      ...s,
      shuffle: on,
      queue: queueRef.current,
      index: indexRef.current,
    }));
    persistSession();
    void rearmPrefetch();
  }, [persistSession, rearmPrefetch]);

  const cycleLoop = useCallback(() => {
    loopRef.current = loopRef.current === "off" ? "all" : loopRef.current === "all" ? "one" : "off";
    setState((s) => ({ ...s, loop: loopRef.current }));
    persistSession();
    void rearmPrefetch();
  }, [persistSession, rearmPrefetch]);

  // ── Volume ────────────────────────────────────────────────────────────────

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
            // keep-open=yes holds at EOF only when mpv has no next playlist
            // entry — i.e. end of queue, or a failed prefetch. With a
            // prefetched entry mpv advances natively instead (handled via
            // music-end-file below), so this signal isn't trusted then.
            if (value === true && activeRef.current && prefetchedRef.current == null) {
              void autoAdvanceRef.current();
            }
            break;
        }
      })
    );

    unlisteners.push(
      listen<{ reason: number }>("music-end-file", (event) => {
        if (event.payload.reason !== 0 || !activeRef.current) return;
        const pre = prefetchedRef.current;
        if (pre) {
          // mpv advanced NATIVELY into the prefetched entry (gapless) — sync
          // the queue state and swap the play-history row; no loadfile.
          prefetchedRef.current = null;
          setPosition(0);
          applyTargetState(pre);
          invoke("music_track_started", { trackId: pre.item.trackId }).catch(() => {});
          persistSession();
          void prefetchNextRef.current();
          return;
        }
        // No prefetched entry (shouldn't occur under keep-open) — advance
        // the ordinary way rather than stalling.
        void autoAdvanceRef.current();
      })
    );

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, [setPosition, applyTargetState, persistSession]);

  // ── F5 rehydration ─────────────────────────────────────────────────────────
  // mpv is native and keeps playing across a webview refresh; restore the bar
  // from the session snapshot + live status.
  useEffect(() => {
    (async () => {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const session = JSON.parse(raw) as {
          queue: MusicQueueItem[];
          index: number;
          explicitCurrent?: MusicQueueItem | null;
          explicitQueue?: MusicQueueItem[];
          label?: string | null;
          shuffle?: boolean;
          loop?: LoopMode;
          originalOrder?: MusicQueueItem[] | null;
        };
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
        explicitCurrentRef.current = session.explicitCurrent ?? null;
        explicitQueueRef.current = session.explicitQueue ?? [];
        labelRef.current = session.label ?? null;
        shuffleRef.current = session.shuffle ?? false;
        loopRef.current = session.loop ?? "off";
        originalOrderRef.current = session.originalOrder ?? null;
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
          explicitCurrent: explicitCurrentRef.current,
          explicitQueue: explicitQueueRef.current,
          contextLabel: labelRef.current,
          shuffle: shuffleRef.current,
          loop: loopRef.current,
        });
        // mpv may still hold a pre-refresh prefetched entry this session
        // knows nothing about — drop pending entries and re-arm the prefetch
        // so the native-advance bookkeeping stays in sync.
        try {
          await invoke("music_command", { cmd: "playlist-clear", args: [] });
        } catch {
          /* best-effort */
        }
        void prefetchNextRef.current();
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
      enqueueNext,
      enqueueLast,
      removeQueuedAt,
      moveQueued,
      clearExplicitQueue,
      playQueuedAt,
      toggleShuffle,
      cycleLoop,
      subscribePosition,
      getPosition,
    },
  ];
}
