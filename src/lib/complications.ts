import type { ComplicationNode, GenreSummary, Library, LibraryCounts, PlaylistSummary, ViewSpec } from "@/types";

export function getComplicationsForLibrary(
  library: Library,
  playlists: PlaylistSummary[] = [],
  counts?: LibraryCounts,
  genres?: GenreSummary[],
): ComplicationNode[] {
  switch (library.format) {
    case "video":
      return videoComplications(library.id, playlists, counts, genres);
    case "music":
      return musicComplications(library.id, playlists, counts);
    default:
      return [];
  }
}

function musicComplications(
  libraryId: string,
  playlists: PlaylistSummary[],
  counts?: LibraryCounts,
): ComplicationNode[] {
  const playlistChildren: ComplicationNode[] = playlists.map((p) => ({
    id: `playlist.${p.id}`,
    label: p.title,
    iconName: "ListMusic",
    count: p.root_item_count,
    view: {
      kind: "playlist-detail",
      libraryId,
      playlistId: p.id,
      playlistName: p.title,
      collectionId: null,
    },
  }));

  const nodes: ComplicationNode[] = [
    {
      id: "artists",
      label: "Artists",
      iconName: "Users",
      count: counts?.artists,
      view: { kind: "library-root", libraryId },
    },
    {
      id: "albums",
      label: "Albums",
      iconName: "Disc3",
      count: counts?.albums,
      view: { kind: "albums", libraryId },
    },
    {
      id: "tracks",
      label: "Tracks",
      iconName: "Music2",
      count: counts?.tracks,
      view: { kind: "tracks", libraryId },
    },
    {
      id: "playlists",
      label: "Playlists",
      iconName: "ListMusic",
      count: playlists.length,
      view: { kind: "playlists", libraryId },
      children: playlistChildren,
    },
  ];
  // Universal import: under-tagged files import via fallbacks now, so there
  // is no needs-attention node — tag issues live in the metadata center.
  return nodes;
}

function videoComplications(
  libraryId: string,
  playlists: PlaylistSummary[],
  counts?: LibraryCounts,
  genres?: GenreSummary[],
): ComplicationNode[] {
  // Each genre appears as a child of "Genres" (already alphabetized by the
  // backend), showing its movie/show count and drilling into a filtered grid.
  const genreChildren: ComplicationNode[] = (genres ?? []).map((g) => ({
    id: `genre.${g.name}`,
    label: g.name,
    iconName: "Tag",
    count: g.count,
    view: { kind: "genre-detail", libraryId, genre: g.name },
  }));
  // Each user-created playlist appears as a child of the "Playlists" node so users can
  // jump directly into one from the sidebar. Collapsing "Playlists" hides them.
  const playlistChildren: ComplicationNode[] = playlists.map((p) => ({
    id: `playlist.${p.id}`,
    label: p.title,
    iconName: "ListMusic",
    // Top-level items only (links + collections) — what the grid shows when
    // opened, not the recursive media total.
    count: p.root_item_count,
    view: {
      kind: "playlist-detail",
      libraryId,
      playlistId: p.id,
      playlistName: p.title,
      collectionId: null,
    },
  }));

  return [
    {
      id: "all",
      label: "All",
      iconName: "Library",
      count: counts ? (counts.movies ?? 0) + (counts.shows ?? 0) : undefined,
      view: { kind: "library-root", libraryId },
      children: [
        { id: "all.movies", label: "Movies", iconName: "Film", count: counts?.movies, view: { kind: "movies-only", libraryId } },
        { id: "all.shows",  label: "TV",     iconName: "Tv",   count: counts?.shows,  view: { kind: "shows-only",  libraryId } },
      ],
    },
    {
      id: "people",
      label: "People",
      iconName: "Users",
      count: counts?.people,
      view: { kind: "people-all", libraryId },
      children: [
        { id: "people.actors",    label: "Actors",                iconName: "User",         count: counts?.actors,             view: { kind: "people-list", libraryId, role: "actor" } },
        { id: "people.directors", label: "Directors & Creators", iconName: "Clapperboard", count: counts?.directors_creators, view: { kind: "people-list", libraryId, role: "director_creator" } },
        { id: "people.composers", label: "Composers",             iconName: "Music2",       count: counts?.composers,          view: { kind: "people-list", libraryId, role: "composer" } },
      ],
    },
    {
      id: "genres",
      label: "Genres",
      iconName: "Drama",
      count: counts?.genres,
      view: { kind: "genres", libraryId },
      children: genreChildren,
      defaultCollapsed: true,
    },
    {
      id: "playlists",
      label: "Playlists",
      iconName: "ListMusic",
      count: playlists.length,
      view: { kind: "playlists", libraryId },
      children: playlistChildren,
    },
  ];
}

// Stable string key for caching per-view state (entries, scroll, etc).
// Replaces the old `${libraryId}:${parentId}` pattern by including view kind.
export function viewCacheKey(view: ViewSpec): string {
  switch (view.kind) {
    case "home":               return "home";
    case "library-root":       return `${view.libraryId}:root`;
    case "movies-only":        return `${view.libraryId}:movies`;
    case "shows-only":         return `${view.libraryId}:shows`;
    case "playlists":           return `${view.libraryId}:playlists`;
    case "people-all":         return `${view.libraryId}:people:all`;
    case "people-list":        return `${view.libraryId}:people:${view.role}`;
    case "genres":             return `${view.libraryId}:genres`;
    case "genre-detail":       return `${view.libraryId}:genre:${view.genre}`;
    case "person-detail":      return `${view.libraryId}:person:${view.role}:${view.personId}`;
    case "playlist-detail":    return `${view.libraryId}:playlist:${view.playlistId}:${view.collectionId ?? "root"}`;
    case "albums":             return `${view.libraryId}:albums`;
    case "tracks":             return `${view.libraryId}:tracks`;
    case "music-issues":       return `${view.libraryId}:music-issues`;
  }
}

// Scope key for saved sort presets. Mirrors the backend encoding in commands.rs so a single
// preset table row maps to a single sortable location.
//
// `parentId` disambiguates library-root at the library's null parent vs inside a collection.
// Returns null for non-sortable views (person-detail / people-list / people-all / search),
// which the UI uses to gate the save-preset button.
export function scopeKeyFor(view: ViewSpec, parentId: number | null): string | null {
  switch (view.kind) {
    case "home":             return null;
    case "library-root":
      return parentId !== null
        ? `lib-coll:${parentId}`
        : `lib-root:${view.libraryId}`;
    case "movies-only":      return `movies-only:${view.libraryId}`;
    case "shows-only":       return `shows-only:${view.libraryId}`;
    case "playlist-detail":
      return view.collectionId !== null
        ? `pl-coll:${view.collectionId}`
        : `pl-root:${view.playlistId}`;
    case "playlists":      return `playlists:${view.libraryId}`;
    case "people-all":
    case "people-list":
    case "person-detail":
    case "genres":
    case "genre-detail":
    case "albums":
    case "tracks":
    case "music-issues":
      return null;
  }
}
