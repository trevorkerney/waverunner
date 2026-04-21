import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { MediaEntry, ViewSpec } from "@/types"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Stable, collision-free sortable id for a grid entry. Playlist links use their `link_id`
 *  (distinct across playlists); nested playlist_collections use `pc-<id>` so they don't
 *  collide with real media_entry ids. Everything else keeps its numeric media_entry id so
 *  existing library drag-and-drop / update_sort_order flows keep working. */
export function sortableIdFor(entry: MediaEntry): string | number {
  if (entry.link_id != null) return `link-${entry.link_id}`;
  if (entry.entry_type === "playlist_collection") return `pc-${entry.id}`;
  return entry.id;
}

/** Stable string key for caching per-view state (entries, scroll, etc). Includes view kind
 *  so sidebar switches don't leak cache between views (library-root at parentId=null is
 *  distinct from movies-only at parentId=null). */
export function viewCacheKey(view: ViewSpec): string {
  switch (view.kind) {
    case "library-root":       return `${view.libraryId}:root`;
    case "movies-only":        return `${view.libraryId}:movies`;
    case "shows-only":         return `${view.libraryId}:shows`;
    case "playlists":          return `${view.libraryId}:playlists`;
    case "people-all":         return `${view.libraryId}:people:all`;
    case "people-list":        return `${view.libraryId}:people:${view.role}`;
    case "person-detail":      return `${view.libraryId}:person:${view.role}:${view.personId}`;
    case "playlist-detail":    return `${view.libraryId}:playlist:${view.playlistId}:${view.collectionId ?? "root"}`;
  }
}

/** Scope key for saved sort presets. Mirrors the backend encoding in commands.rs so a
 *  single preset table row maps to a single sortable location. `parentId` disambiguates
 *  library-root at the library's null parent vs inside a collection. Returns null for
 *  non-sortable views (person-detail / people-list / people-all / search), which the UI
 *  uses to gate the save-preset button. */
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
