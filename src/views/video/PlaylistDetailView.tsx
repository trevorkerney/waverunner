import { useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { FolderPlus } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
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
import { CoverCarouselDialog } from "@/components/dialogs/CoverCarouselDialog";
import { DeleteEntryDialog } from "@/components/dialogs/DeleteEntryDialog";
import { MovieDetailPage } from "@/views/video/detail/MovieDetailPage";
import { ShowDetailPage } from "@/views/video/detail/ShowDetailPage";
import { GridToolbar } from "@/views/video/parts/GridToolbar";
import { GridSearchInput } from "@/views/video/parts/GridSearchInput";
import { SortDropdown, type SortOption } from "@/views/video/parts/SortDropdown";
import { SavePresetButton } from "@/views/video/parts/SavePresetButton";
import { CoverSizeSlider } from "@/views/video/parts/CoverSizeSlider";
import { SortableCoverGrid } from "@/views/video/parts/SortableCoverGrid";
import { useSelectedLibrary } from "@/context/LibraryContext";
import { scopeKeyFor, sortableIdFor } from "@/lib/complications";
import type { GridDndAdapter } from "@/hooks/useGridDnd";
import type {
  BreadcrumbItem,
  MediaEntry,
  SortPreset,
  ViewSpec,
} from "@/types";

export function PlaylistDetailView({
  view,
  breadcrumbBar,
  breadcrumbs,
  entries,
  searchResults,
  selectedEntry,
  loading,
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
  onDeleteEntry,
  onEntryChanged,
  onPlaylistChanged,
  scrollContainerRef,
  onPlayFile,
  onPlayEpisode,
}: {
  view: Extract<ViewSpec, { kind: "playlist-detail" }>;
  breadcrumbBar: ReactNode;
  breadcrumbs: BreadcrumbItem[];
  entries: MediaEntry[];
  searchResults: MediaEntry[] | null;
  selectedEntry: MediaEntry | null;
  loading: boolean;
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
  onDeleteEntry: (entryId: number, deleteFromDisk: boolean) => Promise<void>;
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

  // Playlist DnD adapter — `pc-drop-N` drop targets, routes to move_media_link or
  // move_playlist_collection depending on the active entry kind. onMoveUp walks breadcrumbs
  // to resolve the parent playlist_collection (or falls back to the root playlist).
  const adapter = useMemo<GridDndAdapter>(
    () => ({
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
          if (parentView.collectionId === null) parentPlaylistId = parentView.playlistId;
          else parentCollectionId = parentView.collectionId;
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
    }),
    [
      filteredEntries,
      sortMode,
      breadcrumbs,
      view,
      onSortOrderChange,
      selectedLibrary,
      onPlaylistChanged,
    ],
  );

  // Playlist: no Date option (playlists have no uniform release-date semantics — user
  // uses Custom for chronological ordering).
  const sortOptions: SortOption[] = [
    { id: "alpha", label: "Alphabetical", onClick: () => onSortModeChange("alpha") },
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
  const separatorBeforeIndex = presets.length > 0 ? 2 : undefined;

  const triggerLabel = (() => {
    if (selectedPresetId != null) {
      const p = presets.find((p) => p.id === selectedPresetId);
      if (p) return p.name;
    }
    return sortMode === "alpha" ? "A\u2013Z" : "Custom";
  })();

  const scopeKey = scopeKeyFor(view, breadcrumbs[breadcrumbs.length - 1]?.id ?? null);
  const savePresetVisible =
    sortMode === "custom" &&
    selectedPresetId === null &&
    scopeKey != null &&
    filteredEntries.length > 0;

  // Inside a nested playlist_collection — move-up zone is meaningful.
  const isInsideCollection = view.collectionId !== null;

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
      onRemoveLink={async (linkId) => {
        try {
          await invoke("remove_media_link", { linkId });
          if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
        } catch (err) {
          toast.error(String(err));
        }
      }}
      onRenamePlaylistCollection={(e) => setRenameCollectionFor(e)}
      onDeletePlaylistCollection={async (e) => {
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
      }}
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
              {!selectedLibrary ? null : loading ? (
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
              <ContextMenuItem onClick={() => setCreateCollectionOpen(true)}>
                <FolderPlus size={14} />
                Create collection here
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>

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

      <CreatePlaylistCollectionDialog
        open={createCollectionOpen}
        onOpenChange={setCreateCollectionOpen}
        parentPlaylistId={view.collectionId === null ? view.playlistId : null}
        parentCollectionId={view.collectionId}
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
