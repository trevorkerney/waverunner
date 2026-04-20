import type { RefObject } from "react";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem as BreadcrumbUIItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import type {
  MediaEntry,
  BreadcrumbItem,
  ViewSpec,
  PersonSummary,
  PersonRole,
  PlaylistSummary,
  SortPreset,
} from "@/types";
import { LibraryGridView } from "@/views/video/LibraryGridView";
import { PlaylistDetailView } from "@/views/video/PlaylistDetailView";
import { PersonDetailView } from "@/views/video/PersonDetailView";
import { PlaylistsView } from "@/views/video/PlaylistsView";
import { PeopleListView } from "@/views/video/PeopleListView";

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
  onNavigateToPlaylist: (playlist: PlaylistSummary) => void;
  onPlaylistChanged: (libraryId: string) => void;
  onBreadcrumbClick: (index: number) => void;
  hasLibraries: boolean;
  sortMode: string;
  onSortModeChange: (mode: string) => void;
  presets: SortPreset[];
  selectedPresetId: number | null;
  onChangePreset: (presetId: number | null) => Promise<void> | void;
  onSavePreset: (name: string, overwrite: boolean) => Promise<void>;
  onDeletePreset: (presetId: number) => Promise<void> | void;
  onSortOrderChange: (reordered: MediaEntry[]) => void;
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
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onPlayFile?: (path: string, title: string) => void;
  onPlayEpisode?: (args: {
    libraryId: string;
    showId: number;
    showTitle: string;
    startEpisodeId: number;
  }) => void;
}

export function MainContent(props: MainContentProps) {
  const { activeView, breadcrumbs, onBreadcrumbClick } = props;

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

  // Pulled out so both library / playlist-detail / person-detail call sites share the
  // same fat prop bag without repeating 30 lines.
  const gridCommon = {
    breadcrumbBar,
    breadcrumbs,
    entries: props.entries,
    searchResults: props.searchResults,
    selectedEntry: props.selectedEntry,
    loading: props.loading,
    hasLibraries: props.hasLibraries,
    coverSize: props.coverSize,
    onCoverSizeChange: props.onCoverSizeChange,
    search: props.search,
    onSearchChange: props.onSearchChange,
    sortMode: props.sortMode,
    onSortModeChange: props.onSortModeChange,
    presets: props.presets,
    selectedPresetId: props.selectedPresetId,
    onChangePreset: props.onChangePreset,
    onSavePreset: props.onSavePreset,
    onDeletePreset: props.onDeletePreset,
    onSortOrderChange: props.onSortOrderChange,
    onNavigate: props.onNavigate,
    onRenameEntry: props.onRenameEntry,
    onTitleChanged: props.onTitleChanged,
    onSetCover: props.onSetCover,
    onAddCover: props.onAddCover,
    onDeleteCover: props.onDeleteCover,
    onMoveEntry: props.onMoveEntry,
    onCreateCollection: props.onCreateCollection,
    onDeleteEntry: props.onDeleteEntry,
    onRescan: props.onRescan,
    onEntryChanged: props.onEntryChanged,
    onPlaylistChanged: props.onPlaylistChanged,
    scrollContainerRef: props.scrollContainerRef,
    onPlayFile: props.onPlayFile,
    onPlayEpisode: props.onPlayEpisode,
  };

  if (!activeView) {
    // Render the library-root shell anyway so the empty-state UI (no libraries / no
    // selection) shows up inside the normal main area.
    return (
      <LibraryGridView
        view={{ kind: "library-root", libraryId: "" }}
        {...gridCommon}
      />
    );
  }

  switch (activeView.kind) {
    case "people-all":
    case "people-list":
      return (
        <PeopleListView
          view={activeView}
          people={props.people}
          loading={props.loading}
          breadcrumbBar={breadcrumbBar}
          scrollContainerRef={props.scrollContainerRef}
          onNavigateToPerson={props.onNavigateToPerson}
        />
      );
    case "playlists":
      return (
        <PlaylistsView
          libraryId={activeView.libraryId}
          playlists={props.playlists}
          loading={props.loading}
          breadcrumbBar={breadcrumbBar}
          scrollContainerRef={props.scrollContainerRef}
          onNavigateToPlaylist={props.onNavigateToPlaylist}
          onPlaylistChanged={props.onPlaylistChanged}
        />
      );
    case "playlist-detail":
      return <PlaylistDetailView view={activeView} {...gridCommon} />;
    case "person-detail":
      return <PersonDetailView view={activeView} {...gridCommon} />;
    case "library-root":
    case "movies-only":
    case "shows-only":
      return <LibraryGridView view={activeView} {...gridCommon} />;
  }
}
