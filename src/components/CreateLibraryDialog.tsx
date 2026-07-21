import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
import { MetadataCenter } from "@/components/music/MetadataCenter";
import type { Library } from "@/types";
import { FolderOpen, Film, Music, Server, HardDrive, Plus, X, Check } from "lucide-react";

/** The import wizard. Setup → Scan → Match → Review for music (the library
 *  stays hidden — "Finish setup…" — until the wizard completes); Setup → Scan
 *  for video (unchanged flow inside the new shell). Clicking outside never
 *  dismisses; the X is step-aware (confirm mid-scan, skip-remaining
 *  mid-match). Rescans reuse the same wizard from the Scan step and may
 *  minimize during matching. */

export type WizardMode =
  | { kind: "create" }
  | { kind: "resume"; libraryId: string; name: string; stage: "scan" | "match" | "review" }
  | { kind: "rescan"; libraryId: string; name: string };

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

  const isMusicFlow = mode.kind !== "create" || format === "music";
  const managesSetupRow = mode.kind === "create" || mode.kind === "resume";

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
    if (!isOpen || step !== 3 || matchPhase !== "running") return;
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
    try {
      await invoke("music_match_begin", { libraryId });
    } catch (e) {
      toast.error(String(e));
      setMatchPhase("elect");
    }
  }

  async function skipMatching() {
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
      if (format === "music") {
        setLibraryId(library.id);
        setLibraryName(library.name);
        await enterMatch(library.id);
      } else {
        onOpenChange(false);
        resetForm();
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes("cancelled")) {
        if (toastIdRef.current != null) {
          toast.info("Import paused — finish setup from the sidebar", { id: toastIdRef.current, duration: 3000, action: undefined });
          toastIdRef.current = null;
        }
        // Music wizard scans survive a cancel: the library stays as
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
      if (!isMusicFlow) {
        // Video keeps the pre-wizard behavior: detach to a progress toast.
        if (toastIdRef.current == null) {
          toastIdRef.current = toast.loading(scanProgress || "Creating library...", {
            duration: Infinity,
            action: { label: "Cancel", onClick: handleCancelScan },
          });
        }
        onOpenChange(false);
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
        try {
          await invoke("music_match_skip");
        } catch (e) {
          console.error(e);
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

  const showMusicSteps = isMusicFlow;
  const steps: { n: Step; label: string }[] = showMusicSteps
    ? [
        { n: 1, label: "Setup" },
        { n: 2, label: "Scan" },
        { n: 3, label: "Match" },
        { n: 4, label: "Review" },
      ]
    : [
        { n: 1, label: "Setup" },
        { n: 2, label: "Scan" },
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
            <MetadataCenter libraryId={libraryId} reloadKey={centerReloadKey} />
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

              {step === 3 && matchPhase === "elect" && (
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

              {step === 3 && matchPhase === "running" && (
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
                  : "Skip the remaining matching? Unmatched albums stay available in the metadata center."}
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
              {!isMusicFlow && (
                <Button variant="outline" size="sm" onClick={handleCancelScan}>
                  Cancel
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => handleDialogClose(false)}>
                {isMusicFlow ? "Exit" : "Hide"}
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
