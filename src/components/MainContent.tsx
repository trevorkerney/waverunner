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
import { toast } from "sonner";
import { Library, MediaEntry, BreadcrumbItem } from "@/types";

function getDisplayCover(entry: MediaEntry): string | null {
  if (entry.selected_cover && entry.covers.includes(entry.selected_cover)) {
    return entry.selected_cover;
  }
  return entry.covers[0] || null;
}

interface MainContentProps {
  entries: MediaEntry[];
  searchResults: MediaEntry[] | null;
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
          <div className="flex items-center gap-3 border-b border-border px-4 py-2">
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
          </div>
        </>
      )}

      {/* Content Grid */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4">
        {!selectedLibrary ? (
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
              !isRenaming && entry.entry_type === "collection" && onNavigate(entry)
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
