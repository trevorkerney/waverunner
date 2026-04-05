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
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import { Input } from "@/components/ui/input";
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
  Search,
  Folder,
  ArrowUpDown,
  GripVertical,
  Pencil,
  Image as ImageIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Library, MediaEntry, BreadcrumbItem, MovieDetail, MovieDetailUpdate } from "@/types";

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
  sortMode: string;
  onSortModeChange: (mode: string) => void;
  onSortOrderChange: (reordered: MediaEntry[]) => void;
  onRenameEntry: (entryId: number, newTitle: string) => Promise<string | null>;
  onSetCover: (entryId: number, coverPath: string | null) => void;
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
  sortMode,
  onSortModeChange,
  onSortOrderChange,
  onRenameEntry,
  onSetCover,
  getCoverUrl,
  getFullCoverUrl,
  scrollContainerRef,
}: MainContentProps) {
  const [reordering, setReordering] = useState(false);
  const [coverDialogEntry, setCoverDialogEntry] = useState<MediaEntry | null>(
    null
  );
  const isSearching = searchResults != null;
  const filteredEntries = isSearching ? searchResults : entries;

  const changeSortMode = useCallback(
    (mode: string) => {
      setReordering(false);
      onSortModeChange(mode);
    },
    [onSortModeChange]
  );

  const [activeDragId, setActiveDragId] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as number);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = filteredEntries.findIndex((e) => e.id === active.id);
      const newIndex = filteredEntries.findIndex((e) => e.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = [...filteredEntries];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      onSortOrderChange(reordered);
    },
    [filteredEntries, onSortOrderChange]
  );

  const activeDragEntry = activeDragId != null
    ? filteredEntries.find((e) => e.id === activeDragId) ?? null
    : null;

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {selectedLibrary && (
        <>
          {/* Breadcrumbs */}
          <Breadcrumb className="border-b border-border px-4 py-2">
            <BreadcrumbList>
              {breadcrumbs.map((crumb, i) => (
                <BreadcrumbUIItem key={i}>
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
                <DropdownMenuItem onClick={() => changeSortMode("alpha")}>
                  Alphabetical
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => changeSortMode("year")}>
                  Year
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => changeSortMode("custom")}>
                  Custom
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {sortMode === "custom" && (
              <button
                onClick={() => setReordering((r) => !r)}
                className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs ${
                  reordering
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                <GripVertical size={12} />
                {reordering ? "Done" : "Reorder"}
              </button>
            )}
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
            ? <ShowDetailPage entry={selectedEntry} selectedLibrary={selectedLibrary!} getFullCoverUrl={getFullCoverUrl} />
            : <EntryDetailPage entry={selectedEntry} selectedLibrary={selectedLibrary!} getFullCoverUrl={getFullCoverUrl} />
        ) : !selectedLibrary ? (
          <div />
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : filteredEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {search ? "No results" : "Empty"}
          </p>
        ) : reordering ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToParentElement]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveDragId(null)}
          >
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
                    getCoverUrl={getCoverUrl}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeDragEntry && (
                <DragOverlayCard entry={activeDragEntry} size={coverSize} getCoverUrl={getCoverUrl} />
              )}
            </DragOverlay>
          </DndContext>
        ) : (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))`,
              alignItems: "center",
              justifyItems: "center",
            }}
          >
            {filteredEntries.map((entry) => (
              <CoverCard
                key={entry.id}
                entry={entry}
                size={coverSize}
                onNavigate={onNavigate}
                onRename={onRenameEntry}
                onChangeCover={() => setCoverDialogEntry(entry)}
                getCoverUrl={getCoverUrl}
              />
            ))}
          </div>
        )}
      </div>

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

function CoverCard({
  entry,
  size,
  onNavigate,
  onRename,
  onChangeCover,
  getCoverUrl,
}: {
  entry: MediaEntry;
  size: number;
  onNavigate: (entry: MediaEntry) => void;
  onRename: (entryId: number, newTitle: string) => Promise<string | null>;
  onChangeCover: () => void;
  getCoverUrl: (filePath: string) => string;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameValue, setRenameValue] = useState("");
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
          <button
            onClick={() =>
              !isRenaming && onNavigate(entry)
            }
          />
        }
        className="group flex flex-col items-center gap-2 rounded-md p-2 text-left hover:bg-accent"
        style={{ maxWidth: size }}
      >
        <div
          className="relative overflow-hidden rounded-md bg-muted"
        >
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={entry.title}
              className="w-full"
              style={{ maxHeight: size * 2 }}
            />
          ) : (
            <div
              className="flex items-center justify-center"
              style={{ height: size * 1.5 }}
            >
              <Folder
                size={size * 0.3}
                className="text-muted-foreground/30"
              />
            </div>
          )}
          {entry.entry_type === "collection" && (
            <div className="absolute bottom-1 right-1 rounded-sm bg-black/60 px-1.5 py-0.5 text-xs text-white">
              Collection
            </div>
          )}
        </div>
        <div className="w-full">
          {renameLoading ? (
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
              {entry.year && (
                <p className="text-xs text-muted-foreground">{entry.year}</p>
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
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SortableCoverCard({
  entry,
  size,
  getCoverUrl,
}: {
  entry: MediaEntry;
  size: number;
  getCoverUrl: (filePath: string) => string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getCoverUrl(coverPath) : null;

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, maxWidth: size }}
      {...attributes}
      {...listeners}
      className="group flex cursor-grab flex-col items-center gap-2 rounded-md p-2 text-left hover:bg-accent active:cursor-grabbing"
    >
      <div
        className="relative overflow-hidden rounded-md bg-muted"
      >
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
            style={{ height: size * 1.5 }}
          >
            <Folder
              size={size * 0.3}
              className="text-muted-foreground/30"
            />
          </div>
        )}
        <div className="absolute top-1 left-1 rounded-sm bg-black/60 p-1 text-white">
          <GripVertical size={14} />
        </div>
      </div>
      <div className="w-full">
        <p className="text-sm font-medium">{entry.title}</p>
        {entry.year && (
          <p className="text-xs text-muted-foreground">{entry.year}</p>
        )}
      </div>
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
      <div className="relative overflow-hidden rounded-md bg-muted">
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
            <Folder
              size={size * 0.3}
              className="text-muted-foreground/30"
            />
          </div>
        )}
        <div className="absolute top-1 left-1 rounded-sm bg-black/60 p-1 text-white">
          <GripVertical size={14} />
        </div>
      </div>
      <div className="w-full" style={{ maxWidth: size }}>
        <p className="text-sm font-medium">{entry.title}</p>
        {entry.year && (
          <p className="text-xs text-muted-foreground">{entry.year}</p>
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
}: {
  entry: MediaEntry;
  selectedLibrary: Library;
  getFullCoverUrl: (filePath: string) => string;
}) {
  const [detail, setDetail] = useState<MovieDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MovieDetailUpdate>({});
  const [saving, setSaving] = useState(false);

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
      year: entry.year ?? "",
      tmdb_id: detail?.tmdb_id ?? null,
      imdb_id: detail?.imdb_id ?? null,
      rotten_tomatoes_id: detail?.rotten_tomatoes_id ?? null,
      plot: detail?.plot ?? null,
      tagline: detail?.tagline ?? null,
      runtime: detail?.runtime ?? null,
      maturity_rating: detail?.maturity_rating ?? null,
      genres: detail?.genres ?? [],
      directors: detail?.directors.map((d: { name: string }) => d.name) ?? [],
      cast: detail?.cast.map((c: { name: string; role: string | null }) => ({ name: c.name, role: c.role })) ?? [],
      crew: detail?.crew.map((c: { name: string; job: string | null }) => ({ name: c.name, job: c.job })) ?? [],
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
                  value={draft.year ?? ""}
                  onChange={(e) => updateDraft("year", e.target.value)}
                  placeholder="Year"
                  className="w-24 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
                />
              </div>
            ) : (
              <>
                <h1 className="text-3xl font-bold">{entry.title}</h1>
                {entry.year && (
                  <p className="text-lg text-muted-foreground">
                    {entry.year}{entry.end_year ? `–${entry.end_year}` : ""}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="flex gap-2">
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
              <Button size="sm" variant="outline" onClick={startEditing}>
                <Pencil size={14} />
                Edit
              </Button>
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
    </div>
  );
}

function ShowDetailPage({
  entry,
  selectedLibrary: _selectedLibrary,
  getFullCoverUrl,
}: {
  entry: MediaEntry;
  selectedLibrary: Library;
  getFullCoverUrl: (filePath: string) => string;
}) {
  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getFullCoverUrl(coverPath) : null;

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
        <div>
          <h1 className="text-3xl font-bold">{entry.title}</h1>
          {entry.year && (
            <p className="text-lg text-muted-foreground">
              {entry.year}{entry.end_year ? `–${entry.end_year}` : ""}
            </p>
          )}
        </div>
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
