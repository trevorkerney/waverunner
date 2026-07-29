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
import { Search, Undo2, GitMerge, CircleCheck, RefreshCw, FileWarning, TriangleAlert, ChevronRight, Scissors } from "lucide-react";
import { MatchDialog } from "./MatchDialog";
import { SplitArtistDialog } from "./EditDialogs";

/** The metadata matching/cleaning center — the permanent home for a music
 *  library's external-source state. Two entrances: the import wizard's final
 *  step embeds it, and the sidebar opens it any time after. Sections: match
 *  summary + re-run, uncertain matches, artist merges, unmatched albums
 *  (manual search), incomplete tags (informational — the files imported via
 *  fallbacks and play fine), unreadable files, and the undoable log of what
 *  the automatic pass applied. */

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
    /** Candidate release groups — the pass no longer guesses a pressing. */
    groups?: {
      group_id: string;
      title: string;
      artist: string;
      album_type: string | null;
      first_release_date: string | null;
      disambiguation: string | null;
      score: number;
    }[];
    // artist_merge
    keep_id?: number;
    keep_title?: string;
    other_name?: string;
    // artist_split
    artist_id?: number;
    artist_name?: string;
    parts?: string[];
  };
}

type MbAlbumState = "release" | "album" | "notfound" | "unchecked";

interface MbAlbumRow {
  album_id: number;
  title: string;
  artist_title: string | null;
  state: MbAlbumState;
  gap_ours: number;
  gap_mb: number;
}

interface MbChange {
  /** The batch — one ACTION, however many rows it wrote. Undo takes this. */
  id: number;
  kind: string;
  label: string;
  undone: boolean;
  created_at: string;
  /** Rows this action wrote; 1 for most. */
  change_count: number;
  kinds: string[];
}

interface MbGapRow {
  /** "ours" — in your library; "mb" — on the matched release. */
  side: "ours" | "mb";
  disc: number;
  position: number;
  title: string;
  /** MusicBrainz's title at the same slot, when both sides have one. */
  counterpart: string | null;
}

interface MbGapAlbum {
  album_id: number;
  title: string;
  artist_title: string | null;
  rows: MbGapRow[];
}

type MbArtistState = "matched" | "notfound" | "unchecked";

interface MbArtistRow {
  artist_id: number;
  title: string;
  state: MbArtistState;
  album_count: number;
}

interface MbReview {
  suggestions: MbSuggestion[];
  albums: MbAlbumRow[];
  artists: MbArtistRow[];
  gaps: MbGapAlbum[];
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
  /** Fired after library data changes underneath (match applied, undo,
   *  suggestion resolved, or a re-run pass landing) so the host can refresh
   *  the pages behind this panel. */
  onChanged?: () => void;
}

type PaneId = "albums" | "artists" | "review" | "gaps" | "files" | "history";

const STATE_ORDER: MbAlbumState[] = ["release", "album", "notfound", "unchecked"];
const STATE_LABEL: Record<MbAlbumState, string> = {
  release: "matched to a release",
  album: "matched to an album only",
  notfound: "not matched",
  unchecked: "never checked",
};

/** A titled block that stays shut until asked. For lists that are long by
 *  nature and not actionable here — file paths the user fixes elsewhere. */
function Collapsible({
  title,
  note,
  open,
  onToggle,
  children,
}: {
  title: string;
  note?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <ChevronRight size={13} className={open ? "rotate-90 transition-transform" : "transition-transform"} />
        {title}
      </button>
      {open && (
        <>
          {note && <p className="mb-2 mt-1.5 text-xs text-muted-foreground">{note}</p>}
          <div className="overflow-hidden rounded-md border text-sm">{children}</div>
        </>
      )}
    </section>
  );
}

function ArtistRow({
  a,
  first,
  onMatch,
  onSplit,
}: {
  a: MbArtistRow;
  first: boolean;
  onMatch: (id: number) => void;
  /** Unidentified rows only — a name MusicBrainz can't place is very often
   *  several artists in one tag, and that is the fix. */
  onSplit?: (a: MbArtistRow) => void;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-1.5 text-sm ${first ? "" : "border-t"}`}>
      <span className="min-w-0 flex-1 truncate">
        {a.title}
        <span className="ml-1.5 text-[11px] text-muted-foreground">
          {a.album_count} {a.album_count === 1 ? "release" : "releases"}
        </span>
      </span>
      {onSplit && a.state !== "matched" && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 gap-1 px-2 text-xs"
          onClick={() => onSplit(a)}
        >
          <Scissors size={12} />
          Split
        </Button>
      )}
      {/* An identified artist's button states the fact rather than repeating
          the invitation — it still opens the dialog, where you can look at
          the id or unmatch. */}
      <Button
        size="sm"
        variant="ghost"
        className={`h-6 shrink-0 gap-1 px-2 text-xs ${
          a.state === "matched" ? "text-emerald-400 hover:text-emerald-300" : ""
        }`}
        onClick={() => onMatch(a.artist_id)}
      >
        {a.state === "matched" ? (
          <>
            <CircleCheck size={12} className="-translate-y-px" />
            Matched
          </>
        ) : (
          <>
            <Search size={12} />
            Match
          </>
        )}
      </Button>
    </div>
  );
}

/** Change kinds in the log → words. */
const KIND_WORD: Record<string, string> = {
  track_credits: "credits",
  album_artists: "album artist",
  album_type: "type",
  album_year: "date",
  artist_merge: "artist merge",
  artist_mbid: "artist match",
};
const KIND_LABELS = (kinds: string[]) =>
  kinds.map((k) => KIND_WORD[k] ?? k).join(", ");

export function MetadataCenter({ libraryId, reloadKey = 0, onChanged }: MetadataCenterProps) {
  const [review, setReview] = useState<MbReview | null>(null);
  const [matchState, setMatchState] = useState<MusicMatchState | null>(null);
  const [fallbacks, setFallbacks] = useState<TagFallbackRow[]>([]);
  const [issues, setIssues] = useState<ScanIssueRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Which mutation is in flight ("apply:…", "resolve:…", "undo:…") — the
  // matching button shows a spinner; everything else just disables.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busy = busyKey !== null;
  // Live progress of a running matching pass (re-run started here, or a
  // wizard pass still finishing in the background of this view).
  const [progress, setProgress] = useState<{ done: number; total: number; name: string; etaSecs: number | null } | null>(null);
  // Rolling per-step timestamps → avg gap × steps left = time remaining.
  const etaSamplesRef = useRef<{ phase: string; times: number[] }>({ phase: "", times: [] });
  // Per-suggestion chosen candidate; per-album manual search state.
  const [picked, setPicked] = useState<Record<number, string>>({});
  // Which state the album list is showing, plus its text filter and paging.
  const [filter, setFilter] = useState<MbAlbumState | null>(null);
  const [albumFilter, setAlbumFilter] = useState("");
  const [albumLimit, setAlbumLimit] = useState(50);
  // Album / artist opened in the shared match dialog.
  const [matchAlbum, setMatchAlbum] = useState<number | null>(null);
  const [matchArtist, setMatchArtist] = useState<number | null>(null);
  const [splitArtist, setSplitArtist] = useState<MbArtistRow | null>(null);
  const [artistFilter, setArtistFilter] = useState("");
  const [artistLimit, setArtistLimit] = useState(30);
  // Which pane the right-hand side is showing.
  const [pane, setPane] = useState<PaneId>("artists");
  const [hideUndone, setHideUndone] = useState(false);
  const [changeLimit, setChangeLimit] = useState(25);

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
    refresh();
  }, [refresh, reloadKey]);

  useEffect(() => {
    setAlbumLimit(50);
  }, [filter, albumFilter]);

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
      if (e.payload.libraryId === libraryId) {
        refresh();
        onChanged?.();
      }
    });
    return () => {
      unProgress.then((fn) => fn());
      unDone.then((fn) => fn());
    };
  }, [libraryId, refresh, onChanged]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await fn();
    } catch (e) {
      toast.error(String(e));
    } finally {
      // Refresh even on failure — some errors dismiss the item they were
      // about (e.g. a stale merge suggestion), and the list must show that.
      await refresh();
      setBusyKey(null);
      onChanged?.();
    }
  };

  const applyMatch = (albumId: number, groupId: string) =>
    run(`apply:${albumId}:${groupId}`, () =>
      invoke("mb_apply_entity_match", {
        kind: "album",
        entityId: albumId,
        mbid: groupId,
        mbidKind: "release-group",
      }),
    );
  const resolve = (suggestionId: number, accept: boolean) =>
    run(`resolve:${suggestionId}:${accept}`, () =>
      invoke("mb_resolve_suggestion", { libraryId, suggestionId, accept }),
    );
  const undo = (batchId: number) =>
    run(`undo:${batchId}`, () => invoke("mb_undo_batch", { libraryId, batchId }));
  const recheck = (albumId: number) =>
    run(`recheck:${albumId}`, async () => {
      const g = await invoke<{ ours: number; mb: number }>("mb_recheck_album", { albumId });
      const parts = [
        g.ours > 0 && `${g.ours} of your tracks unmatched`,
        g.mb > 0 && `${g.mb} on the release missing here`,
      ].filter(Boolean);
      toast.success(parts.length === 0 ? "Track lists line up now." : `Still ${parts.join(" · ")}.`);
    });
  const dismissGaps = (albumId: number) =>
    run(`gaps:${albumId}`, () => invoke("mb_dismiss_gaps", { albumId }));

  const rerunMatching = async () => {
    try {
      await invoke("music_match_begin", { libraryId });
      setMatchState((s) => (s ? { ...s, running: true } : s));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const albums = review?.albums ?? [];
  const counts = STATE_ORDER.reduce(
    (acc, st) => ({ ...acc, [st]: albums.filter((a) => a.state === st).length }),
    {} as Record<MbAlbumState, number>,
  );
  const shown = albums.filter(
    (a) =>
      (filter === null || a.state === filter) &&
      (albumFilter.trim() === "" ||
        `${a.title} ${a.artist_title ?? ""}`.toLowerCase().includes(albumFilter.trim().toLowerCase())),
  );
  const visibleChanges = (review?.changes ?? []).filter((c) => !hideUndone || !c.undone);
  const artists = review?.artists ?? [];
  const artistMatches = (a: MbArtistRow) =>
    artistFilter.trim() === "" || a.title.toLowerCase().includes(artistFilter.trim().toLowerCase());
  const artistsUnmatched = artists.filter((a) => a.state !== "matched" && artistMatches(a));
  const artistsIdentified = artists.filter((a) => a.state === "matched" && artistMatches(a));
  const artistsMatched = artists.filter((a) => a.state === "matched").length;

  const albumSuggestions = review?.suggestions.filter((s) => s.kind === "album_match") ?? [];
  const mergeSuggestions = review?.suggestions.filter((s) => s.kind === "artist_merge") ?? [];

  const running = matchState?.running ?? false;

  if (loading && !review) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <Spinner className="size-6" />
      </div>
    );
  }

  // `count` is the size of the pane; `warn` is how much of it still wants
  // attention. They differ for Albums and Artists, where most rows are fine.
  const NAV: { id: PaneId; label: string; count: number; warn?: number }[] = [
    {
      id: "artists",
      label: "Artists",
      count: artists.length,
      warn: artists.filter((a) => a.state !== "matched").length,
    },
    {
      id: "albums",
      label: "Albums",
      count: albums.length,
      warn: counts.notfound + counts.unchecked,
    },
    {
      id: "review",
      label: "Needs a decision",
      count: albumSuggestions.length + mergeSuggestions.length,
      warn: albumSuggestions.length + mergeSuggestions.length,
    },
    {
      id: "gaps",
      label: "Track lists differ",
      count: review?.gaps.length ?? 0,
      warn: review?.gaps.length ?? 0,
    },
    {
      id: "files",
      label: "File problems",
      count: fallbacks.length + issues.length,
      warn: issues.length,
    },
    { id: "history", label: "History", count: review?.changes.length ?? 0 },
  ];

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {/* Nav rail: every section at a glance with its size, so nothing hides
          below a fold and the panel stops being one long scroll. */}
      <nav className="flex w-64 shrink-0 flex-col gap-0.5 border-r pr-2">
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setPane(n.id)}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              pane === n.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{n.label}</span>
            {(n.warn ?? 0) > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-amber-300">
                <TriangleAlert size={12} />
                {n.warn}
              </span>
            )}
            {n.count > 0 && (
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {n.count}
              </span>
            )}
          </button>
        ))}
        {running && (
          <div className="mt-2 border-t pt-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              <span className="min-w-0 truncate">
                {progress ? `${progress.done + 1}/${progress.total}` : "Matching…"}
              </span>
            </div>
            {progress && (
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{progress.name}</p>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 h-6 w-full px-2 text-xs"
              onClick={() => invoke("music_match_skip").catch(() => {})}
            >
              Skip remaining
            </Button>
          </div>
        )}
      </nav>

      {/* pt-1 so a focused input's ring isn't clipped by the scroll box —
          the filter field sits flush against the top of this container. */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-4 pt-1">
      {/* Where the library stands. Every number is a tally of `albums` below,
          so the summary and the list can never disagree — and each is a
          filter, because a count you can't open is just trivia. */}
      {pane === "albums" && (
      <section className="rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {STATE_ORDER.filter((s) => s === filter || counts[s] > 0 || s === "release").map((s) => (
            <button
              key={s}
              onClick={() => setFilter(filter === s ? null : s)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                filter === s
                  ? "border-primary bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="font-medium tabular-nums">{counts[s]}</span> {STATE_LABEL[s]}
            </button>
          ))}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {albums.length} albums
          </span>
          {counts.unchecked > 0 && !running && (
            <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={rerunMatching}>
              <RefreshCw size={13} />
              Match {counts.unchecked}
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
      {pane === "review" && albumSuggestions.length > 0 && (
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
                {/* More than one album on MusicBrainz answers to this name,
                    which is exactly when a machine should not choose. */}
                <p className="text-xs text-muted-foreground">
                  {(s.payload.groups ?? []).length} albums share this name
                </p>
                <div className="mt-2 space-y-1">
                  {(s.payload.groups ?? []).map((g) => (
                    <label
                      key={g.group_id}
                      className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/50"
                    >
                      <input
                        type="radio"
                        name={`cand-${s.id}`}
                        className="mt-1"
                        checked={picked[s.id] === g.group_id}
                        onChange={() => setPicked((p) => ({ ...p, [s.id]: g.group_id }))}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block">{g.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {[g.artist, g.album_type, g.first_release_date, g.disambiguation]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      {/* Two candidates can render identically — MusicBrainz
                          has genuine near-duplicate groups — so every row
                          carries a way to go look at the real thing. */}
                      <a
                        href={`https://musicbrainz.org/release-group/${g.group_id}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0 self-center text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        view
                      </a>
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={busy || !picked[s.id]}
                    onClick={() => s.payload.album_id != null && applyMatch(s.payload.album_id, picked[s.id])}
                  >
                    {busyKey === `apply:${s.payload.album_id}:${picked[s.id]}` && <Spinner className="size-3" />}
                    Apply
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={busy}
                    onClick={() => resolve(s.id, false)}
                  >
                    {busyKey === `resolve:${s.id}:false` && <Spinner className="size-3" />}
                    None of these
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Artist merges */}
      {pane === "review" && mergeSuggestions.length > 0 && (
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
                  <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => resolve(s.id, true)}>
                    {busyKey === `resolve:${s.id}:true` && <Spinner className="size-3" />}
                    Merge
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={busy}
                    onClick={() => resolve(s.id, false)}
                  >
                    {busyKey === `resolve:${s.id}:false` && <Spinner className="size-3" />}
                    Keep separate
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* One album list, filtered by the header. Compact rows: 42 fat cards
          was already a wall, and "album only" has 187 of them. */}
      {pane === "albums" && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {filter ? STATE_LABEL[filter] : "All albums"} ({shown.length})
            </h3>
            <Input
              value={albumFilter}
              onChange={(e) => setAlbumFilter(e.target.value)}
              placeholder="Filter…"
              className="ml-auto h-7 w-44 text-xs"
            />
          </div>
          <div className="overflow-hidden rounded-md border">
            {shown.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">Nothing here.</p>
            )}
            {shown.slice(0, albumLimit).map((a, i) => (
              <div
                key={a.album_id}
                className={`flex items-center gap-3 px-3 py-1.5 text-sm ${i > 0 ? "border-t" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {a.title}
                  {a.artist_title && (
                    <span className="text-muted-foreground"> — {a.artist_title}</span>
                  )}
                  {(a.gap_ours > 0 || a.gap_mb > 0) && (
                    <span className="ml-1.5 text-[11px] text-amber-300">
                      {[a.gap_ours > 0 && `${a.gap_ours} unmatched`, a.gap_mb > 0 && `${a.gap_mb} missing`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 gap-1 px-2 text-xs"
                  onClick={() => setMatchAlbum(a.album_id)}
                >
                  <Search size={12} />
                  Match
                </Button>
              </div>
            ))}
            {shown.length > albumLimit && (
              <button
                onClick={() => setAlbumLimit((n) => n + 100)}
                className="w-full border-t px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Show {Math.min(100, shown.length - albumLimit)} more of {shown.length}
              </button>
            )}
          </div>
        </section>
      )}


      {pane === "artists" && (
        <section>
          <div className="mb-8 flex items-center gap-2">
            {/* Numbers hold the larger size; the words step down and go to
                caps, so the counts read as the headline. */}
            <h3 className="text-lg font-semibold uppercase tracking-wide text-foreground">
              <span className="text-xl">{artistsMatched}</span> of{" "}
              <span className="text-xl">{artists.length}</span> artists identified
            </h3>
            <Input
              value={artistFilter}
              onChange={(e) => setArtistFilter(e.target.value)}
              placeholder="Filter…"
              className="ml-auto h-7 w-44 text-xs"
            />
          </div>
          {/* Unidentified first and in full — an artist's id is resolved from
              its NAME, so these are the ones that need a person. The matched
              ones are reference rather than work, so they sit below, cut short. */}
          {artistsUnmatched.length > 0 && (
            <div className="mb-8">
              <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-amber-300">
                <TriangleAlert size={14} />
                Unidentified ({artistsUnmatched.length})
              </h4>
              <div className="overflow-hidden rounded-md border border-amber-500/30">
                {artistsUnmatched.map((a, i) => (
                  <ArtistRow key={a.artist_id} a={a} first={i === 0} onMatch={setMatchArtist} />
                ))}
              </div>
            </div>
          )}

          {artistsIdentified.length > 0 && (
            <>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-emerald-400">
                <CircleCheck size={14} className="-translate-y-px" />
                Identified ({artistsIdentified.length})
              </h4>
              <div className="overflow-hidden rounded-md border border-emerald-500/30">
                {artistsIdentified.slice(0, artistLimit).map((a, i) => (
                  <ArtistRow key={a.artist_id} a={a} first={i === 0} onMatch={setMatchArtist} />
                ))}
                {artistsIdentified.length > artistLimit && (
                  <button
                    onClick={() => setArtistLimit((n) => n + 100)}
                    className="w-full border-t px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Show more of {artistsIdentified.length}
                  </button>
                )}
              </div>
            </>
          )}
          {artistsUnmatched.length === 0 && artistsIdentified.length === 0 && (
            <p className="px-1 py-2 text-xs text-muted-foreground">Nothing here.</p>
          )}
        </section>
      )}

      {/* Matched, but the track lists disagree */}
      {pane === "gaps" && (review?.gaps.length ?? 0) > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Track lists that don’t line up ({review!.gaps.length})
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            These albums matched, but some tracks couldn’t be paired with the release. MusicBrainz
            data — artist credits included — was <span className="font-medium">not</span> applied to
            those tracks, so they keep whatever their tags said. Fix the tags at the source, rescan,
            then <span className="font-medium">Re-check</span>. <span className="font-medium">Ignore</span> just
            hides the warning — nothing about the match or your files changes, and it returns on the
            next check.
          </p>
          <div className="space-y-2">
            {review!.gaps.map((g) => {
              const mine = g.rows.filter((r) => r.side === "ours").length;
              const theirs = g.rows.length - mine;
              return (
                <div
                  key={g.album_id}
                  className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 break-words text-sm">
                      <span className="font-medium">{g.title}</span>
                      {g.artist_title && (
                        <span className="text-muted-foreground"> — {g.artist_title}</span>
                      )}
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-200/90">
                        <TriangleAlert size={12} className="shrink-0" />
                        {[
                          mine > 0 && `${mine} of your track${mine === 1 ? "" : "s"} unmatched`,
                          theirs > 0 && `${theirs} on the release missing here`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </p>
                    <div className="flex shrink-0 gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={busy}
                        onClick={() => recheck(g.album_id)}
                      >
                        {busyKey === `recheck:${g.album_id}` && <Spinner className="size-3" />}
                        Re-check
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => dismissGaps(g.album_id)}
                      >
                        Ignore
                      </Button>
                    </div>
                  </div>
                  <ul className="mt-2 space-y-0.5">
                    {[...g.rows]
                      .sort((a, b) => (a.side === b.side ? 0 : a.side === "ours" ? -1 : 1))
                      .slice(0, 12)
                      .map((r) => (
                      <li
                        key={`${r.side}-${r.disc}-${r.position}`}
                        className="flex gap-2 text-xs text-muted-foreground"
                      >
                        <span className="shrink-0 tabular-nums opacity-70">
                          {r.disc}·{r.position}
                        </span>
                        <span className="min-w-0 break-words">
                          {r.side === "mb" ? (
                            <>
                              “{r.title}” — on MusicBrainz, nothing here
                            </>
                          ) : r.counterpart ? (
                            <>
                              “{r.title}” — MusicBrainz has “
                              <span className="text-foreground">{r.counterpart}</span>”
                            </>
                          ) : (
                            <>“{r.title}” — nothing at this position on MusicBrainz</>
                          )}
                        </span>
                      </li>
                    ))}
                    {g.rows.length > 12 && (
                      <li className="text-xs text-muted-foreground">
                        …and {g.rows.length - 12} more
                      </li>
                    )}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Nothing pending */}
      {pane === "review" &&
        review &&
        !running &&
        albumSuggestions.length === 0 &&
        mergeSuggestions.length === 0 &&
        counts.notfound === 0 &&
        review.gaps.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
            <CircleCheck size={32} />
            <p className="text-sm">Nothing needs matching.</p>
          </div>
        )}

      {/* File-level notes. Both are long by nature and neither is actionable
          inside waverunner, so they collapse to a line you open on purpose. */}
      {pane === "files" && fallbacks.length > 0 && (
        <Collapsible
          title={`Incomplete tags (${fallbacks.length})`}
          note="Imported with fallbacks for the missing fields. They play normally — fix the tags externally and rescan."
          open
          onToggle={() => {}}
        >
          {fallbacks.map((f, i) => (
            <div key={f.track_id} className={`px-3 py-1.5 ${i > 0 ? "border-t" : ""}`}>
              <span className="block min-w-0 break-all font-mono text-xs">
                <FileWarning size={12} className="mr-1.5 inline text-muted-foreground" />
                {f.file_path}
              </span>
              <span className="block text-xs text-muted-foreground">missing {f.missing.join(", ")}</span>
            </div>
          ))}
        </Collapsible>
      )}

      {pane === "files" && issues.length > 0 && (
        <Collapsible
          title={`Unreadable files (${issues.length})`}
          note="The scanner could not read these at all."
          open
          onToggle={() => {}}
        >
          {issues.map((iss, i) => (
            <div key={iss.file_path} className={`px-3 py-1.5 ${i > 0 ? "border-t" : ""}`}>
              <span className="block min-w-0 break-all font-mono text-xs">
                <TriangleAlert size={12} className="mr-1.5 inline text-muted-foreground" />
                {iss.file_path}
              </span>
              <span className="block text-xs text-muted-foreground">{iss.reason}</span>
            </div>
          ))}
        </Collapsible>
      )}


      {/* Applied-changes log — an action per row, newest first, collapsed to a
          recent window. The label carries the album; the kinds line says what
          the action touched, so Undo's scope is visible before clicking. */}
      {pane === "history" && (review?.changes.length ?? 0) > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Applied changes ({review!.changes.length})
            </h3>
            {review!.changes.some((c) => c.undone) && (
              <button
                onClick={() => setHideUndone((v) => !v)}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground"
              >
                {hideUndone ? "Show undone" : "Hide undone"}
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-md border">
            {visibleChanges.slice(0, changeLimit).map((c, i) => (
              <div
                key={c.id}
                className={`flex items-baseline gap-3 px-3 py-1.5 ${i > 0 ? "border-t" : ""} ${
                  c.undone ? "opacity-45" : ""
                }`}
              >
                <span className="w-16 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {c.created_at.slice(5, 10)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{c.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {KIND_LABELS(c.kinds)}
                    {c.change_count > 1 ? ` · ${c.change_count} changes` : ""}
                  </span>
                </span>
                {c.undone ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">undone</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
                    disabled={busy}
                    onClick={() => undo(c.id)}
                  >
                    {busyKey === `undo:${c.id}` ? <Spinner className="size-3" /> : <Undo2 size={12} />}
                    Undo
                  </Button>
                )}
              </div>
            ))}
            {visibleChanges.length > changeLimit && (
              <button
                onClick={() => setChangeLimit((n) => n + 50)}
                className="w-full border-t px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Show more of {visibleChanges.length}
              </button>
            )}
          </div>
        </section>
      )}

      {pane === "gaps" && (review?.gaps.length ?? 0) === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Every matched album's track list agrees with its release.
        </p>
      )}
      {pane === "files" && fallbacks.length === 0 && issues.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Every file read cleanly and carried the tags it needed.
        </p>
      )}
      {pane === "history" && (review?.changes.length ?? 0) === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Nothing has been applied yet.
        </p>
      )}

      {splitArtist && (
          <SplitArtistDialog
            artistId={splitArtist.artist_id}
            artistName={splitArtist.title}
            open={splitArtist !== null}
            onOpenChange={(o) => !o && setSplitArtist(null)}
          />
        )}
      {matchArtist != null && (
          <MatchDialog
            kind="artist"
            entityId={matchArtist}
            open={matchArtist != null}
            onOpenChange={(o) => !o && setMatchArtist(null)}
            onChanged={() => {
              refresh();
              onChanged?.();
            }}
          />
        )}
      {matchAlbum != null && (
          <MatchDialog
            kind="album"
            entityId={matchAlbum}
            open={matchAlbum != null}
            onOpenChange={(o) => !o && setMatchAlbum(null)}
            onChanged={() => {
              refresh();
              onChanged?.();
            }}
          />
        )}
      </div>
    </div>
  );
}

interface MetadataCenterDialogProps {
  libraryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}

/** Standalone host — the sidebar's always-available entrance to the center. */
export function MetadataCenterDialog({ libraryId, open, onOpenChange, onChanged }: MetadataCenterDialogProps) {
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (open) setReloadKey((k) => k + 1);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-[min(72rem,calc(100vw-3rem))] max-w-none flex-col overflow-hidden pr-0">
        <DialogHeader>
          <DialogTitle>Metadata center</DialogTitle>
        </DialogHeader>
        {libraryId && open && (
          <MetadataCenter libraryId={libraryId} reloadKey={reloadKey} onChanged={onChanged} />
        )}
      </DialogContent>
    </Dialog>
  );
}
