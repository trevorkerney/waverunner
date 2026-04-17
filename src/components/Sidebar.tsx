import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Trash2, RefreshCw, FolderPlus, ChevronRight } from "lucide-react";
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
import { CreateLibraryDialog } from "@/components/CreateLibraryDialog";
import { PlayerDock } from "@/components/player/PlayerDock";
import { PlayerState, PlayerActions } from "@/hooks/usePlayer";
import { SidebarTree } from "@/components/SidebarTree";
import { getComplicationsForLibrary } from "@/lib/complications";
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
  onLibraryCreated: () => void;
  onLibraryDeleted: () => void;
  onLibraryRescanned: () => void;
  playerState: PlayerState;
  playerActions: PlayerActions;
}

export function Sidebar({
  libraries,
  selectedLibrary,
  activeView,
  onSelectLibrary,
  onSelectView,
  onLibraryCreated,
  onLibraryDeleted,
  onLibraryRescanned,
  playerState,
  playerActions,
}: SidebarProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Library | null>(null);
  // Track libraries the user has explicitly collapsed; default is expanded.
  const [collapsedLibs, setCollapsedLibs] = useState<Set<string>>(new Set());
  const isResizing = useRef(false);

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
            render={<nav className="flex-1 overflow-y-auto p-1" />}
          >
          {libraries.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground whitespace-nowrap">
              No libraries yet
            </p>
          ) : (
            libraries.map((lib) => {
              const expanded = !collapsedLibs.has(lib.id);
              const isSelected = selectedLibrary?.id === lib.id;
              return (
                <div key={lib.id} className="flex flex-col">
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={
                        <button
                          onClick={() => {
                            onSelectLibrary(lib);
                            setCollapsedLibs((prev) => {
                              if (!prev.has(lib.id)) return prev;
                              const next = new Set(prev);
                              next.delete(lib.id);
                              return next;
                            });
                          }}
                        />
                      }
                      className={`flex w-full items-center gap-1 rounded-sm truncate py-1.5 pr-2 pl-1 text-left text-sm ${
                        isSelected
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                      }`}
                    >
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLibExpand(lib.id);
                        }}
                        className="flex h-4 w-4 flex-shrink-0 items-center justify-center"
                      >
                        <ChevronRight
                          size={12}
                          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
                        />
                      </span>
                      <span className="truncate">{lib.name}</span>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onClick={async () => {
                          const toastId = toast.loading("Rescanning...");
                          const unlisten = await listen<string>("scan-progress", (event) => {
                            toast.loading(event.payload, { id: toastId });
                          });
                          try {
                            await invoke("rescan_library", { libraryId: lib.id });
                            toast.success("Rescan complete", { id: toastId });
                            onLibraryRescanned();
                          } catch (err) {
                            toast.error(String(err), { id: toastId });
                          } finally {
                            unlisten();
                          }
                        }}
                      >
                        <RefreshCw size={14} />
                        Rescan
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
                      nodes={getComplicationsForLibrary(lib)}
                      activeView={isSelected ? activeView : null}
                      onSelectView={(view) => {
                        onSelectView(view);
                      }}
                      depth={1}
                    />
                  )}
                </div>
              );
            })
          )}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => setDialogOpen(true)}>
              <FolderPlus size={14} />
              Create library
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </aside>
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
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={onLibraryCreated}
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
                  onLibraryDeleted();
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
