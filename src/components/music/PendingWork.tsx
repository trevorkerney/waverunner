import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../ui/button";
import { useLibraryRuns } from "@/hooks/libraryRuns";
import { useMbHidden } from "@/lib/mbVisibility";
import { RefreshCw, Sparkles, TriangleAlert } from "lucide-react";

/** The deferred-work queue a music library carries: applied matches a
 *  MATCHING PASS cashes in (stamping the artists their credits prove), plus
 *  what the pass will look at on its own. (Edits, splits and combines apply
 *  on the spot since the tag layer — nothing waits on a rescan any more.)
 *  The metadata center's banner is the full view; these pieces are the
 *  outside-the-center layer — a sidebar badge (ambient) and a library-page
 *  strip (actionable) — so queued work is never invisible. */

/** An applied match a matching pass has yet to cash in. */
export interface PendingPassRow {
  id: number;
  target: string;
  label: string;
  batch_id: number | null;
}

/** Anything that changes the queue announces it with this so every
 *  badge/strip refetches without prop threading. */
export function notifyPendingWorkChanged() {
  window.dispatchEvent(new Event("waverunner:pending-work-changed"));
}

/** What the next pass will do besides the queue rows: albums MusicBrainz
 *  has never been asked about (plus retry-eligible ones) and artists whose
 *  identity matched evidence can derive. Each bucket counts as ONE queued
 *  item — the banner lists it as one line. Zero when online metadata is off
 *  for the library (the pass won't run). */
export interface PendingPassBuckets {
  uncheckedAlbums: number;
  uncheckedArtists: number;
  /** Items whose last request failed — the pass retries them, and they
   *  stay listed until one goes through (or is settled by hand). */
  failedRequests: number;
}

/** One item whose MusicBrainz request failed on its last try (user's call,
 *  2026-09-27: failures are said, listed, and retried by the next pass —
 *  never silently, never on their own). */
export interface FetchFailureRow {
  kind: string;
  target: string;
  label: string;
  phase: string;
  error: string;
  /** Passes in a row it has failed. */
  attempts: number;
  last_failed_at: string;
}

/** The one number every surface shows for the pass: queue rows + one per
 *  non-empty bucket. */
export function passItemCount(pass: PendingPassRow[], buckets: PendingPassBuckets): number {
  return (
    pass.length +
    (buckets.uncheckedAlbums > 0 ? 1 : 0) +
    (buckets.uncheckedArtists > 0 ? 1 : 0) +
    (buckets.failedRequests > 0 ? 1 : 0)
  );
}

export function passItemsLabel(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"} queued for the next matching pass`;
}

const NO_BUCKETS: PendingPassBuckets = { uncheckedAlbums: 0, uncheckedArtists: 0, failedRequests: 0 };

interface PendingSnapshot {
  pass: PendingPassRow[];
  buckets: PendingPassBuckets;
  failures: FetchFailureRow[];
}

/** One fetch per library at a time, shared by every hook instance. The
 *  sidebar badge, the library strip and the metadata page all listen to the
 *  same events, so they all refetch in the same tick — three copies of four
 *  round-trips each, parsed on the main thread, for one answer. Joiners
 *  await the in-flight promise instead. */
const inflight = new Map<string, Promise<PendingSnapshot>>();

/** Last snapshot per library. An instance mounting for a library seen
 *  before renders from this in its FIRST commit and refetches behind it —
 *  otherwise the banner lands one round-trip after the page and shoves the
 *  content down. The sidebar badges fetch every music library at startup,
 *  so by the time a page opens, its library is usually already here. */
const lastSnapshot = new Map<string, PendingSnapshot>();

function fetchPending(libraryId: string): Promise<PendingSnapshot> {
  const running = inflight.get(libraryId);
  if (running) return running;
  const p = (async () => {
    const [pass, ms, ls, failures] = await Promise.all([
      invoke<PendingPassRow[]>("get_pending_pass", { libraryId }),
      invoke<{ unchecked: number; unchecked_artists: number; failed_requests: number }>(
        "music_match_state",
        { libraryId },
      ),
      invoke<Record<string, string>>("get_library_settings", { libraryId }),
      invoke<FetchFailureRow[]>("get_fetch_failures", { libraryId }),
    ]);
    const online = ls["online_metadata"] !== "off";
    const snap: PendingSnapshot = {
      pass,
      buckets: online
        ? {
            uncheckedAlbums: ms.unchecked,
            uncheckedArtists: ms.unchecked_artists,
            failedRequests: ms.failed_requests,
          }
        : NO_BUCKETS,
      failures: online ? failures : [],
    };
    lastSnapshot.set(libraryId, snap);
    return snap;
  })();
  inflight.set(libraryId, p);
  p.finally(() => {
    if (inflight.get(libraryId) === p) inflight.delete(libraryId);
  }).catch(() => {});
  return p;
}

/** The pass queue, live: fetched on mount (a few cheap queries) and again on
 *  every event that can change it. The metadata center's banners read from
 *  here too, so the badge, the strip and the banners always agree — and the
 *  banners don't wait on the center's slow review fetch. */
export function usePendingWork(libraryId: string | null) {
  const cached = libraryId ? lastSnapshot.get(libraryId) : undefined;
  const [pass, setPass] = useState<PendingPassRow[]>(() => cached?.pass ?? []);
  const [buckets, setBuckets] = useState<PendingPassBuckets>(() => cached?.buckets ?? NO_BUCKETS);
  const [failures, setFailures] = useState<FetchFailureRow[]>(() => cached?.failures ?? []);
  const refetch = useCallback(async () => {
    if (!libraryId) {
      setPass([]);
      setBuckets(NO_BUCKETS);
      setFailures([]);
      return;
    }
    // A library switch on a mounted instance: show its last snapshot now,
    // not the previous library's rows until the fetch lands.
    const known = lastSnapshot.get(libraryId);
    if (known) {
      setPass(known.pass);
      setBuckets(known.buckets);
      setFailures(known.failures);
    }
    try {
      const snap = await fetchPending(libraryId);
      setPass(snap.pass);
      setBuckets(snap.buckets);
      setFailures(snap.failures);
    } catch {
      // Library mid-delete or backend busy — keep the last known state.
    }
  }, [libraryId]);
  useEffect(() => {
    void refetch();
    const onDom = () => void refetch();
    // Mutating sites dispatch pending-work-changed; rescans announce through
    // library-rescanned; applies/unmatches/undos and pass completion all emit
    // music-enrich-done from the backend; scan-state end covers rescans.
    window.addEventListener("waverunner:pending-work-changed", onDom);
    window.addEventListener("waverunner:library-rescanned", onDom);
    const unEnrich = listen("music-enrich-done", () => void refetch());
    const unScan = listen<{ state: string }>("scan-state", (e) => {
      if (e.payload.state !== "started") void refetch();
    });
    return () => {
      window.removeEventListener("waverunner:pending-work-changed", onDom);
      window.removeEventListener("waverunner:library-rescanned", onDom);
      unEnrich.then((fn) => fn());
      unScan.then((fn) => fn());
    };
  }, [refetch]);
  return { pass, buckets, failures, passItems: passItemCount(pass, buckets), refetch };
}

/** The sidebar's Metadata row's ONE attention slot: matches waiting on a
 *  matching pass (gold triangle; music). Opens the metadata center — the
 *  full picture lives there. Silent when nothing applies. (A span, not a
 *  button: the row itself renders as a button and buttons can't nest —
 *  same trick as the row's chevron.) */
export function LibraryAttentionBadge({
  libraryId,
  format,
}: {
  libraryId: string;
  format: string;
}) {
  // Only music carries the pass queue; other formats skip the fetch.
  const { passItems } = usePendingWork(format === "music" ? libraryId : null);
  if (passItems === 0) return null;
  return (
    // h-5 matches the row's one-line text height (the same trick its chevron
    // uses), so the icon centers on the title's first line even when a long
    // library name wraps in the items-start row.
    <span
      onClick={(e) => {
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("waverunner:open-music-center", { detail: { libraryId } }),
        );
      }}
      title={`${passItemsLabel(passItems)} — open Metadata`}
      // No hover treatment: it's a status mark that happens to be
      // clickable, not a button — the row it sits in already highlights.
      className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center text-primary"
    >
      <TriangleAlert size={13} />
    </span>
  );
}

/** The actionable layer: a one-line strip under the library's toolbar naming
 *  the pass queue, with the action it wants. */
export function PendingWorkStrip({ libraryId }: { libraryId: string }) {
  const { passItems: passItemsAll } = usePendingWork(libraryId);
  // "Show MusicBrainz outside this page" off: the matching-pass queue is
  // MusicBrainz work, so it stays on the Metadata page.
  const mbHidden = useMbHidden(libraryId);
  const passItems = mbHidden ? 0 : passItemsAll;
  // A running pass IS the queue being worked — the strip would sit there
  // still saying "waiting" (the queue only clears when the pass lands),
  // reading as if the click did nothing. The Metadata page shows the pass.
  const { runs } = useLibraryRuns();
  const passRunning = runs[libraryId]?.kind === "match";
  if (passRunning || passItems === 0) return null;
  // App's run controller starts the pass; its progress lives on the Metadata
  // page, so the click goes there too — otherwise it starts silently behind
  // whatever page this strip is on.
  const runPass = () => {
    window.dispatchEvent(
      new CustomEvent("waverunner:open-music-center", { detail: { libraryId } }),
    );
    window.dispatchEvent(
      new CustomEvent("waverunner:open-match", { detail: { libraryId } }),
    );
  };
  return (
    <div className="flex items-center gap-3 border-b border-primary/25 bg-primary/5 px-4 py-1.5">
      {/* Pass-waiting = the running pass's palette (primary tint, primary
          icon, plain text), so the two read as one thing. */}
      <TriangleAlert size={13} className="shrink-0 text-primary" />
      <p className="min-w-0 flex-1 truncate text-xs">{passItemsLabel(passItems)}</p>
      <Button
        size="sm"
        variant="outline"
        className="h-6 shrink-0 gap-1.5 px-2 text-xs"
        onClick={runPass}
      >
        <RefreshCw size={12} />
        Run matching pass
      </Button>
      <button
        type="button"
        className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("waverunner:open-music-center", { detail: { libraryId } }),
          )
        }
      >
        <Sparkles size={12} className="mr-1 inline -translate-y-px" />
        Review
      </button>
    </div>
  );
}
