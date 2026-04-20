import type { ComplicationNode, Library, MediaEntry, PlaylistSummary, ViewSpec } from "@/types";

/** Stable, collision-free sortable id for a grid entry. Playlist links use their `link_id`
 *  (distinct across playlists); nested playlist_collections use `pc-<id>` so they don't
 *  collide with real media_entry ids. Everything else keeps its numeric media_entry id so
 *  existing library drag-and-drop / update_sort_order flows keep working. */
export function sortableIdFor(entry: MediaEntry): string | number {
  if (entry.link_id != null) return `link-${entry.link_id}`;
  if (entry.entry_type === "playlist_collection") return `pc-${entry.id}`;
  return entry.id;
}

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

// Scope key for saved sort presets. Mirrors the backend encoding in commands.rs so a single
// preset table row maps to a single sortable location.
//
// `parentId` disambiguates library-root at the library's null parent vs inside a collection.
// Returns null for non-sortable views (person-detail / people-list / people-all / search),
// which the UI uses to gate the save-preset button.
export function scopeKeyFor(view: ViewSpec, parentId: number | null): string | null {
  switch (view.kind) {
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
    case "playlists":
    case "people-all":
    case "people-list":
    case "person-detail":
      return null;
  }
}
