import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useLibraryRuns } from "@/hooks/libraryRuns";
import { LibraryAttentionBadge } from "@/components/music/PendingWork";
import { Trash2, RefreshCw, FolderPlus, FolderCog, ChevronRight, Sparkles, Pencil, Home, CircleAlert, Music2, Settings2, Plus } from "lucide-react";
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
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton, useHandoff } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreateLibraryDialog } from "@/components/CreateLibraryDialog";
import { CreatePlaylistDialog } from "@/components/CreatePlaylistDialog";
import { RenameDialog } from "@/components/RenameDialog";
import { LibrarySettingsDialog } from "@/components/LibrarySettingsDialog";
import { PlayerDock } from "@/components/player/PlayerDock";
import { PlayerState, PlayerActions } from "@/hooks/usePlayer";
import { SidebarTree } from "@/components/SidebarTree";
import { getComplicationsForLibrary } from "@/lib/complications";
import type { ComplicationNode, GenreSummary, LibraryCounts, PlaylistSummary } from "@/types";
import { Library, ViewSpec } from "@/types";
import type { BackgroundJob } from "@/lib/backgroundJobs";

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
  onLibraryDeleted: (deletedId: string) => void;
  /** A library being scanned (possibly mid-creation, so not yet in
   *  `libraries`): open its page — App shows the scan view there. */
  onOpenScanning: (libraryId: string) => void;
  /** Called after a rename so App can reload libraries and fix baked-in labels. */
  onLibraryRenamed: (libraryId: string, oldName: string, newName: string) => void;
  /** Called after a playlist is created via the sidebar so App.tsx can invalidate caches. */
  onPlaylistChanged: (libraryId: string) => void;
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
  /** Running background jobs — one progress line per job under its library
   *  (waveform preload, MusicBrainz prefetches). Clicking a line hands the
   *  job to the host (reopen its window, or go where its results land). */
  backgroundJobs?: BackgroundJob[];
  onOpenJob?: (job: BackgroundJob) => void;
}

export function Sidebar({
  libraries,
  selectedLibrary,
  activeView,
  onSelectLibrary,
  onSelectView,
  defaultLibraryId,
  onSetDefaultLibrary,
  onLibraryDeleted,
  onLibraryRenamed,
  onPlaylistChanged,
  sidebarPlaylists,
  sidebarCounts,
  sidebarGenres,
  playerState,
  playerActions,
  dockedMusic,
  onOpenHome,
  homeActive,
  onOpenScanning,
  backgroundJobs,
  onOpenJob,
}: SidebarProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  // Library runs (scan / prompt / match) — progress lines and locked rows.
  const { runs, rescan } = useLibraryRuns();
  // Libraries mid-CREATION: hidden from get_libraries until their scan
  // lands, so they render from the run (a scanning row below the list).
  const creatingRuns = Object.values(runs).filter(
    (r) => r.kind === "scan" && !libraries.some((l) => l.id === r.libraryId),
  );
  const [createOpen, setCreateOpen] = useState(false);
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

  /** The live status line under a library row, from its run: scan folder /
   *  stage counts while scanning, the pass's item while matching. */
  const runLine = (libraryId: string): string | null => {
    const run = runs[libraryId];
    if (!run) return null;
    if (run.kind === "scan") {
      // Counts only, no path: a path wraps to two or three lines and
      // everything below the row jumps as it changes (the scan view has
      // the detail).
      if (run.phase === "read-tags" && run.total) {
        return `reading tags ${Math.min((run.done ?? 0) + 1, run.total)}/${run.total}`;
      }
      if (run.phase === "build" && run.total) {
        return `building ${Math.min((run.done ?? 0) + 1, run.total)}/${run.total}`;
      }
      return "scanning";
    }
    if (run.kind === "match") {
      const p = run.progress;
      if (!p) return "matching…";
      const n = `${Math.min(p.done + 1, p.total)}/${p.total}`;
      return p.phase === "artist-ids"
        ? `identifying artists ${n}`
        : p.phase === "artist-credits"
          ? `reading album credits ${n}`
          : p.phase === "artist-search"
            ? `searching artists ${n}`
            // No item name: it wrapped to a second line on and off, and
            // everything below the row jumped with it.
            : `matching ${n}`;
    }
    return null;
  };


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
        {/* No "Your library" header — Home is the first row, flush with the
            top (user's call, 2026-09-20). */}
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
          {libraries.length === 0 && creatingRuns.length === 0 ? (
            // The empty sidebar's one job: the same "Create library" the
            // background context menu offers — a quiet inline link, not a
            // row that pretends to be a library. A library mid-creation
            // (scanning, not yet listed) counts as one — the link hides.
            <button
              onClick={() => setCreateOpen(true)}
              className="group/create mt-1 flex items-center gap-1 py-1 pl-3 pr-2 text-left text-xs text-sidebar-foreground"
            >
              <Plus size={10} className="shrink-0" />
              <span className="leading-none group-hover/create:underline">create a library…</span>
            </button>
          ) : (
            libraries.map((lib) => {
              const expanded = !collapsedLibs.has(lib.id);
              const isSelected = selectedLibrary?.id === lib.id;
              const run = runs[lib.id];
              // Scan in flight: the row locks (mid-scan the library's data is
              // inconsistent) and shows live progress. Clicking opens the
              // library's page, where the scan view stands in for it.
              if (run?.kind === "scan") {
                return (
                  // One clickable unit: title row + progress line. Title
                  // renders EXACTLY like a normal row (spinner sized into the
                  // chevron slot) so nothing shifts when a rescan starts.
                  <button
                    key={lib.id}
                    onClick={() => onOpenScanning(lib.id)}
                    className={`flex w-full flex-col text-left transition-colors ${
                      isSelected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50"
                    }`}
                  >
                    <span className="flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-sm font-medium text-sidebar-foreground/90">
                      <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                        <Spinner className="size-2" />
                      </span>
                      <span className="min-w-0 flex-1 break-words">{lib.name}</span>
                    </span>
                    {/* The complication tree's spot while scanning. */}
                    <span className="break-words pb-1 pl-6 pr-2 text-xs italic text-muted-foreground">
                      {runLine(lib.id)}
                    </span>
                  </button>
                );
              }
              // A paused first-time import (its scan was stopped, or the app
              // died mid-scan): amber alert, click resumes the scan. Libraries
              // paused at the MATCH question are ordinary rows — browsable,
              // with the question as a banner on their page.
              if (lib.setup_stage === "scan") {
                return (
                  <div key={lib.id} className="flex flex-col">
                    <ContextMenu>
                      <ContextMenuTrigger
                        render={<button onClick={() => void rescan(lib)} />}
                        className="flex w-full flex-col text-left transition-colors hover:bg-sidebar-accent/50"
                      >
                        <span className="flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-sm font-medium text-sidebar-foreground/90">
                          <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                            <CircleAlert size={12} className="text-amber-400" />
                          </span>
                          <span className="min-w-0 flex-1 break-words">{lib.name}</span>
                        </span>
                        <span className="break-words pb-1 pl-6 pr-2 text-xs italic text-muted-foreground">
                          Setup paused — click to finish scanning
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
                      {/* Badge rides right beside the name, not flushed to
                          the row's far edge — the outer span owns flex-1. */}
                      <span className="flex min-w-0 flex-1 items-start gap-1">
                        <span className="min-w-0 break-words">{lib.name}</span>
                      </span>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => setRenameTarget(lib)}>
                        <Pencil size={14} />
                        Rename
                      </ContextMenuItem>
                      <ContextMenuItem
                        // Rescans show in place of the library's page, then
                        // the match question follows as a banner there.
                        onClick={() => void rescan(lib)}
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
                        onClick={() => onSelectView({ kind: "metadata", libraryId: lib.id })}
                      >
                        <Sparkles size={14} />
                        Metadata
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
                  {/* A matching pass in flight: its live item under the name,
                      like a background job. The row stays browsable; the
                      Metadata page carries the full progress strip. */}
                  {run?.kind === "match" && (
                    <button
                      // Like a background job: the click goes where the
                      // detail is — the Metadata page's running strip.
                      onClick={() => onSelectView({ kind: "metadata", libraryId: lib.id })}
                      className="flex items-start gap-1.5 pb-1 pl-6 pr-2 pt-1 text-left text-xs italic text-muted-foreground hover:text-foreground"
                    >
                      <Spinner className="mt-1 size-2 shrink-0" />
                      <span className="min-w-0 break-words">{runLine(lib.id)}</span>
                    </button>
                  )}
                  {/* Background jobs — background work lives in the sidebar;
                      one line per running job under the library name, above
                      the tree. Several can run at once (a preload beside a
                      prefetch), so they stack. */}
                  {(backgroundJobs ?? [])
                    .filter((job) => job.library_id === lib.id)
                    .map((job) => (
                      <button
                        key={job.id}
                        onClick={() => onOpenJob?.(job)}
                        title={job.detail ?? undefined}
                        className="flex items-start gap-1.5 pb-1 pl-6 pr-2 pt-1 text-left text-xs italic text-muted-foreground hover:text-foreground"
                      >
                        {/* mt-1 centers the 8px spinner on the first 16px text
                            line (items-start, so wrapped lines don't drag it). */}
                        <Spinner className="mt-1 size-2 shrink-0" />
                        {/* Wraps rather than truncating — a narrow sidebar gets
                            two lines, never an ellipsis. */}
                        <span className="min-w-0 break-words">
                          {job.label} · {job.done}/{job.total}
                        </span>
                      </button>
                    ))}
                  {expanded && (
                    <SidebarTree
                      nodes={getComplicationsForLibrary(lib, sidebarPlaylists[lib.id] ?? [], sidebarCounts[lib.id], sidebarGenres[lib.id])}
                      activeView={isSelected ? activeView : null}
                      onSelectView={(view) => {
                        onSelectView(view);
                      }}
                      renderNodeMenu={renderNodeMenu}
                      // The attention badge rides the Metadata row — that's
                      // where its click leads (staged work, a waiting wizard).
                      renderNodeTrailing={(node) =>
                        node.id === "metadata" ? (
                          <LibraryAttentionBadge libraryId={lib.id} format={lib.format} />
                        ) : null
                      }
                      depth={1}
                    />
                  )}
                </div>
              );
            })
          )}
          {/* A library mid-CREATION is hidden from get_libraries until its
              scan lands — its scanning row renders from the run so it has
              a face in the sidebar (and a page: the scan view). */}
          {creatingRuns.map((r) => (
              <button
                key={r.libraryId}
                onClick={() => onOpenScanning(r.libraryId)}
                className={`flex w-full flex-col text-left transition-colors ${
                  activeView?.libraryId === r.libraryId
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "hover:bg-sidebar-accent/50"
                }`}
              >
                <span className="flex w-full items-start gap-1 py-1.5 pr-2 pl-1 text-sm font-medium text-sidebar-foreground/90">
                  <span className="flex h-5 w-4 flex-shrink-0 items-center justify-center">
                    <Spinner className="size-2" />
                  </span>
                  <span className="min-w-0 flex-1 break-words">{r.name}</span>
                </span>
                <span className="break-words pb-1 pl-6 pr-2 text-xs italic text-muted-foreground">
                  {runLine(r.libraryId)}
                </span>
              </button>
            ))}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => setCreateOpen(true)}>
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
      <CreateLibraryDialog open={createOpen} onOpenChange={setCreateOpen} />
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
          // Adds/removals change nothing until a rescan. (Pure repoints
          // skip this.)
          void rescan(lib);
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
        dismiss="self"
      >
        {/* 16 pad + 20 title + 8 + 60 three-line description + 16 + 36
            input + 16 + 68 footer = 240px. */}
        <DialogContent size="sm" height="15rem">
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
  // Skeleton rows after 500ms, then the hand-off.
  const foldersRef = useRef<HTMLDivElement | null>(null);
  const {
    stage: foldersStage,
    skeletonSeen: foldersSkeletonSeen,
    shown: foldersShown,
    contentVisible: foldersVisible,
  } = useHandoff(folders !== null, foldersRef);

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
      {/* Static: four folder rows (40 + 4 between) plus the header, the
          add row and the footer — measured live at 348px; more folders
          scroll, the add row stays put. */}
      <DialogContent size="lg" height="21.75rem">
        <DialogHeader>
          <DialogTitle className="truncate">Manage folders{library ? ` — ${library.name}` : ""}</DialogTitle>
          <DialogDescription>
            Removing a folder deletes its media from the library on the next rescan (including watch
            and play history).
          </DialogDescription>
        </DialogHeader>
        <DialogBody ref={foldersRef} className="relative grid content-start gap-1">
          {!foldersShown && foldersSkeletonSeen && (
            <div
              className={`absolute inset-x-0 top-0 grid gap-1 transition-opacity duration-200 ${
                foldersStage === "hidden" ? "" : "opacity-0"
              }`}
            >
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                  <Skeleton className="h-4 w-12 rounded" />
                  <Skeleton className="h-3 flex-1" />
                  <Skeleton className="size-4 rounded" />
                </div>
              ))}
            </div>
          )}
          <div
            className={`grid gap-1 transition-opacity duration-200 will-change-[opacity] ${
              foldersVisible ? "opacity-100" : "opacity-0"
            }`}
          >
            {(folders ?? []).map((f) => (
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
            ))}
          </div>
        </DialogBody>
        <div className="flex shrink-0 gap-2">
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
        <DialogFooter>
          <Button onClick={close} disabled={busy}>
            {needsRescan ? "Done & rescan" : "Done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
