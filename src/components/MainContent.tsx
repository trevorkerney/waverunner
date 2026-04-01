import { useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import { Search, Folder, ArrowUpDown, GripVertical } from "lucide-react";
import { Library, MediaEntry, BreadcrumbItem } from "@/types";

interface MainContentProps {
  entries: MediaEntry[];
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
}

export function MainContent({
  entries,
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
}: MainContentProps) {
  const [reordering, setReordering] = useState(false);
  const filteredEntries = search
    ? entries.filter((e) =>
        e.title.toLowerCase().includes(search.toLowerCase())
      )
    : entries;

  const changeSortMode = useCallback(
    (mode: string) => {
      setReordering(false);
      onSortModeChange(mode);
    },
    [onSortModeChange]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
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
                {sortMode === "alpha" ? "A–Z" : sortMode === "year" ? "Year" : "Custom"}
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
                onValueChange={(v) => onCoverSizeChange(Array.isArray(v) ? v[0] : v)}
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
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4">
        {!selectedLibrary ? (
          <div />
        ) : filteredEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {search ? "No results" : "Empty"}
          </p>
        ) : reordering ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={filteredEntries.map((e) => e.id)}
              strategy={rectSortingStrategy}
            >
              <div
                className="grid gap-4"
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))`,
                }}
              >
                {filteredEntries.map((entry) => (
                  <SortableCoverCard
                    key={entry.id}
                    entry={entry}
                    size={coverSize}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))`,
            }}
          >
            {filteredEntries.map((entry) => (
              <CoverCard
                key={entry.id}
                entry={entry}
                size={coverSize}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function CoverCard({
  entry,
  size,
  onNavigate,
}: {
  entry: MediaEntry;
  size: number;
  onNavigate: (entry: MediaEntry) => void;
}) {
  const coverPath = entry.covers[0];
  const coverSrc = coverPath ? convertFileSrc(coverPath) : null;

  return (
    <button
      onClick={() => {
        if (entry.is_collection) {
          onNavigate(entry);
        }
      }}
      className="group flex flex-col items-center gap-2 rounded-md p-2 text-left hover:bg-accent"
    >
      <div
        className="relative flex items-center justify-center overflow-hidden rounded-md bg-muted"
        style={{ width: size, height: size * 1.5 }}
      >
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={entry.title}
            className="h-full w-full object-cover"
          />
        ) : (
          <Folder
            size={size * 0.3}
            className="text-muted-foreground/30"
          />
        )}
        {entry.is_collection && (
          <div className="absolute bottom-1 right-1 rounded-sm bg-black/60 px-1.5 py-0.5 text-xs text-white">
            Collection
          </div>
        )}
      </div>
      <div className="w-full" style={{ maxWidth: size }}>
        <p className="text-sm font-medium">{entry.title}</p>
        {entry.year && (
          <p className="text-xs text-muted-foreground">{entry.year}</p>
        )}
      </div>
    </button>
  );
}

function SortableCoverCard({
  entry,
  size,
}: {
  entry: MediaEntry;
  size: number;
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
    opacity: isDragging ? 0.5 : 1,
  };

  const coverPath = entry.covers[0];
  const coverSrc = coverPath ? convertFileSrc(coverPath) : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="group flex cursor-grab flex-col items-center gap-2 rounded-md p-2 text-left hover:bg-accent active:cursor-grabbing"
    >
      <div
        className="relative flex items-center justify-center overflow-hidden rounded-md bg-muted"
        style={{ width: size, height: size * 1.5 }}
      >
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={entry.title}
            className="pointer-events-none h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <Folder
            size={size * 0.3}
            className="text-muted-foreground/30"
          />
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
