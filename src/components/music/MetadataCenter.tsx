import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Search, Undo2, GitMerge, CircleCheck, RefreshCw, FileWarning, TriangleAlert } from "lucide-react";

/** The metadata matching/cleaning center — the permanent home for a music
 *  library's external-source state. Two entrances: the import wizard's final
 *  step embeds it, and the sidebar opens it any time after. Sections: match
 *  summary + re-run, uncertain matches, artist merges, unmatched albums
 *  (manual search), incomplete tags (informational — the files imported via
 *  fallbacks and play fine), unreadable files, and the undoable log of what
 *  the automatic pass applied. */

interface MbCandidate {
  release_id: string;
  title: string;
  artist: string;
  date: string | null;
  track_count: number | null;
  score: number;
  country?: string | null;
  format?: string | null;
  label?: string | null;
  status?: string | null;
  disambiguation?: string | null;
}

interface MbSuggestion {
  id: number;
  kind: string;
  payload: {
    // album_match
    album_id?: number;
    album_title?: string;
    artist_title?: string | null;
    album_date?: string | null;
    album_tracks?: number;
    candidates?: MbCandidate[];
    // artist_merge
    keep_id?: number;
    keep_title?: string;
    other_name?: string;
  };
}

interface MbUnmatched {
  album_id: number;
  title: string;
  artist_title: string | null;
}

interface MbChange {
  id: number;
  kind: string;
  label: string;
  undone: boolean;
  created_at: string;
}

interface MbReview {
  suggestions: MbSuggestion[];
  unmatched: MbUnmatched[];
  changes: MbChange[];
}

export interface MusicMatchState {
  running: boolean;
  unchecked: number;
  pending_suggestions: number;
  unmatched: number;
  matched: number;
}

interface TagFallbackRow {
  track_id: number;
  file_path: string;
  missing: string[];
}

interface ScanIssueRow {
  file_path: string;
  reason: string;
}

interface MetadataCenterProps {
  libraryId: string;
  /** Re-fetch trigger — bump to reload (e.g. when the hosting dialog opens). */
  reloadKey?: number;
}

export function MetadataCenter({ libraryId, reloadKey = 0 }: MetadataCenterProps) {
  const [review, setReview] = useState<MbReview | null>(null);
  const [matchState, setMatchState] = useState<MusicMatchState | null>(null);
  const [fallbacks, setFallbacks] = useState<TagFallbackRow[]>([]);
  const [issues, setIssues] = useState<ScanIssueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Live progress of a running matching pass (re-run started here, or a
  // wizard pass still finishing in the background of this view).
  const [progress, setProgress] = useState<{ done: number; total: number; name: string; etaSecs: number | null } | null>(null);
  // Rolling per-step timestamps → avg gap × steps left = time remaining.
  const etaSamplesRef = useRef<{ phase: string; times: number[] }>({ phase: "", times: [] });
  // Per-suggestion chosen candidate; per-album manual search state.
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [searchFor, setSearchFor] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MbCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [rev, ms, fb, iss] = await Promise.all([
        invoke<MbReview>("mb_get_review", { libraryId }),
        invoke<MusicMatchState>("music_match_state", { libraryId }),
        invoke<TagFallbackRow[]>("get_music_tag_fallbacks", { libraryId }),
        invoke<ScanIssueRow[]>("get_music_scan_issues", { libraryId }),
      ]);
      setReview(rev);
      setMatchState(ms);
      setFallbacks(fb);
      setIssues(iss);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [libraryId]);

  useEffect(() => {
    setPicked({});
    setSearchFor(null);
    setSearchResults(null);
    refresh();
  }, [refresh, reloadKey]);

  // A pass runs behind this panel (re-run here, or still going from the
  // wizard): stream its progress and refresh when it lands.
  useEffect(() => {
    const unProgress = listen<{ phase: string; done: number; total: number; name: string }>(
      "music-enrich-progress",
      (e) => {
        const s = etaSamplesRef.current;
        if (s.phase !== e.payload.phase) {
          s.phase = e.payload.phase;
          s.times = [];
        }
        s.times.push(performance.now());
        if (s.times.length > 30) s.times.shift();
        let etaSecs: number | null = null;
        if (s.times.length >= 3) {
          const avgMs = (s.times[s.times.length - 1] - s.times[0]) / (s.times.length - 1);
          etaSecs = Math.round((avgMs * Math.max(0, e.payload.total - e.payload.done - 1)) / 1000);
        }
        setProgress({ done: e.payload.done, total: e.payload.total, name: e.payload.name, etaSecs });
      },
    );
    const unDone = listen<{ libraryId: string }>("music-enrich-done", (e) => {
      setProgress(null);
      if (e.payload.libraryId === libraryId) refresh();
    });
    return () => {
      unProgress.then((fn) => fn());
      unDone.then((fn) => fn());
    };
  }, [libraryId, refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(String(e));
    } finally {
      // Refresh even on failure — some errors dismiss the item they were
      // about (e.g. a stale merge suggestion), and the list must show that.
      await refresh();
      setBusy(false);
    }
  };

  const applyMatch = (albumId: number, releaseId: string) =>
    run(() => invoke("mb_apply_album_match", { libraryId, albumId, mbReleaseId: releaseId }));
  const resolve = (suggestionId: number, accept: boolean) =>
    run(() => invoke("mb_resolve_suggestion", { libraryId, suggestionId, accept }));
  const undo = (changeId: number) =>
    run(() => invoke("mb_undo_change", { libraryId, changeId }));

  const rerunMatching = async () => {
    try {
      await invoke("music_match_begin", { libraryId });
      setMatchState((s) => (s ? { ...s, running: true } : s));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const doSearch = async (albumId: number, query: string, artist: string | null) => {
    setSearching(true);
    setSearchFor(albumId);
    setSearchResults(null);
    try {
      setSearchResults(await invoke<MbCandidate[]>("mb_search_releases", { query, artist }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSearching(false);
    }
  };

  const albumSuggestions = review?.suggestions.filter((s) => s.kind === "album_match") ?? [];
  const mergeSuggestions = review?.suggestions.filter((s) => s.kind === "artist_merge") ?? [];

  const candidateRow = (c: MbCandidate) =>
    [
      c.artist,
      c.date,
      c.track_count != null ? `${c.track_count} tracks` : null,
      c.format,
      c.country,
      c.label,
      c.status && c.status !== "Official" ? c.status : null,
      c.disambiguation,
      `score ${c.score}`,
    ]
      .filter(Boolean)
      .join(" · ");

  const running = matchState?.running ?? false;

  if (loading && !review) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <Spinner className="size-6" />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
      {/* Match summary + re-run */}
      {matchState && (
        <section className="rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-muted-foreground">
              {[
                `${matchState.matched} matched`,
                matchState.pending_suggestions > 0 ? `${matchState.pending_suggestions} pending review` : null,
                matchState.unmatched > 0 ? `${matchState.unmatched} not found` : null,
                matchState.unchecked > 0 ? `${matchState.unchecked} never matched` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {matchState.unchecked > 0 && !running && (
              <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={rerunMatching}>
                <RefreshCw size={13} />
                Match {matchState.unchecked} {matchState.unchecked === 1 ? "album" : "albums"}
              </Button>
            )}
          </div>
          {running && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              <span className="min-w-0 truncate">
                {progress
                  ? `Matching ${progress.done + 1}/${progress.total} — ${progress.name}${
                      progress.etaSecs != null && progress.etaSecs >= 60
                        ? ` · ~${Math.round(progress.etaSecs / 60)} min left`
                        : ""
                    }`
                  : "Matching against MusicBrainz…"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-xs"
                onClick={() => invoke("music_match_skip").catch(() => {})}
              >
                Skip remaining
              </Button>
            </div>
          )}
        </section>
      )}

      {/* Uncertain album matches */}
      {albumSuggestions.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Uncertain matches ({albumSuggestions.length})
          </h3>
          <div className="space-y-3">
            {albumSuggestions.map((s) => (
              <div key={s.id} className="rounded-md border p-3">
                <p className="text-sm font-medium">
                  {s.payload.album_title}
                  {s.payload.artist_title && (
                    <span className="text-muted-foreground"> — {s.payload.artist_title}</span>
                  )}
                </p>
                {/* What WE have, so the candidates can be compared. */}
                <p className="text-xs text-muted-foreground">
                  Your copy:{" "}
                  {[
                    s.payload.album_date ?? "no date",
                    s.payload.album_tracks != null ? `${s.payload.album_tracks} tracks` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <div className="mt-2 space-y-1">
                  {(s.payload.candidates ?? []).map((c) => (
                    <label key={c.release_id} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/50">
                      <input
                        type="radio"
                        name={`cand-${s.id}`}
                        className="mt-1"
                        checked={picked[s.id] === c.release_id}
                        onChange={() => setPicked((p) => ({ ...p, [s.id]: c.release_id }))}
                      />
                      <span className="min-w-0">
                        <span className="block">{c.title}</span>
                        <span className="block text-xs text-muted-foreground">{candidateRow(c)}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !picked[s.id]}
                    onClick={() => s.payload.album_id != null && applyMatch(s.payload.album_id, picked[s.id])}
                  >
                    Apply
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => resolve(s.id, false)}>
                    None of these
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Artist merges */}
      {mergeSuggestions.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Artist merges ({mergeSuggestions.length})
          </h3>
          <div className="space-y-2">
            {mergeSuggestions.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <p className="min-w-0 text-sm">
                  <GitMerge size={14} className="mr-1.5 inline text-muted-foreground" />
                  Merge <span className="font-medium">“{s.payload.other_name}”</span> into{" "}
                  <span className="font-medium">“{s.payload.keep_title}”</span>
                </p>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" disabled={busy} onClick={() => resolve(s.id, true)}>
                    Merge
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => resolve(s.id, false)}>
                    Keep separate
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Unmatched albums — manual search */}
      {(review?.unmatched.length ?? 0) > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Not found on MusicBrainz ({review!.unmatched.length})
          </h3>
          <div className="space-y-2">
            {review!.unmatched.map((u) => (
              <div key={u.album_id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm">
                    <span className="font-medium">{u.title}</span>
                    {u.artist_title && <span className="text-muted-foreground"> — {u.artist_title}</span>}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || searching}
                    onClick={() => {
                      setSearchQuery(u.title);
                      doSearch(u.album_id, u.title, u.artist_title);
                    }}
                  >
                    <Search size={13} />
                    Search
                  </Button>
                </div>
                {searchFor === u.album_id && (
                  <div className="mt-2">
                    <div className="flex gap-2">
                      <Input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") doSearch(u.album_id, searchQuery, u.artist_title);
                        }}
                        className="h-8 text-sm"
                        placeholder="Search MusicBrainz releases…"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={searching}
                        onClick={() => doSearch(u.album_id, searchQuery, u.artist_title)}
                      >
                        Go
                      </Button>
                    </div>
                    {searching ? (
                      <div className="flex justify-center py-3">
                        <Spinner className="size-4" />
                      </div>
                    ) : (
                      searchResults && (
                        <div className="mt-2 space-y-1">
                          {searchResults.length === 0 && (
                            <p className="px-1 text-xs text-muted-foreground">No results.</p>
                          )}
                          {searchResults.map((c) => (
                            <div key={c.release_id} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/50">
                              <span className="min-w-0">
                                <span className="block truncate">{c.title}</span>
                                <span className="block text-xs text-muted-foreground">{candidateRow(c)}</span>
                              </span>
                              <Button size="sm" disabled={busy} onClick={() => applyMatch(u.album_id, c.release_id)}>
                                Apply
                              </Button>
                            </div>
                          ))}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Nothing pending */}
      {review &&
        !running &&
        albumSuggestions.length === 0 &&
        mergeSuggestions.length === 0 &&
        review.unmatched.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
            <CircleCheck size={32} />
            <p className="text-sm">Nothing needs matching.</p>
          </div>
        )}

      {/* Incomplete tags — informational; the files imported and play fine. */}
      {fallbacks.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Incomplete tags ({fallbacks.length})
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            These files imported with fallbacks for the missing fields. They play normally; fix the
            tags externally and rescan whenever you like.
          </p>
          <div className="overflow-hidden rounded-md border">
            {fallbacks.map((f, i) => (
              <div key={f.track_id} className={`px-3 py-1.5 text-sm ${i > 0 ? "border-t" : ""}`}>
                <span className="block min-w-0 truncate font-mono text-xs" title={f.file_path}>
                  <FileWarning size={12} className="mr-1.5 inline text-muted-foreground" />
                  {f.file_path}
                </span>
                <span className="block text-xs text-muted-foreground">missing {f.missing.join(", ")}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Unreadable files — the only thing the scanner refuses. */}
      {issues.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Unreadable files ({issues.length})
          </h3>
          <div className="overflow-hidden rounded-md border">
            {issues.map((iss, i) => (
              <div key={iss.file_path} className={`px-3 py-1.5 text-sm ${i > 0 ? "border-t" : ""}`}>
                <span className="block min-w-0 truncate font-mono text-xs" title={iss.file_path}>
                  <TriangleAlert size={12} className="mr-1.5 inline text-muted-foreground" />
                  {iss.file_path}
                </span>
                <span className="block text-xs text-muted-foreground">{iss.reason}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Applied-changes log */}
      {(review?.changes.length ?? 0) > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Applied changes
          </h3>
          <div className="overflow-hidden rounded-md border">
            {review!.changes.map((c, i) => (
              <div
                key={c.id}
                className={`flex items-center justify-between gap-3 px-3 py-1.5 text-sm ${i > 0 ? "border-t" : ""} ${c.undone ? "opacity-50" : ""}`}
              >
                <span className="min-w-0 truncate" title={c.label}>
                  {c.label}
                </span>
                {c.undone ? (
                  <span className="shrink-0 text-xs text-muted-foreground">undone</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
                    disabled={busy}
                    onClick={() => undo(c.id)}
                  >
                    <Undo2 size={12} />
                    Undo
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface MetadataCenterDialogProps {
  libraryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Standalone host — the sidebar's always-available entrance to the center. */
export function MetadataCenterDialog({ libraryId, open, onOpenChange }: MetadataCenterDialogProps) {
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (open) setReloadKey((k) => k + 1);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Metadata center</DialogTitle>
        </DialogHeader>
        {libraryId && open && <MetadataCenter libraryId={libraryId} reloadKey={reloadKey} />}
      </DialogContent>
    </Dialog>
  );
}
