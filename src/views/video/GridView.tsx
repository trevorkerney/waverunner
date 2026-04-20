import { useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  Search,
  ArrowUpDown,
  LibraryBig,
  FolderPlus,
  Trash2,
  RefreshCw,
  Save,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { SortPresetSaveDialog } from "@/components/SortPresetSaveDialog";
import { TmdbImageBrowserDialog } from "@/components/TmdbImageBrowserDialog";
import { AddToPlaylistDialog } from "@/components/AddToPlaylistDialog";
import { CreatePlaylistCollectionDialog } from "@/components/CreatePlaylistCollectionDialog";
import { RenameDialog } from "@/components/RenameDialog";
import { SortableCoverCard } from "@/components/cards/SortableCoverCard";
import { DragOverlayCard } from "@/components/cards/DragOverlayCard";
import { MoveUpDropZone } from "@/components/cards/MoveUpDropZone";
import { PersonDetailHeader } from "@/components/PersonDetailHeader";
import { CoverCarouselDialog } from "@/components/dialogs/CoverCarouselDialog";
import { NewCollectionDialog } from "@/components/dialogs/NewCollectionDialog";
import { DeleteEntryDialog } from "@/components/dialogs/DeleteEntryDialog";
import { MovieDetailPage } from "@/views/video/detail/MovieDetailPage";
import { ShowDetailPage } from "@/views/video/detail/ShowDetailPage";
import { useGridDnd, type GridDndAdapter } from "@/hooks/useGridDnd";
import { useSelectedLibrary } from "@/context/LibraryContext";
import { scopeKeyFor } from "@/lib/complications";
import type { BreadcrumbItem, MediaEntry, SortPreset, ViewSpec } from "@/types";

/** Stable, collision-free sortable id for a grid entry. Playlist links use their link_id
 *  (distinct across playlists), nested playlist_collections use `pc-<id>` so they don't
 *  collide with real media_entry ids. Everything else keeps its numeric media_entry id
 *  so existing library drag-and-drop and update_sort_order flows keep working. */
function sortableIdFor(entry: MediaEntry): string | number {
  if (entry.link_id != null) return `link-${entry.link_id}`;
  if (entry.entry_type === "playlist_collection") return `pc-${entry.id}`;
  return entry.id;
}

type GridViewKind =
  | "library-root"
  | "movies-only"
  | "shows-only"
  | "playlist-detail"
  | "person-detail";

export function GridView({
  view,
  breadcrumbBar,
  entries,
  searchResults,
  selectedEntry,
  loading,
  hasLibraries,
  coverSize,
  onCoverSizeChange,
  search,
  onSearchChange,
  sortMode,
  onSortModeChange,
  presets,
  selectedPresetId,
  onChangePreset,
  onSavePreset,
  onDeletePreset,
  onSortOrderChange,
  onNavigate,
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
  onPlaylistChanged,
  scrollContainerRef,
  onPlayFile,
  onPlayEpisode,
  breadcrumbs,
}: {
  view: Extract<ViewSpec, { kind: GridViewKind }>;
  breadcrumbBar: ReactNode;
  entries: MediaEntry[];
  searchResults: MediaEntry[] | null;
  selectedEntry: MediaEntry | null;
  loading: boolean;
  hasLibraries: boolean;
  coverSize: number;
  onCoverSizeChange: (size: number) => void;
  search: string;
  onSearchChange: (search: string) => void;
  sortMode: string;
  onSortModeChange: (mode: string) => void;
  presets: SortPreset[];
  selectedPresetId: number | null;
  onChangePreset: (presetId: number | null) => Promise<void> | void;
  onSavePreset: (name: string, overwrite: boolean) => Promise<void>;
  onDeletePreset: (presetId: number) => Promise<void> | void;
  onSortOrderChange: (reordered: MediaEntry[]) => void;
  onNavigate: (entry: MediaEntry) => void;
  onRenameEntry: (entryId: number, newTitle: string) => Promise<string | null>;
  onTitleChanged: (entryId: number, newTitle: string) => void;
  onSetCover: (
    entryId: number,
    coverPath: string | null,
    opts?: { linkId?: number | null; playlistCollection?: boolean },
  ) => void;
  onAddCover: (entryId: number, opts?: { playlistCollection?: boolean }) => Promise<void>;
  onDeleteCover: (
    entryId: number,
    coverPath: string,
    opts?: { playlistCollection?: boolean },
  ) => Promise<void>;
  onMoveEntry: (
    entryId: number,
    newParentId: number | null,
    insertBeforeId: number | null,
  ) => Promise<void>;
  onCreateCollection: (name: string, basePath?: string) => Promise<void>;
  onDeleteEntry: (entryId: number, deleteFromDisk: boolean) => Promise<void>;
  onRescan: () => void;
  onEntryChanged: () => void;
  onPlaylistChanged: (libraryId: string) => void;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onPlayFile?: (path: string, title: string) => void;
  onPlayEpisode?: (args: {
    libraryId: string;
    showId: number;
    showTitle: string;
    startEpisodeId: number;
  }) => void;
  breadcrumbs: BreadcrumbItem[];
}) {
  const selectedLibrary = useSelectedLibrary();

  // Shared dialog state — each of these dialogs is opened from at least two paths
  // (card context menu + detail-page context menu + background menu, etc).
  const [coverDialogEntry, setCoverDialogEntry] = useState<MediaEntry | null>(null);
  const [coverDialogMode, setCoverDialogMode] = useState<"select" | "delete">("select");
  const [tmdbImagesEntry, setTmdbImagesEntry] = useState<
    { entry: MediaEntry; tmdbId: string } | null
  >(null);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MediaEntry | null>(null);
  const [deleteFilesWarning, setDeleteFilesWarning] = useState<MediaEntry | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [addToPlaylistFor, setAddToPlaylistFor] = useState<MediaEntry | null>(null);
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [renameCollectionFor, setRenameCollectionFor] = useState<MediaEntry | null>(null);

  const openCoverDialog = useCallback((entry: MediaEntry, mode: "select" | "delete") => {
    setCoverDialogMode(mode);
    setCoverDialogEntry(entry);
  }, []);

  const openTmdbImages = useCallback(
    async (entry: MediaEntry) => {
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
    },
    [selectedLibrary],
  );

  // Keep cover-dialog entry in sync with live entries/selectedEntry so covers list
  // updates after a delete.
  const liveCoverDialogEntry = useMemo(() => {
    if (!coverDialogEntry) return null;
    if (selectedEntry?.id === coverDialogEntry.id) return selectedEntry;
    const found = entries.find((e) => e.id === coverDialogEntry.id);
    return found ?? coverDialogEntry;
  }, [coverDialogEntry, entries, selectedEntry]);

  const isSearching = searchResults != null;
  const filteredEntries = isSearching ? searchResults : entries;

  const handleDelete = useCallback(
    async (entryId: number, deleteFromDisk: boolean) => {
      setDeletingId(entryId);
      try {
        await onDeleteEntry(entryId, deleteFromDisk);
      } finally {
        setDeletingId(null);
      }
    },
    [onDeleteEntry],
  );

  const isPlaylist = view.kind === "playlist-detail";
  const isPerson = view.kind === "person-detail";

  // DnD adapter — library flow vs playlist flow differ only in id parsing + which
  // backend command fires. The shared hook owns sensor/collision/reorder plumbing.
  const adapter = useMemo<GridDndAdapter>(() => {
    if (isPlaylist && view.kind === "playlist-detail") {
      return {
        items: filteredEntries.map(sortableIdFor),
        sortMode,
        parseMoveIntoTarget: (overId) =>
          overId.startsWith("pc-drop-") ? Number(overId.slice("pc-drop-".length)) : null,
        onMoveInto: async (activeId, targetPcId) => {
          const activeEntry = filteredEntries.find((e) => sortableIdFor(e) === activeId);
          if (!activeEntry) return;
          if (
            activeEntry.entry_type === "playlist_collection" &&
            activeEntry.id === targetPcId
          )
            return;
          try {
            if (activeEntry.link_id != null) {
              await invoke("move_media_link", {
                linkId: activeEntry.link_id,
                parentPlaylistId: null,
                parentCollectionId: targetPcId,
              });
            } else if (activeEntry.entry_type === "playlist_collection") {
              await invoke("move_playlist_collection", {
                collectionId: activeEntry.id,
                parentPlaylistId: null,
                parentCollectionId: targetPcId,
              });
            } else {
              return;
            }
            if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
          } catch (e) {
            toast.error(String(e));
          }
        },
        onMoveUp: async (activeId) => {
          if (view.collectionId === null) return;
          const activeEntry = filteredEntries.find((e) => sortableIdFor(e) === activeId);
          if (!activeEntry) return;
          const parentCrumb = breadcrumbs[breadcrumbs.length - 2];
          const parentView = parentCrumb?.view;
          let parentPlaylistId: number | null = null;
          let parentCollectionId: number | null = null;
          if (parentView && parentView.kind === "playlist-detail") {
            if (parentView.collectionId === null) {
              parentPlaylistId = parentView.playlistId;
            } else {
              parentCollectionId = parentView.collectionId;
            }
          } else {
            parentPlaylistId = view.playlistId;
          }
          try {
            if (activeEntry.link_id != null) {
              await invoke("move_media_link", {
                linkId: activeEntry.link_id,
                parentPlaylistId,
                parentCollectionId,
              });
            } else if (activeEntry.entry_type === "playlist_collection") {
              await invoke("move_playlist_collection", {
                collectionId: activeEntry.id,
                parentPlaylistId,
                parentCollectionId,
              });
            } else {
              return;
            }
            if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
          } catch (e) {
            toast.error(String(e));
          }
        },
        onReorder: (oldIndex, newIndex) => {
          const reordered = [...filteredEntries];
          const [moved] = reordered.splice(oldIndex, 1);
          reordered.splice(newIndex, 0, moved);
          onSortOrderChange(reordered);
        },
      };
    }
    // Library adapter — also used for person-detail (readOnly grid, reorder disabled
    // via sortMode; adapter outcomes simply never fire meaningfully there).
    return {
      items: filteredEntries.map(sortableIdFor),
      sortMode,
      parseMoveIntoTarget: (overId) =>
        overId.startsWith("collection-") ? Number(overId.slice("collection-".length)) : null,
      onMoveInto: async (activeId, targetId) => {
        const entryId = Number(activeId);
        if (targetId === entryId) return;
        await onMoveEntry(entryId, targetId, null);
      },
      onMoveUp: async (activeId) => {
        const entryId = Number(activeId);
        const currentParentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        const grandparentId =
          breadcrumbs.length >= 3 ? breadcrumbs[breadcrumbs.length - 2].id : null;
        await onMoveEntry(entryId, grandparentId, currentParentId);
      },
      onReorder: (oldIndex, newIndex) => {
        const reordered = [...filteredEntries];
        const [moved] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, moved);
        onSortOrderChange(reordered);
      },
    };
  }, [
    isPlaylist,
    view,
    filteredEntries,
    sortMode,
    breadcrumbs,
    onMoveEntry,
    onSortOrderChange,
    selectedLibrary,
    onPlaylistChanged,
  ]);

  const { sensors, dragId, handleDragStart, handleDragEnd, collisionDetection, onDragCancel } =
    useGridDnd(adapter);

  const dragEntry =
    dragId != null ? filteredEntries.find((e) => sortableIdFor(e) === dragId) ?? null : null;

  // Show the move-up droppable whenever dragging up one level is meaningful.
  // Library-root nests via collection breadcrumbs (breadcrumbs.length > 1).
  // Playlist-detail is "inside" only when pointing at a nested playlist_collection.
  const isInsideCollection = isPlaylist
    ? view.kind === "playlist-detail" && view.collectionId !== null
    : breadcrumbs.length > 1;

  const renderSortableGrid = (readOnly: boolean) => (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={onDragCancel}
    >
      {!readOnly && isInsideCollection && <MoveUpDropZone isActive={dragId != null} />}
      <SortableContext
        items={filteredEntries.map(sortableIdFor)}
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
              key={sortableIdFor(entry)}
              sortableId={sortableIdFor(entry)}
              entry={entry}
              size={coverSize}
              onNavigate={onNavigate}
              onRename={onRenameEntry}
              onChangeCover={() => openCoverDialog(entry, "select")}
              onAddCover={() =>
                onAddCover(entry.id, {
                  playlistCollection: entry.entry_type === "playlist_collection",
                })
              }
              onAddCoverFromTmdb={() => openTmdbImages(entry)}
              onDeleteCover={() => openCoverDialog(entry, "delete")}
              onDelete={async (entry) => {
                if (readOnly) return;
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
              isDragActive={dragId != null}
              sortMode={sortMode}
              onAddToPlaylist={selectedLibrary ? (e) => setAddToPlaylistFor(e) : undefined}
              onRemoveLink={
                isPlaylist
                  ? async (linkId) => {
                      try {
                        await invoke("remove_media_link", { linkId });
                        if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
                      } catch (err) {
                        toast.error(String(err));
                      }
                    }
                  : undefined
              }
              onRenamePlaylistCollection={
                isPlaylist ? (e) => setRenameCollectionFor(e) : undefined
              }
              onDeletePlaylistCollection={
                isPlaylist
                  ? async (e) => {
                      if (
                        !window.confirm(
                          `Delete collection "${e.title}"? Its links and nested collections will be removed from the playlist.`,
                        )
                      )
                        return;
                      try {
                        await invoke("delete_playlist_collection", { collectionId: e.id });
                        if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
                      } catch (err) {
                        toast.error(String(err));
                      }
                    }
                  : undefined
              }
              readOnly={readOnly}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {dragEntry && <DragOverlayCard entry={dragEntry} size={coverSize} />}
      </DragOverlay>
    </DndContext>
  );

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {selectedLibrary && (
        <>
          {breadcrumbBar}

          {isPerson && !selectedEntry && view.kind === "person-detail" && (
            <PersonDetailHeader
              name={view.personName}
              imagePath={view.personImage}
              role={view.role}
              workCount={entries.length}
            />
          )}

          {!selectedEntry && (
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
              <div className="flex items-center gap-1.5">
                <DropdownMenu>
                  <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                    <ArrowUpDown size={12} />
                    {(() => {
                      if (selectedPresetId != null) {
                        const p = presets.find((p) => p.id === selectedPresetId);
                        if (p) return p.name;
                      }
                      return sortMode === "alpha"
                        ? "A\u2013Z"
                        : sortMode === "date" || sortMode === "year"
                          ? "Date"
                          : "Custom";
                    })()}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onSortModeChange("alpha")}>
                      Alphabetical
                    </DropdownMenuItem>
                    {!isPlaylist && (
                      <DropdownMenuItem onClick={() => onSortModeChange("date")}>
                        Date
                      </DropdownMenuItem>
                    )}
                    {!isPerson && (
                      <DropdownMenuItem
                        onClick={() => {
                          onSortModeChange("custom");
                          onChangePreset(null);
                        }}
                      >
                        Custom
                      </DropdownMenuItem>
                    )}
                    {presets.length > 0 && <DropdownMenuSeparator />}
                    {presets.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onClick={() => onChangePreset(p.id)}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{p.name}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Delete preset "${p.name}"?`)) {
                              onDeletePreset(p.id);
                            }
                          }}
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Delete preset ${p.name}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {sortMode === "custom" &&
                  selectedPresetId === null &&
                  scopeKeyFor(view, breadcrumbs[breadcrumbs.length - 1]?.id ?? null) != null &&
                  filteredEntries.length > 0 && (
                    <button
                      onClick={() => setSavePresetOpen(true)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      title="Save current order as a preset"
                    >
                      <Save size={14} />
                    </button>
                  )}
              </div>
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
          )}
        </>
      )}

      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden p-4"
      >
        {selectedEntry ? (
          selectedEntry.entry_type === "show" ? (
            <ShowDetailPage
              entry={selectedEntry}
              onEntryChanged={onEntryChanged}
              onTitleChanged={onTitleChanged}
              onChangeCover={() => openCoverDialog(selectedEntry, "select")}
              onAddCover={() => onAddCover(selectedEntry.id)}
              onDeleteCover={() => openCoverDialog(selectedEntry, "delete")}
              onPlayEpisode={onPlayEpisode}
            />
          ) : (
            <MovieDetailPage
              entry={selectedEntry}
              onEntryChanged={onEntryChanged}
              onTitleChanged={onTitleChanged}
              onChangeCover={() => openCoverDialog(selectedEntry, "select")}
              onAddCover={() => onAddCover(selectedEntry.id)}
              onDeleteCover={() => openCoverDialog(selectedEntry, "delete")}
              onPlayFile={onPlayFile}
            />
          )
        ) : isPerson ? (
          <div
            className="flex min-h-full flex-col"
            onContextMenu={(e) => e.preventDefault()}
          >
            {!selectedLibrary ? null : loading ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner className="size-6" />
              </div>
            ) : filteredEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {search ? "No results" : "Empty"}
              </p>
            ) : (
              renderSortableGrid(true)
            )}
          </div>
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
                        <EmptyDescription>
                          Select a library from the sidebar to get started.
                        </EmptyDescription>
                      </>
                    ) : (
                      <>
                        <EmptyTitle>No libraries yet</EmptyTitle>
                        <EmptyDescription>
                          Create a library from the sidebar to start organizing your media.
                        </EmptyDescription>
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
                renderSortableGrid(false)
              )}
            </ContextMenuTrigger>
            <ContextMenuContent>
              {isPlaylist && (
                <ContextMenuItem onClick={() => setCreateCollectionOpen(true)}>
                  <FolderPlus size={14} />
                  Create collection here
                </ContextMenuItem>
              )}
              {view.kind === "library-root" && selectedLibrary?.format === "video" && (
                <ContextMenuItem onClick={() => setNewCollectionOpen(true)}>
                  <FolderPlus size={14} />
                  New Collection
                </ContextMenuItem>
              )}
              {!isPlaylist && (
                <ContextMenuItem
                  onClick={async () => {
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
                  }}
                >
                  <RefreshCw size={14} />
                  Rescan
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>

      <NewCollectionDialog
        open={newCollectionOpen}
        onOpenChange={setNewCollectionOpen}
        selectedLibrary={selectedLibrary}
        breadcrumbs={breadcrumbs}
        onCreate={onCreateCollection}
      />

      <DeleteEntryDialog
        target={deleteTarget}
        onTargetChange={setDeleteTarget}
        filesWarning={deleteFilesWarning}
        onFilesWarningChange={setDeleteFilesWarning}
        selectedLibrary={selectedLibrary}
        onConfirm={handleDelete}
      />

      <SortPresetSaveDialog
        open={savePresetOpen}
        onOpenChange={setSavePresetOpen}
        onSave={onSavePreset}
      />

      {liveCoverDialogEntry && (
        <CoverCarouselDialog
          entry={liveCoverDialogEntry}
          mode={coverDialogMode}
          open={!!coverDialogEntry}
          onOpenChange={(open) => {
            if (!open) setCoverDialogEntry(null);
          }}
          onSelect={(coverPath) => {
            onSetCover(liveCoverDialogEntry.id, coverPath, {
              linkId: liveCoverDialogEntry.link_id,
              playlistCollection:
                liveCoverDialogEntry.entry_type === "playlist_collection",
            });
            setCoverDialogEntry(null);
          }}
          onDelete={async (coverPath) => {
            const wasLast = liveCoverDialogEntry.covers.length <= 1;
            await onDeleteCover(liveCoverDialogEntry.id, coverPath, {
              playlistCollection:
                liveCoverDialogEntry.entry_type === "playlist_collection",
            });
            if (wasLast) setCoverDialogEntry(null);
          }}
        />
      )}

      {tmdbImagesEntry && selectedLibrary && (
        <TmdbImageBrowserDialog
          open={!!tmdbImagesEntry}
          onOpenChange={(open) => {
            if (!open) setTmdbImagesEntry(null);
          }}
          libraryId={selectedLibrary.id}
          entryId={tmdbImagesEntry.entry.id}
          tmdbId={tmdbImagesEntry.tmdbId}
          onDownloaded={() => {
            onEntryChanged();
          }}
        />
      )}

      <AddToPlaylistDialog
        open={addToPlaylistFor !== null}
        onOpenChange={(o) => {
          if (!o) setAddToPlaylistFor(null);
        }}
        libraryId={selectedLibrary?.id ?? null}
        entryId={addToPlaylistFor?.id ?? null}
        entryTitle={addToPlaylistFor?.title ?? null}
        onAdded={() => {
          if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
        }}
      />

      <CreatePlaylistCollectionDialog
        open={createCollectionOpen}
        onOpenChange={setCreateCollectionOpen}
        parentPlaylistId={
          isPlaylist && view.kind === "playlist-detail" && view.collectionId === null
            ? view.playlistId
            : null
        }
        parentCollectionId={
          isPlaylist && view.kind === "playlist-detail" ? view.collectionId : null
        }
        onCreated={() => {
          if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
        }}
      />

      <RenameDialog
        open={renameCollectionFor !== null}
        onOpenChange={(o) => {
          if (!o) setRenameCollectionFor(null);
        }}
        title="Rename collection"
        initialValue={renameCollectionFor?.title ?? ""}
        onSubmit={async (newName) => {
          if (!renameCollectionFor) return;
          try {
            await invoke("rename_playlist_collection", {
              collectionId: renameCollectionFor.id,
              newTitle: newName,
            });
            if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
          } catch (e) {
            toast.error(String(e));
          }
        }}
      />
    </main>
  );
}
