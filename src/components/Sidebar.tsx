import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { PendingWorkBadge } from "@/components/music/PendingWork";
import { Trash2, RefreshCw, FolderPlus, FolderCog, ChevronRight, Sparkles, Pencil, Home, CircleAlert, Music2, Settings2, TriangleAlert } from "lucide-react";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreateLibraryDialog, type WizardMode } from "@/components/CreateLibraryDialog";
import { CreatePlaylistDialog } from "@/components/CreatePlaylistDialog";
import { RenameDialog } from "@/components/RenameDialog";
import { LibrarySettingsDialog } from "@/components/LibrarySettingsDialog";
import { PlayerDock } from "@/components/player/PlayerDock";
import { PlayerState, PlayerActions } from "@/hooks/usePlayer";
import { SidebarTree } from "@/components/SidebarTree";
import { getComplicationsForLibrary } from "@/lib/complications";
import type { ComplicationNode, GenreSummary, LibraryCounts, PlaylistSummary } from "@/types";
import { Library, ViewSpec } from "@/types";

const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 256;

interface SidebarProps {
  libraries: Library[];
  selectedLibrary: Library | null;
  // The currently active view (library-root, movies-only, people-list, etc).
  // Threaded through for the upcoming complication-tree UI; not yet rendered.
  activeView: ViewSpec | null;
  onSelectLibrary: (library: Library) => void;
  onSelectView: (view: ViewSpec) => void;
  /** Library auto-opened on launch, or null when none is set. */
  defaultLibraryId: string | null;
  /** Set (library id) or clear (null) the default library. */
  onSetDefaultLibrary: (libraryId: string | null) => void;
  onLibraryCreated: () => void;
  onLibraryDeleted: (deletedId: string) => void;
  /** Wizard completed (create finish, rescan finish, or skip-out) — the id
   *  tells App which library's caches to drop. */
  onLibraryRescanned: (libraryId?: string) => void;
  /** Called after a rename so App can reload libraries and fix baked-in labels. */
  onLibraryRenamed: (libraryId: string, oldName: string, newName: string) => void;
  /** Called after a playlist is created via the sidebar so App.tsx can invalidate caches. */
  onPlaylistChanged: (libraryId: string) => void;
  /** Opens the App-owned Match-to-MusicBrainz review modal. */
  onOpenMusicBrainzReview: (libraryId: string) => void;
  /** Opens the App-owned video metadata center (TMDB match review). */
  onOpenVideoMetadataCenter: (libraryId: string) => void;
  /** Per-library playlists to show as children of the "Playlists" sidebar node. */
  sidebarPlaylists: Record<string, PlaylistSummary[]>;
  /** Per-library counts shown dimmed on sidebar nodes. */
  sidebarCounts: Record<string, LibraryCounts>;
  /** Per-library genre lists shown as children of the "Genres" node. */
  sidebarGenres: Record<string, GenreSummary[]>;
  playerState: PlayerState;
  playerActions: PlayerActions;
  /** Now-playing art docked up here by the bar's up-arrow (null = not docked /
   *  nothing playing). coverUrl null = the docked track has no art — the dock
   *  stays up and shows a placeholder instead of collapsing. */
  dockedMusic?: { coverUrl: string | null } | null;
  /** The Home pseudo-library pinned above the real ones. */
  onOpenHome: () => void;
  homeActive: boolean;
  /** Libraries with a scan/rescan in flight — locked rows with a spinner. */
  scanningLibs: Set<string>;
  /** Libraries with a matching pass in flight — locked like a scanning one. */
  passLibs: Set<string>;
}

export function Sidebar({
  libraries,
  selectedLibrary,
  activeView,
  onSelectLibrary,
  onSelectView,
  defaultLibraryId,
  onSetDefaultLibrary,
  onLibraryCreated,
  onLibraryDeleted,
  onLibraryRescanned,
  onLibraryRenamed,
  onPlaylistChanged,
  onOpenMusicBrainzReview,
  onOpenVideoMetadataCenter,
  sidebarPlaylists,
  sidebarCounts,
  sidebarGenres,
  playerState,
  playerActions,
  dockedMusic,
  onOpenHome,
  homeActive,
  scanningLibs,
  passLibs,
}: SidebarProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  // The import wizard (create / resume unfinished setup / rescan), or null.
  const [wizard, setWizard] = useState<WizardMode | null>(null);
  const [wizardMinimized, setWizardMinimized] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Library | null>(null);
  // Typed-name gate for the delete dialog — must equal the library's name.
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [renameTarget, setRenameTarget] = useState<Library | null>(null);
  // Library whose source folders are being managed (add/remove/repoint).
  const [manageFoldersTarget, setManageFoldersTarget] = useState<Library | null>(null);
  // Library whose per-library settings dialog is open.
  const [settingsTarget, setSettingsTarget] = useState<Library | null>(null);
  // Which library to create a playlist inside, or null when the dialog is closed.
  const [createPlaylistFor, setCreatePlaylistFor] = useState<string | null>(null);
  // Track libraries the user has explicitly collapsed; default is expanded.
  const [collapsedLibs, setCollapsedLibs] = useState<Set<string>>(new Set());
  const isResizing = useRef(false);

  const renderNodeMenu = useCallback((node: ComplicationNode) => {
    if (node.id === "playlists" && node.view?.kind === "playlists") {
      const libId = node.view.libraryId;
      return (
        <ContextMenuItem onClick={() => setCreatePlaylistFor(libId)}>
          <FolderPlus size={14} />
          Create playlist
        </ContextMenuItem>
      );
    }
    return null;
  }, []);

  // Live per-library matching progress — the library row's status line.
  // Music streams tauri events (backend pass); video dispatches window
  // CustomEvents (the TMDB run lives in the frontend). Both carry libraryId.
  const [matchStatus, setMatchStatus] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const setLine = (libraryId: string, line: string | null) =>
      setMatchStatus((prev) => {
        const next = new Map(prev);
        if (line == null) next.delete(libraryId);
        else next.set(libraryId, line);
        return next;
      });
    const onVideoProgress = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        libraryId?: string;
        current?: number;
        total?: number;
        label?: string;
        done?: boolean;
      };
      if (!d.libraryId) return;
      if (d.done) setLine(d.libraryId, null);
      else setLine(d.libraryId, `matching ${d.current}/${d.total} — ${d.label}`);
    };
    window.addEventListener("video-match-progress", onVideoProgress);
    const unProgress = listen<{ libraryId?: string; phase: string; done: number; total: number; name: string }>(
      "music-enrich-progress",
      (e) => {
        const { libraryId, phase, done, total, name } = e.payload;
        if (!libraryId) return;
        const line =
          phase === "artist-ids"
            ? `identifying artists ${Math.min(done + 1, total)}/${total}`
            : phase === "artist-credits"
              ? `reading album credits ${Math.min(done + 1, total)}/${total}`
              : phase === "artist-search"
                ? `searching artists ${Math.min(done + 1, total)}/${total}`
                : phase === "artist-images"
                  ? `fetching artist images ${Math.min(done + 1, total)}/${total}`
                  : `matching ${Math.min(done + 1, total)}/${total} — ${name}`;
        setLine(libraryId, line);
      },
    );
    const unDone = listen<{ libraryId: string }>("music-enrich-done", (e) => {
      setLine(e.payload.libraryId, null);
    });
    return () => {
      unProgress.then((fn) => fn());
      unDone.then((fn) => fn());
      window.removeEventListener("video-match-progress", onVideoProgress);
    };
  }, []);

  // Latest scanned-folder line per library — shown under the locked sidebar
  // row while its scan runs; cleared when the scan-state beacon ends. Names
  // ride the started beacon so a mid-CREATION library (hidden from
  // get_libraries) can render under its real name.
  const [scanFolders, setScanFolders] = useState<Map<string, string>>(new Map());
  const [scanNames, setScanNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const unProgress = listen<{
      libraryId: string;
      folder: string;
      phase?: string;
      done?: number;
      total?: number;
    }>("scan-progress", (e) => {
      // The stored string is the full display line — phased music scans show
      // stage + counts, video scans keep the bare folder form.
      const { libraryId, folder, phase, done, total } = e.payload;
      const line =
        phase === "read-tags" && total
          ? `reading tags ${Math.min((done ?? 0) + 1, total)}/${total} — ${folder}`
          : phase === "build" && total
            ? `building ${Math.min((done ?? 0) + 1, total)}/${total} — ${folder}`
            : `scanning — ${folder}`;
      setScanFolders((prev) => new Map(prev).set(libraryId, line));
    });
    const unState = listen<{ libraryId: string; name?: string; state: string }>("scan-state", (e) => {
      if (e.payload.state === "started") {
        if (e.payload.name) {
          const { libraryId, name } = e.payload;
          setScanNames((prev) => new Map(prev).set(libraryId, name!));
        }
      } else {
        setScanFolders((prev) => {
          const next = new Map(prev);
          next.delete(e.payload.libraryId);
          return next;
        });
      }
    });
    return () => {
      unProgress.then((fn) => fn());
      unState.then((fn) => fn());
    };
  }, []);

  /** Open a new wizard unless one is already mounted (possibly minimized
   *  mid-scan/match) — clobbering it would orphan the in-flight run. */
  const launchWizard = useCallback((next: WizardMode) => {
    if (wizard) {
      setWizardMinimized(false);
      toast.info("Finish the current import first");
      return;
    }
    setWizard(next);
  }, [wizard]);

  // Rescan requests from surfaces that can't reach the wizard state (the
  // split-artist dialog, the grid context menu) arrive as window events.
  useEffect(() => {
    const onOpenRescan = (e: Event) => {
      const libraryId = (e as CustomEvent).detail?.libraryId as string | undefined;
      const lib = libraries.find((l) => l.id === libraryId);
      if (!lib) return;
      launchWizard({ kind: "rescan", libraryId: lib.id, name: lib.name, format: lib.format });
    };
    window.addEventListener("waverunner:open-rescan", onOpenRescan);
    // "Run a matching pass" from anywhere (center footer, queue banner,
    // library-page strip) opens the match-only wizard — the pass runs in the
    // normal modal, minimizable, instead of a rail spinner somewhere.
    const onOpenMatch = (e: Event) => {
      const libraryId = (e as CustomEvent).detail?.libraryId as string | undefined;
      const lib = libraries.find((l) => l.id === libraryId);
      if (!lib) return;
      launchWizard({ kind: "match", libraryId: lib.id, name: lib.name, format: lib.format });
    };
    window.addEventListener("waverunner:open-match", onOpenMatch);
    return () => {
      window.removeEventListener("waverunner:open-rescan", onOpenRescan);
      window.removeEventListener("waverunner:open-match", onOpenMatch);
    };
  }, [libraries, launchWizard]);


  const toggleLibExpand = useCallback((libId: string) => {
    setCollapsedLibs((prev) => {
      const next = new Set(prev);
      if (next.has(libId)) next.delete(libId);
      else next.add(libId);
      return next;
    });
  }, []);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    setDragging(true);

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
      setWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      setDragging(false);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const dockActive = playerState.isActive && playerState.isMinimized;

  // Last docked content (cover or placeholder), kept so it's still there to
  // slide away during the collapse animation after undocking.
  const lastDockedRef = useRef<{ coverUrl: string | null } | null>(null);
  if (dockedMusic) lastDockedRef.current = dockedMusic;
  const dockContent = dockedMusic ?? lastDockedRef.current;

  return (
    <div
      className={`relative flex h-full flex-shrink-0 flex-col text-sidebar-foreground ${dragging ? "" : "transition-[width] duration-200"}`}
      style={{ width }}
    >
      <aside className="flex flex-1 flex-col overflow-hidden bg-sidebar">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            Your library
          </span>
        </div>
        <ContextMenu>
          <ContextMenuTrigger
            render={<nav className="flex-1 overflow-y-auto pb-1" />}
          >
          {/* Home — the app's front door, pinned above the real libraries.
              The empty spacer keeps its label flush with the library names. */}
          <button
            onClick={onOpenHome}
            className={`flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-left text-sm font-medium transition-colors ${
              homeActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/90 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            }`}
          >
            <span className="flex h-5 w-4 flex-shrink-0" />
            <span className="min-w-0 flex-1 break-words">Home</span>
          </button>
          {libraries.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground whitespace-nowrap">
              No libraries yet
            </p>
          ) : (
            libraries.map((lib) => {
              const expanded = !collapsedLibs.has(lib.id);
              const isSelected = selectedLibrary?.id === lib.id;
              // Scan in flight: the row locks (mid-scan the library's data is
              // inconsistent) and shows live progress. Clicking brings back a
              // minimized wizard when one is running; there's nothing else to
              // do here until the scan ends.
              if (scanningLibs.has(lib.id)) {
                const folder = scanFolders.get(lib.id);
                return (
                  // One clickable unit: title row + progress line highlight
                  // and reopen the wizard together. Title renders EXACTLY
                  // like a normal row (spinner sized into the chevron slot)
                  // so nothing shifts when a rescan starts.
                  <button
                    key={lib.id}
                    onClick={() => {
                      if (wizard && wizardMinimized) setWizardMinimized(false);
                    }}
                    className="flex w-full flex-col text-left transition-colors hover:bg-sidebar-accent/50"
                  >
                    <span className="flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-sm font-medium text-sidebar-foreground/90">
                      <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                        <Spinner className="size-2" />
                      </span>
                      <span className="min-w-0 flex-1 break-words">{lib.name}</span>
                    </span>
                    {/* The complication tree's spot while scanning. */}
                    <span className="break-words pb-1 pl-6 pr-2 text-xs italic text-muted-foreground">
                      {folder ?? "scanning…"}
                    </span>
                  </button>
                );
              }
              // Matching in flight (MB/TMDB pass running behind a minimized
              // wizard): spinner in the chevron slot, live progress line
              // where the tree renders. Clicking brings the modal back.
              if (matchStatus.has(lib.id) || passLibs.has(lib.id)) {
                return (
                  <button
                    key={lib.id}
                    onClick={() => {
                      // A mounted wizard comes back; after an app reload
                      // (wizard state lost, backend pass still running)
                      // resume it — enterMatch detects the running pass.
                      if (wizard) {
                        setWizardMinimized(false);
                        return;
                      }
                      if (lib.setup_stage) {
                        setWizard({
                          kind: "resume",
                          libraryId: lib.id,
                          name: lib.name,
                          format: lib.format,
                          stage: (["scan", "match", "review"].includes(lib.setup_stage)
                            ? lib.setup_stage
                            : "match") as "scan" | "match" | "review",
                        });
                        return;
                      }
                      // A finished library running a pass (started from the
                      // metadata center) has no setup stage to resume — open
                      // the match wizard on the live pass instead. Without
                      // this the row locks with no way back to the modal.
                      if (passLibs.has(lib.id)) {
                        launchWizard({
                          kind: "match",
                          libraryId: lib.id,
                          name: lib.name,
                          format: lib.format,
                        });
                      }
                    }}
                    className="flex w-full flex-col text-left transition-colors hover:bg-sidebar-accent/50"
                  >
                    <span className="flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-sm font-medium text-sidebar-foreground/90">
                      <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                        <Spinner className="size-2" />
                      </span>
                      <span className="min-w-0 flex-1 break-words">{lib.name}</span>
                    </span>
                    <span className="break-words pb-1 pl-6 pr-2 text-xs italic text-muted-foreground">
                      {matchStatus.get(lib.id) ?? "matching…"}
                    </span>
                  </button>
                );
              }
              // Unfinished import, nothing running: the wizard is waiting on
              // the user — amber alert in the chevron slot, stage-specific
              // line below. Clicking resumes the wizard where it left off.
              // (A minimized RESCAN/MATCH wizard with nothing running does NOT
              // take this branch: the library's data is consistent again, so
              // the row stays browsable — a triangle beside the name reopens
              // the waiting wizard instead.)
              if (lib.setup_stage) {
                const stageLine =
                  lib.setup_stage === "review"
                    ? "Ready to review"
                    : lib.setup_stage === "match"
                      ? "Ready to match"
                      : lib.setup_stage === "scan"
                        ? "Setup paused — scan incomplete"
                        : "Ready to continue";
                return (
                  <div key={lib.id} className="flex flex-col">
                    <ContextMenu>
                      <ContextMenuTrigger
                        render={
                          <button
                            onClick={() => {
                              // A wizard already mounted (minimized mid-flight)
                              // must not be clobbered — just bring it back.
                              if (wizard) {
                                setWizardMinimized(false);
                                return;
                              }
                              setWizard({
                                kind: "resume",
                                libraryId: lib.id,
                                name: lib.name,
                                format: lib.format,
                                stage: (["scan", "match", "review"].includes(lib.setup_stage!)
                                  ? lib.setup_stage
                                  : "scan") as "scan" | "match" | "review",
                              });
                            }}
                          />
                        }
                        className="flex w-full flex-col text-left transition-colors hover:bg-sidebar-accent/50"
                      >
                        <span className="flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-sm font-medium text-sidebar-foreground/90">
                          <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                            <CircleAlert size={12} className="text-amber-400" />
                          </span>
                          <span className="min-w-0 flex-1 break-words">{lib.name}</span>
                        </span>
                        <span className="break-words pb-1 pl-6 pr-2 text-xs italic text-muted-foreground">
                          {stageLine}
                        </span>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          onClick={() => setDeleteTarget(lib)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 size={14} />
                          Delete
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </div>
                );
              }
              return (
                <div key={lib.id} className="flex flex-col">
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={
                        <button
                          // Navigate only — expand/collapse is the chevron's
                          // job. Exception: a pass running with no wizard to
                          // show it — the click reattaches the match modal
                          // (launchWizard un-minimizes an existing one).
                          onClick={() => onSelectLibrary(lib)}
                        />
                      }
                      className={`flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-left text-sm font-medium transition-colors ${
                        isSelected
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/90 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                      }`}
                    >
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLibExpand(lib.id);
                        }}
                        className="flex h-5 w-4 flex-shrink-0 items-center justify-center"
                      >
                        <ChevronRight
                          size={12}
                          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
                        />
                      </span>
                      {/* Badge rides right beside the name, not flushed to
                          the row's far edge — the outer span owns flex-1. */}
                      <span className="flex min-w-0 flex-1 items-start gap-1">
                        <span className="min-w-0 break-words">{lib.name}</span>
                        {lib.format === "music" && <PendingWorkBadge libraryId={lib.id} />}
                        {wizard && wizard.kind !== "create" && wizard.libraryId === lib.id && wizardMinimized && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              setWizardMinimized(false);
                            }}
                            title="The rescan wizard is waiting — click to reopen"
                            className="flex h-5 flex-shrink-0 cursor-pointer items-center"
                          >
                            <TriangleAlert size={12} className="text-amber-400 hover:text-amber-300" />
                          </span>
                        )}
                      </span>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => setRenameTarget(lib)}>
                        <Pencil size={14} />
                        Rename
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() =>
                          // Rescans run through the wizard for both formats
                          // (scan → elective match → review, minimizable).
                          launchWizard({ kind: "rescan", libraryId: lib.id, name: lib.name, format: lib.format })
                        }
                      >
                        <RefreshCw size={14} />
                        Rescan
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => setManageFoldersTarget(lib)}>
                        <FolderCog size={14} />
                        Manage folders…
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => setSettingsTarget(lib)}>
                        <Settings2 size={14} />
                        Library settings…
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => {
                          const makingDefault = defaultLibraryId !== lib.id;
                          onSetDefaultLibrary(makingDefault ? lib.id : null);
                          toast.success(
                            makingDefault
                              ? `${lib.name} will open on launch`
                              : "Default library cleared",
                          );
                        }}
                      >
                        <Home size={14} />
                        {defaultLibraryId === lib.id ? "Unset as default" : "Set as default"}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() =>
                          lib.format === "music"
                            ? onOpenMusicBrainzReview(lib.id)
                            : onOpenVideoMetadataCenter(lib.id)
                        }
                      >
                        <Sparkles size={14} />
                        Metadata center
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => setDeleteTarget(lib)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 size={14} />
                        Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  {expanded && (
                    <SidebarTree
                      nodes={getComplicationsForLibrary(lib, sidebarPlaylists[lib.id] ?? [], sidebarCounts[lib.id], sidebarGenres[lib.id])}
                      activeView={isSelected ? activeView : null}
                      onSelectView={(view) => {
                        onSelectView(view);
                      }}
                      renderNodeMenu={renderNodeMenu}
                      depth={1}
                    />
                  )}
                </div>
              );
            })
          )}
          {/* A library mid-CREATION is hidden from get_libraries until its
              scan lands — its scanning row renders synthetically so the
              minimized wizard still has a face in the sidebar. */}
          {[...scanningLibs]
            .filter((id) => !libraries.some((l) => l.id === id))
            .map((id) => (
              <button
                key={id}
                onClick={() => {
                  if (wizard && wizardMinimized) setWizardMinimized(false);
                }}
                className="flex w-full flex-col text-left transition-colors hover:bg-sidebar-accent/50"
              >
                <span className="flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-sm font-medium text-sidebar-foreground/90">
                  <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                    <Spinner className="size-2" />
                  </span>
                  <span className="min-w-0 flex-1 break-words">{scanNames.get(id) ?? "New library"}</span>
                </span>
                <span className="break-words pb-1 pl-6 pr-2 text-xs italic text-muted-foreground">
                  {scanFolders.get(id) ?? "scanning…"}
                </span>
              </button>
            ))}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => launchWizard({ kind: "create" })}>
              <FolderPlus size={14} />
              Create library
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </aside>
      {/* Docked now-playing cover — the music bar's up-arrow parks the album
          art here, video-dock style. Art only; the bar keeps title/controls.
          The container animates a KNOWN pixel height (square = sidebar width;
          fr-unit grid transitions stutter with aspect-ratio content) and the
          full-size image is glued to its top edge, so the artwork physically
          rides up out of the playback bar and back down into it. The last URL
          is kept so the art stays visible through the slide-down. */}
      <div
        className="relative shrink-0 overflow-hidden transition-[height] duration-300 ease-out"
        style={{ height: dockedMusic ? width : 0 }}
      >
        {dockContent && (
          dockContent.coverUrl ? (
            // Flush with the sidebar edges on every side, square corners.
            <img
              src={dockContent.coverUrl}
              alt=""
              draggable={false}
              className="absolute left-0 top-0 aspect-square w-full object-cover"
            />
          ) : (
            // Cover-less track: the dock holds its spot with a placeholder.
            <div className="absolute left-0 top-0 flex aspect-square w-full items-center justify-center bg-muted text-muted-foreground">
              <Music2 size={Math.round(width * 0.25)} />
            </div>
          )
        )}
        {/* Top edge line (matches the sidebar/playback-bar borders). The border
            color is translucent, so like the sidebar's right edge it needs an
            opaque bg-sidebar underlay to read consistently over the artwork. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-sidebar" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-border" />
      </div>
      {dockActive && <PlayerDock state={playerState} actions={playerActions} />}
      {/* Right-edge border: bg-sidebar underlay + bg-border overlay so the
          translucent border color blends consistently regardless of what sits
          behind. Rendered after all siblings so it paints on top. */}
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-px bg-sidebar" />
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-px bg-border" />
      <div
        onMouseDown={startResize}
        className="absolute top-0 bottom-0 right-0 z-10 w-2 translate-x-1/2 cursor-col-resize"
      />
      <CreateLibraryDialog
        open={wizard !== null}
        mode={wizard ?? { kind: "create" }}
        minimized={wizardMinimized}
        onMinimizedChange={setWizardMinimized}
        onOpenChange={(o) => {
          if (!o) {
            setWizard(null);
            setWizardMinimized(false);
          }
        }}
        onCreated={onLibraryCreated}
        onFinished={(libId) => onLibraryRescanned(libId)}
      />
      <LibrarySettingsDialog
        library={settingsTarget}
        onOpenChange={(o) => {
          if (!o) setSettingsTarget(null);
        }}
      />
      <ManageFoldersDialog
        library={manageFoldersTarget}
        onOpenChange={(o) => {
          if (!o) setManageFoldersTarget(null);
        }}
        onNeedsRescan={(lib) => {
          // Adds/removals change nothing until a rescan — run it through
          // the wizard like any other rescan. (Pure repoints skip this.)
          launchWizard({ kind: "rescan", libraryId: lib.id, name: lib.name, format: lib.format });
        }}
      />
      <RenameDialog
        open={renameTarget !== null}
        onOpenChange={(o) => { if (!o) setRenameTarget(null); }}
        title="Rename library"
        initialValue={renameTarget?.name ?? ""}
        onSubmit={async (newName) => {
          if (!renameTarget) return;
          try {
            await invoke("rename_library", { libraryId: renameTarget.id, newName });
            onLibraryRenamed(renameTarget.id, renameTarget.name, newName);
          } catch (e) {
            toast.error(String(e));
          }
        }}
      />
      <CreatePlaylistDialog
        libraryId={createPlaylistFor}
        open={createPlaylistFor !== null}
        onOpenChange={(o) => { if (!o) setCreatePlaylistFor(null); }}
        onCreated={() => {
          if (createPlaylistFor) onPlaylistChanged(createPlaylistFor);
        }}
      />
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteConfirmText("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete library?</DialogTitle>
            <DialogDescription>
              This deletes "{deleteTarget?.name}" — its matches, edits, playlists, play history,
              and every decision made in it. It cannot be undone. Type the library's name to
              confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            placeholder={deleteTarget?.name ?? ""}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteTarget(null); setDeleteConfirmText(""); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              // Exact name, case included — deliberate friction for a
              // destructive, unrecoverable action.
              disabled={deleteConfirmText !== (deleteTarget?.name ?? "")}
              onClick={async () => {
                if (!deleteTarget) return;
                try {
                  await invoke("delete_library", { libraryId: deleteTarget.id });
                  setDeleteTarget(null);
                  setDeleteConfirmText("");
                  onLibraryDeleted(deleteTarget.id);
                } catch (err) {
                  toast.error(String(err));
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Manage a library's source folders: add (typed) and remove (two-click,
 *  swept on the next rescan — destructive for that content's history).
 *  Moves/renames = remove + add (user decision — no repoint operation).
 *  Operations commit immediately; closing after changes runs the rescan
 *  wizard via onNeedsRescan. */
function ManageFoldersDialog({
  library,
  onOpenChange,
  onNeedsRescan,
}: {
  library: Library | null;
  onOpenChange: (open: boolean) => void;
  onNeedsRescan: (library: Library) => void;
}) {
  const [folders, setFolders] = useState<{ path: string; kind: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Adds/removals happened — closing should run the rescan wizard.
  const [needsRescan, setNeedsRescan] = useState(false);
  // Two-click remove confirmation: the path currently armed.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const open = library !== null;

  const reload = useCallback(async () => {
    if (!library) return;
    try {
      setFolders(await invoke<{ path: string; kind: string }[]>("get_library_folders", { libraryId: library.id }));
    } catch (e) {
      toast.error(String(e));
    }
  }, [library]);

  useEffect(() => {
    if (open) {
      setFolders(null);
      setNeedsRescan(false);
      setConfirmRemove(null);
      setBusy(false);
      void reload();
    }
  }, [open, reload]);

  const kindLabel = (k: string) =>
    k === "music" ? "Music" : k === "sounds" ? "Sounds" : k === "movie" ? "Movies" : k === "show" ? "TV" : k;

  const addKinds: string[] = library?.format === "music" ? ["music", "sounds"] : ["movie", "show"];

  const addFolder = async (kind: string) => {
    if (!library) return;
    const dir = await openFolderPicker({ directory: true, multiple: false });
    if (typeof dir !== "string" || !dir) return;
    setBusy(true);
    try {
      await invoke("add_library_paths", { libraryId: library.id, paths: [{ path: dir, kind }] });
      setNeedsRescan(true);
      await reload();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeFolder = async (path: string) => {
    if (!library) return;
    setBusy(true);
    try {
      await invoke("remove_library_path", { libraryId: library.id, path });
      setNeedsRescan(true);
      setConfirmRemove(null);
      await reload();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    if (needsRescan && library) onNeedsRescan(library);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage folders{library ? ` — ${library.name}` : ""}</DialogTitle>
          <DialogDescription>
            Removing a folder deletes its media from the library on the next rescan (including watch
            and play history).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 py-1">
          {folders === null ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-5" />
            </div>
          ) : (
            folders.map((f) => (
              <div key={f.path} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {kindLabel(f.kind)}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs" title={f.path}>
                  {f.path}
                </span>
                {confirmRemove === f.path ? (
                  <button
                    onClick={() => void removeFolder(f.path)}
                    disabled={busy}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    title="Click again to remove"
                  >
                    Remove?
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmRemove(f.path)}
                    disabled={busy}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
                    title="Remove folder"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))
          )}
          <div className="mt-1 flex gap-2">
            {addKinds.map((k) => (
              <Button
                key={k}
                variant="ghost"
                size="sm"
                onClick={() => void addFolder(k)}
                disabled={busy}
                className="justify-start gap-1.5 text-muted-foreground"
              >
                <FolderPlus size={14} />
                Add {kindLabel(k).toLowerCase()} folder
              </Button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={close} disabled={busy}>
            {needsRescan ? "Done & rescan" : "Done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
