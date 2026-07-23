import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Trash2, RefreshCw, FolderPlus, FolderCog, ChevronRight, Sparkles, Pencil, Home, CircleCheck } from "lucide-react";
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
import { CreateLibraryDialog, type WizardMode } from "@/components/CreateLibraryDialog";
import { CreatePlaylistDialog } from "@/components/CreatePlaylistDialog";
import { RenameDialog } from "@/components/RenameDialog";
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
  onLibraryRescanned: () => void;
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
  /** Now-playing album cover, docked up here by the bar's up-arrow (null =
   *  not docked / nothing playing). Rendered like the minimized video dock. */
  dockedMusicCoverUrl?: string | null;
  /** The Home pseudo-library pinned above the real ones. */
  onOpenHome: () => void;
  homeActive: boolean;
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
  dockedMusicCoverUrl,
  onOpenHome,
  homeActive,
}: SidebarProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  // The import wizard (create / resume unfinished setup / rescan), or null.
  const [wizard, setWizard] = useState<WizardMode | null>(null);
  const [wizardMinimized, setWizardMinimized] = useState(false);
  // Minimized-wizard chip: live matching progress, flipping to "ready" when
  // the pass lands so the user can reopen at the review step.
  const [chip, setChip] = useState<{ text: string; ready: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Library | null>(null);
  const [renameTarget, setRenameTarget] = useState<Library | null>(null);
  // Library whose source folders are being managed (add/remove/repoint).
  const [manageFoldersTarget, setManageFoldersTarget] = useState<Library | null>(null);
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

  // Feed the minimized-wizard chip from the matching pass's events —
  // Tauri events for music (backend pass), window CustomEvents for video
  // (the TMDB run lives in the frontend).
  useEffect(() => {
    if (!wizardMinimized) {
      setChip(null);
      return;
    }
    const isVideoWizard = wizard != null && wizard.kind !== "create" && wizard.format !== "music";
    setChip({
      text: isVideoWizard ? "Matching against TMDB…" : "Matching against MusicBrainz…",
      ready: false,
    });
    const onVideoProgress = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        current?: number;
        total?: number;
        label?: string;
        etaSecs?: number | null;
        done?: boolean;
      };
      if (d.done) {
        setChip({ text: "Matching finished — review ready", ready: true });
        return;
      }
      let eta = "";
      if (d.etaSecs != null && d.etaSecs >= 60) eta = ` · ~${Math.round(d.etaSecs / 60)} min left`;
      setChip({ text: `Matching ${d.current}/${d.total} — ${d.label}${eta}`, ready: false });
    };
    window.addEventListener("video-match-progress", onVideoProgress);
    const samples: number[] = [];
    const unProgress = listen<{ done: number; total: number; name: string }>(
      "music-enrich-progress",
      (e) => {
        samples.push(performance.now());
        if (samples.length > 30) samples.shift();
        let eta = "";
        if (samples.length >= 3) {
          const avgMs = (samples[samples.length - 1] - samples[0]) / (samples.length - 1);
          const secs = (avgMs * Math.max(0, e.payload.total - e.payload.done - 1)) / 1000;
          if (secs >= 60) eta = ` · ~${Math.round(secs / 60)} min left`;
        }
        setChip({ text: `Matching ${e.payload.done + 1}/${e.payload.total} — ${e.payload.name}${eta}`, ready: false });
      },
    );
    const unDone = listen("music-enrich-done", () => {
      setChip({ text: "Matching finished — review ready", ready: true });
    });
    return () => {
      unProgress.then((fn) => fn());
      unDone.then((fn) => fn());
      window.removeEventListener("video-match-progress", onVideoProgress);
    };
  }, [wizardMinimized, wizard]);

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

  // Last docked cover URL, kept so the image is still there to slide away
  // during the collapse animation after undocking.
  const lastDockedCoverRef = useRef<string | null>(null);
  if (dockedMusicCoverUrl) lastDockedCoverRef.current = dockedMusicCoverUrl;
  const dockImgUrl = dockedMusicCoverUrl ?? lastDockedCoverRef.current;

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
              // Unfinished import: greyed, not browsable — clicking resumes
              // the wizard where it left off.
              if (lib.setup_stage) {
                return (
                  <div key={lib.id} className="flex flex-col">
                    <ContextMenu>
                      <ContextMenuTrigger
                        render={
                          <button
                            onClick={() =>
                              setWizard({
                                kind: "resume",
                                libraryId: lib.id,
                                name: lib.name,
                                format: lib.format,
                                stage: (["scan", "match", "review"].includes(lib.setup_stage!)
                                  ? lib.setup_stage
                                  : "scan") as "scan" | "match" | "review",
                              })
                            }
                          />
                        }
                        className="flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-left text-sm font-medium text-muted-foreground/70 transition-colors hover:bg-sidebar-accent/50"
                      >
                        <span className="flex h-5 w-4 flex-shrink-0" />
                        <span className="min-w-0 flex-1 break-words">
                          {lib.name}
                          <span className="block text-xs font-normal italic">Finish setup…</span>
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
                          // Navigate only — expand/collapse is the chevron's job.
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
                      <span className="min-w-0 flex-1 break-words">{lib.name}</span>
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
                          setWizard({ kind: "rescan", libraryId: lib.id, name: lib.name, format: lib.format })
                        }
                      >
                        <RefreshCw size={14} />
                        Rescan
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => setManageFoldersTarget(lib)}>
                        <FolderCog size={14} />
                        Manage folders…
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
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => setWizard({ kind: "create" })}>
              <FolderPlus size={14} />
              Create library
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </aside>
      {/* Minimized rescan-matching chip: progress → "review ready"; click
          restores the wizard modal. */}
      {wizard && wizardMinimized && (
        <button
          onClick={() => setWizardMinimized(false)}
          className="mx-2 mb-2 flex items-center gap-2 rounded-md border border-border bg-sidebar-accent/40 px-2.5 py-2 text-left text-xs text-sidebar-foreground/90 transition-colors hover:bg-sidebar-accent"
        >
          {chip?.ready ? (
            <CircleCheck size={14} className="shrink-0 text-primary" />
          ) : (
            <Spinner className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{chip?.text ?? "Matching against MusicBrainz…"}</span>
        </button>
      )}
      {/* Docked now-playing cover — the music bar's up-arrow parks the album
          art here, video-dock style. Art only; the bar keeps title/controls.
          The container animates a KNOWN pixel height (square = sidebar width;
          fr-unit grid transitions stutter with aspect-ratio content) and the
          full-size image is glued to its top edge, so the artwork physically
          rides up out of the playback bar and back down into it. The last URL
          is kept so the art stays visible through the slide-down. */}
      <div
        className="relative shrink-0 overflow-hidden transition-[height] duration-300 ease-out"
        style={{ height: dockedMusicCoverUrl ? width : 0 }}
      >
        {dockImgUrl && (
          // Flush with the sidebar edges on every side, square corners.
          <img
            src={dockImgUrl}
            alt=""
            draggable={false}
            className="absolute left-0 top-0 aspect-square w-full object-cover"
          />
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
        onFinished={() => onLibraryRescanned()}
      />
      <ManageFoldersDialog
        library={manageFoldersTarget}
        onOpenChange={(o) => {
          if (!o) setManageFoldersTarget(null);
        }}
        onNeedsRescan={(lib) => {
          // Adds/removals change nothing until a rescan — run it through
          // the wizard like any other rescan. (Pure repoints skip this.)
          setWizard({ kind: "rescan", libraryId: lib.id, name: lib.name, format: lib.format });
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
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete library?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!deleteTarget) return;
                try {
                  await invoke("delete_library", { libraryId: deleteTarget.id });
                  setDeleteTarget(null);
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
