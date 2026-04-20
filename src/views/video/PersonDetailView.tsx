import { useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { PersonDetailHeader } from "@/components/PersonDetailHeader";
import { SortableCoverCard } from "@/components/cards/SortableCoverCard";
import { CoverCarouselDialog } from "@/components/dialogs/CoverCarouselDialog";
import { AddToPlaylistDialog } from "@/components/AddToPlaylistDialog";
import { TmdbImageBrowserDialog } from "@/components/TmdbImageBrowserDialog";
import { MovieDetailPage } from "@/views/video/detail/MovieDetailPage";
import { ShowDetailPage } from "@/views/video/detail/ShowDetailPage";
import { GridToolbar } from "@/views/video/parts/GridToolbar";
import { GridSearchInput } from "@/views/video/parts/GridSearchInput";
import { SortDropdown, type SortOption } from "@/views/video/parts/SortDropdown";
import { CoverSizeSlider } from "@/views/video/parts/CoverSizeSlider";
import { useSelectedLibrary } from "@/context/LibraryContext";
import { sortableIdFor } from "@/lib/complications";
import type { MediaEntry, ViewSpec } from "@/types";

export function PersonDetailView({
  view,
  breadcrumbBar,
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
  onNavigate,
  onRenameEntry,
  onTitleChanged,
  onSetCover,
  onAddCover,
  onDeleteCover,
  onEntryChanged,
  onPlaylistChanged,
  scrollContainerRef,
  onPlayFile,
  onPlayEpisode,
}: {
  view: Extract<ViewSpec, { kind: "person-detail" }>;
  breadcrumbBar: ReactNode;
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

  // Keep the cover dialog's entry in sync with live entries so covers re-render after delete.
  const liveCoverDialogEntry = useMemo(() => {
    if (!coverDialogEntry) return null;
    if (selectedEntry?.id === coverDialogEntry.id) return selectedEntry;
    const found = entries.find((e) => e.id === coverDialogEntry.id);
    return found ?? coverDialogEntry;
  }, [coverDialogEntry, entries, selectedEntry]);

  const isSearching = searchResults != null;
  const filteredEntries = isSearching ? searchResults : entries;

  // Person-detail only supports alpha and date — no Custom, no presets. Build the options
  // list locally; the dropdown itself has zero view-kind awareness.
  const sortOptions: SortOption[] = [
    { id: "alpha", label: "Alphabetical", onClick: () => onSortModeChange("alpha") },
    { id: "date", label: "Date", onClick: () => onSortModeChange("date") },
  ];

  const triggerLabel =
    sortMode === "alpha" ? "A\u2013Z" : sortMode === "date" || sortMode === "year" ? "Date" : "A\u2013Z";

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {selectedLibrary && (
        <>
          {breadcrumbBar}
          {!selectedEntry && (
            <PersonDetailHeader
              name={view.personName}
              imagePath={view.personImage}
              role={view.role}
              workCount={entries.length}
            />
          )}
          {!selectedEntry && (
            <GridToolbar>
              <GridSearchInput value={search} onChange={onSearchChange} />
              <SortDropdown triggerLabel={triggerLabel} options={sortOptions} />
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
                    onAddCover={() => onAddCover(entry.id)}
                    onAddCoverFromTmdb={() => openTmdbImages(entry)}
                    onDeleteCover={() => openCoverDialog(entry, "delete")}
                    onDelete={async () => {
                      /* no-op in person-detail, readOnly hides the item */
                    }}
                    deletingId={null}
                    isDragActive={false}
                    sortMode={sortMode}
                    onAddToPlaylist={(e) => setAddToPlaylistFor(e)}
                    readOnly
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

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
