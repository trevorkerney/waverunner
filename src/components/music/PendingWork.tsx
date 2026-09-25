import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../ui/button";
import { useLibraryRuns } from "@/hooks/libraryRuns";
import { useMbHidden } from "@/lib/mbVisibility";
import { RefreshCw, Sparkles, TriangleAlert } from "lucide-react";

/** The two deferred-work queues a music library carries:
 *  - staged changes a RESCAN applies (splits, combines, separations)
 *  - applied matches a MATCHING PASS cashes in (stamping the artists their
 *    credits prove)
 *  The metadata center's banner is the full view; these pieces are the
 *  outside-the-center layer — a sidebar badge (ambient) and a library-page
 *  strip (actionable) — so deferred work is never invisible. */

/** A staged directive (split, combine, separate) a rescan will apply. */
export interface PendingRescanRow {
  id: number;
  label: string;
  kind: string;
  target: string;
  /** Entities the directive has decided — frozen until the rescan. */
  locked_ids: number[];
}

/** An applied match a matching pass has yet to cash in. */
export interface PendingPassRow {
  id: number;
  target: string;
  label: string;
  batch_id: number | null;
}

/** Staging happens in dialogs scattered across the app — they announce it
 *  with this so every badge/strip refetches without prop threading. */
export function notifyPendingWorkChanged() {
  window.dispatchEvent(new Event("waverunner:pending-work-changed"));
}

/** Both queues, live: fetched on mount (two cheap queries) and again on
 *  every event that can change them. The metadata center's banners read
 *  from here too, so the badge, the strip and the banners always agree —
 *  and the banners don't wait on the center's slow review fetch. */
export function usePendingWork(libraryId: string | null) {
  const [rescan, setRescan] = useState<PendingRescanRow[]>([]);
  const [pass, setPass] = useState<PendingPassRow[]>([]);
  const refetch = useCallback(async () => {
    if (!libraryId) {
      setRescan([]);
      setPass([]);
      return;
    }
    try {
      const [r, p] = await Promise.all([
        invoke<PendingRescanRow[]>("get_pending_changes", { libraryId }),
        invoke<PendingPassRow[]>("get_pending_pass", { libraryId }),
      ]);
      setRescan(r);
      setPass(p);
    } catch {
      // Library mid-delete or backend busy — keep the last known state.
    }
  }, [libraryId]);
  useEffect(() => {
    void refetch();
    const onDom = () => void refetch();
    // Staging sites dispatch pending-work-changed; rescans announce through
    // library-rescanned; applies/unmatches/undos and pass completion all emit
    // music-enrich-done from the backend; scan-state end covers wizard
    // rescans that clear the staged list.
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
  return { rescan, pass, refetch };
}

/** The sidebar's Metadata row's ONE attention slot — never two icons side by side.
 *  Priority, top first:
 *    1. staged changes waiting on a rescan (red triangle; music)
 *    2. matches waiting on a matching pass (amber triangle; music)
 *  Both open the metadata center — the full picture lives there. Silent
 *  when nothing applies. (A span, not a button: the row itself renders as a
 *  button and buttons can't nest — same trick as the row's chevron.) */
export function LibraryAttentionBadge({
  libraryId,
  format,
}: {
  libraryId: string;
  format: string;
}) {
  // Only music carries the deferred-work queues; other formats skip the fetch.
  const { rescan, pass } = usePendingWork(format === "music" ? libraryId : null);
  // The match QUESTION after a scan waits on the Metadata page (its banner
  // shows only there) — the badge is how the user finds it.
  const { runs } = useLibraryRuns();
  const asking = runs[libraryId]?.kind === "prompt";
  if (rescan.length === 0 && pass.length === 0 && !asking) return null;
  const urgent = rescan.length > 0;
  const parts = [
    asking && "Match question waiting",
    rescan.length > 0 &&
      `${rescan.length} change${rescan.length === 1 ? "" : "s"} staged for the next rescan`,
    pass.length > 0 &&
      `${pass.length} match${pass.length === 1 ? "" : "es"} waiting for a matching pass`,
  ]
    .filter(Boolean)
    .join(" · ");
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
      title={`${parts} — open Metadata`}
      // No hover treatment: it's a status mark that happens to be
      // clickable, not a button — the row it sits in already highlights.
      className={`flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center ${
        urgent ? "text-red-400" : "text-primary"
      }`}
    >
      <TriangleAlert size={13} />
    </span>
  );
}

/** The actionable layer: a one-line strip under the library's toolbar naming
 *  both queues, with the action each one wants. Rescan applies staged
 *  changes; the pass cashes in matches — and staged changes gate the pass
 *  (same rule the backend enforces), so the strip only offers what can run. */
export function PendingWorkStrip({ libraryId }: { libraryId: string }) {
  const { rescan, pass: passAll } = usePendingWork(libraryId);
  // "Show MusicBrainz outside this page" off: the matching-pass queue is
  // MusicBrainz work, so it stays on the Metadata page. Staged rescan
  // changes are the library's own and still show.
  const mbHidden = useMbHidden(libraryId);
  const pass = mbHidden ? [] : passAll;
  // A running pass IS the queue being worked — the strip would sit there
  // still saying "waiting" (the queue only clears when the pass lands),
  // reading as if the click did nothing. The Metadata page shows the pass.
  const { runs } = useLibraryRuns();
  const passRunning = runs[libraryId]?.kind === "match";
  if (passRunning || (rescan.length === 0 && pass.length === 0)) return null;
  const message = [
    rescan.length > 0 &&
      `${rescan.length} change${rescan.length === 1 ? "" : "s"} staged for the next rescan`,
    pass.length > 0 &&
      `${pass.length} match${pass.length === 1 ? "" : "es"} waiting for a matching pass`,
  ]
    .filter(Boolean)
    .join(" · ");
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
  // Rescan-needed outranks pass-needed: red while any staged change waits
  // (the rescan gates everything), amber once only the pass is left.
  const urgent = rescan.length > 0;
  return (
    <div
      className={`flex items-center gap-3 border-b px-4 py-1.5 ${
        urgent ? "border-red-500/30 bg-red-500/5" : "border-primary/25 bg-primary/5"
      }`}
    >
      {/* Pass-waiting = the running pass's palette (primary tint, primary
          icon, plain text), so the two read as one thing. */}
      <TriangleAlert
        size={13}
        className={`shrink-0 ${urgent ? "text-red-400" : "text-primary"}`}
      />
      <p
        className={`min-w-0 flex-1 truncate text-xs ${
          urgent ? "text-red-200/90" : ""
        }`}
      >
        {message}
      </p>
      {rescan.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 shrink-0 gap-1.5 px-2 text-xs"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("waverunner:open-rescan", { detail: { libraryId } }),
            )
          }
        >
          <RefreshCw size={12} />
          Rescan now
        </Button>
      )}
      {pass.length > 0 && rescan.length === 0 && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 shrink-0 gap-1.5 px-2 text-xs"
          onClick={runPass}
        >
          <RefreshCw size={12} />
          Run matching pass
        </Button>
      )}
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
