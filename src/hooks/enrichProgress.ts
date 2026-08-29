import { listen } from "@tauri-apps/api/event";

/** The most recent matching-pass progress event, cached at module level.
 *
 *  The wizard modal's own listener attaches only once it's open on the match
 *  step — asynchronously — while the backend starts emitting the moment the
 *  pass spawns. The FIRST album's event therefore lands before the modal can
 *  hear it, and with MusicBrainz rate-limiting, "Starting…" then sits on
 *  screen for the whole first item while the sidebar (whose listener lives
 *  from app start) happily shows "1/N". This cache is the always-on ear: the
 *  modal seeds its display from it on attach instead of waiting for event 2.
 */
export interface EnrichProgress {
  libraryId?: string;
  phase: string;
  done: number;
  total: number;
  name: string;
}

let latest: EnrichProgress | null = null;

// Module-level listeners, alive for the app's lifetime — deliberately never
// unsubscribed. Cleared on done so a finished pass can't seed the next one
// with a stale item.
void listen<EnrichProgress>("music-enrich-progress", (e) => {
  latest = e.payload;
});
void listen<{ libraryId?: string }>("music-enrich-done", (e) => {
  if (!latest || !e.payload.libraryId || latest.libraryId === e.payload.libraryId) {
    latest = null;
  }
});

export function latestEnrichProgress(libraryId: string): EnrichProgress | null {
  return latest && latest.libraryId === libraryId ? latest : null;
}
