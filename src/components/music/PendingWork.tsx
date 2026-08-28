import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../ui/button";
import { RefreshCw, Sparkles, TriangleAlert } from "lucide-react";

/** The two deferred-work queues a music library carries:
 *  - staged changes a RESCAN applies (splits, combines, separations)
 *  - applied matches a MATCHING PASS cashes in (stamping the artists their
 *    credits prove)
 *  The metadata center's banner is the full view; these pieces are the
 *  outside-the-center layer — a sidebar badge (ambient) and a library-page
 *  strip (actionable) — so deferred work is never invisible. */

interface PendingRescanRow {
  id: number;
  label: string;
}

interface PendingPassRow {
  id: number;
  target: string;
  label: string;
}

/** Staging happens in dialogs scattered across the app — they announce it
 *  with this so every badge/strip refetches without prop threading. */
export function notifyPendingWorkChanged() {
  window.dispatchEvent(new Event("waverunner:pending-work-changed"));
}

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

/** Ambient signal on the sidebar's library row: one warning icon, red while
 *  staged changes wait on a rescan, amber when only the pass is left. Click
 *  opens the metadata center — the full picture lives there. Silent when
 *  both queues are empty. (A span, not a button: the row itself renders as a
 *  button and buttons can't nest — same trick as the row's chevron.) */
export function PendingWorkBadge({ libraryId }: { libraryId: string }) {
  const { rescan, pass } = usePendingWork(libraryId);
  if (rescan.length === 0 && pass.length === 0) return null;
  const urgent = rescan.length > 0;
  const parts = [
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
      title={`${parts} — open the metadata center`}
      className={`flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-foreground/10 ${
        urgent ? "text-red-400 hover:text-red-300" : "text-amber-300 hover:text-amber-200"
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
  const { rescan, pass } = usePendingWork(libraryId);
  if (rescan.length === 0 && pass.length === 0) return null;
  const message = [
    rescan.length > 0 &&
      `${rescan.length} change${rescan.length === 1 ? "" : "s"} staged for the next rescan`,
    pass.length > 0 &&
      `${pass.length} match${pass.length === 1 ? "" : "es"} waiting for a matching pass`,
  ]
    .filter(Boolean)
    .join(" · ");
  // The pass runs in the match-only wizard modal (Sidebar owns the launch);
  // the modal starts it itself, so this only has to ask.
  const runPass = () => {
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
        urgent ? "border-red-500/30 bg-red-500/5" : "border-amber-500/30 bg-amber-500/5"
      }`}
    >
      <TriangleAlert
        size={13}
        className={`shrink-0 ${urgent ? "text-red-400" : "text-amber-300"}`}
      />
      <p
        className={`min-w-0 flex-1 truncate text-xs ${
          urgent ? "text-red-200/90" : "text-amber-200/90"
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
