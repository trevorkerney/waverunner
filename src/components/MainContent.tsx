import { useState, useCallback, useRef, useEffect, type RefObject } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  useDroppable,
  pointerWithin,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem as BreadcrumbUIItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Search,
  Folder,
  ArrowUpDown,
  ArrowUp,
  Pencil,
  Play,
  Image as ImageIcon,
  LibraryBig,
  FolderPlus,
  Film,
  Tv,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Library, MediaEntry, BreadcrumbItem, MovieDetail, MovieDetailUpdate, SeasonInfo, EpisodeInfo, ShowDetail, SeasonDetailLocal, EpisodeDetailLocal, TmdbSeasonDetail, TmdbEpisodeDetail, TmdbSeasonFieldSelection, TmdbEpisodeFieldSelection } from "@/types";
import { TmdbMatchDialog } from "@/components/TmdbMatchDialog";
import { TmdbShowMatchDialog } from "@/components/TmdbShowMatchDialog";
import { TmdbImageBrowserDialog } from "@/components/TmdbImageBrowserDialog";

function getDisplayCover(entry: MediaEntry): string | null {
  if (entry.selected_cover && entry.covers.includes(entry.selected_cover)) {
    return entry.selected_cover;
  }
  return entry.covers[0] || null;
}

interface MainContentProps {
  entries: MediaEntry[];
  searchResults: MediaEntry[] | null;
  selectedEntry: MediaEntry | null;
  loading: boolean;
  breadcrumbs: BreadcrumbItem[];
  coverSize: number;
  onCoverSizeChange: (size: number) => void;
  search: string;
  onSearchChange: (search: string) => void;
  onNavigate: (entry: MediaEntry) => void;
  onBreadcrumbClick: (index: number) => void;
  selectedLibrary: Library | null;
  hasLibraries: boolean;
  sortMode: string;
  onSortModeChange: (mode: string) => void;
  onSortOrderChange: (reordered: MediaEntry[]) => void;
  onRenameEntry: (entryId: number, newTitle: string) => Promise<string | null>;
  onSetCover: (entryId: number, coverPath: string | null) => void;
  onMoveEntry: (entryId: number, newParentId: number | null, insertBeforeId: number | null) => Promise<void>;
  onCreateCollection: (name: string, basePath?: string) => Promise<void>;
  onDeleteEntry: (entryId: number, deleteFromDisk: boolean) => Promise<void>;
  onRescan: () => void;
  onEntryChanged: () => void;
  getCoverUrl: (filePath: string) => string;
  getFullCoverUrl: (filePath: string) => string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}

export function MainContent({
  entries,
  searchResults,
  selectedEntry,
  loading,
  breadcrumbs,
  coverSize,
  onCoverSizeChange,
  search,
  onSearchChange,
  onNavigate,
  onBreadcrumbClick,
  selectedLibrary,
  hasLibraries,
  sortMode,
  onSortModeChange,
  onSortOrderChange,
  onRenameEntry,
  onSetCover,
  onMoveEntry,
  onCreateCollection,
  onDeleteEntry,
  onRescan,
  onEntryChanged,
  getCoverUrl,
  getFullCoverUrl,
  scrollContainerRef,
}: MainContentProps) {
  const [coverDialogEntry, setCoverDialogEntry] = useState<MediaEntry | null>(
    null
  );
  const isSearching = searchResults != null;
  const filteredEntries = isSearching ? searchResults : entries;

  const [dragId, setDragId] = useState<number | null>(null);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newCollectionPath, setNewCollectionPath] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MediaEntry | null>(null);
  const [deleteFromDisk, setDeleteFromDisk] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteFilesWarning, setDeleteFilesWarning] = useState<MediaEntry | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const handleDelete = useCallback(async (entryId: number, deleteFromDisk: boolean) => {
    setDeletingId(entryId);
    try {
      await onDeleteEntry(entryId, deleteFromDisk);
    } finally {
      setDeletingId(null);
    }
  }, [onDeleteEntry]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 500, tolerance: 5 } })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragId(event.active.id as number);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const entryId = active.id as number;
      const overId = String(over.id);

      if (overId === "move-up-zone") {
        const currentParentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        const grandparentId = breadcrumbs.length >= 3 ? breadcrumbs[breadcrumbs.length - 2].id : null;
        await onMoveEntry(entryId, grandparentId, currentParentId);
      } else if (overId.startsWith("collection-")) {
        const targetId = Number(overId.replace("collection-", ""));
        if (targetId !== entryId) {
          await onMoveEntry(entryId, targetId, null);
        }
      } else {
        // Sortable reorder (over.id is the numeric entry id from useSortable)
        if (sortMode !== "custom") return;
        const targetId = over.id as number;
        const oldIndex = filteredEntries.findIndex((e) => e.id === entryId);
        const newIndex = filteredEntries.findIndex((e) => e.id === targetId);
        if (oldIndex === -1 || newIndex === -1) return;
        const reordered = [...filteredEntries];
        const [moved] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, moved);
        onSortOrderChange(reordered);
      }
    },
    [breadcrumbs, onMoveEntry, sortMode, filteredEntries, onSortOrderChange]
  );

  const dragEntry = dragId != null
    ? filteredEntries.find((e) => e.id === dragId) ?? null
    : null;

  // Prefer collection/move-up droppables (pointerWithin), fall back to closestCenter for sort
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointerCollisions = pointerWithin(args);
    // Filter for our special droppables (collection-* and move-up-zone)
    const specialCollisions = pointerCollisions.filter((c) => {
      const id = String(c.id);
      return id === "move-up-zone" || id.startsWith("collection-");
    });
    if (specialCollisions.length > 0) return specialCollisions;
    return closestCenter(args);
  }, []);

  const isInsideCollection = breadcrumbs.length > 1;

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {selectedLibrary && (
        <>
          {/* Breadcrumbs */}
          <Breadcrumb className="border-b border-border">
            <BreadcrumbList className="!flex-nowrap overflow-x-auto px-4 py-2 pr-8">
              {breadcrumbs.map((crumb, i) => (
                <BreadcrumbUIItem key={i} className="whitespace-nowrap">
                  {i > 0 && <BreadcrumbSeparator />}
                  {i === breadcrumbs.length - 1 ? (
                    <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      render={<button onClick={() => onBreadcrumbClick(i)} />}
                    >
                      {crumb.title}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbUIItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>

          {/* Search + Sort + Size Slider */}
          {!selectedEntry && <div className="flex items-center gap-3 border-b border-border px-4 py-2">
            <div className="relative flex-1">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search..."
                className="h-8 pl-8 text-sm"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                <ArrowUpDown size={12} />
                {sortMode === "alpha"
                  ? "A\u2013Z"
                  : sortMode === "year"
                    ? "Year"
                    : "Custom"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onSortModeChange("alpha")}>
                  Alphabetical
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSortModeChange("year")}>
                  Year
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSortModeChange("custom")}>
                  Custom
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex w-32 items-center gap-2">
              <Slider
                value={[coverSize]}
                onValueChange={(v) =>
                  onCoverSizeChange(Array.isArray(v) ? v[0] : v)
                }
                min={100}
                max={400}
                step={10}
                className="w-full"
              />
            </div>
          </div>}
        </>
      )}

      {/* Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4">
      {selectedEntry ? (
        selectedEntry.entry_type === "show"
          ? <ShowDetailPage entry={selectedEntry} selectedLibrary={selectedLibrary!} getFullCoverUrl={getFullCoverUrl} onEntryChanged={onEntryChanged} />
          : <EntryDetailPage entry={selectedEntry} selectedLibrary={selectedLibrary!} getFullCoverUrl={getFullCoverUrl} onEntryChanged={onEntryChanged} />
      ) : (
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-h-full flex-col" />}>
        {!selectedLibrary ? (
          <Empty className="border-none min-h-full">
            <EmptyHeader>
              <EmptyMedia>
                <LibraryBig size={48} className="text-muted-foreground" />
              </EmptyMedia>
              {hasLibraries ? (
                <>
                  <EmptyTitle>No library selected</EmptyTitle>
                  <EmptyDescription>Select a library from the sidebar to get started.</EmptyDescription>
                </>
              ) : (
                <>
                  <EmptyTitle>No libraries yet</EmptyTitle>
                  <EmptyDescription>Create a library from the sidebar to start organizing your media.</EmptyDescription>
                </>
              )}
            </EmptyHeader>
          </Empty>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : filteredEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {search ? "No results" : "Empty"}
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDragId(null)}
          >
            {isInsideCollection && <MoveUpDropZone isActive={dragId != null} />}
            <SortableContext
              items={filteredEntries.map((e) => e.id)}
              strategy={rectSortingStrategy}
            >
              <div
                className="grid gap-4"
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))`,
                  alignItems: "center",
                  justifyItems: "center",
                }}
              >
                {filteredEntries.map((entry) => (
                  <SortableCoverCard
                    key={entry.id}
                    entry={entry}
                    size={coverSize}
                    onNavigate={onNavigate}
                    onRename={onRenameEntry}
                    onChangeCover={() => setCoverDialogEntry(entry)}
                    onDelete={async (entry) => {
                      if (entry.entry_type === "collection" && entry.child_count === 0) {
                        if (selectedLibrary?.managed) {
                          const hasFiles = await invoke<boolean>("check_entry_has_files", {
                            libraryId: selectedLibrary.id,
                            entryId: entry.id,
                          });
                          if (hasFiles) {
                            setDeleteFilesWarning(entry);
                            return;
                          }
                          handleDelete(entry.id, true);
                        } else {
                          handleDelete(entry.id, false);
                        }
                      } else {
                        setDeleteTarget(entry);
                      }
                    }}
                    deletingId={deletingId}
                    getCoverUrl={getCoverUrl}
                    isDragActive={dragId != null}
                    sortMode={sortMode}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay>
              {dragEntry && (
                <DragOverlayCard entry={dragEntry} size={coverSize} getCoverUrl={getCoverUrl} />
              )}
            </DragOverlay>
          </DndContext>
        )}
        </ContextMenuTrigger>
          <ContextMenuContent>
            {selectedLibrary?.format === "video" && (
              <ContextMenuItem onClick={() => { setNewCollectionName(""); setNewCollectionPath(selectedLibrary?.paths[0] ?? ""); setNewCollectionOpen(true); }}>
                <FolderPlus size={14} />
                New Collection
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={async () => {
              if (!selectedLibrary) return;
              const toastId = toast.loading("Rescanning...");
              const unlisten = await listen<string>("scan-progress", (event) => {
                toast.loading(event.payload, { id: toastId });
              });
              try {
                await invoke("rescan_library", { libraryId: selectedLibrary.id });
                toast.success("Rescan complete", { id: toastId });
                onRescan();
              } catch (err) {
                toast.error(String(err), { id: toastId });
              } finally {
                unlisten();
              }
            }}>
              <RefreshCw size={14} />
              Rescan
            </ContextMenuItem>
          </ContextMenuContent>
      </ContextMenu>
      )}
      </div>

      {/* New Collection Dialog */}
      <Dialog open={newCollectionOpen} onOpenChange={setNewCollectionOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New Collection</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Input
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              placeholder="Collection name"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newCollectionName.trim()) {
                  onCreateCollection(newCollectionName.trim(), newCollectionPath || undefined);
                  setNewCollectionOpen(false);
                }
              }}
              autoFocus
            />
            {selectedLibrary?.managed && (selectedLibrary.paths.length > 1) && breadcrumbs.length <= 1 && (
              <Select value={newCollectionPath} onValueChange={(v) => setNewCollectionPath(v ?? "")}>
                <SelectTrigger className="text-xs">
                  {newCollectionPath || "Select location"}
                </SelectTrigger>
                <SelectContent>
                  {selectedLibrary.paths.map((p) => (
                    <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewCollectionOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newCollectionName.trim()}
              onClick={() => {
                onCreateCollection(newCollectionName.trim(), newCollectionPath || undefined);
                setNewCollectionOpen(false);
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteTarget != null} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteFromDisk(false); setDeleteConfirmText(""); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.entry_type === "movie" ? "Movie" : deleteTarget?.entry_type === "show" ? "Show" : "Entry"}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete &ldquo;{deleteTarget?.title}&rdquo;?
          </p>
          {selectedLibrary?.managed && (
            <div className="flex flex-col">
              <div className="flex items-center justify-between">
                <label className="text-sm">Delete from disk</label>
                <Switch
                  checked={deleteFromDisk}
                  onCheckedChange={(checked) => { setDeleteFromDisk(checked); setDeleteConfirmText(""); }}
                />
              </div>
              <div className="grid transition-[grid-template-rows] duration-200 ease-out" style={{ gridTemplateRows: deleteFromDisk ? "0fr" : "1fr" }}>
                <div className="overflow-hidden">
                  <p className="pt-2 text-xs text-muted-foreground">
                    The folder will remain on disk. A rescan will bring it back.
                  </p>
                </div>
              </div>
              <div className="grid transition-[grid-template-rows] duration-200 ease-out" style={{ gridTemplateRows: deleteFromDisk ? "1fr" : "0fr" }}>
                <div className="overflow-hidden">
                  <div className="flex flex-col gap-2 px-1 pb-1 pt-2">
                    <p className="text-xs text-muted-foreground">Type &ldquo;<ContextMenu><ContextMenuTrigger render={<span />} className="!inline !select-text cursor-text font-semibold text-foreground">{deleteTarget?.title}</ContextMenuTrigger><ContextMenuContent><ContextMenuItem onClick={() => { if (deleteTarget) navigator.clipboard.writeText(deleteTarget.title); }}>Copy title</ContextMenuItem></ContextMenuContent></ContextMenu>&rdquo; to confirm.</p>
                    <ContextMenu>
                      <ContextMenuTrigger className="w-full">
                        <Input
                          value={deleteConfirmText}
                          onChange={(e) => setDeleteConfirmText(e.target.value)}
                          placeholder={deleteTarget?.title ?? ""}
                        />
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onClick={async () => { const text = await navigator.clipboard.readText(); setDeleteConfirmText(text); }}>
                          Paste
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteTarget(null); setDeleteFromDisk(false); setDeleteConfirmText(""); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={selectedLibrary?.managed && deleteFromDisk && deleteConfirmText !== deleteTarget?.title}
              onClick={() => {
                if (deleteTarget) handleDelete(deleteTarget.id, deleteFromDisk);
                setDeleteTarget(null);
                setDeleteFromDisk(false);
                setDeleteConfirmText("");
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Empty Collection With Files Warning */}
      <Dialog open={deleteFilesWarning != null} onOpenChange={(open) => { if (!open) setDeleteFilesWarning(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Collection</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            &ldquo;{deleteFilesWarning?.title}&rdquo; contains files on disk. Are you sure you want to delete it?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteFilesWarning(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteFilesWarning) handleDelete(deleteFilesWarning.id, true);
                setDeleteFilesWarning(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cover Carousel Dialog */}
      {coverDialogEntry && (
        <CoverCarouselDialog
          entry={coverDialogEntry}
          open={!!coverDialogEntry}
          onOpenChange={(open) => {
            if (!open) setCoverDialogEntry(null);
          }}
          onSelect={(coverPath) => {
            onSetCover(coverDialogEntry.id, coverPath);
            setCoverDialogEntry(null);
          }}
          getCoverUrl={getFullCoverUrl}
        />
      )}
    </main>
  );
}

function SortableCoverCard({
  entry,
  size,
  onNavigate,
  onRename,
  onChangeCover,
  onDelete,
  getCoverUrl,
  isDragActive,
  sortMode,
  deletingId,
}: {
  entry: MediaEntry;
  size: number;
  onNavigate: (entry: MediaEntry) => void;
  onRename: (entryId: number, newTitle: string) => Promise<string | null>;
  onChangeCover: () => void;
  onDelete: (entry: MediaEntry) => Promise<void>;
  getCoverUrl: (filePath: string) => string;
  isDragActive: boolean;
  sortMode: string;
  deletingId: number | null;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setSortRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id });

  const isCollection = entry.entry_type === "collection";
  // Collections get an extra droppable so we can detect "move into" vs "reorder"
  const { setNodeRef: setCollectionDropRef, isOver } = useDroppable({
    id: `collection-${entry.id}`,
    disabled: !isCollection || isDragging,
  });

  const setRef = useCallback(
    (node: HTMLElement | null) => {
      setSortRef(node);
      if (isCollection) setCollectionDropRef(node);
    },
    [setSortRef, setCollectionDropRef, isCollection]
  );

  // Only show sort shift animation in custom sort mode
  const style = {
    transform: sortMode === "custom" ? CSS.Transform.toString(transform) : undefined,
    transition: sortMode === "custom" ? transition : undefined,
  };

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const isDeleting = deletingId === entry.id;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (isRenaming) {
      submittedRef.current = false;
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const startRename = () => {
    setRenameValue(entry.title);
    setIsRenaming(true);
  };

  const submitRename = async () => {
    if (submittedRef.current) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === entry.title) {
      setIsRenaming(false);
      return;
    }
    submittedRef.current = true;
    setRenameLoading(true);
    const error = await onRename(entry.id, trimmed);
    setRenameLoading(false);
    setIsRenaming(false);
    if (error) {
      toast.error(error);
    }
  };

  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getCoverUrl(coverPath) : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={setRef}
            {...attributes}
            {...listeners}
            onClick={() => !isRenaming && !isDragging && onNavigate(entry)}
          />
        }
        className={`group flex flex-col items-center gap-2 rounded-md p-2 text-left hover:bg-accent ${
          isDragging ? "opacity-0" : ""
        } ${isOver && isDragActive ? "ring-2 ring-primary ring-offset-2" : ""}`}
        style={{ ...style, maxWidth: size }}
      >
        <div className="relative overflow-hidden rounded-sm bg-muted">
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={entry.title}
              className="pointer-events-none w-full"
              style={{ maxHeight: size * 2 }}
              draggable={false}
            />
          ) : (
            <div
              className="flex items-center justify-center"
              style={{ height: size * 1.5, width: size - 16 }}
            >
              {entry.entry_type === "movie" ? (
                <Film size={size * 0.3} className="text-muted-foreground" />
              ) : entry.entry_type === "show" ? (
                <Tv size={size * 0.3} className="text-muted-foreground" />
              ) : (
                <Folder size={size * 0.3} className="text-muted-foreground" />
              )}
            </div>
          )}
          {isCollection && (
            <div className="absolute bottom-1 right-1 rounded-sm bg-black/60 px-1.5 py-0.5 text-xs text-white">
              Collection
            </div>
          )}
        </div>
        <div className="w-full">
          {isDeleting ? (
            <div className="flex items-center gap-1.5 px-1">
              <Spinner className="size-3" />
              <span className="truncate text-sm text-muted-foreground">{entry.title}</span>
            </div>
          ) : renameLoading ? (
            <div className="flex items-center gap-1.5 px-1">
              <Spinner className="size-3" />
              <span className="truncate text-sm text-muted-foreground">{renameValue}</span>
            </div>
          ) : isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") {
                  submittedRef.current = true;
                  setIsRenaming(false);
                }
              }}
              onBlur={submitRename}
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded bg-transparent px-1 text-sm font-medium outline-none ring-1 ring-primary"
              style={{ userSelect: "text" }}
            />
          ) : (
            <>
              <p className="text-sm font-medium">{entry.title}</p>
              {(entry.season_display || entry.collection_display || entry.year) && (
                <p className="text-xs text-muted-foreground">{[entry.season_display || entry.collection_display, entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`].filter(Boolean).join(", ")}</p>
              )}
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={startRename}>
          <Pencil size={14} />
          Rename
        </ContextMenuItem>
        {entry.covers.length > 1 && (
          <ContextMenuItem onClick={onChangeCover}>
            <ImageIcon size={14} />
            Change Cover
          </ContextMenuItem>
        )}
        {!(entry.entry_type === "collection" && entry.child_count > 0) && (
          <ContextMenuItem onClick={() => onDelete(entry)} className="text-destructive focus:text-destructive">
            <Trash2 size={14} />
            Delete
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MoveUpDropZone({ isActive }: { isActive: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "move-up-zone",
  });

  if (!isActive) return null;

  return (
    <div
      ref={setNodeRef}
      className={`mb-4 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm transition-colors ${
        isOver
          ? "border-primary bg-primary/10 text-primary"
          : "border-muted-foreground/30 text-muted-foreground"
      }`}
    >
      <ArrowUp size={16} />
      Move up a level
    </div>
  );
}

function DragOverlayCard({
  entry,
  size,
  getCoverUrl,
}: {
  entry: MediaEntry;
  size: number;
  getCoverUrl: (filePath: string) => string;
}) {
  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getCoverUrl(coverPath) : null;

  return (
    <div className="flex cursor-grabbing flex-col items-center gap-2 rounded-md bg-accent p-2 text-left shadow-lg">
      <div className="relative overflow-hidden rounded-sm bg-muted">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={entry.title}
            className="pointer-events-none w-full"
            style={{ maxHeight: size * 2, width: size }}
            draggable={false}
          />
        ) : (
          <div
            className="flex items-center justify-center"
            style={{ height: size * 1.5, width: size }}
          >
            {entry.entry_type === "movie" ? (
              <Film size={size * 0.3} className="text-muted-foreground" />
            ) : entry.entry_type === "show" ? (
              <Tv size={size * 0.3} className="text-muted-foreground" />
            ) : (
              <Folder size={size * 0.3} className="text-muted-foreground" />
            )}
          </div>
        )}
      </div>
      <div className="w-full" style={{ maxWidth: size }}>
        <p className="text-sm font-medium">{entry.title}</p>
        {(entry.season_display || entry.collection_display || entry.year) && (
          <p className="text-xs text-muted-foreground">{[entry.season_display || entry.collection_display, entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`].filter(Boolean).join(", ")}</p>
        )}
      </div>
    </div>
  );
}

function CoverCarouselDialog({
  entry,
  open,
  onOpenChange,
  onSelect,
  getCoverUrl,
}: {
  entry: MediaEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (coverPath: string) => void;
  getCoverUrl: (filePath: string) => string;
}) {
  const currentCover = getDisplayCover(entry);
  const startIndex = currentCover
    ? Math.max(0, entry.covers.indexOf(currentCover))
    : 0;
  const [selectedIndex, setSelectedIndex] = useState(startIndex);
  const [api, setApi] = useState<CarouselApi>();

  useEffect(() => {
    if (!api) return;
    const onSelectSlide = () => setSelectedIndex(api.selectedScrollSnap());
    api.on("select", onSelectSlide);
    return () => {
      api.off("select", onSelectSlide);
    };
  }, [api]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose Cover</DialogTitle>
        </DialogHeader>
        <div className="px-12">
          <Carousel setApi={setApi} opts={{ startIndex }}>
            <CarouselContent>
              {entry.covers.map((cover, i) => (
                <CarouselItem key={i}>
                  <div className="flex items-center justify-center">
                    <img
                      src={getCoverUrl(cover)}
                      alt={`Cover ${i + 1}`}
                      className="max-h-[400px] rounded-md object-contain"
                    />
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
          </Carousel>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {selectedIndex + 1} / {entry.covers.length}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => onSelect(entry.covers[selectedIndex])}
          >
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EntryDetailPage({
  entry,
  selectedLibrary,
  getFullCoverUrl,
  onEntryChanged,
}: {
  entry: MediaEntry;
  selectedLibrary: Library;
  getFullCoverUrl: (filePath: string) => string;
  onEntryChanged: () => void;
}) {
  const [detail, setDetail] = useState<MovieDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MovieDetailUpdate>({});
  const [saving, setSaving] = useState(false);
  const [tmdbDialogOpen, setTmdbDialogOpen] = useState(false);
  const [tmdbImagesOpen, setTmdbImagesOpen] = useState(false);

  const loadDetail = useCallback(async () => {
    try {
      const d = await invoke<MovieDetail>("get_movie_detail", {
        libraryId: selectedLibrary.id,
        entryId: entry.id,
      });
      setDetail(d);
    } catch (e) {
      console.error("Failed to load movie detail:", e);
    }
  }, [selectedLibrary.id, entry.id]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const startEditing = () => {
    setDraft({
      title: entry.title,
      release_date: detail?.release_date ?? entry.year ?? "",
      tmdb_id: detail?.tmdb_id ?? null,
      imdb_id: detail?.imdb_id ?? null,
      rotten_tomatoes_id: detail?.rotten_tomatoes_id ?? null,
      plot: detail?.plot ?? null,
      tagline: detail?.tagline ?? null,
      runtime: detail?.runtime ?? null,
      maturity_rating: detail?.maturity_rating ?? null,
      genres: detail?.genres ?? [],
      directors: detail?.directors.map((d: { name: string }) => d.name) ?? [],
      cast: detail?.cast.map((c: { name: string; role: string | null }) => ({ name: c.name, role: c.role, tmdb_id: null })) ?? [],
      crew: detail?.crew.map((c: { name: string; job: string | null }) => ({ name: c.name, job: c.job, tmdb_id: null })) ?? [],
      producers: detail?.producers.map((p: { name: string }) => p.name) ?? [],
      studios: detail?.studios ?? [],
      keywords: detail?.keywords ?? [],
    });
    setEditing(true);
  };

  const saveDetail = async () => {
    setSaving(true);
    try {
      await invoke("update_movie_detail", {
        libraryId: selectedLibrary.id,
        entryId: entry.id,
        detail: draft,
      });
      await loadDetail();
      onEntryChanged();
      setEditing(false);
    } catch (e) {
      console.error("Failed to save movie detail:", e);
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getFullCoverUrl(coverPath) : null;

  const updateDraft = (field: keyof MovieDetailUpdate, value: unknown) => {
    setDraft((prev: MovieDetailUpdate) => ({ ...prev, [field]: value }));
  };

  const updateListField = (field: keyof MovieDetailUpdate, value: string) => {
    updateDraft(field, value.split(",").map((s) => s.trim()).filter(Boolean));
  };

  return (
    <div className="flex gap-8 p-4">
      {coverSrc && (
        <img
          src={coverSrc}
          alt={entry.title}
          className="h-auto max-h-[500px] w-auto shrink-0 rounded-lg object-contain shadow-lg"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            {editing ? (
              <div className="flex flex-col gap-2">
                <input
                  value={draft.title ?? ""}
                  onChange={(e) => updateDraft("title", e.target.value)}
                  className="rounded border border-input bg-transparent px-2 py-1 text-2xl font-bold outline-none"
                />
                <input
                  value={draft.release_date ?? ""}
                  onChange={(e) => updateDraft("release_date", e.target.value)}
                  placeholder="Release Date"
                  className="w-36 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
                />
              </div>
            ) : (
              <>
                <h1 className="text-3xl font-bold">{entry.title}</h1>
                {(entry.season_display || entry.collection_display || entry.year) && (
                  <p className="text-lg text-muted-foreground">
                    {[entry.season_display || entry.collection_display, entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`].filter(Boolean).join(", ")}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await invoke("play_movie", { libraryId: selectedLibrary.id, entryId: entry.id });
                } catch (e) {
                  toast.error(String(e));
                }
              }}
            >
              <Play size={14} />
              Play
            </Button>
            {editing ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveDetail} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => setTmdbDialogOpen(true)}>
                  <Film size={14} />
                  {detail?.tmdb_id ? "Re-match TMDB" : "Match TMDB"}
                </Button>
                {detail?.tmdb_id && (
                  <Button size="sm" variant="outline" onClick={() => setTmdbImagesOpen(true)}>
                    <ImageIcon size={14} />
                    TMDB Images
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={startEditing}>
                  <Pencil size={14} />
                  Edit
                </Button>
              </>
            )}
          </div>
        </div>

        {detail && !editing && (
          <div className="flex flex-col gap-3 text-sm">
            {detail.tagline && <p className="italic text-muted-foreground">{detail.tagline}</p>}
            {detail.plot && <p>{detail.plot}</p>}
            {detail.runtime != null && <p><span className="font-medium">Runtime:</span> {detail.runtime} min</p>}
            {detail.maturity_rating && <p><span className="font-medium">Rating:</span> {detail.maturity_rating}</p>}
            {detail.genres.length > 0 && <p><span className="font-medium">Genres:</span> {detail.genres.join(", ")}</p>}
            {detail.directors.length > 0 && <p><span className="font-medium">Director:</span> {detail.directors.map((d: { name: string }) => d.name).join(", ")}</p>}
            {detail.cast.length > 0 && (
              <p><span className="font-medium">Cast:</span> {detail.cast.map((c: { name: string; role: string | null }) => c.role ? `${c.name} (${c.role})` : c.name).join(", ")}</p>
            )}
            {detail.crew.length > 0 && (
              <p><span className="font-medium">Crew:</span> {detail.crew.map((c: { name: string; job: string | null }) => c.job ? `${c.name} (${c.job})` : c.name).join(", ")}</p>
            )}
            {detail.producers.length > 0 && <p><span className="font-medium">Producers:</span> {detail.producers.map((p: { name: string }) => p.name).join(", ")}</p>}
            {detail.studios.length > 0 && <p><span className="font-medium">Studios:</span> {detail.studios.join(", ")}</p>}
            {detail.keywords.length > 0 && <p><span className="font-medium">Keywords:</span> {detail.keywords.join(", ")}</p>}
            {detail.tmdb_id && <p><span className="font-medium">TMDB:</span> {detail.tmdb_id}</p>}
            {detail.imdb_id && <p><span className="font-medium">IMDB:</span> {detail.imdb_id}</p>}
            {detail.rotten_tomatoes_id && <p><span className="font-medium">Rotten Tomatoes:</span> {detail.rotten_tomatoes_id}</p>}
          </div>
        )}

        {editing && (
          <div className="flex flex-col gap-3 text-sm">
            <EditField label="Tagline" value={draft.tagline ?? ""} onChange={(v) => updateDraft("tagline", v || null)} />
            <EditField label="Plot" value={draft.plot ?? ""} onChange={(v) => updateDraft("plot", v || null)} multiline />
            <EditField label="Runtime (min)" value={draft.runtime != null ? String(draft.runtime) : ""} onChange={(v) => updateDraft("runtime", v ? Number(v) : null)} />
            <EditField label="Maturity Rating" value={draft.maturity_rating ?? ""} onChange={(v) => updateDraft("maturity_rating", v || null)} />
            <EditField label="Genres (comma-separated)" value={(draft.genres ?? []).join(", ")} onChange={(v) => updateListField("genres", v)} />
            <EditField label="Directors (comma-separated)" value={(draft.directors ?? []).join(", ")} onChange={(v) => updateListField("directors", v)} />
            <EditField label="Producers (comma-separated)" value={(draft.producers ?? []).join(", ")} onChange={(v) => updateListField("producers", v)} />
            <EditField label="Studios (comma-separated)" value={(draft.studios ?? []).join(", ")} onChange={(v) => updateListField("studios", v)} />
            <EditField label="Keywords (comma-separated)" value={(draft.keywords ?? []).join(", ")} onChange={(v) => updateListField("keywords", v)} />
            <EditField label="TMDB ID" value={draft.tmdb_id ?? ""} onChange={(v) => updateDraft("tmdb_id", v || null)} />
            <EditField label="IMDB ID" value={draft.imdb_id ?? ""} onChange={(v) => updateDraft("imdb_id", v || null)} />
            <EditField label="Rotten Tomatoes ID" value={draft.rotten_tomatoes_id ?? ""} onChange={(v) => updateDraft("rotten_tomatoes_id", v || null)} />
          </div>
        )}
      </div>
      <TmdbMatchDialog
        open={tmdbDialogOpen}
        onOpenChange={setTmdbDialogOpen}
        libraryId={selectedLibrary.id}
        entryId={entry.id}
        entryTitle={entry.title}
        entryYear={entry.year}
        currentDetail={detail}
        onApplied={() => { loadDetail(); onEntryChanged(); }}
      />
      {detail?.tmdb_id && (
        <TmdbImageBrowserDialog
          open={tmdbImagesOpen}
          onOpenChange={setTmdbImagesOpen}
          libraryId={selectedLibrary.id}
          entryId={entry.id}
          tmdbId={detail.tmdb_id}
          onDownloaded={() => { loadDetail(); onEntryChanged(); }}
        />
      )}
    </div>
  );
}

function TruncatedList({ label, items, limit = 5 }: { label: string; items: string[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const visible = expanded ? items : items.slice(0, limit);
  const hasMore = items.length > limit;
  return (
    <div className="text-sm">
      <span className="text-muted-foreground">{label}: </span>
      {visible.join(", ")}
      {hasMore && (
        <button
          className="ml-1 text-muted-foreground underline hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "show less" : `+${items.length - limit} more`}
        </button>
      )}
    </div>
  );
}

function ShowDetailPage({
  entry,
  selectedLibrary,
  getFullCoverUrl,
  onEntryChanged,
}: {
  entry: MediaEntry;
  selectedLibrary: Library;
  getFullCoverUrl: (filePath: string) => string;
  onEntryChanged: () => void;
}) {
  const [detail, setDetail] = useState<ShowDetail | null>(null);
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [selectedSeasonId, setSelectedSeasonId] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [tmdbDialogOpen, setTmdbDialogOpen] = useState(false);
  const [tmdbImagesOpen, setTmdbImagesOpen] = useState(false);
  const [seasonDetail, setSeasonDetail] = useState<SeasonDetailLocal | null>(null);
  const [episodeDetails, setEpisodeDetails] = useState<Map<number, EpisodeDetailLocal>>(new Map());
  const [expandedEpisodeId, setExpandedEpisodeId] = useState<number | null>(null);
  const [seasonTmdbLoading, setSeasonTmdbLoading] = useState(false);
  const [bulkEpisodesLoading, setBulkEpisodesLoading] = useState(false);
  const [episodeTmdbLoading, setEpisodeTmdbLoading] = useState<number | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const selectedSeason = seasons.find((s) => s.id === selectedSeasonId);
  const selectedSeasonLabel = selectedSeason
    ? (selectedSeason.season_number != null ? `Season ${selectedSeason.season_number}` : selectedSeason.title)
    : "Select season";

  const loadDetail = useCallback(async () => {
    try {
      const d = await invoke<ShowDetail>("get_show_detail", {
        libraryId: selectedLibrary.id,
        showId: entry.id,
      });
      setDetail(d);
    } catch (e) {
      console.error("Failed to load show detail:", e);
    }
  }, [selectedLibrary.id, entry.id]);

  const loadSeasonDetail = useCallback(async (seasonId: number) => {
    try {
      const d = await invoke<SeasonDetailLocal>("get_season_detail_local", {
        libraryId: selectedLibrary.id,
        seasonId,
      });
      setSeasonDetail(d);
    } catch (e) {
      console.error("Failed to load season detail:", e);
    }
  }, [selectedLibrary.id]);

  const loadEpisodeDetail = useCallback(async (episodeId: number) => {
    try {
      const d = await invoke<EpisodeDetailLocal>("get_episode_detail_local", {
        libraryId: selectedLibrary.id,
        episodeId,
      });
      setEpisodeDetails((prev) => new Map(prev).set(episodeId, d));
    } catch (e) {
      console.error("Failed to load episode detail:", e);
    }
  }, [selectedLibrary.id]);

  useEffect(() => {
    loadDetail();
    (async () => {
      try {
        const s = await invoke<SeasonInfo[]>("get_show_seasons", {
          libraryId: selectedLibrary.id,
          showId: entry.id,
        });
        setSeasons(s);
        if (s.length > 0) {
          setSelectedSeasonId(s[0].id);
        }
      } catch (e) {
        console.error("Failed to load seasons:", e);
      }
    })();
  }, [selectedLibrary.id, entry.id, loadDetail]);

  useEffect(() => {
    if (selectedSeasonId == null) return;
    setSeasonDetail(null);
    setEpisodeDetails(new Map());
    setExpandedEpisodeId(null);
    loadSeasonDetail(selectedSeasonId);
    (async () => {
      try {
        const eps = await invoke<EpisodeInfo[]>("get_season_episodes", {
          libraryId: selectedLibrary.id,
          seasonId: selectedSeasonId,
        });
        setEpisodes(eps);
      } catch (e) {
        console.error("Failed to load episodes:", e);
      }
    })();
  }, [selectedLibrary.id, selectedSeasonId, loadSeasonDetail]);

  const handleSeasonTmdb = useCallback(async () => {
    if (!detail?.tmdb_id || !selectedSeason || selectedSeason.season_number == null) return;
    setSeasonTmdbLoading(true);
    try {
      const tmdbSeason = await invoke<TmdbSeasonDetail>("get_tmdb_season_detail", {
        tmdbId: Number(detail.tmdb_id),
        seasonNumber: selectedSeason.season_number,
      });
      const fields: TmdbSeasonFieldSelection = {};
      if (tmdbSeason.overview) fields.plot = tmdbSeason.overview;
      if (tmdbSeason.credits?.cast && tmdbSeason.credits.cast.length > 0) {
        fields.cast = tmdbSeason.credits.cast.slice(0, 20).map((c) => ({
          name: c.name,
          role: c.character ?? null,
          tmdb_id: c.id,
        }));
      }
      if (tmdbSeason.credits?.crew) {
        const crew = tmdbSeason.credits.crew;
        fields.directors = crew
          .filter((c) => c.job === "Director")
          .map((c) => ({ name: c.name, tmdb_id: c.id }));
        fields.producers = crew
          .filter((c) => c.department === "Production")
          .map((c) => ({ name: c.name, tmdb_id: c.id }));
        fields.crew = crew
          .filter((c) => c.job !== "Director" && c.department !== "Production")
          .filter((c) => ["Writer", "Screenplay", "Story", "Composer", "Original Music Composer", "Director of Photography", "Cinematographer", "Editor"].includes(c.job ?? ""))
          .map((c) => ({ name: c.name, job: c.job ?? null, tmdb_id: c.id }));
      }
      await invoke("apply_tmdb_season_metadata", {
        libraryId: selectedLibrary.id,
        seasonId: selectedSeason.id,
        fields,
      });
      toast.success("Season metadata populated from TMDB");
      loadSeasonDetail(selectedSeason.id);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSeasonTmdbLoading(false);
    }
  }, [detail, selectedSeason, selectedLibrary.id, loadSeasonDetail]);

  const handleBulkEpisodes = useCallback(async () => {
    if (!detail?.tmdb_id || !selectedSeason || selectedSeason.season_number == null) return;
    setBulkConfirmOpen(false);
    setBulkEpisodesLoading(true);
    try {
      const count = await invoke<number>("apply_tmdb_season_episodes", {
        libraryId: selectedLibrary.id,
        seasonId: selectedSeason.id,
        tmdbId: Number(detail.tmdb_id),
        seasonNumber: selectedSeason.season_number,
      });
      toast.success(`Populated ${count} episode(s) from TMDB`);
      // Reload episode details
      setEpisodeDetails(new Map());
      setExpandedEpisodeId(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBulkEpisodesLoading(false);
    }
  }, [detail, selectedSeason, selectedLibrary.id]);

  const handleEpisodeTmdb = useCallback(async (ep: EpisodeInfo) => {
    if (!detail?.tmdb_id || !selectedSeason || selectedSeason.season_number == null || ep.episode_number == null) return;
    setEpisodeTmdbLoading(ep.id);
    try {
      const tmdbEp = await invoke<TmdbEpisodeDetail>("get_tmdb_episode_detail", {
        tmdbId: Number(detail.tmdb_id),
        seasonNumber: selectedSeason.season_number,
        episodeNumber: ep.episode_number,
      });
      const fields: TmdbEpisodeFieldSelection = {};
      if (tmdbEp.overview) fields.plot = tmdbEp.overview;
      if (tmdbEp.runtime) fields.runtime = tmdbEp.runtime;
      if (tmdbEp.air_date) fields.release_date = tmdbEp.air_date;
      if (tmdbEp.guest_stars && tmdbEp.guest_stars.length > 0) {
        fields.cast = tmdbEp.guest_stars.map((c) => ({
          name: c.name,
          role: c.character ?? null,
          tmdb_id: c.id,
        }));
      }
      if (tmdbEp.crew && tmdbEp.crew.length > 0) {
        fields.crew = tmdbEp.crew.map((c) => ({
          name: c.name,
          job: c.job ?? null,
          tmdb_id: c.id,
        }));
      }
      await invoke("apply_tmdb_episode_metadata", {
        libraryId: selectedLibrary.id,
        episodeId: ep.id,
        fields,
      });
      toast.success(`Episode ${ep.episode_number} metadata populated`);
      loadEpisodeDetail(ep.id);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setEpisodeTmdbLoading(null);
    }
  }, [detail, selectedSeason, selectedLibrary.id, loadEpisodeDetail]);

  const toggleEpisode = useCallback((epId: number) => {
    if (expandedEpisodeId === epId) {
      setExpandedEpisodeId(null);
    } else {
      setExpandedEpisodeId(epId);
      if (!episodeDetails.has(epId)) {
        loadEpisodeDetail(epId);
      }
    }
  }, [expandedEpisodeId, episodeDetails, loadEpisodeDetail]);

  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getFullCoverUrl(coverPath) : null;
  const hasTmdb = !!detail?.tmdb_id;
  const canSeasonTmdb = hasTmdb && selectedSeason?.season_number != null;

  return (
    <div className="flex gap-8 p-4">
      {coverSrc && (
        <img
          src={coverSrc}
          alt={entry.title}
          className="h-auto max-h-[500px] w-auto shrink-0 rounded-lg object-contain shadow-lg"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">{entry.title}</h1>
            {(entry.season_display || entry.collection_display || entry.year) && (
              <p className="text-lg text-muted-foreground">
                {[entry.season_display || entry.collection_display, entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`].filter(Boolean).join(", ")}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setTmdbDialogOpen(true)}>
              <Film size={14} />
              {detail?.tmdb_id ? "Re-match TMDB" : "Match TMDB"}
            </Button>
            {detail?.tmdb_id && (
              <Button size="sm" variant="outline" onClick={() => setTmdbImagesOpen(true)}>
                <ImageIcon size={14} />
                TMDB Images
              </Button>
            )}
          </div>
        </div>

        {/* Show metadata */}
        {detail && (
          <div className="flex flex-col gap-3">
            {detail.tagline && (
              <p className="text-sm italic text-muted-foreground">{detail.tagline}</p>
            )}
            {detail.plot && (
              <p className="text-sm">{detail.plot}</p>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {detail.maturity_rating && (
                <div>
                  <span className="text-muted-foreground">Rating: </span>
                  {detail.maturity_rating}
                </div>
              )}
              {detail.genres.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Genres: </span>
                  {detail.genres.join(", ")}
                </div>
              )}
              {detail.studios.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Studios: </span>
                  {detail.studios.join(", ")}
                </div>
              )}
            </div>
            <TruncatedList label="Cast" items={detail.cast.map((c) => c.role ? `${c.name} (${c.role})` : c.name)} />
            <TruncatedList label="Created By" items={detail.creators.map((c) => c.name)} />
            <TruncatedList label="Crew" items={detail.crew.map((c) => c.job ? `${c.name} (${c.job})` : c.name)} />
            <TruncatedList label="Producers" items={detail.producers.map((p) => p.name)} />
            {detail.keywords.length > 0 && (
              <div className="text-sm">
                <span className="text-muted-foreground">Keywords: </span>
                {detail.keywords.join(", ")}
              </div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {detail.tmdb_id && <span>TMDB: {detail.tmdb_id}</span>}
              {detail.imdb_id && <span>IMDB: {detail.imdb_id}</span>}
            </div>
          </div>
        )}

        {/* Seasons + episodes */}
        {seasons.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Select
                value={String(selectedSeasonId)}
                onValueChange={(val) => setSelectedSeasonId(Number(val))}
              >
                <SelectTrigger className="w-48">
                  {selectedSeasonLabel}
                </SelectTrigger>
                <SelectContent>
                  {seasons.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.season_number != null ? `Season ${s.season_number}` : s.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {canSeasonTmdb && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={seasonTmdbLoading}
                    onClick={handleSeasonTmdb}
                  >
                    <Tv size={14} />
                    {seasonTmdbLoading ? "Loading..." : "Populate Season from TMDB"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkEpisodesLoading}
                    onClick={() => setBulkConfirmOpen(true)}
                  >
                    <Film size={14} />
                    {bulkEpisodesLoading ? "Loading..." : "Fetch Episode Details"}
                  </Button>
                </>
              )}
            </div>

            {/* Season metadata */}
            {seasonDetail && (seasonDetail.plot || seasonDetail.cast.length > 0 || seasonDetail.directors.length > 0 || seasonDetail.crew.length > 0 || seasonDetail.producers.length > 0) && (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                {seasonDetail.plot && (
                  <p className="text-sm">{seasonDetail.plot}</p>
                )}
                <TruncatedList label="Cast" items={seasonDetail.cast.map((c) => c.role ? `${c.name} (${c.role})` : c.name)} />
                <TruncatedList label="Directors" items={seasonDetail.directors.map((d) => d.name)} />
                <TruncatedList label="Crew" items={seasonDetail.crew.map((c) => c.job ? `${c.name} (${c.job})` : c.name)} />
                <TruncatedList label="Producers" items={seasonDetail.producers.map((p) => p.name)} />
              </div>
            )}

            {/* Episodes */}
            <div className="flex flex-col gap-1">
              {episodes.map((ep) => {
                const isExpanded = expandedEpisodeId === ep.id;
                const epDetail = episodeDetails.get(ep.id);
                const hasDetail = epDetail && (epDetail.plot || epDetail.runtime || epDetail.cast.length > 0 || epDetail.crew.length > 0);
                return (
                  <div key={ep.id} className="flex flex-col">
                    <div
                      className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-accent"
                      onClick={() => toggleEpisode(ep.id)}
                    >
                      {isExpanded ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={14} className="shrink-0 text-muted-foreground" />}
                      <span className="w-8 text-right text-sm text-muted-foreground">
                        {ep.episode_number != null ? ep.episode_number : "–"}
                      </span>
                      <span className="flex-1 truncate text-sm">{ep.title}</span>
                      {canSeasonTmdb && ep.episode_number != null && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={episodeTmdbLoading === ep.id}
                          onClick={(e) => { e.stopPropagation(); handleEpisodeTmdb(ep); }}
                          title="Fetch from TMDB"
                        >
                          {episodeTmdbLoading === ep.id ? <Spinner className="h-3.5 w-3.5" /> : <Tv size={14} />}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          (async () => {
                            try {
                              await invoke("play_episode", {
                                libraryId: selectedLibrary.id,
                                episodeId: ep.id,
                              });
                            } catch (err) {
                              toast.error(String(err));
                            }
                          })();
                        }}
                      >
                        <Play size={14} />
                      </Button>
                    </div>
                    {isExpanded && (
                      <div className="ml-14 mb-1 flex flex-col gap-1 rounded-md border p-3 text-sm">
                        {!epDetail && <Spinner className="h-4 w-4" />}
                        {epDetail && !hasDetail && (
                          <p className="text-muted-foreground">No metadata</p>
                        )}
                        {epDetail && hasDetail && (
                          <>
                            {epDetail.runtime && (
                              <div>
                                <span className="text-muted-foreground">Runtime: </span>
                                {epDetail.runtime} min
                              </div>
                            )}
                            {epDetail.plot && (
                              <p>{epDetail.plot}</p>
                            )}
                            <TruncatedList label="Guest Stars" items={epDetail.cast.map((c) => c.role ? `${c.name} (${c.role})` : c.name)} />
                            <TruncatedList label="Crew" items={epDetail.crew.map((c) => c.job ? `${c.name} (${c.job})` : c.name)} />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {episodes.length === 0 && (
                <p className="text-sm text-muted-foreground">No episodes</p>
              )}
            </div>
          </div>
        )}

        {seasons.length === 0 && (
          <p className="text-sm text-muted-foreground">No seasons</p>
        )}
      </div>

      <TmdbShowMatchDialog
        open={tmdbDialogOpen}
        onOpenChange={setTmdbDialogOpen}
        libraryId={selectedLibrary.id}
        entryId={entry.id}
        entryTitle={entry.title}
        entryYear={entry.year}
        currentDetail={detail}
        onApplied={() => { loadDetail(); onEntryChanged(); }}
      />

      {detail?.tmdb_id && (
        <TmdbImageBrowserDialog
          open={tmdbImagesOpen}
          onOpenChange={setTmdbImagesOpen}
          libraryId={selectedLibrary.id}
          entryId={entry.id}
          tmdbId={detail.tmdb_id}
          onDownloaded={() => { loadDetail(); onEntryChanged(); }}
        />
      )}

      {/* Bulk episode fetch confirmation */}
      <Dialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fetch Episode Details</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            This will fetch metadata (plot, runtime, guest stars, crew) for all episodes in this season from TMDB.
            Only empty fields will be populated. Doing this multiple times in quick succession may cause you to hit TMDB's rate limit.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConfirmOpen(false)}>Cancel</Button>
            <Button onClick={handleBulkEpisodes}>Fetch All Episodes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditField({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
        />
      )}
    </div>
  );
}
