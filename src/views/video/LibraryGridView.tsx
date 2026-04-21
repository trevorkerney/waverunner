import { useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { LibraryBig, FolderPlus, RefreshCw } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { SortPresetSaveDialog } from "@/components/SortPresetSaveDialog";
import { TmdbImageBrowserDialog } from "@/components/TmdbImageBrowserDialog";
import { AddToPlaylistDialog } from "@/components/AddToPlaylistDialog";
import { SortableCoverCard } from "@/components/cards/SortableCoverCard";
import { DragOverlayCard } from "@/components/cards/DragOverlayCard";
import { CoverCarouselDialog } from "@/components/dialogs/CoverCarouselDialog";
import { NewCollectionDialog } from "@/components/dialogs/NewCollectionDialog";
import { DeleteEntryDialog } from "@/components/dialogs/DeleteEntryDialog";
import { MovieDetailPage } from "@/views/video/detail/MovieDetailPage";
import { ShowDetailPage } from "@/views/video/detail/ShowDetailPage";
import { GridToolbar } from "@/views/video/parts/GridToolbar";
import { GridSearchInput } from "@/views/video/parts/GridSearchInput";
import { SortDropdown, type SortOption } from "@/views/video/parts/SortDropdown";
import { SavePresetButton } from "@/views/video/parts/SavePresetButton";
import { CoverSizeSlider } from "@/views/video/parts/CoverSizeSlider";
import { SortableCoverGrid } from "@/views/video/parts/SortableCoverGrid";
import type { GridDndAdapter } from "@/hooks/useGridDnd";
import { useSelectedLibrary } from "@/context/LibraryContext";
import { scopeKeyFor, sortableIdFor } from "@/lib/utils";
import type {
  BreadcrumbItem,
  MediaEntry,
  SortPreset,
  ViewSpec,
} from "@/types";

export function LibraryGridView({
  view,
  breadcrumbBar,
  breadcrumbs,
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
}: {
  view: Extract<ViewSpec, { kind: "library-root" | "movies-only" | "shows-only" }>;
  breadcrumbBar: ReactNode;
  breadcrumbs: BreadcrumbItem[];
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
}) {
  const selectedLibrary = useSelectedLibrary();

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

  const openCoverDialog = useCallback((entry: MediaEntry, mode: "select" | "delete") => {
    setCoverDialogMode(mode);
    setCoverDialogEntry(entry);
  }, []);

  const openTmdbImages = useCallback(
    async (entry: MediaEntry) => {
      if (!selectedLibrary) return;
      try {
        const cmd = entry.entry_type === "show" ? "get_show_detail" : "get_movie_detail";
        const detail = await invoke<{ tmdb_id: string | null }>(cmd, { entryId: entry.id });
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

  // Library DnD adapter — `collection-N` drop targets, entry-id move-up/reorder flow.
  const adapter = useMemo<GridDndAdapter>(
    () => ({
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
    }),
    [filteredEntries, sortMode, breadcrumbs, onMoveEntry, onSortOrderChange],
  );

  // Build sort dropdown options inline so conditionals live here, not inside the dropdown.
  const sortOptions: SortOption[] = [
    { id: "alpha", label: "Alphabetical", onClick: () => onSortModeChange("alpha") },
    { id: "date", label: "Date", onClick: () => onSortModeChange("date") },
    {
      id: "custom",
      label: "Custom",
      onClick: () => {
        onSortModeChange("custom");
        onChangePreset(null);
      },
    },
    ...presets.map(
      (p): SortOption => ({
        id: `preset-${p.id}`,
        label: p.name,
        onClick: () => onChangePreset(p.id),
        onDelete: () => {
          if (window.confirm(`Delete preset "${p.name}"?`)) onDeletePreset(p.id);
        },
      }),
    ),
  ];
  const separatorBeforeIndex = presets.length > 0 ? 3 : undefined;

  const triggerLabel = (() => {
    if (selectedPresetId != null) {
      const p = presets.find((p) => p.id === selectedPresetId);
      if (p) return p.name;
    }
    return sortMode === "alpha"
      ? "A\u2013Z"
      : sortMode === "date" || sortMode === "year"
        ? "Date"
        : "Custom";
  })();

  const scopeKey = scopeKeyFor(view, breadcrumbs[breadcrumbs.length - 1]?.id ?? null);
  const savePresetVisible =
    sortMode === "custom" &&
    selectedPresetId === null &&
    scopeKey != null &&
    filteredEntries.length > 0;

  // Move-up zone shows when drilled into a collection (breadcrumbs > 1).
  const isInsideCollection = breadcrumbs.length > 1;

  const renderCard = (entry: MediaEntry, dragActive: boolean) => (
    <SortableCoverCard
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
      isDragActive={dragActive}
      sortMode={sortMode}
      onAddToPlaylist={selectedLibrary ? (e) => setAddToPlaylistFor(e) : undefined}
    />
  );

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {selectedLibrary && (
        <>
          {breadcrumbBar}

          {!selectedEntry && (
            <GridToolbar>
              <GridSearchInput value={search} onChange={onSearchChange} />
              <div className="flex items-center gap-1.5">
                <SortDropdown
                  triggerLabel={triggerLabel}
                  options={sortOptions}
                  separatorBeforeIndex={separatorBeforeIndex}
                />
                {savePresetVisible && (
                  <SavePresetButton onClick={() => setSavePresetOpen(true)} />
                )}
              </div>
              <CoverSizeSlider value={coverSize} onChange={onCoverSizeChange} />
            </GridToolbar>
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
                <SortableCoverGrid
                  items={filteredEntries}
                  coverSize={coverSize}
                  adapter={adapter}
                  sortableIdFor={sortableIdFor}
                  renderCard={renderCard}
                  renderDragOverlay={(entry) => (
                    <DragOverlayCard entry={entry} size={coverSize} />
                  )}
                  moveUpEnabled={isInsideCollection}
                />
              )}
            </ContextMenuTrigger>
            <ContextMenuContent>
              {view.kind === "library-root" && selectedLibrary?.format === "video" && (
                <ContextMenuItem onClick={() => setNewCollectionOpen(true)}>
                  <FolderPlus size={14} />
                  New Collection
                </ContextMenuItem>
              )}
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
              playlistCollection: liveCoverDialogEntry.entry_type === "playlist_collection",
            });
            setCoverDialogEntry(null);
          }}
          onDelete={async (coverPath) => {
            const wasLast = liveCoverDialogEntry.covers.length <= 1;
            await onDeleteCover(liveCoverDialogEntry.id, coverPath, {
              playlistCollection: liveCoverDialogEntry.entry_type === "playlist_collection",
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
          onDownloaded={() => onEntryChanged()}
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
    </main>
  );
}
