import type { ComplicationNode, Library, PlaylistSummary, ViewSpec } from "@/types";

export function getComplicationsForLibrary(
  library: Library,
  playlists: PlaylistSummary[] = [],
): ComplicationNode[] {
  switch (library.format) {
    case "video":
      return videoComplications(library.id, playlists);
    default:
      return [];
  }
}

function videoComplications(libraryId: string, playlists: PlaylistSummary[]): ComplicationNode[] {
  // Each user-created playlist appears as a child of the "Playlists" node so users can
  // jump directly into one from the sidebar. Collapsing "Playlists" hides them.
  const playlistChildren: ComplicationNode[] = playlists.map((p) => ({
    id: `playlist.${p.id}`,
    label: p.title,
    iconName: "ListMusic",
    view: {
      kind: "playlist-detail",
      libraryId,
      playlistId: p.id,
      playlistName: p.title,
      collectionId: null,
    },
  }));

  return [
    { id: "all",     label: "All",    iconName: "Library", view: { kind: "library-root", libraryId } },
    { id: "movies",  label: "Movies", iconName: "Film",    view: { kind: "movies-only",  libraryId } },
    { id: "shows",   label: "TV",     iconName: "Tv",      view: { kind: "shows-only",   libraryId } },
    {
      id: "people",
      label: "People",
      iconName: "Users",
      view: { kind: "people-all", libraryId },
      children: [
        { id: "people.actors",    label: "Actors",                iconName: "User",         view: { kind: "people-list", libraryId, role: "actor" } },
        { id: "people.directors", label: "Directors & Creators", iconName: "Clapperboard", view: { kind: "people-list", libraryId, role: "director_creator" } },
        { id: "people.composers", label: "Composers",             iconName: "Music2",       view: { kind: "people-list", libraryId, role: "composer" } },
      ],
    },
    {
      id: "playlists",
      label: "Playlists",
      iconName: "ListMusic",
      view: { kind: "playlists", libraryId },
      children: playlistChildren,
    },
  ];
}

// Stable string key for caching per-view state (entries, scroll, etc).
// Replaces the old `${libraryId}:${parentId}` pattern by including view kind.
export function viewCacheKey(view: ViewSpec): string {
  switch (view.kind) {
    case "library-root":       return `${view.libraryId}:root`;
    case "movies-only":        return `${view.libraryId}:movies`;
    case "shows-only":         return `${view.libraryId}:shows`;
    case "playlists":           return `${view.libraryId}:playlists`;
    case "people-all":         return `${view.libraryId}:people:all`;
    case "people-list":        return `${view.libraryId}:people:${view.role}`;
    case "person-detail":      return `${view.libraryId}:person:${view.role}:${view.personId}`;
    case "playlist-detail":    return `${view.libraryId}:playlist:${view.playlistId}:${view.collectionId ?? "root"}`;
  }
}
