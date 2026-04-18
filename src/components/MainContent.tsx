import { useState, useCallback, useRef, useEffect, useMemo, type RefObject } from "react";
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
  User as UserIcon,
} from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Library, MediaEntry, BreadcrumbItem, MovieDetail, MovieDetailUpdate, SeasonInfo, EpisodeInfo, ShowDetail, SeasonDetailLocal, EpisodeDetailLocal, TmdbSeasonDetail, TmdbEpisodeDetail, TmdbShowFieldSelection, TmdbSeasonFieldSelection, TmdbEpisodeFieldSelection, CastUpdateInfo, ViewSpec, PersonSummary, PersonRole, PlaylistSummary } from "@/types";
import { TmdbMatchDialog } from "@/components/TmdbMatchDialog";
import { TmdbShowMatchDialog } from "@/components/TmdbShowMatchDialog";
import { TmdbImageBrowserDialog } from "@/components/TmdbImageBrowserDialog";
import { PeopleGrid } from "@/components/PeopleGrid";

function getDisplayCover(entry: MediaEntry): string | null {
  if (entry.selected_cover && entry.covers.includes(entry.selected_cover)) {
    return entry.selected_cover;
  }
  return entry.covers[0] || null;
}

function formatReleaseDate(date: string | null | undefined): string | null {
  if (!date) return null;
  if (/^\d{4}$/.test(date)) return date;
  if (/^\d{4}-\d{2}$/.test(date)) {
    const [y, m] = date.split("-");
    return new Date(+y, +m - 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split("-");
    return new Date(+y, +m - 1, +d).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }
  return date;
}

interface MainContentProps {
  entries: MediaEntry[];
  people: PersonSummary[] | null;
  playlists: PlaylistSummary[] | null;
  activeView: ViewSpec | null;
  searchResults: MediaEntry[] | null;
  selectedEntry: MediaEntry | null;
  loading: boolean;
  breadcrumbs: BreadcrumbItem[];
  coverSize: number;
  onCoverSizeChange: (size: number) => void;
  search: string;
  onSearchChange: (search: string) => void;
  onNavigate: (entry: MediaEntry) => void;
  onNavigateToPerson: (person: PersonSummary, role: PersonRole) => void;
  onBreadcrumbClick: (index: number) => void;
  selectedLibrary: Library | null;
  hasLibraries: boolean;
  sortMode: string;
  onSortModeChange: (mode: string) => void;
  onSortOrderChange: (reordered: MediaEntry[]) => void;
  onRenameEntry: (entryId: number, newTitle: string) => Promise<string | null>;
  onTitleChanged: (entryId: number, newTitle: string) => void;
  onSetCover: (entryId: number, coverPath: string | null) => void;
  onAddCover: (entryId: number) => Promise<void>;
  onDeleteCover: (entryId: number, coverPath: string) => Promise<void>;
  onMoveEntry: (entryId: number, newParentId: number | null, insertBeforeId: number | null) => Promise<void>;
  onCreateCollection: (name: string, basePath?: string) => Promise<void>;
  onDeleteEntry: (entryId: number, deleteFromDisk: boolean) => Promise<void>;
  onRescan: () => void;
  onEntryChanged: () => void;
  getCoverUrl: (filePath: string) => string;
  getFullCoverUrl: (filePath: string) => string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onPlayFile?: (path: string, title: string) => void;
  onPlayEpisode?: (args: { libraryId: string; showId: number; showTitle: string; startEpisodeId: number }) => void;
}

export function MainContent({
  entries,
  people,
  playlists,
  activeView,
  searchResults,
  selectedEntry,
  loading,
  breadcrumbs,
  coverSize,
  onCoverSizeChange,
  search,
  onSearchChange,
  onNavigate,
  onNavigateToPerson,
  onBreadcrumbClick,
  selectedLibrary,
  hasLibraries,
  sortMode,
  onSortModeChange,
  onSortOrderChange,
  onRenameEntry,
  onTitleChanged,
  onSetCover,
  onAddCover,
  onDeleteCover,
  onMoveEntry,
  onCreateCollection,
  onDeleteEntry,
  onRescan,
  onEntryChanged,
  getCoverUrl,
  getFullCoverUrl,
  scrollContainerRef,
  onPlayFile,
  onPlayEpisode,
}: MainContentProps) {
  const [coverDialogEntry, setCoverDialogEntry] = useState<MediaEntry | null>(
    null
  );
  const [coverDialogMode, setCoverDialogMode] = useState<"select" | "delete">("select");

  const openCoverDialog = useCallback((entry: MediaEntry, mode: "select" | "delete") => {
    setCoverDialogMode(mode);
    setCoverDialogEntry(entry);
  }, []);

  const [tmdbImagesEntry, setTmdbImagesEntry] = useState<{ entry: MediaEntry; tmdbId: string } | null>(null);

  const openTmdbImages = useCallback(async (entry: MediaEntry) => {
    if (!selectedLibrary) return;
    try {
      const cmd = entry.entry_type === "show" ? "get_show_detail" : "get_movie_detail";
      const detail = await invoke<{ tmdb_id: string | null }>(cmd, {
        entryId: entry.id,
      });
      if (!detail.tmdb_id) {
        toast.error("Match to TMDB first");
        return;
      }
      setTmdbImagesEntry({ entry, tmdbId: detail.tmdb_id });
    } catch (e) {
      toast.error(String(e));
    }
  }, [selectedLibrary]);

  // Keep the dialog's entry in sync with the live entries/selectedEntry so covers list updates after delete
  const liveCoverDialogEntry = useMemo(() => {
    if (!coverDialogEntry) return null;
    if (selectedEntry?.id === coverDialogEntry.id) return selectedEntry;
    const found = entries.find((e) => e.id === coverDialogEntry.id);
    return found ?? coverDialogEntry;
  }, [coverDialogEntry, entries, selectedEntry]);
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

  const breadcrumbBar = (
    <Breadcrumb className="border-b border-border">
      <BreadcrumbList className="!flex-nowrap overflow-x-auto px-4 py-2 pr-8 text-xs font-medium">
        {breadcrumbs.map((crumb, i) => (
          <BreadcrumbUIItem key={i} className="whitespace-nowrap">
            {i > 0 && <BreadcrumbSeparator />}
            {i === breadcrumbs.length - 1 ? (
              <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<button onClick={() => onBreadcrumbClick(i)} />}>
                {crumb.title}
              </BreadcrumbLink>
            )}
          </BreadcrumbUIItem>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );

  if (activeView?.kind === "people-list" || activeView?.kind === "people-all") {
    const role: PersonRole = activeView.kind === "people-all" ? "all" : activeView.role;
    return (
      <main className="flex flex-1 flex-col overflow-hidden bg-background">
        {breadcrumbBar}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
          {!loading && people && people.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No people found.</p>
          )}
          {!loading && people && people.length > 0 && (
            <PeopleGrid
              people={people}
              onSelectPerson={(p) => onNavigateToPerson(p, role)}
            />
          )}
        </div>
      </main>
    );
  }

  if (activeView?.kind === "playlists") {
    return (
      <main className="flex flex-1 flex-col overflow-hidden bg-background">
        {breadcrumbBar}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && playlists && playlists.length === 0 && (
            <p className="text-sm text-muted-foreground">No playlists yet.</p>
          )}
          {!loading && playlists && playlists.length > 0 && (
            <ul className="space-y-1 text-sm">
              {playlists.map((pl) => (
                <li key={pl.id}>{pl.title}</li>
              ))}
            </ul>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {selectedLibrary && (
        <>
          {breadcrumbBar}

          {/* Person-detail header */}
          {activeView?.kind === "person-detail" && !selectedEntry && (
            <PersonDetailHeader
              name={activeView.personName}
              imagePath={activeView.personImage}
              role={activeView.role}
              workCount={entries.length}
            />
          )}

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
                  : sortMode === "date" || sortMode === "year"
                    ? "Date"
                    : "Custom"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onSortModeChange("alpha")}>
                  Alphabetical
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSortModeChange("date")}>
                  Date
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
          ? <ShowDetailPage entry={selectedEntry} selectedLibrary={selectedLibrary!} getFullCoverUrl={getFullCoverUrl} onEntryChanged={onEntryChanged} onTitleChanged={onTitleChanged} onChangeCover={() => openCoverDialog(selectedEntry, "select")} onAddCover={() => onAddCover(selectedEntry.id)} onDeleteCover={() => openCoverDialog(selectedEntry, "delete")} onPlayEpisode={onPlayEpisode} />
          : <EntryDetailPage entry={selectedEntry} selectedLibrary={selectedLibrary!} getFullCoverUrl={getFullCoverUrl} onEntryChanged={onEntryChanged} onTitleChanged={onTitleChanged} onChangeCover={() => openCoverDialog(selectedEntry, "select")} onAddCover={() => onAddCover(selectedEntry.id)} onDeleteCover={() => openCoverDialog(selectedEntry, "delete")} onPlayFile={onPlayFile} />
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
                    onChangeCover={() => openCoverDialog(entry, "select")}
                    onAddCover={() => onAddCover(entry.id)}
                    onAddCoverFromTmdb={() => openTmdbImages(entry)}
                    onDeleteCover={() => openCoverDialog(entry, "delete")}
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
      {liveCoverDialogEntry && (
        <CoverCarouselDialog
          entry={liveCoverDialogEntry}
          mode={coverDialogMode}
          open={!!coverDialogEntry}
          onOpenChange={(open) => {
            if (!open) setCoverDialogEntry(null);
          }}
          onSelect={(coverPath) => {
            onSetCover(liveCoverDialogEntry.id, coverPath);
            setCoverDialogEntry(null);
          }}
          onDelete={async (coverPath) => {
            const wasLast = liveCoverDialogEntry.covers.length <= 1;
            await onDeleteCover(liveCoverDialogEntry.id, coverPath);
            if (wasLast) setCoverDialogEntry(null);
          }}
          getCoverUrl={getFullCoverUrl}
        />
      )}

      {tmdbImagesEntry && selectedLibrary && (
        <TmdbImageBrowserDialog
          open={!!tmdbImagesEntry}
          onOpenChange={(open) => { if (!open) setTmdbImagesEntry(null); }}
          libraryId={selectedLibrary.id}
          entryId={tmdbImagesEntry.entry.id}
          tmdbId={tmdbImagesEntry.tmdbId}
          onDownloaded={() => { onEntryChanged(); }}
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
  onAddCover,
  onAddCoverFromTmdb,
  onDeleteCover,
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
  onAddCover: () => void;
  onAddCoverFromTmdb: () => void;
  onDeleteCover: () => void;
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
        <ContextMenuItem onClick={onAddCover}>
          <ImageIcon size={14} />
          Add local cover
        </ContextMenuItem>
        <ContextMenuItem onClick={onAddCoverFromTmdb} disabled={entry.entry_type === "collection" || !entry.tmdb_id}>
          <ImageIcon size={14} />
          Add cover from TMDB
        </ContextMenuItem>
        <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
          <ImageIcon size={14} />
          Change cover
        </ContextMenuItem>
        <ContextMenuItem onClick={onDeleteCover} disabled={entry.covers.length < 1}>
          <Trash2 size={14} />
          Delete cover
        </ContextMenuItem>
        {!(entry.entry_type === "collection" && entry.child_count > 0) && (
          <ContextMenuItem onClick={() => onDelete(entry)} className="text-destructive focus:text-destructive">
            <Trash2 size={14} />
            {entry.entry_type === "collection" ? "Delete collection" : "Delete media"}
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
  mode,
  open,
  onOpenChange,
  onSelect,
  onDelete,
  getCoverUrl,
}: {
  entry: MediaEntry;
  mode: "select" | "delete";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (coverPath: string) => void;
  onDelete: (coverPath: string) => Promise<void>;
  getCoverUrl: (filePath: string) => string;
}) {
  const currentCover = getDisplayCover(entry);
  const startIndex = currentCover
    ? Math.max(0, entry.covers.indexOf(currentCover))
    : 0;
  const [selectedIndex, setSelectedIndex] = useState(startIndex);
  const [api, setApi] = useState<CarouselApi>();
  const [dims, setDims] = useState<Map<number, { w: number; h: number }>>(new Map());
  const [sizes, setSizes] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    if (!api) return;
    const onSelectSlide = () => setSelectedIndex(api.selectedScrollSnap());
    api.on("select", onSelectSlide);
    return () => {
      api.off("select", onSelectSlide);
    };
  }, [api]);

  useEffect(() => {
    entry.covers.forEach((cover, i) => {
      if (sizes.has(i)) return;
      invoke<number>("get_file_size", { path: cover })
        .then((n) => setSizes((prev) => new Map(prev).set(i, n)))
        .catch(() => {});
    });
  }, [entry.covers, sizes]);

  const fmtSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const selDim = dims.get(selectedIndex);
  const selSize = sizes.get(selectedIndex);

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
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        setDims((prev) => {
                          if (prev.has(i)) return prev;
                          return new Map(prev).set(i, { w: img.naturalWidth, h: img.naturalHeight });
                        });
                      }}
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
            {selDim && ` · ${selDim.w}×${selDim.h}`}
            {selSize != null && ` · ${fmtSize(selSize)}`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {mode === "delete" ? "Close" : "Cancel"}
          </Button>
          {mode === "delete" ? (
            <Button
              variant="destructive"
              onClick={async () => {
                const cover = entry.covers[selectedIndex];
                if (!cover) return;
                await onDelete(cover);
                setSelectedIndex((prev) => Math.max(0, Math.min(prev, entry.covers.length - 2)));
              }}
            >
              Delete
            </Button>
          ) : (
            <Button onClick={() => onSelect(entry.covers[selectedIndex])}>
              Select
            </Button>
          )}
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
  onTitleChanged,
  onChangeCover,
  onAddCover,
  onDeleteCover,
  onPlayFile,
}: {
  entry: MediaEntry;
  selectedLibrary: Library;
  getFullCoverUrl: (filePath: string) => string;
  onEntryChanged: () => void;
  onTitleChanged: (entryId: number, newTitle: string) => void;
  onChangeCover: () => void;
  onAddCover: () => void;
  onDeleteCover: () => void;
  onPlayFile?: (path: string, title: string) => void;
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
        entryId: entry.id,
      });
      setDetail(d);
    } catch (e) {
      console.error("Failed to load movie detail:", e);
    }
  }, [entry.id]);

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
      cast: detail?.cast.map((c: { name: string; role: string | null }) => ({ name: c.name, role: c.role, tmdb_id: null, profile_path: null })) ?? [],
      composers: detail?.composers.map((p: { name: string }) => p.name) ?? [],
      studios: detail?.studios ?? [],
      keywords: detail?.keywords ?? [],
    });
    setEditing(true);
  };

  const saveDetail = async () => {
    setSaving(true);
    try {
      await invoke("update_movie_detail", {
        entryId: entry.id,
        detail: draft,
      });
      await loadDetail();
      if (draft.title && draft.title !== entry.title) {
        onTitleChanged(entry.id, draft.title);
      }
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
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <img
                src={coverSrc}
                alt={entry.title}
                className="h-auto max-h-[500px] w-auto shrink-0 rounded-lg object-contain shadow-lg"
              />
            }
          />
          <ContextMenuContent>
            <ContextMenuItem onClick={onAddCover}>
              <ImageIcon size={14} />
              Add local cover
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setTmdbImagesOpen(true)} disabled={!detail?.tmdb_id}>
              <ImageIcon size={14} />
              Add cover from TMDB
            </ContextMenuItem>
            <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
              <ImageIcon size={14} />
              Change cover
            </ContextMenuItem>
            <ContextMenuItem onClick={onDeleteCover} disabled={entry.covers.length < 1}>
              <Trash2 size={14} />
              Delete cover
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-w-0 flex-1 flex-col gap-4" />}>
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
                  placeholder="YYYY, YYYY-MM, or YYYY-MM-DD"
                  className="w-36 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
                />
              </div>
            ) : (
              <>
                <h1 className="text-3xl font-bold">{entry.title}</h1>
                {(() => {
                  const dateDisplay = formatReleaseDate(detail?.release_date) ?? (entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`);
                  return dateDisplay && <p className="text-lg text-muted-foreground">{dateDisplay}</p>;
                })()}
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={async () => {
                try {
                  const path = await invoke<string>("get_movie_file_path", { libraryId: selectedLibrary.id, entryId: entry.id });
                  onPlayFile?.(path, entry.title);
                } catch (e) {
                  toast.error(String(e));
                }
              }}
            >
              <Play size={14} />
              Play
            </Button>
            {editing && (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveDetail} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
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
            {detail.composers.length > 0 && <p><span className="font-medium">Composers:</span> {detail.composers.map((p: { name: string }) => p.name).join(", ")}</p>}
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
            <EditField label="Composers (comma-separated)" value={(draft.composers ?? []).join(", ")} onChange={(v) => updateListField("composers", v)} />
            <EditField label="Studios (comma-separated)" value={(draft.studios ?? []).join(", ")} onChange={(v) => updateListField("studios", v)} />
            <EditField label="Keywords (comma-separated)" value={(draft.keywords ?? []).join(", ")} onChange={(v) => updateListField("keywords", v)} />
            <EditField label="TMDB ID" value={draft.tmdb_id ?? ""} onChange={(v) => updateDraft("tmdb_id", v || null)} />
            <EditField label="IMDB ID" value={draft.imdb_id ?? ""} onChange={(v) => updateDraft("imdb_id", v || null)} />
            <EditField label="Rotten Tomatoes ID" value={draft.rotten_tomatoes_id ?? ""} onChange={(v) => updateDraft("rotten_tomatoes_id", v || null)} />
            <PeopleListEdit label="Cast" items={draft.cast ?? []} onChange={(items) => updateDraft("cast", items)} secondaryField="role" secondaryLabel="Role" />
          </div>
        )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setTmdbDialogOpen(true)}>
            <Film size={14} />
            {detail?.tmdb_id ? "Rematch TMDB" : "Match TMDB"}
          </ContextMenuItem>
          <ContextMenuItem onClick={startEditing}>
            <Pencil size={14} />
            Edit
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <TmdbMatchDialog
        open={tmdbDialogOpen}
        onOpenChange={setTmdbDialogOpen}
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
  onTitleChanged: _onTitleChanged,
  onChangeCover,
  onAddCover,
  onDeleteCover,
  onPlayEpisode,
}: {
  entry: MediaEntry;
  selectedLibrary: Library;
  getFullCoverUrl: (filePath: string) => string;
  onEntryChanged: () => void;
  onTitleChanged: (entryId: number, newTitle: string) => void;
  onChangeCover: () => void;
  onAddCover: () => void;
  onDeleteCover: () => void;
  onPlayEpisode?: (args: { libraryId: string; showId: number; showTitle: string; startEpisodeId: number }) => void;
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
  const [showEditing, setShowEditing] = useState(false);
  const [showDraft, setShowDraft] = useState<TmdbShowFieldSelection>({});
  const [showSaving, setShowSaving] = useState(false);
  const [seasonEditing, setSeasonEditing] = useState(false);
  const [seasonDraft, setSeasonDraft] = useState<TmdbSeasonFieldSelection>({});
  const [seasonSaving, setSeasonSaving] = useState(false);
  const [editingEpisodeId, setEditingEpisodeId] = useState<number | null>(null);
  const [episodeDraft, setEpisodeDraft] = useState<TmdbEpisodeFieldSelection>({});
  const [episodeSaving, setEpisodeSaving] = useState(false);
  const selectedSeason = seasons.find((s) => s.id === selectedSeasonId);
  const selectedSeasonLabel = selectedSeason
    ? (selectedSeason.season_number != null ? `Season ${selectedSeason.season_number}` : selectedSeason.title)
    : "Select season";

  const loadDetail = useCallback(async () => {
    try {
      const d = await invoke<ShowDetail>("get_show_detail", {
        showId: entry.id,
      });
      setDetail(d);
    } catch (e) {
      console.error("Failed to load show detail:", e);
    }
  }, [entry.id]);

  const loadSeasonDetail = useCallback(async (seasonId: number) => {
    try {
      const d = await invoke<SeasonDetailLocal>("get_season_detail_local", {
        seasonId,
      });
      setSeasonDetail(d);
    } catch (e) {
      console.error("Failed to load season detail:", e);
    }
  }, []);

  const loadEpisodeDetail = useCallback(async (episodeId: number) => {
    try {
      const d = await invoke<EpisodeDetailLocal>("get_episode_detail_local", {
        episodeId,
      });
      setEpisodeDetails((prev) => new Map(prev).set(episodeId, d));
    } catch (e) {
      console.error("Failed to load episode detail:", e);
    }
  }, []);

  useEffect(() => {
    loadDetail();
    (async () => {
      try {
        const s = await invoke<SeasonInfo[]>("get_show_seasons", {
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
  }, [entry.id, loadDetail]);

  useEffect(() => {
    if (selectedSeasonId == null) return;
    setSeasonDetail(null);
    setEpisodeDetails(new Map());
    setExpandedEpisodeId(null);
    loadSeasonDetail(selectedSeasonId);
    (async () => {
      try {
        const eps = await invoke<EpisodeInfo[]>("get_season_episodes", {
          seasonId: selectedSeasonId,
        });
        setEpisodes(eps);
      } catch (e) {
        console.error("Failed to load episodes:", e);
      }
    })();
  }, [selectedSeasonId, loadSeasonDetail]);

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
          profile_path: c.profile_path,
        }));
      }
      // Any season-level director gets fanned out to every episode in the season by the backend.
      if (tmdbSeason.credits?.crew) {
        const directors = tmdbSeason.credits.crew
          .filter((c) => c.job === "Director")
          .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
        if (directors.length > 0) fields.season_director = directors;
      }
      await invoke("apply_tmdb_season_metadata", {
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
  }, [detail, selectedSeason, loadSeasonDetail]);

  const handleBulkEpisodes = useCallback(async () => {
    if (!detail?.tmdb_id || !selectedSeason || selectedSeason.season_number == null) return;
    setBulkConfirmOpen(false);
    setBulkEpisodesLoading(true);
    try {
      const count = await invoke<number>("apply_tmdb_season_episodes", {
        seasonId: selectedSeason.id,
        tmdbId: Number(detail.tmdb_id),
        seasonNumber: selectedSeason.season_number,
      });
      toast.success(`Populated ${count} episode(s) from TMDB`);
      // Reload episode details
      setEpisodeDetails(new Map());
      setExpandedEpisodeId(null);
      onEntryChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBulkEpisodesLoading(false);
    }
  }, [detail, selectedSeason, selectedLibrary.id, onEntryChanged]);

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
          profile_path: c.profile_path,
        }));
      }
      if (tmdbEp.crew && tmdbEp.crew.length > 0) {
        const directors = tmdbEp.crew
          .filter((c) => c.job === "Director")
          .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
        const composers = tmdbEp.crew
          .filter((c) => c.job === "Composer" || c.job === "Original Music Composer")
          .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
        if (directors.length > 0) fields.director = directors;
        if (composers.length > 0) fields.composer = composers;
      }
      await invoke("apply_tmdb_episode_metadata", {
        episodeId: ep.id,
        fields,
      });
      toast.success(`Episode ${ep.episode_number} metadata populated`);
      loadEpisodeDetail(ep.id);
      onEntryChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setEpisodeTmdbLoading(null);
    }
  }, [detail, selectedSeason, loadEpisodeDetail, onEntryChanged]);

  const startEditShow = useCallback(() => {
    if (!detail) return;
    setSeasonEditing(false);
    setEditingEpisodeId(null);
    setShowDraft({
      plot: detail.plot ?? "",
      tagline: detail.tagline ?? "",
      maturity_rating: detail.maturity_rating ?? "",
      genres: [...detail.genres],
      creators: detail.creators.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })),
      cast: detail.cast.map((c) => ({ name: c.name, role: c.role, tmdb_id: null, profile_path: null })),
      composers: detail.composers.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })),
      studios: [...detail.studios],
      keywords: [...detail.keywords],
    });
    setShowEditing(true);
  }, [detail]);

  const saveShow = useCallback(async () => {
    setShowSaving(true);
    try {
      await invoke("apply_tmdb_show_metadata", {
        showId: entry.id,
        fields: showDraft,
      });
      await loadDetail();
      onEntryChanged();
      setShowEditing(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setShowSaving(false);
    }
  }, [selectedLibrary.id, entry.id, showDraft, loadDetail, onEntryChanged]);

  const startEditSeason = useCallback(() => {
    if (!seasonDetail) return;
    setShowEditing(false);
    setEditingEpisodeId(null);
    setSeasonDraft({
      plot: seasonDetail.plot ?? "",
      cast: seasonDetail.cast.map((c) => ({ name: c.name, role: c.role, tmdb_id: null, profile_path: null })),
    });
    setSeasonEditing(true);
  }, [seasonDetail]);

  const saveSeason = useCallback(async () => {
    if (!selectedSeason) return;
    setSeasonSaving(true);
    try {
      await invoke("apply_tmdb_season_metadata", {
        seasonId: selectedSeason.id,
        fields: seasonDraft,
      });
      loadSeasonDetail(selectedSeason.id);
      setSeasonEditing(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSeasonSaving(false);
    }
  }, [selectedLibrary.id, selectedSeason, seasonDraft, loadSeasonDetail]);

  const startEditEpisode = useCallback((ep: EpisodeInfo) => {
    setShowEditing(false);
    setSeasonEditing(false);
    const d = episodeDetails.get(ep.id);
    setEpisodeDraft({
      plot: d?.plot ?? "",
      runtime: d?.runtime ?? undefined,
      release_date: d?.release_date ?? "",
      cast: d?.cast.map((c) => ({ name: c.name, role: c.role, tmdb_id: null, profile_path: null })) ?? [],
      director: d?.directors.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })) ?? [],
      composer: d?.composers.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })) ?? [],
    });
    setEditingEpisodeId(ep.id);
  }, [episodeDetails]);

  const saveEpisode = useCallback(async () => {
    if (editingEpisodeId == null) return;
    setEpisodeSaving(true);
    try {
      await invoke("apply_tmdb_episode_metadata", {
        episodeId: editingEpisodeId,
        fields: episodeDraft,
      });
      loadEpisodeDetail(editingEpisodeId);
      onEntryChanged();
      setEditingEpisodeId(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setEpisodeSaving(false);
    }
  }, [selectedLibrary.id, editingEpisodeId, episodeDraft, loadEpisodeDetail, onEntryChanged]);

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
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <img
                src={coverSrc}
                alt={entry.title}
                className="h-auto max-h-[500px] w-auto shrink-0 rounded-lg object-contain shadow-lg"
              />
            }
          />
          <ContextMenuContent>
            <ContextMenuItem onClick={onAddCover}>
              <ImageIcon size={14} />
              Add local cover
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setTmdbImagesOpen(true)} disabled={!detail?.tmdb_id}>
              <ImageIcon size={14} />
              Add cover from TMDB
            </ContextMenuItem>
            <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
              <ImageIcon size={14} />
              Change cover
            </ContextMenuItem>
            <ContextMenuItem onClick={onDeleteCover} disabled={entry.covers.length < 1}>
              <Trash2 size={14} />
              Delete cover
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-w-0 flex-1 flex-col gap-4" />}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">{entry.title}</h1>
            {(entry.season_display || entry.collection_display || entry.year) && (
              <p className="text-lg text-muted-foreground">
                {[entry.season_display || entry.collection_display, entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`].filter(Boolean).join(", ")}
              </p>
            )}
          </div>
        </div>

        {/* Show metadata */}
        {detail && !showEditing && (
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
            <TruncatedList label="Composers" items={detail.composers.map((c) => c.name)} />
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

        {showEditing && (
          <div className="flex flex-col gap-3 text-sm">
            <EditField label="Tagline" value={showDraft.tagline ?? ""} onChange={(v) => setShowDraft((p) => ({ ...p, tagline: v }))} />
            <EditField label="Plot" value={showDraft.plot ?? ""} onChange={(v) => setShowDraft((p) => ({ ...p, plot: v }))} multiline />
            <EditField label="Maturity Rating" value={showDraft.maturity_rating ?? ""} onChange={(v) => setShowDraft((p) => ({ ...p, maturity_rating: v }))} />
            <EditField label="Genres (comma-separated)" value={(showDraft.genres ?? []).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, genres: v.split(",").map((s) => s.trim()).filter(Boolean) }))} />
            <EditField label="Creators (comma-separated)" value={(showDraft.creators ?? []).map((c) => c.name).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, creators: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
            <EditField label="Composers (comma-separated)" value={(showDraft.composers ?? []).map((c) => c.name).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, composers: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
            <PeopleListEdit label="Cast" items={showDraft.cast ?? []} onChange={(items) => setShowDraft((p) => ({ ...p, cast: items }))} secondaryField="role" secondaryLabel="Role" />
            <EditField label="Studios (comma-separated)" value={(showDraft.studios ?? []).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, studios: v.split(",").map((s) => s.trim()).filter(Boolean) }))} />
            <EditField label="Keywords (comma-separated)" value={(showDraft.keywords ?? []).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, keywords: v.split(",").map((s) => s.trim()).filter(Boolean) }))} />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowEditing(false)} disabled={showSaving}>Cancel</Button>
              <Button size="sm" onClick={saveShow} disabled={showSaving}>{showSaving ? "Saving..." : "Save"}</Button>
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
            </div>

            {/* Season metadata */}
            {selectedSeason && !seasonEditing && (() => {
              const hasMeta = seasonDetail && (seasonDetail.plot || seasonDetail.cast.length > 0);
              const episodesNumbered = episodes.length > 0 && episodes.every((e) => e.episode_number != null);
              return (
                <ContextMenu>
                  <ContextMenuTrigger render={<div className="flex flex-col gap-2 rounded-md border p-3" />}>
                    {!seasonDetail && <Spinner className="h-4 w-4" />}
                    {seasonDetail && !hasMeta && (
                      <p className="text-sm text-muted-foreground">No metadata</p>
                    )}
                    {seasonDetail && hasMeta && (
                      <>
                        {seasonDetail.plot && <p className="text-sm">{seasonDetail.plot}</p>}
                        <TruncatedList label="Cast" items={seasonDetail.cast.map((c) => c.role ? `${c.name} (${c.role})` : c.name)} />
                      </>
                    )}
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={startEditSeason} disabled={!seasonDetail}>
                      <Pencil size={14} />
                      Edit
                    </ContextMenuItem>
                    <ContextMenuItem onClick={handleSeasonTmdb} disabled={!canSeasonTmdb || seasonTmdbLoading}>
                      <Tv size={14} />
                      {seasonTmdbLoading ? "Loading..." : "Populate season from TMDB"}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => setBulkConfirmOpen(true)} disabled={!canSeasonTmdb || bulkEpisodesLoading || !episodesNumbered}>
                      <Film size={14} />
                      {bulkEpisodesLoading ? "Loading..." : "Fetch all episodes' details"}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })()}

            {selectedSeason && seasonEditing && (
              <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
                <EditField label="Plot" value={seasonDraft.plot ?? ""} onChange={(v) => setSeasonDraft((p) => ({ ...p, plot: v }))} multiline />
                <EditField label="Season-wide Director (comma-separated — applied to every episode)" value={(seasonDraft.season_director ?? []).map((c) => c.name).join(", ")} onChange={(v) => setSeasonDraft((p) => ({ ...p, season_director: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
                <PeopleListEdit label="Cast" items={seasonDraft.cast ?? []} onChange={(items) => setSeasonDraft((p) => ({ ...p, cast: items }))} secondaryField="role" secondaryLabel="Role" />
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setSeasonEditing(false)} disabled={seasonSaving}>Cancel</Button>
                  <Button size="sm" onClick={saveSeason} disabled={seasonSaving}>{seasonSaving ? "Saving..." : "Save"}</Button>
                </div>
              </div>
            )}

            {/* Episodes */}
            <div className="flex flex-col gap-1">
              {episodes.map((ep) => {
                const isExpanded = expandedEpisodeId === ep.id;
                const epDetail = episodeDetails.get(ep.id);
                const hasDetail = epDetail && (epDetail.release_date || epDetail.plot || epDetail.runtime || epDetail.cast.length > 0 || epDetail.directors.length > 0 || epDetail.composers.length > 0);
                return (
                  <div key={ep.id} className="flex flex-col">
                    <ContextMenu>
                      <ContextMenuTrigger
                        render={
                          <div
                            className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-accent"
                            onClick={() => toggleEpisode(ep.id)}
                          />
                        }
                      >
                      {isExpanded ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={14} className="shrink-0 text-muted-foreground" />}
                      <span className="w-8 text-right text-sm text-muted-foreground">
                        {ep.episode_number != null ? ep.episode_number : "–"}
                      </span>
                      <span className="flex-1 truncate text-sm">{ep.title}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          try {
                            onPlayEpisode?.({
                              libraryId: selectedLibrary.id,
                              showId: entry.id,
                              showTitle: entry.title,
                              startEpisodeId: ep.id,
                            });
                          } catch (err) {
                            toast.error(String(err));
                          }
                        }}
                      >
                        <Play size={14} />
                      </Button>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          onClick={() => handleEpisodeTmdb(ep)}
                          disabled={!canSeasonTmdb || ep.episode_number == null || episodeTmdbLoading === ep.id}
                        >
                          <Film size={14} />
                          {episodeTmdbLoading === ep.id ? "Loading..." : "Fetch from TMDB"}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    {isExpanded && editingEpisodeId !== ep.id && (
                      <ContextMenu>
                        <ContextMenuTrigger render={<div className="ml-14 mb-1 flex flex-col gap-1 rounded-md border p-3 text-sm" />}>
                          {!epDetail && <Spinner className="h-4 w-4" />}
                          {epDetail && !hasDetail && (
                            <p className="text-muted-foreground">No metadata</p>
                          )}
                          {epDetail && hasDetail && (
                            <>
                              {epDetail.release_date && (
                                <div>
                                  <span className="text-muted-foreground">Air Date: </span>
                                  {formatReleaseDate(epDetail.release_date)}
                                </div>
                              )}
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
                              <TruncatedList label="Directors" items={epDetail.directors.map((d) => d.name)} />
                              <TruncatedList label="Composers" items={epDetail.composers.map((c) => c.name)} />
                            </>
                          )}
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onClick={() => startEditEpisode(ep)} disabled={!epDetail}>
                            <Pencil size={14} />
                            Edit
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => handleEpisodeTmdb(ep)}
                            disabled={!canSeasonTmdb || ep.episode_number == null || episodeTmdbLoading === ep.id}
                          >
                            <Film size={14} />
                            {episodeTmdbLoading === ep.id ? "Loading..." : "Fetch from TMDB"}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    )}
                    {isExpanded && editingEpisodeId === ep.id && (
                      <div className="ml-14 mb-1 flex flex-col gap-3 rounded-md border p-3 text-sm">
                        <EditField label="Air Date" value={episodeDraft.release_date ?? ""} onChange={(v) => setEpisodeDraft((p) => ({ ...p, release_date: v }))} />
                        <EditField label="Runtime (min)" value={episodeDraft.runtime != null ? String(episodeDraft.runtime) : ""} onChange={(v) => setEpisodeDraft((p) => ({ ...p, runtime: v ? Number(v) : undefined }))} />
                        <EditField label="Plot" value={episodeDraft.plot ?? ""} onChange={(v) => setEpisodeDraft((p) => ({ ...p, plot: v }))} multiline />
                        <PeopleListEdit label="Guest Stars" items={episodeDraft.cast ?? []} onChange={(items) => setEpisodeDraft((p) => ({ ...p, cast: items }))} secondaryField="role" secondaryLabel="Role" />
                        <EditField label="Director (comma-separated)" value={(episodeDraft.director ?? []).map((d) => d.name).join(", ")} onChange={(v) => setEpisodeDraft((p) => ({ ...p, director: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
                        <EditField label="Composer (comma-separated)" value={(episodeDraft.composer ?? []).map((c) => c.name).join(", ")} onChange={(v) => setEpisodeDraft((p) => ({ ...p, composer: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => setEditingEpisodeId(null)} disabled={episodeSaving}>Cancel</Button>
                          <Button size="sm" onClick={saveEpisode} disabled={episodeSaving}>{episodeSaving ? "Saving..." : "Save"}</Button>
                        </div>
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
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setTmdbDialogOpen(true)}>
            <Film size={14} />
            {detail?.tmdb_id ? "Rematch TMDB" : "Match TMDB"}
          </ContextMenuItem>
          <ContextMenuItem onClick={startEditShow} disabled={!detail}>
            <Pencil size={14} />
            Edit
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <TmdbShowMatchDialog
        open={tmdbDialogOpen}
        onOpenChange={setTmdbDialogOpen}
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

function PeopleListEdit<T extends CastUpdateInfo>({
  label,
  items,
  onChange,
  secondaryField,
  secondaryLabel,
}: {
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  secondaryField: "role";
  secondaryLabel: string;
}) {
  const update = (i: number, patch: Partial<T>) => {
    const next = items.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, { name: "", [secondaryField]: null, tmdb_id: null } as unknown as T]);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex flex-col gap-1">
        {items.map((item, i) => (
          <div key={i} className="flex gap-1">
            <input
              value={item.name}
              onChange={(e) => update(i, { name: e.target.value } as Partial<T>)}
              placeholder="Name"
              className="flex-1 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
            />
            <input
              value={(item as unknown as Record<string, string | null>)[secondaryField] ?? ""}
              onChange={(e) => update(i, { [secondaryField]: e.target.value || null } as unknown as Partial<T>)}
              placeholder={secondaryLabel}
              className="flex-1 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
            />
            <Button size="sm" variant="ghost" onClick={() => remove(i)}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={add} className="w-fit">
          + Add
        </Button>
      </div>
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

function PersonDetailHeader({
  name,
  imagePath,
  role,
  workCount,
}: {
  name: string;
  imagePath: string | null;
  role: PersonRole;
  workCount: number;
}) {
  const imageSrc = imagePath ? convertFileSrc(imagePath) : null;
  const roleLabel =
    role === "actor" ? "Actor"
    : role === "director_creator" ? "Director / Creator"
    : role === "composer" ? "Composer"
    : "Credits";
  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-4">
      <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
        {imageSrc ? (
          <img src={imageSrc} alt={name} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <UserIcon className="h-10 w-10 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-2xl font-bold">{name}</h1>
        <p className="text-sm text-muted-foreground">
          {roleLabel} · {workCount === 1 ? "1 work" : `${workCount} works`}
        </p>
      </div>
    </div>
  );
}
