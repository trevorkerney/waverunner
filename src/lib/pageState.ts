/** Page-owned navigation state for history-true back/forward.
 *
 *  A history snapshot holds the view, entry, crumbs and search — but some
 *  pages keep state of their own that a return visit should also restore:
 *  the Metadata page's open tab and its pane's scroll offset (it scrolls
 *  its own container, not the one App saves for grids). Rather than
 *  threading that through every host, the page registers a COLLECTOR here
 *  while mounted; App's history pushes call it and store the result on the
 *  snapshot. Applying a snapshot with page state parks it here as a pending
 *  restore, which the page consumes when it (re)mounts for that view. */

export interface MetadataPageState {
  /** The open pane id (tab). */
  pane: string;
  /** The pane container's scrollTop. */
  scrollTop: number;
}

let collector: (() => MetadataPageState) | null = null;

/** The mounted page's state collector, or null when no such page is up. */
export function setPageStateCollector(fn: (() => MetadataPageState) | null) {
  collector = fn;
}

/** What the mounted page would want restored, or null. Called by history
 *  pushes BEFORE the navigation commits, so the leaving page is still up. */
export function collectPageState(): MetadataPageState | null {
  return collector ? collector() : null;
}

let pending: MetadataPageState | null = null;

/** Park a restore for the page a snapshot is about to show (null clears —
 *  a snapshot without page state must land like a fresh visit). */
export function requestPageRestore(state: MetadataPageState | null) {
  pending = state;
}

/** The parked restore without consuming it (initial-state peeks). */
export function peekPageRestore(): MetadataPageState | null {
  return pending;
}

/** The parked restore, consumed. */
export function takePageRestore(): MetadataPageState | null {
  const p = pending;
  pending = null;
  return p;
}
