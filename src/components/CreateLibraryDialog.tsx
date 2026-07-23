import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import { MetadataCenter } from "@/components/music/MetadataCenter";
import { VideoMetadataCenter } from "@/components/VideoMetadataCenter";
import { runBulkMatch } from "@/components/tmdbMatchEngine";
import type { Library, TmdbBulkTargets } from "@/types";
import { FolderOpen, Film, Music, Server, HardDrive, Plus, X, Check } from "lucide-react";

/** The import wizard: Setup → Scan → Match → Review for BOTH formats. The
 *  library stays hidden — "Finish setup…" — until the wizard completes.
 *  External matching (MusicBrainz for music, TMDB for video) is elective:
 *  the Match step is an election screen with a skip. Clicking outside never
 *  dismisses; the X is step-aware (confirm mid-scan, skip-remaining
 *  mid-match). Rescans reuse the same wizard from the Scan step and may
 *  minimize during matching. */

export type WizardMode =
  | { kind: "create" }
  | { kind: "resume"; libraryId: string; name: string; format: string; stage: "scan" | "match" | "review" }
  | { kind: "rescan"; libraryId: string; name: string; format: string };

interface CreateLibraryDialogProps {
  open: boolean;
  mode?: WizardMode;
  /** Rescan-matching may hide the modal behind a progress chip (App renders
   *  the chip); the component stays mounted so listeners/state survive. */
  minimized?: boolean;
  onMinimizedChange?: (minimized: boolean) => void;
  onOpenChange: (open: boolean) => void;
  /** Library list changed (created / stage advanced) — refresh the sidebar. */
  onCreated: () => void;
  /** The wizard fully completed for a music library. */
  onFinished?: (libraryId: string) => void;
}

let creatingGlobal = false;

export function isCreatingLibrary(): boolean {
  return creatingGlobal;
}

type Step = 1 | 2 | 3 | 4;
type MatchPhase = "elect" | "running";

/** "about N minutes remaining" from a seconds estimate. */
export function fmtEta(secs: number): string {
  if (secs < 60) return "less than a minute remaining";
  const m = Math.round(secs / 60);
  return `about ${m} ${m === 1 ? "minute" : "minutes"} remaining`;
}

export function CreateLibraryDialog({
  open: isOpen,
  mode = { kind: "create" },
  minimized = false,
  onMinimizedChange,
  onOpenChange,
  onCreated,
  onFinished,
}: CreateLibraryDialogProps) {
  const [name, setName] = useState("");
  // Folders are tagged by kind: movies vs TV shows (video) or music. At least
  // one folder for the chosen format is required.
  const [moviePaths, setMoviePaths] = useState<string[]>([""]);
  const [showPaths, setShowPaths] = useState<string[]>([""]);
  const [musicPaths, setMusicPaths] = useState<string[]>([""]);
  const [format, setFormat] = useState("video");
  // Only 'local' is implemented; 'server' (Jellyfin/Plex/Emby client mode) is
  // shown disabled so the direction is visible in the UI.
  const [source, setSource] = useState("local");
  const [creating, setCreating] = useState(creatingGlobal);
  const [scanProgress, setScanProgress] = useState("");
  const toastIdRef = useRef<string | number | null>(null);

  const [step, setStep] = useState<Step>(1);
  const [matchPhase, setMatchPhase] = useState<MatchPhase>("elect");
  const [matchProgress, setMatchProgress] = useState<{
    done: number;
    total: number;
    name: string;
    phase: string;
    etaSecs: number | null;
  } | null>(null);
  // Rolling per-step timestamps for the time-remaining estimate: average gap
  // between recent steps × steps left. Reset when the pass changes phase
  // (albums → artists) since their per-step costs differ.
  const etaSamplesRef = useRef<{ phase: string; times: number[] }>({ phase: "", times: [] });
  const [uncheckedCount, setUncheckedCount] = useState<number | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [centerReloadKey, setCenterReloadKey] = useState(0);
  // The library the wizard is driving (created here, or resumed/rescanned).
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [libraryName, setLibraryName] = useState("");
  const initializedRef = useRef(false);

  // The library format the wizard is actually driving: the picker's value on a
  // fresh create, the library's known format on resume/rescan.
  const effFormat = mode.kind === "create" ? format : mode.format;
  const managesSetupRow = mode.kind === "create" || mode.kind === "resume";
  // Bridge to the video match step: the parent footer's Start/Skip buttons
  // drive the embedded TMDB run through this handle.
  const videoMatchRef = useRef<{ start: () => void; cancel: () => void } | null>(null);

  // Animate the dialog's height when the content changes size (switching
  // steps or Video ↔ Music folder sections). height:auto can't transition, so
  // the scroll wrapper gets an explicit measured height that eases between
  // values; flexbox (min-h-0, shrink) still caps it on small windows.
  // The node is held in STATE (callback ref): the dialog mounts in a portal
  // after this component's effects run, so a plain ref is still null when an
  // [isOpen] effect fires and the observer would never attach.
  const [formEl, setFormEl] = useState<HTMLDivElement | null>(null);
  const prevFormHeightRef = useRef<number | null>(null);
  const [formHeight, setFormHeight] = useState<number | null>(null);
  const [heightAnimating, setHeightAnimating] = useState(false);

  useEffect(() => {
    if (!formEl) {
      // Content unmounted (dialog closed) — measure fresh next open.
      prevFormHeightRef.current = null;
      setFormHeight(null);
      setHeightAnimating(false);
      return;
    }
    const measure = () => {
      // Ceil, not offsetHeight: rounding down leaves the content a sub-pixel
      // taller than the wrapper, which is enough to summon a scrollbar at rest.
      const h = Math.ceil(formEl.getBoundingClientRect().height);
      if (prevFormHeightRef.current !== null && Math.abs(prevFormHeightRef.current - h) > 1) {
        setHeightAnimating(true);
      }
      prevFormHeightRef.current = h;
      setFormHeight(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(formEl);
    return () => ro.disconnect();
  }, [formEl]);

  // Safety net: if the height ends up unchanged (or the transition event is
  // missed), don't leave the wrapper clipped forever.
  useEffect(() => {
    if (!heightAnimating) return;
    const id = window.setTimeout(() => setHeightAnimating(false), 450);
    return () => window.clearTimeout(id);
  }, [heightAnimating]);

  useEffect(() => {
    if (!creating) return;
    const unlisten = listen<string>("scan-progress", (event) => {
      setScanProgress(event.payload);
      if (toastIdRef.current != null) {
        toast.loading(event.payload, { id: toastIdRef.current, duration: Infinity });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [creating]);

  // Matching progress/completion — active whenever the wizard has a match
  // step in flight (the component stays mounted while minimized).
  useEffect(() => {
    if (!isOpen || step !== 3 || matchPhase !== "running" || effFormat !== "music") return;
    const unProgress = listen<{ phase: string; done: number; total: number; name: string }>(
      "music-enrich-progress",
      (e) => {
        const s = etaSamplesRef.current;
        if (s.phase !== e.payload.phase) {
          s.phase = e.payload.phase;
          s.times = [];
        }
        s.times.push(performance.now());
        if (s.times.length > 30) s.times.shift();
        let etaSecs: number | null = null;
        if (s.times.length >= 3) {
          const avgMs = (s.times[s.times.length - 1] - s.times[0]) / (s.times.length - 1);
          const remaining = Math.max(0, e.payload.total - e.payload.done - 1);
          etaSecs = Math.round((avgMs * remaining) / 1000);
        }
        setMatchProgress({
          done: e.payload.done,
          total: e.payload.total,
          name: e.payload.name,
          phase: e.payload.phase,
          etaSecs,
        });
      },
    );
    const unDone = listen<{ libraryId: string; error?: string }>("music-enrich-done", async (e) => {
      if (e.payload.libraryId !== libraryId) return;
      setMatchProgress(null);
      if (e.payload.error) {
        toast.error(`MusicBrainz matching failed: ${e.payload.error}. You can retry from the metadata center.`);
      }
      await enterReview();
    });
    return () => {
      unProgress.then((fn) => fn());
      unDone.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, step, matchPhase, libraryId]);

  // Mode-driven initialization on open.
  useEffect(() => {
    if (!isOpen) {
      initializedRef.current = false;
      return;
    }
    if (initializedRef.current) return;
    initializedRef.current = true;
    setConfirmExit(false);
    setMatchProgress(null);
    if (mode.kind === "create") {
      setStep(1);
      setLibraryId(null);
      setLibraryName("");
    } else {
      setLibraryId(mode.libraryId);
      setLibraryName(mode.name);
      if (mode.kind === "rescan" || mode.stage === "scan") {
        setStep(2);
        void runRescan(mode.libraryId);
      } else if (mode.stage === "match") {
        void enterMatch(mode.libraryId);
      } else {
        setStep(4);
        setCenterReloadKey((k) => k + 1);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode]);

  // Fill the name from the first browsed folder if the user hasn't named the library yet.
  function maybeAutoName(folder: string) {
    if (name) return;
    const parts = folder.replace(/\\/g, "/").split("/");
    setName(parts[parts.length - 1] || "");
  }

  const validMoviePaths = moviePaths.filter((p) => p.trim() !== "");
  const validShowPaths = showPaths.filter((p) => p.trim() !== "");
  const validMusicPaths = musicPaths.filter((p) => p.trim() !== "");
  const totalValidPaths =
    format === "music" ? validMusicPaths.length : validMoviePaths.length + validShowPaths.length;

  async function handleCancelScan() {
    try {
      await invoke("cancel_library_creation");
    } catch (e) {
      console.error("Failed to cancel:", e);
    }
  }

  function resetForm() {
    setName("");
    setMoviePaths([""]);
    setShowPaths([""]);
    setMusicPaths([""]);
    setFormat("video");
    setSource("local");
    setStep(1);
    setMatchPhase("elect");
    setMatchProgress(null);
    setUncheckedCount(null);
    setConfirmExit(false);
    setLibraryId(null);
    setLibraryName("");
  }

  function closeWizard() {
    onMinimizedChange?.(false);
    onOpenChange(false);
    resetForm();
  }

  async function enterMatch(libId: string) {
    setStep(3);
    setMatchPhase("elect");
    setHeightAnimating(true);
    if (effFormat !== "music") {
      // The video match step loads its own TMDB targets and reports its
      // workable count through onElectInfo; 0 keeps Start disabled until then.
      setUncheckedCount(0);
      return;
    }
    try {
      const ms = await invoke<{ unchecked: number; running: boolean }>("music_match_state", { libraryId: libId });
      setUncheckedCount(ms.unchecked);
      // A pass already running (resumed mid-match after an app restart with
      // the flag still set is impossible — RUNNING dies with the app — but a
      // center-triggered pass may be live): show its progress instead.
      if (ms.running) setMatchPhase("running");
    } catch {
      setUncheckedCount(null);
    }
  }

  async function enterReview() {
    const libId = libraryId;
    if (managesSetupRow && libId) {
      try {
        await invoke("set_library_setup_stage", { libraryId: libId, stage: "review" });
      } catch (e) {
        console.error(e);
      }
      onCreated();
    }
    setHeightAnimating(true);
    setStep(4);
    setCenterReloadKey((k) => k + 1);
    // Deliberately no auto-restore when minimized — the sidebar chip flips to
    // "review ready" and the user reopens when they're ready.
  }

  async function startMatching() {
    if (!libraryId) return;
    setMatchPhase("running");
    if (effFormat !== "music") {
      videoMatchRef.current?.start();
      return;
    }
    try {
      await invoke("music_match_begin", { libraryId });
    } catch (e) {
      toast.error(String(e));
      setMatchPhase("elect");
    }
  }

  async function skipMatching() {
    if (effFormat !== "music") {
      if (matchPhase === "elect") {
        await enterReview();
      } else {
        // The run finishes its current item, then its outcome lands and the
        // step advances to review via onDone.
        videoMatchRef.current?.cancel();
      }
      return;
    }
    try {
      await invoke("music_match_skip");
    } catch (e) {
      console.error(e);
    }
    // The done event lands shortly and advances to review; for the
    // never-started case, advance immediately.
    if (matchPhase === "elect") await enterReview();
  }

  async function finishWizard() {
    const libId = libraryId;
    if (managesSetupRow && libId) {
      try {
        await invoke("complete_library_setup", { libraryId: libId });
      } catch (e) {
        toast.error(String(e));
        return;
      }
      onFinished?.(libId);
    }
    onCreated();
    closeWizard();
  }

  async function runRescan(libId: string) {
    setCreating(true);
    creatingGlobal = true;
    setScanProgress("");
    try {
      await invoke("rescan_library", { libraryId: libId });
      if (managesSetupRow) {
        await invoke("set_library_setup_stage", { libraryId: libId, stage: "match" });
      }
      onCreated();
      await enterMatch(libId);
    } catch (e) {
      toast.error(String(e));
      closeWizard();
    } finally {
      setCreating(false);
      creatingGlobal = false;
    }
  }

  async function handleCreate() {
    if (!name || totalValidPaths === 0 || creatingGlobal) return;
    setCreating(true);
    creatingGlobal = true;
    setScanProgress("");
    setStep(2);
    setHeightAnimating(true);
    try {
      const paths =
        format === "music"
          ? validMusicPaths.map((path) => ({ path, kind: "music" }))
          : [
              ...validMoviePaths.map((path) => ({ path, kind: "movie" })),
              ...validShowPaths.map((path) => ({ path, kind: "show" })),
            ];
      const library = await invoke<Library>("create_library", { name, paths, format, source });
      if (toastIdRef.current != null) {
        toast.success(`Library "${name}" created`, { id: toastIdRef.current, duration: 4000, action: undefined });
        toastIdRef.current = null;
      }
      onCreated();
      setLibraryId(library.id);
      setLibraryName(library.name);
      await enterMatch(library.id);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("cancelled")) {
        if (toastIdRef.current != null) {
          toast.info("Import paused — finish setup from the sidebar", { id: toastIdRef.current, duration: 3000, action: undefined });
          toastIdRef.current = null;
        }
        // Wizard scans survive a cancel: the library stays as
        // "Finish setup…" and resumes at the scan step.
        onCreated();
        onOpenChange(false);
        resetForm();
      } else if (toastIdRef.current != null) {
        toast.error(msg, { id: toastIdRef.current, duration: 4000, action: undefined });
        toastIdRef.current = null;
      } else {
        toast.error(msg);
      }
    } finally {
      setCreating(false);
      creatingGlobal = false;
    }
  }

  /** Step-aware close request (the X button — outside clicks are disabled). */
  function handleDialogClose(openReq: boolean) {
    if (openReq) return;
    if (step === 1) {
      closeWizard();
      return;
    }
    if (step === 2) {
      if (!creating) {
        closeWizard();
        return;
      }
      setConfirmExit(true);
      return;
    }
    if (step === 3) {
      setConfirmExit(true);
      return;
    }
    // Step 4: closing IS finishing.
    void finishWizard();
  }

  /** Confirmed exit from step 2 (stop scan, resume later) or step 3 (skip
   *  remaining matching; the rest stays reviewable in the metadata center). */
  async function confirmExitNow() {
    setConfirmExit(false);
    if (step === 2) {
      if (mode.kind === "create") {
        // The backend keeps the library resumable at the scan stage.
        await handleCancelScan();
        // create_library's error path closes the wizard.
        return;
      }
      // Resume/rescan scans have no cancel path — detach to a toast.
      if (toastIdRef.current == null) {
        toastIdRef.current = toast.loading(scanProgress || "Scanning…", { duration: Infinity });
      }
      onOpenChange(false);
      return;
    }
    if (step === 3) {
      if (matchPhase === "running") {
        if (effFormat !== "music") {
          videoMatchRef.current?.cancel();
        } else {
          try {
            await invoke("music_match_skip");
          } catch (e) {
            console.error(e);
          }
        }
      }
      if (managesSetupRow && libraryId) {
        try {
          await invoke("complete_library_setup", { libraryId });
        } catch (e) {
          console.error(e);
        }
        onFinished?.(libraryId);
      }
      onCreated();
      closeWizard();
    }
  }

  const steps: { n: Step; label: string }[] = [
    { n: 1, label: "Setup" },
    { n: 2, label: "Scan" },
    { n: 3, label: "Match" },
    { n: 4, label: "Review" },
  ];
  const visibleSteps = mode.kind === "create" ? steps : steps.filter((s) => s.n !== 1);

  const estMinutes =
    uncheckedCount != null ? Math.max(1, Math.round((uncheckedCount * 3) / 60)) : null;

  const title =
    mode.kind === "create"
      ? "Create Library"
      : mode.kind === "rescan"
        ? `Rescan — ${libraryName}`
        : `Finish setup — ${libraryName}`;

  return (
    // Outside clicks never dismiss the wizard (only the X / Escape, both of
    // which route through handleDialogClose's step-aware rules).
    <Dialog
      open={isOpen && !minimized}
      onOpenChange={(o, details) => {
        if (!o && details.reason === "outside-press") return;
        handleDialogClose(o);
      }}
    >
      <DialogContent
        className={`overflow-hidden flex flex-col px-0 gap-0 ${step === 4 ? "sm:max-w-2xl max-h-[85vh]" : "sm:max-w-md"}`}
      >
        <DialogHeader className="px-4 pb-2">
          <DialogTitle>{title}</DialogTitle>
          {/* Stepper */}
          <div className="mt-1 flex items-center justify-center gap-1.5">
            {visibleSteps.map((s, i) => (
              <div key={s.n} className="flex items-center gap-1.5">
                {i > 0 && <div className={`h-px w-5 ${step >= s.n ? "bg-primary" : "bg-border"}`} />}
                <div
                  className={`flex items-center gap-1.5 text-xs ${
                    step === s.n ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <span
                    className={`flex size-4.5 items-center justify-center rounded-full border text-[10px] ${
                      step > s.n
                        ? "border-primary bg-primary text-primary-foreground"
                        : step === s.n
                          ? "border-primary text-primary"
                          : "border-border"
                    }`}
                  >
                    {step > s.n ? <Check size={10} /> : s.n}
                  </span>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </DialogHeader>

        {step === 4 && libraryId ? (
          <div className="flex min-h-0 flex-1 flex-col px-4 pt-2">
            {effFormat === "music" ? (
              <MetadataCenter libraryId={libraryId} reloadKey={centerReloadKey} />
            ) : (
              <VideoMetadataCenter libraryId={libraryId} reloadKey={centerReloadKey} />
            )}
          </div>
        ) : (
          <div
            className={`min-h-0 transition-[height] duration-300 ease-in-out ${
              heightAnimating ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"
            }`}
            style={{ height: formHeight != null ? `${formHeight}px` : undefined }}
            onTransitionEnd={(e) => {
              if (e.propertyName === "height") setHeightAnimating(false);
            }}
          >
            {/* min-w-0 down the chain: long unbreakable paths must truncate
                with an ellipsis instead of widening the modal. */}
            <div ref={setFormEl} className="grid min-w-0 gap-6 py-4 px-4">
              {step === 1 && (
                <>
                  <div className="grid gap-3">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={format === "video" ? "Videos" : "Music"}
                    />
                  </div>
                  <div className="grid gap-3">
                    <Label>Format</Label>
                    <ToggleGroup
                      value={[format]}
                      onValueChange={(v) => {
                        // Clip BEFORE the content swap commits — waiting for the
                        // ResizeObserver leaves one painted frame where the taller
                        // content flashes a scrollbar in the still-short wrapper.
                        // Only on a real change: an unchanged height never fires the
                        // transition, which would leave the clip stuck on.
                        if (v.includes("video") && format !== "video") {
                          setHeightAnimating(true);
                          setFormat("video");
                        } else if (v.includes("music") && format !== "music") {
                          setHeightAnimating(true);
                          setFormat("music");
                        }
                      }}
                      spacing={1}
                      className="grid w-full grid-cols-2 gap-3"
                    >
                      <ToggleGroupItem
                        value="video"
                        className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-4 data-[state=on]:border-primary data-[state=on]:bg-accent"
                      >
                        <Film size={28} />
                        <span className="text-sm font-medium">Video</span>
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value="music"
                        className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-4 data-[state=on]:border-primary data-[state=on]:bg-accent"
                      >
                        <Music size={28} />
                        <span className="text-sm font-medium">Music</span>
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                  <div className="grid gap-3">
                    <Label>Source</Label>
                    <ToggleGroup
                      value={[source]}
                      // Only 'local' is implemented — see the format group note above.
                      onValueChange={(v) => { if (v.includes("local")) setSource("local"); }}
                      spacing={1}
                      className="grid w-full grid-cols-2 gap-3"
                    >
                      <ToggleGroupItem
                        value="local"
                        className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-5 data-[state=on]:border-primary data-[state=on]:bg-accent"
                      >
                        <HardDrive size={32} />
                        <span className="text-sm font-medium">Local folders</span>
                      </ToggleGroupItem>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <ToggleGroupItem
                                value="server"
                                aria-disabled
                                className="flex h-auto cursor-not-allowed flex-col items-center gap-2 rounded border border-border px-4 py-5 opacity-50"
                              >
                                <Server size={32} />
                                <span className="text-sm font-medium">Media server</span>
                              </ToggleGroupItem>
                            }
                          />
                          <TooltipContent>
                            Coming soon. waverunner will be able to act as a client for a
                            Jellyfin, Plex, or Emby server.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </ToggleGroup>
                  </div>
                  {format === "music" ? (
                    <FolderSection
                      label="Music folders"
                      paths={musicPaths}
                      setPaths={setMusicPaths}
                      onAutoName={maybeAutoName}
                      onRowsChange={() => setHeightAnimating(true)}
                    />
                  ) : (
                    <>
                      <FolderSection
                        label="Movie folders"
                        paths={moviePaths}
                        setPaths={setMoviePaths}
                        onAutoName={maybeAutoName}
                        onRowsChange={() => setHeightAnimating(true)}
                      />
                      <FolderSection
                        label="TV Show folders"
                        paths={showPaths}
                        setPaths={setShowPaths}
                        onAutoName={maybeAutoName}
                        onRowsChange={() => setHeightAnimating(true)}
                      />
                    </>
                  )}
                </>
              )}

              {step === 2 && (
                <div className="flex w-full min-w-0 flex-col items-center gap-3 overflow-hidden py-6 text-center">
                  <Spinner className="size-6" />
                  <p className="text-sm font-medium">Scanning your library…</p>
                  <p className="min-h-4 w-full min-w-0 truncate px-2 text-xs text-muted-foreground">
                    {scanProgress || "Reading folders…"}
                  </p>
                </div>
              )}

              {step === 3 && effFormat !== "music" && libraryId && (
                <VideoMatchStep
                  libraryId={libraryId}
                  phase={matchPhase}
                  handle={videoMatchRef}
                  onElectInfo={(work) => setUncheckedCount(work)}
                  onDone={() => void enterReview()}
                />
              )}

              {step === 3 && effFormat === "music" && matchPhase === "elect" && (
                <div className="grid gap-4">
                  <div>
                    <p className="text-sm font-medium">Match against MusicBrainz?</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Fills gaps your tags don't cover — full track credits, release types, dates —
                      and flags anything uncertain for your review. Your own tag data is never
                      overwritten without your approval. You can also skip this entirely and match
                      later (or never) from the metadata center.
                    </p>
                    {uncheckedCount != null && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {uncheckedCount} {uncheckedCount === 1 ? "album" : "albums"} to check
                        {estMinutes != null && uncheckedCount > 0
                          ? ` · about ${estMinutes} ${estMinutes === 1 ? "minute" : "minutes"} — each album takes a couple of requests, and MusicBrainz allows ~1 per second`
                          : ""}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {step === 3 && effFormat === "music" && matchPhase === "running" && (
                <div className="flex w-full min-w-0 flex-col items-center gap-3 overflow-hidden py-6 text-center">
                  <Spinner className="size-6" />
                  <p className="w-full min-w-0 truncate px-2 text-sm font-medium">
                    {matchProgress?.phase === "artists"
                      ? "Looking up artists on MusicBrainz"
                      : matchProgress?.phase === "artist-images"
                        ? "Fetching artist images"
                        : "Matching against MusicBrainz"}
                    {matchProgress ? ` — ${matchProgress.done + 1}/${matchProgress.total}` : "…"}
                  </p>
                  <p className="min-h-4 w-full min-w-0 truncate px-2 text-xs text-muted-foreground">
                    {matchProgress?.name ?? "Starting…"}
                  </p>
                  <p className="min-h-4 text-xs text-muted-foreground">
                    {matchProgress?.etaSecs != null ? fmtEta(matchProgress.etaSecs) : ""}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="px-4 mx-0 -mb-4">
          {confirmExit ? (
            <div className="flex w-full items-center gap-2">
              <span className="flex-1 text-xs text-muted-foreground">
                {step === 2
                  ? "Stop the scan and finish setup later?"
                  : `Skip the remaining matching? Unmatched ${effFormat === "music" ? "albums" : "items"} stay available in the metadata center.`}
              </span>
              <Button variant="outline" size="sm" onClick={() => setConfirmExit(false)}>
                Keep going
              </Button>
              <Button size="sm" onClick={confirmExitNow}>
                {step === 2 ? "Stop & exit" : "Skip & exit"}
              </Button>
            </div>
          ) : step === 1 ? (
            <>
              <Button variant="outline" onClick={() => handleDialogClose(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={!name || totalValidPaths === 0}>
                Create
              </Button>
            </>
          ) : step === 2 ? (
            // Progress lives in the step body only — no duplicate line here.
            <div className="flex w-full items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => handleDialogClose(false)}>
                Exit
              </Button>
            </div>
          ) : step === 3 && matchPhase === "elect" ? (
            <>
              <Button variant="outline" onClick={() => void skipMatching()}>
                Skip for now
              </Button>
              <Button onClick={() => void startMatching()} disabled={uncheckedCount === 0}>
                Start matching
              </Button>
            </>
          ) : step === 3 ? (
            <div className="flex w-full items-center justify-end gap-2">
              {mode.kind === "rescan" && onMinimizedChange && (
                <Button variant="outline" size="sm" onClick={() => onMinimizedChange(true)}>
                  Minimize
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => void skipMatching()}>
                Skip remaining
              </Button>
            </div>
          ) : (
            <Button onClick={() => void finishWizard()}>Finish</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The wizard's video Match step: elective TMDB matching. Elect phase shows
 *  the pass checkboxes + request estimate; running phase shows progress + ETA.
 *  The parent footer drives it (Start/Skip/Skip-remaining) via `handle`; the
 *  serial run itself is the shared engine (tmdbMatchEngine). Progress is also
 *  dispatched as window "video-match-progress" events for the sidebar's
 *  minimized-rescan chip. */
function VideoMatchStep({
  libraryId,
  phase,
  handle,
  onElectInfo,
  onDone,
}: {
  libraryId: string;
  phase: MatchPhase;
  handle: MutableRefObject<{ start: () => void; cancel: () => void } | null>;
  /** Workable-unit count for the parent's Start button (0 disables it). */
  onElectInfo: (work: number) => void;
  onDone: () => void;
}) {
  const [targets, setTargets] = useState<TmdbBulkTargets | null>(null);
  const [hasToken, setHasToken] = useState(true);
  const [omdbEnabled, setOmdbEnabled] = useState(false);
  const [rtEnabled, setRtEnabled] = useState(false);
  const [doMovies, setDoMovies] = useState(true);
  const [doShows, setDoShows] = useState(true);
  const [doSeasons, setDoSeasons] = useState(true);
  const [doEpisodes, setDoEpisodes] = useState(true);
  const [doWebisodes, setDoWebisodes] = useState(false);
  const [doRatings, setDoRatings] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [etaSecs, setEtaSecs] = useState<number | null>(null);
  const etaTimesRef = useRef<number[]>([]);
  const cancelRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, settings] = await Promise.all([
          invoke<TmdbBulkTargets>("get_tmdb_bulk_targets", { libraryId }),
          invoke<Record<string, string>>("get_settings"),
        ]);
        if (cancelled) return;
        setTargets(t);
        setHasToken(Boolean(settings["tmdb_api_token"]?.trim()));
        setOmdbEnabled(settings["omdb_enabled"] === "true" && Boolean(settings["omdb_api_key"]?.trim()));
        setRtEnabled(settings["rt_scraper_enabled"] === "true");
        const willDoShows = t.shows.some((s) => !s.tmdb_id);
        setDoMovies(t.movies.length > 0);
        setDoShows(willDoShows);
        setDoSeasons(t.seasons.some((se) => !se.season_done));
        setDoEpisodes(t.seasons.some((se) => !se.episodes_done));
      } catch (e) {
        toast.error(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  const unmatchedShows = targets?.shows.filter((s) => !s.tmdb_id) ?? [];
  const matchableShowIds = new Set(
    (targets?.shows ?? []).filter((s) => s.tmdb_id != null || doShows).map((s) => s.id),
  );
  const seasonsNeeding = (targets?.seasons ?? []).filter(
    (se) => !se.season_done && matchableShowIds.has(se.show_id),
  );
  const episodeSeasonsNeeding = (targets?.seasons ?? []).filter(
    (se) => !se.episodes_done && matchableShowIds.has(se.show_id),
  );
  const eligibleWebisodeShows = (targets?.webisodes ?? []).filter((w) =>
    matchableShowIds.has(w.show_id),
  );
  const ratingsCount = (targets?.all_movies.length ?? 0) + (targets?.all_shows.length ?? 0);

  const workCount =
    (doMovies ? targets?.movies.length ?? 0 : 0) +
    (doShows ? unmatchedShows.length : 0) +
    (doSeasons ? seasonsNeeding.length : 0) +
    (doEpisodes ? episodeSeasonsNeeding.length : 0) +
    (doWebisodes ? eligibleWebisodeShows.length : 0) +
    (doRatings ? ratingsCount : 0);

  const apiHits =
    (doMovies ? (targets?.movies.length ?? 0) * 2 : 0) +
    (doShows ? unmatchedShows.length * 2 : 0) +
    (doSeasons ? seasonsNeeding.length : 0) +
    (doEpisodes ? episodeSeasonsNeeding.length : 0) +
    (doWebisodes ? eligibleWebisodeShows.length : 0) +
    (doRatings ? ratingsCount * (rtEnabled ? 3 : 1) : 0);

  // Parent Start button state: no token or nothing selected = disabled.
  useEffect(() => {
    onElectInfo(hasToken && targets ? workCount : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, targets, workCount]);

  const emitChip = (detail: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent("video-match-progress", { detail }));
  };

  const start = async () => {
    if (!targets) return;
    cancelRef.current = false;
    etaTimesRef.current = [];
    setEtaSecs(null);
    const total = workCount;
    let step = 0;
    const tick = (label: string) => {
      step++;
      const times = etaTimesRef.current;
      times.push(performance.now());
      if (times.length > 30) times.shift();
      let eta: number | null = null;
      if (times.length >= 3) {
        const avgMs = (times[times.length - 1] - times[0]) / (times.length - 1);
        eta = Math.round((avgMs * Math.max(0, total - step)) / 1000);
      }
      setEtaSecs(eta);
      setProgress({ current: step, total, label });
      emitChip({ current: step, total, label, etaSecs: eta, done: false });
    };
    const outcome = await runBulkMatch(
      {
        targets,
        doMovies,
        doShows,
        doSeasons,
        doEpisodes,
        doWebisodes,
        doRatings,
        unmatchedShows,
        seasonsNeeding,
        episodeSeasonsNeeding,
        eligibleWebisodeShows,
      },
      tick,
      () => cancelRef.current,
    );
    const st = outcome.stats;
    const matched = st.moviesMatched + st.showsMatched;
    if (matched > 0 || st.failed > 0) {
      toast.success(
        `TMDB matching: ${matched} matched${outcome.review.length > 0 ? `, ${outcome.review.length} need review` : ""}${st.failed > 0 ? `, ${st.failed} failed` : ""}`,
      );
    }
    emitChip({ done: true });
    onDone();
  };

  handle.current = {
    start: () => void start(),
    cancel: () => {
      cancelRef.current = true;
    },
  };

  if (phase === "running") {
    return (
      <div className="flex w-full min-w-0 flex-col items-center gap-3 overflow-hidden py-6 text-center">
        <Spinner className="size-6" />
        <p className="w-full min-w-0 truncate px-2 text-sm font-medium">
          Matching against TMDB
          {progress.total > 0 ? ` — ${progress.current}/${progress.total}` : "…"}
        </p>
        <p className="min-h-4 w-full min-w-0 truncate px-2 text-xs text-muted-foreground">
          {progress.label || "Starting…"}
        </p>
        <p className="min-h-4 text-xs text-muted-foreground">
          {etaSecs != null ? fmtEta(etaSecs) : ""}
        </p>
      </div>
    );
  }

  const checkboxRow = (
    label: string,
    count: number,
    checked: boolean,
    onChange: (v: boolean) => void,
    note?: string,
  ) => {
    const inert = count === 0;
    return (
      <label
        className={`flex items-center gap-3 rounded-md border border-border px-3 py-2 ${
          inert ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-accent/40"
        }`}
      >
        <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={inert} />
        <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
          <span className={`text-sm ${count === 0 ? "text-muted-foreground" : ""}`}>{label}</span>
          <span className="text-xs text-muted-foreground">
            {count}
            {note ? ` ${note}` : ""}
          </span>
        </div>
      </label>
    );
  };

  return (
    <div className="grid gap-4">
      <div>
        <p className="text-sm font-medium">Match against TMDB?</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Fills in posters, plots, cast, genres and more. Only confident matches are
          applied automatically — anything ambiguous is set aside for your review.
          You can also skip this entirely and match later (or never) from the
          metadata center.
        </p>
      </div>
      {!hasToken && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          No TMDB API token configured. Add one in Settings first, or skip for now.
        </p>
      )}
      {targets == null ? (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Counting unmatched media…
        </div>
      ) : (
        <>
          <div className="grid gap-2">
            {checkboxRow("Movies", targets.movies.length, doMovies, setDoMovies, "unmatched")}
            {checkboxRow("TV shows", unmatchedShows.length, doShows, (v) => {
              setDoShows(v);
              if (!v) {
                setDoSeasons(false);
                setDoEpisodes(false);
                setDoWebisodes(false);
              }
            }, "unmatched")}
            {checkboxRow("Seasons", seasonsNeeding.length, doSeasons, setDoSeasons, "to fetch")}
            {checkboxRow("Episodes", episodeSeasonsNeeding.length, doEpisodes, setDoEpisodes, "season fetches")}
            {omdbEnabled && checkboxRow("Ratings", ratingsCount, doRatings, setDoRatings, "titles")}
            {(targets.webisodes.length > 0) &&
              checkboxRow("Webisodes", eligibleWebisodeShows.length, doWebisodes, setDoWebisodes, "shows (fuzzy matching)")}
          </div>
          <p className="text-xs text-muted-foreground">
            Estimated API requests: <span className="font-medium text-foreground">{apiHits}</span>
          </p>
        </>
      )}
    </div>
  );
}

/** A repeatable folder picker for one media kind (movies, shows, or music). */
function FolderSection({
  label,
  paths,
  setPaths,
  onAutoName,
  onRowsChange,
}: {
  label: string;
  paths: string[];
  setPaths: Dispatch<SetStateAction<string[]>>;
  onAutoName: (folder: string) => void;
  /** Called before a row is added/removed so the dialog can clip pre-commit
   *  (the animated-height wrapper — see CreateLibraryDialog). */
  onRowsChange?: () => void;
}) {
  function updatePath(index: number, value: string) {
    setPaths((prev) => prev.map((p, i) => (i === index ? value : p)));
  }
  function addPath() {
    onRowsChange?.();
    setPaths((prev) => [...prev, ""]);
  }
  function removePath(index: number) {
    onRowsChange?.();
    setPaths((prev) => prev.filter((_, i) => i !== index));
  }
  async function browsePath(index: number) {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      updatePath(index, selected as string);
      onAutoName(selected as string);
    }
  }

  return (
    <div className="grid gap-3">
      <Label>{label}</Label>
      <div className="grid gap-2">
        {paths.map((p, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={p}
              onChange={(e) => updatePath(i, e.target.value)}
              placeholder="Select a folder..."
              className="flex-1"
            />
            <Button variant="outline" onClick={() => browsePath(i)} className="h-9 w-9 shrink-0 p-0">
              <FolderOpen size={16} />
            </Button>
            {paths.length > 1 && (
              <Button variant="outline" onClick={() => removePath(i)} className="h-9 w-9 shrink-0 p-0">
                <X size={16} />
              </Button>
            )}
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={addPath} className="justify-start gap-1.5 text-muted-foreground">
          <Plus size={14} />
          Add folder
        </Button>
      </div>
    </div>
  );
}
