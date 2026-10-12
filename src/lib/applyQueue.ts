import { useSyncExternalStore } from "react";
import { toast } from "@/lib/toast";

/** The metadata page's apply queue.
 *
 *  Working through the decision cards means answering one, waiting for the
 *  apply, watching the page shift as the card leaves, then the next. With a
 *  queue, a click on Apply / "This one" enqueues the decision and returns
 *  at once: the card leaves the list immediately (the page hides whatever a
 *  queued item targets), the queue applies items one at a time in the
 *  background, and the page refreshes once when the queue drains — not
 *  after every item. Module-level so it survives navigation; the sidebar
 *  shows a line per library while items remain.
 *
 *  Serial on purpose: applies write the same tables and each one's tail
 *  walks the library; two at once would only fight for the write lock. */

/** What a queued apply is about — the page hides these until it lands. */
export interface ApplyTarget {
  suggestionId?: number;
  artistId?: number;
  albumId?: number;
}

export interface QueuedApply {
  id: number;
  libraryId: string;
  /** The banner line: what's being matched to what. */
  label: string;
  target: ApplyTarget;
  run: () => Promise<void>;
}

interface Snapshot {
  items: QueuedApply[];
  /** The item being applied right now (always items[0] while running). */
  runningId: number | null;
  /** Applied successfully, but the page hasn't refreshed yet: its card
   *  must STAY hidden until then, or it pops back for the beat between
   *  the item leaving the queue and the new review landing. The page
   *  clears these once its refresh has the data (clearSettledApplies). */
  settled: SettledApply[];
}

/** A settled item remembers WHEN, so a refresh can tell whether its data
 *  already reflects the apply (see clearSettledApplies). */
export interface SettledApply extends QueuedApply {
  settledAt: number;
}

let items: QueuedApply[] = [];
let settled: SettledApply[] = [];
let runningId: number | null = null;
let nextId = 1;
let snapshot: Snapshot = { items, runningId, settled };
const listeners = new Set<() => void>();

function emit() {
  snapshot = { items, runningId, settled };
  for (const l of listeners) l();
}

/** The page's refresh has landed — the settled items' cards are gone from
 *  the data itself now, so the hide can stop. `dataAsOf` is when that
 *  refresh STARTED: only items settled before it are in its data. A refresh
 *  that began earlier and landed after the apply would otherwise lift the
 *  hide with stale data, and the row flashed back until the drain refresh
 *  landed (his "goes away, comes back, goes away", 2026-10-04). */
export function clearSettledApplies(libraryId: string, dataAsOf = Infinity) {
  const gone = (i: SettledApply) => i.libraryId === libraryId && i.settledAt <= dataAsOf;
  if (!settled.some(gone)) return;
  settled = settled.filter((i) => !gone(i));
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Add a decision to the queue; it starts at once if nothing is running. */
export function enqueueApply(a: Omit<QueuedApply, "id">): number {
  const id = nextId++;
  items = [...items, { ...a, id }];
  emit();
  void pump();
  return id;
}

/** Drop a waiting item (the running one can't be pulled back). */
export function cancelApply(id: number) {
  if (id === runningId) return;
  items = items.filter((i) => i.id !== id);
  emit();
}

/** Anything queued or running for this library? */
export function applyQueueHas(libraryId: string): boolean {
  return items.some((i) => i.libraryId === libraryId);
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (items.length > 0) {
      const item = items[0];
      runningId = item.id;
      emit();
      try {
        await item.run();
        // Stays hidden until the page's refresh shows it gone for real.
        settled = [...settled, { ...item, settledAt: performance.now() }];
      } catch (e) {
        // The card comes back (it's no longer hidden once the item leaves)
        // and the error names the decision it was for.
        toast.error(`${item.label}: ${String(e)}`);
      }
      items = items.filter((i) => i.id !== item.id);
      runningId = null;
      emit();
      // The page refreshes off this, once per library, when its last item
      // lands — not once per item.
      if (!items.some((i) => i.libraryId === item.libraryId)) {
        window.dispatchEvent(
          new CustomEvent("waverunner:apply-queue-drained", {
            detail: { libraryId: item.libraryId },
          }),
        );
      }
    }
  } finally {
    pumping = false;
  }
}

export function useApplyQueue(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
