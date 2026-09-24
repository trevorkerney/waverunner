import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { runBulkMatch, type BulkRunConfig } from "@/components/tmdbMatchEngine";
import { latestEnrichProgress } from "@/hooks/enrichProgress";
import type { Library } from "@/types";

/** Library runs — the scan → (match?) lifecycle, owned in one place.
 *
 *  This replaced the import wizard modal (2026-09-22). A run is per library
 *  and moves through:
 *
 *    scan    — the library is being (re)built. Not browsable: the page shows
 *              the scan view in place of the library.
 *    prompt  — the scan landed; the library is browsable and a banner asks
 *              whether to match against MusicBrainz / TMDB (with the counts
 *              only a finished scan can know). "Not now" ends the run.
 *    match   — the pass is running; the banner shows its progress. The
 *              library stays browsable and playable — the BACKEND refuses
 *              edits while it works (music_mb::ensure_not_matching).
 *
 *  Libraries mid-setup (a library_setup row) complete their setup when the
 *  run ends, whichever way it ends. The video match run (a frontend serial
 *  loop over TMDB) lives here too, so it survives navigation.
 */

export interface ScanRun {
  kind: "scan";
  libraryId: string;
  name: string;
  format: string;
  /** First-time creation (Exit cancels and leaves the library resumable). */
  isCreate: boolean;
  /** The library carries a setup row — finish it when the run ends. */
  setup: boolean;
  folder: string | null;
  phase: string | null;
  done: number | null;
  total: number | null;
  sub: Record<string, { done: number; total: number }>;
  stopRequested: boolean;
}

export interface PromptRun {
  kind: "prompt";
  libraryId: string;
  name: string;
  format: string;
  setup: boolean;
  /** Music: what the pass would check. Video loads its own targets. */
  music: { unchecked: number; uncheckedArtists: number } | null;
}

export interface MatchProgress {
  done: number;
  total: number;
  name: string;
  phase: string;
  etaSecs: number | null;
}

export interface MatchRun {
  kind: "match";
  libraryId: string;
  name: string;
  format: string;
  setup: boolean;
  progress: MatchProgress | null;
  sub: Record<string, { done: number; total: number }>;
  sweep: number;
  skipRequested: boolean;
}

export type LibraryRun = ScanRun | PromptRun | MatchRun;

export interface VideoMatchOptions {
  cfg: BulkRunConfig;
  total: number;
}

export interface LibraryRunsApi {
  runs: Record<string, LibraryRun>;
  runFor: (libraryId: string | null | undefined) => LibraryRun | null;
  isScanning: (libraryId: string) => boolean;
  isMatching: (libraryId: string) => boolean;
  createLibrary: (args: {
    name: string;
    paths: { path: string; kind: string }[];
    format: string;
    source: string;
    onlineMetadata: boolean;
  }) => Promise<void>;
  rescan: (library: Library) => Promise<void>;
  stopScan: (libraryId: string) => Promise<void>;
  /** Music: start the pass. Video: run the chosen TMDB work. */
  startMatch: (library: Library, video?: VideoMatchOptions) => Promise<void>;
  /** Prompt: decline. Running: skip the rest. Either way the run ends. */
  skipMatch: (libraryId: string) => Promise<void>;
  /** Re-ask the match question for a library left mid-setup with no run. */
  resumePrompt: (library: Library) => Promise<void>;
}

export interface RunsCallbacks {
  /** Library list changed (created / setup completed). */
  onLibrariesChanged: () => void | Promise<void>;
  /** A scan began for this library (name known from the beacon). */
  onScanStarted: (libraryId: string, name: string, isCreate: boolean) => void;
  /** A scan finished (ok or not) — the library's contents changed. */
  onScanFinished: (libraryId: string, ok: boolean) => void;
  /** The whole run is over. `matched` = a pass actually ran (not declined). */
  onRunFinished: (libraryId: string, format: string, matched: boolean) => void;
}

interface HostApi {
  /** App feeds the provider what it needs each render (refs, no re-render). */
  _host: (libraries: Library[], callbacks: RunsCallbacks) => void;
}

const LibraryRunsContext = createContext<(LibraryRunsApi & HostApi) | null>(null);

export function useLibraryRuns(): LibraryRunsApi {
  const api = useContext(LibraryRunsContext);
  if (!api) throw new Error("useLibraryRuns outside LibraryRunsProvider");
  return api;
}

/** The one component that owns navigation (App) registers here. */
export function useLibraryRunsHost(libraries: Library[], callbacks: RunsCallbacks): LibraryRunsApi {
  const api = useContext(LibraryRunsContext);
  if (!api) throw new Error("useLibraryRunsHost outside LibraryRunsProvider");
  api._host(libraries, callbacks);
  return api;
}

/** Humanized time remaining from a seconds estimate: minutes under an hour,
 *  hours (with a minutes remainder while short) under a day, and a hard cap
 *  above that — an estimate that can't be trusted to the minute shouldn't
 *  print one ("about 80932 minutes" happened). */
export function fmtEta(secs: number): string {
  if (secs < 60) return "less than a minute remaining";
  if (secs < 3600) {
    const m = Math.round(secs / 60);
    return `about ${m} ${m === 1 ? "minute" : "minutes"} remaining`;
  }
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    if (h < 3 && m >= 5) {
      return `about ${h} ${h === 1 ? "hour" : "hours"} ${m} min remaining`;
    }
    const hr = Math.round(secs / 3600);
    return `about ${hr} ${hr === 1 ? "hour" : "hours"} remaining`;
  }
  return "more than a day remaining";
}

/** Steady rate for a phase: overall elapsed over items completed since the
 *  phase began, not a window over the last few events — a burst of instant
 *  items or one long stall skewed the old per-gap average into nonsense.
 *  Silent (null) until enough has happened to mean anything. */
const ETA_MIN_ITEMS = 5;
const ETA_MIN_ELAPSED_MS = 8000;
export function etaFromPhase(
  s: { startedAt: number; startDone: number },
  done: number,
  total: number,
): number | null {
  const completed = done - s.startDone;
  const elapsed = performance.now() - s.startedAt;
  if (completed < ETA_MIN_ITEMS || elapsed < ETA_MIN_ELAPSED_MS) return null;
  const remaining = Math.max(0, total - done);
  return Math.round(((elapsed / completed) * remaining) / 1000);
}

let creatingGlobal = false;
/** A create scan is in flight (the titlebar's close button confirms first). */
export function isCreatingLibrary(): boolean {
  return creatingGlobal;
}

const NO_CALLBACKS: RunsCallbacks = {
  onLibrariesChanged: () => {},
  onScanStarted: () => {},
  onScanFinished: () => {},
  onRunFinished: () => {},
};

export function LibraryRunsProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<Record<string, LibraryRun>>({});
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const librariesRef = useRef<Library[]>([]);
  const cbRef = useRef<RunsCallbacks>(NO_CALLBACKS);
  const host = useCallback((libraries: Library[], callbacks: RunsCallbacks) => {
    librariesRef.current = libraries;
    cbRef.current = callbacks;
  }, []);

  // Video runs: cancel flags per library (the engine polls between items).
  const videoCancelRef = useRef<Map<string, { cancelled: boolean }>>(new Map());
  // ETA bookkeeping per library (phase start + items done at that point).
  const etaRef = useRef<Map<string, { phase: string; startedAt: number; startDone: number }>>(new Map());
  // Scans this controller started itself, with what it knew at launch — the
  // scan-state beacon fills the rest. `create` marks first-time imports.
  const pendingScanRef = useRef<Map<string, { isCreate: boolean; setup: boolean; format: string }>>(new Map());
  const pendingCreateRef = useRef<{ format: string } | null>(null);
  // Scans picked up mid-flight from get_running_scans (no command await of
  // ours will report their end — the finished beacon does, see below).
  const rejoinedRef = useRef<Set<string>>(new Set());

  const update = useCallback((libraryId: string, f: (r: LibraryRun | undefined) => LibraryRun | undefined) => {
    setRuns((prev) => {
      const next = f(prev[libraryId]);
      if (next === prev[libraryId]) return prev;
      const copy = { ...prev };
      if (next) copy[libraryId] = next;
      else delete copy[libraryId];
      return copy;
    });
  }, []);

  const libMeta = useCallback((libraryId: string) => {
    const lib = librariesRef.current.find((l) => l.id === libraryId);
    return lib ? { name: lib.name, format: lib.format, setup: lib.setup_stage != null } : null;
  }, []);

  // ---- ending a run -------------------------------------------------------

  const finishRun = useCallback(async (libraryId: string) => {
    const run = runsRef.current[libraryId];
    const meta = libMeta(libraryId);
    const setup = run ? run.setup : meta?.setup ?? false;
    const format = run?.format ?? meta?.format ?? "music";
    const matched = run?.kind === "match";
    if (setup) {
      try {
        await invoke("complete_library_setup", { libraryId });
      } catch (e) {
        toast.error(String(e));
      }
    }
    update(libraryId, () => undefined);
    etaRef.current.delete(libraryId);
    videoCancelRef.current.delete(libraryId);
    await cbRef.current.onLibrariesChanged();
    cbRef.current.onRunFinished(libraryId, format, matched);
  }, [libMeta, update]);

  // ---- after a scan: prompt, or nothing to ask ---------------------------

  const afterScan = useCallback(async (libraryId: string, name: string, format: string, setup: boolean) => {
    // Per-library opt-out: with online metadata off there is no match step.
    try {
      const ls = await invoke<Record<string, string>>("get_library_settings", { libraryId });
      if (ls["online_metadata"] === "off") {
        await finishRun(libraryId);
        return;
      }
    } catch (e) {
      console.error(e);
    }
    if (format === "music") {
      try {
        const ms = await invoke<{ unchecked: number; unchecked_artists: number; running: boolean }>(
          "music_match_state",
          { libraryId },
        );
        if (ms.running) {
          update(libraryId, () => ({
            kind: "match", libraryId, name, format, setup,
            progress: null, sub: {}, sweep: 1, skipRequested: false,
          }));
          return;
        }
        if (ms.unchecked === 0 && ms.unchecked_artists === 0) {
          // Nothing a pass could do — don't ask.
          await finishRun(libraryId);
          return;
        }
        update(libraryId, () => ({
          kind: "prompt", libraryId, name, format, setup,
          music: { unchecked: ms.unchecked, uncheckedArtists: ms.unchecked_artists },
        }));
      } catch (e) {
        toast.error(String(e));
        await finishRun(libraryId);
      }
      return;
    }
    update(libraryId, () => ({ kind: "prompt", libraryId, name, format, setup, music: null }));
  }, [finishRun, update]);

  // ---- scans --------------------------------------------------------------

  useEffect(() => {
    const unState = listen<{ libraryId: string; name?: string; state: string }>("scan-state", (e) => {
      const { libraryId, name, state } = e.payload;
      if (state === "started") {
        const known = pendingScanRef.current.get(libraryId);
        // A create's id is only known from this beacon — claim the pending
        // create for it.
        const create = !known && pendingCreateRef.current ? pendingCreateRef.current : null;
        if (create) {
          pendingCreateRef.current = null;
          // Claimed: the create command's own await decides what follows
          // its finished beacon, same as a rescan we started.
          pendingScanRef.current.set(libraryId, { isCreate: true, setup: true, format: create.format });
        }
        const meta = libMeta(libraryId);
        const run: ScanRun = {
          kind: "scan",
          libraryId,
          name: name || meta?.name || "New library",
          format: known?.format ?? create?.format ?? meta?.format ?? "music",
          isCreate: known?.isCreate ?? !!create,
          setup: known?.setup ?? (create ? true : meta?.setup ?? false),
          folder: null, phase: null, done: null, total: null, sub: {},
          stopRequested: false,
        };
        update(libraryId, () => run);
        cbRef.current.onScanStarted(libraryId, run.name, run.isCreate);
        return;
      }
      // finished / failed: for scans we started, the command's own await
      // reports (the beacon lands a beat BEFORE the command's final writes,
      // e.g. a create's library becoming visible). A scan started elsewhere
      // just ends here.
      if (!pendingScanRef.current.has(libraryId)) {
        const run = runsRef.current[libraryId];
        update(libraryId, (r) => (r?.kind === "scan" ? undefined : r));
        cbRef.current.onScanFinished(libraryId, state === "finished");
        // A scan we REJOINED (see get_running_scans below) has no command
        // await to carry on from — do what the await would have: refresh
        // the list and, for a setup scan, ask the match question.
        if (rejoinedRef.current.delete(libraryId) && run?.kind === "scan") {
          void (async () => {
            // The command's final writes (create: the library becoming
            // visible) land a beat after this beacon.
            await new Promise((r) => setTimeout(r, 300));
            await cbRef.current.onLibrariesChanged();
            if (state === "finished") await afterScan(libraryId, run.name, run.format, run.setup);
          })();
        }
      }
    });
    const unProgress = listen<{
      libraryId: string; folder: string; phase?: string; done?: number; total?: number;
    }>("scan-progress", (e) => {
      const { libraryId, folder, phase, done, total } = e.payload;
      update(libraryId, (r) => {
        if (r?.kind !== "scan") return r;
        const sub = phase && total != null ? { ...r.sub, [phase]: { done: done ?? 0, total } } : r.sub;
        return { ...r, folder, phase: phase ?? null, done: done ?? null, total: total ?? null, sub };
      });
    });
    return () => {
      unState.then((fn) => fn());
      unProgress.then((fn) => fn());
    };
  }, [afterScan, libMeta, update]);

  // Rejoin scans already running when this controller mounts: the beacons
  // are fire-and-forget, so after a page reload (dev) or webview restart the
  // "started" is long gone and the scan would be invisible — its library
  // hidden, its row absent — until it finished on its own.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let running: { libraryId: string; name: string; format: string; isCreate: boolean }[];
      try {
        running = await invoke("get_running_scans");
      } catch {
        return;
      }
      if (cancelled) return;
      for (const s of running) {
        if (runsRef.current[s.libraryId] || pendingScanRef.current.has(s.libraryId)) continue;
        const meta = libMeta(s.libraryId);
        const run: ScanRun = {
          kind: "scan",
          libraryId: s.libraryId,
          name: s.name || meta?.name || "New library",
          format: s.format,
          isCreate: s.isCreate,
          setup: s.isCreate || (meta?.setup ?? false),
          folder: null, phase: null, done: null, total: null, sub: {},
          stopRequested: false,
        };
        rejoinedRef.current.add(s.libraryId);
        update(s.libraryId, () => run);
        cbRef.current.onScanStarted(s.libraryId, run.name, run.isCreate);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libMeta, update]);

  const createLibrary = useCallback<LibraryRunsApi["createLibrary"]>(async ({ name, paths, format, source, onlineMetadata }) => {
    if (creatingGlobal) {
      toast.info("A library is already being created");
      return;
    }
    creatingGlobal = true;
    pendingCreateRef.current = { format };
    try {
      const library = await invoke<Library>("create_library", { name, paths, format, source });
      pendingScanRef.current.delete(library.id);
      if (!onlineMetadata) {
        // Recorded before afterScan so its opt-out check sees the choice.
        await invoke("set_library_setting", { libraryId: library.id, key: "online_metadata", value: "off" });
      }
      await cbRef.current.onLibrariesChanged();
      cbRef.current.onScanFinished(library.id, true);
      await afterScan(library.id, library.name, format, true);
    } catch (e) {
      pendingCreateRef.current = null;
      const msg = String(e);
      if (msg.includes("cancelled")) {
        // The library stays, resumable: its setup row sits at "scan".
        toast("Setup paused — the library is in the sidebar, click it to finish scanning.");
      } else {
        toast.error(msg);
      }
      // Whichever run the beacon created for it is over.
      for (const [id, p] of [...pendingScanRef.current.entries()]) {
        if (p.isCreate) pendingScanRef.current.delete(id);
      }
      const failed = Object.values(runsRef.current).filter((r) => r.kind === "scan" && r.isCreate);
      setRuns((prev) => {
        const next = { ...prev };
        for (const [id, r] of Object.entries(prev)) {
          if (r.kind === "scan" && r.isCreate) delete next[id];
        }
        return next;
      });
      await cbRef.current.onLibrariesChanged();
      for (const r of failed) cbRef.current.onScanFinished(r.libraryId, false);
    } finally {
      creatingGlobal = false;
    }
  }, [afterScan]);

  const rescan = useCallback<LibraryRunsApi["rescan"]>(async (library) => {
    const existing = runsRef.current[library.id];
    if (existing?.kind === "scan") return;
    if (existing?.kind === "match") {
      toast.info(`“${library.name}” is being matched — rescan when the pass finishes.`);
      return;
    }
    const setup = library.setup_stage != null;
    pendingScanRef.current.set(library.id, { isCreate: false, setup, format: library.format });
    try {
      await invoke("rescan_library", { libraryId: library.id });
      if (setup) {
        await invoke("set_library_setup_stage", { libraryId: library.id, stage: "match" });
      }
      await cbRef.current.onLibrariesChanged();
      cbRef.current.onScanFinished(library.id, true);
      await afterScan(library.id, library.name, library.format, setup);
    } catch (e) {
      // A user-initiated stop is not an error: nothing was written that a
      // later rescan won't complete (read phase writes nothing; build stops
      // between artists and never sweeps).
      if (String(e).toLowerCase().includes("cancelled")) {
        toast("Rescan stopped — nothing lost.");
      } else {
        toast.error(String(e));
      }
      update(library.id, () => undefined);
      await cbRef.current.onLibrariesChanged();
      cbRef.current.onScanFinished(library.id, false);
    } finally {
      pendingScanRef.current.delete(library.id);
    }
  }, [afterScan, update]);

  const stopScan = useCallback<LibraryRunsApi["stopScan"]>(async (libraryId) => {
    update(libraryId, (r) => (r?.kind === "scan" ? { ...r, stopRequested: true } : r));
    try {
      await invoke("cancel_library_creation");
    } catch (e) {
      toast.error(String(e));
    }
  }, [update]);

  // ---- matching -----------------------------------------------------------

  useEffect(() => {
    const unIteration = listen<{ libraryId: string; iteration: number }>("music-enrich-iteration", (e) => {
      const { libraryId, iteration } = e.payload;
      update(libraryId, (r) => {
        if (r?.kind === "match") {
          // Fresh sweep, fresh sections — stale "(N)" chips from the previous
          // sweep would misread as this sweep's totals.
          return { ...r, sweep: iteration, sub: iteration > 1 ? {} : r.sub };
        }
        if (r?.kind === "scan") return r;
        // A pass started elsewhere (Metadata page): give it a banner.
        const meta = libMeta(libraryId);
        return {
          kind: "match", libraryId,
          name: meta?.name ?? "", format: meta?.format ?? "music",
          setup: r?.setup ?? meta?.setup ?? false,
          progress: null, sub: {}, sweep: iteration, skipRequested: false,
        };
      });
    });
    const unProgress = listen<{ libraryId?: string; phase: string; done: number; total: number; name: string }>(
      "music-enrich-progress",
      (e) => {
        const { libraryId, phase, done, total, name } = e.payload;
        if (!libraryId) return;
        let s = etaRef.current.get(libraryId);
        if (!s || s.phase !== phase) {
          s = { phase, startedAt: performance.now(), startDone: done };
          etaRef.current.set(libraryId, s);
        }
        const etaSecs = etaFromPhase(s, done, total);
        update(libraryId, (r) => {
          if (r?.kind !== "match") return r;
          return {
            ...r,
            progress: { done, total, name, phase, etaSecs },
            sub: { ...r.sub, [phase]: { done, total } },
          };
        });
      },
    );
    const unDone = listen<{ libraryId: string; error?: string }>("music-enrich-done", (e) => {
      const { libraryId, error } = e.payload;
      if (error) {
        toast.error(`MusicBrainz matching failed: ${error}. You can retry from the Metadata page.`);
      }
      if (runsRef.current[libraryId]?.kind === "match") void finishRun(libraryId);
    });
    return () => {
      unIteration.then((fn) => fn());
      unProgress.then((fn) => fn());
      unDone.then((fn) => fn());
    };
  }, [finishRun, libMeta, update]);

  const runVideo = useCallback(async (library: Library, setup: boolean, opts: VideoMatchOptions) => {
    const flag = { cancelled: false };
    videoCancelRef.current.set(library.id, flag);
    const eta = { phase: "tmdb", startedAt: performance.now(), startDone: 0 };
    let step = 0;
    const tick = (label: string) => {
      step++;
      const etaSecs = etaFromPhase(eta, step, opts.total);
      update(library.id, (r) =>
        r?.kind === "match"
          ? { ...r, progress: { done: step - 1, total: opts.total, name: label, phase: "tmdb", etaSecs } }
          : r,
      );
    };
    try {
      const outcome = await runBulkMatch(opts.cfg, tick, () => flag.cancelled);
      const st = outcome.stats;
      const matched = st.moviesMatched + st.showsMatched;
      if (matched > 0 || st.failed > 0) {
        toast.success(
          `TMDB matching: ${matched} matched${outcome.review.length > 0 ? `, ${outcome.review.length} need review` : ""}${st.failed > 0 ? `, ${st.failed} failed` : ""}`,
        );
      }
    } catch (e) {
      toast.error(String(e));
    }
    void setup;
    await finishRun(library.id);
  }, [finishRun, update]);

  const startMatch = useCallback<LibraryRunsApi["startMatch"]>(async (library, video) => {
    const existing = runsRef.current[library.id];
    if (existing?.kind === "scan") return;
    if (existing?.kind === "match") return;
    const setup = existing?.setup ?? library.setup_stage != null;
    update(library.id, () => ({
      kind: "match", libraryId: library.id, name: library.name, format: library.format, setup,
      progress: null, sub: {}, sweep: 1, skipRequested: false,
    }));
    if (library.format !== "music") {
      if (!video) {
        update(library.id, () => existing);
        return;
      }
      void runVideo(library, setup, video);
      return;
    }
    try {
      await invoke("music_match_begin", { libraryId: library.id });
      // The pass may already be mid-item before the listeners see event 1 —
      // seed from the always-on cache so item 1 shows instead of "Starting…".
      const cached = latestEnrichProgress(library.id);
      if (cached) {
        update(library.id, (r) =>
          r?.kind === "match" && !r.progress
            ? { ...r, progress: { done: cached.done, total: cached.total, name: cached.name, phase: cached.phase, etaSecs: null } }
            : r,
        );
      }
    } catch (e) {
      toast.error(String(e));
      update(library.id, () => existing);
    }
  }, [runVideo, update]);

  const skipMatch = useCallback<LibraryRunsApi["skipMatch"]>(async (libraryId) => {
    const run = runsRef.current[libraryId];
    if (!run || run.kind === "scan") return;
    if (run.kind === "prompt") {
      await finishRun(libraryId);
      return;
    }
    update(libraryId, (r) => (r?.kind === "match" ? { ...r, skipRequested: true } : r));
    if (run.format !== "music") {
      const flag = videoCancelRef.current.get(libraryId);
      if (flag) flag.cancelled = true;
      return;
    }
    try {
      await invoke("music_match_skip");
    } catch (e) {
      console.error(e);
    }
    // The done event lands shortly and ends the run.
  }, [finishRun, update]);

  // A library whose setup row still says "match" (the app was closed, or
  // it predates the banner) with no run: re-ask when it's opened.
  const resumePrompt = useCallback<LibraryRunsApi["resumePrompt"]>(async (library) => {
    if (runsRef.current[library.id]) return;
    if (!library.setup_stage || library.setup_stage === "scan") return;
    await afterScan(library.id, library.name, library.format, true);
  }, [afterScan]);

  const api = useMemo<LibraryRunsApi & HostApi>(() => ({
    runs,
    runFor: (id) => (id ? runs[id] ?? null : null),
    isScanning: (id) => runs[id]?.kind === "scan",
    isMatching: (id) => runs[id]?.kind === "match",
    createLibrary,
    rescan,
    stopScan,
    startMatch,
    skipMatch,
    resumePrompt,
    _host: host,
  }), [runs, createLibrary, rescan, stopScan, startMatch, skipMatch, resumePrompt, host]);

  return <LibraryRunsContext.Provider value={api}>{children}</LibraryRunsContext.Provider>;
}
