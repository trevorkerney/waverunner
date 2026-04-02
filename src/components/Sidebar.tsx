import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Plus, Trash2, RefreshCw } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { CreateLibraryDialog } from "@/components/CreateLibraryDialog";
import { Library } from "@/types";

const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 256;

interface SidebarProps {
  libraries: Library[];
  selectedLibrary: Library | null;
  onSelectLibrary: (library: Library) => void;
  onLibraryCreated: () => void;
  onLibraryDeleted: () => void;
  onLibraryRescanned: () => void;
}

export function Sidebar({
  libraries,
  selectedLibrary,
  onSelectLibrary,
  onLibraryCreated,
  onLibraryDeleted,
  onLibraryRescanned,
}: SidebarProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const widthBeforeCollapse = useRef(DEFAULT_WIDTH);
  const didDrag = useRef(false);
  const isResizing = useRef(false);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      if (collapsed) return;
      e.preventDefault();
      isResizing.current = true;
      didDrag.current = false;
      setDragging(true);

      const onMouseMove = (e: MouseEvent) => {
        if (!isResizing.current) return;
        didDrag.current = true;
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
    },
    [collapsed]
  );

  const handleClick = useCallback(() => {
    if (didDrag.current) return;
    if (collapsed) {
      setWidth(widthBeforeCollapse.current);
      setCollapsed(false);
    } else {
      widthBeforeCollapse.current = width;
      setCollapsed(true);
    }
  }, [collapsed, width]);

  return (
    <div className="relative flex h-full flex-shrink-0">
      <aside
        className={`flex h-full flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground ${dragging ? "" : "transition-[width] duration-200"}`}
        style={{ width: collapsed ? 0 : width }}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            Libraries
          </span>
          <button
            onClick={() => setDialogOpen(true)}
            className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto p-1">
          {libraries.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground whitespace-nowrap">
              No libraries yet
            </p>
          ) : (
            libraries.map((lib) => (
              <ContextMenu key={lib.id}>
                <ContextMenuTrigger
                  render={
                    <button
                      onClick={() => onSelectLibrary(lib)}
                    />
                  }
                  className={`flex w-full items-center rounded-sm truncate px-2 py-1.5 text-left text-sm ${
                    selectedLibrary?.id === lib.id
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                  }`}
                >
                  {lib.name}
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
                    onClick={async () => {
                      try {
                        await invoke("delete_library", { libraryId: lib.id });
                        onLibraryDeleted();
                      } catch (err) {
                        toast.error(String(err));
                      }
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} />
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))
          )}
        </nav>
      </aside>
      <div
        onMouseDown={startResize}
        onClick={handleClick}
        className={`z-10 flex w-4 items-center justify-center rounded-r-sm text-muted-foreground hover:bg-accent ${collapsed ? "cursor-pointer" : "cursor-col-resize"}`}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </div>
      <CreateLibraryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={onLibraryCreated}
      />
    </div>
  );
}
