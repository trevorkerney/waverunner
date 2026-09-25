import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { fmtEta, useLibraryRuns, type MatchRun, type PromptRun, type ScanRun } from "@/hooks/libraryRuns";
import type { Library, TmdbBulkTargets } from "@/types";

/** The in-page faces of a library run (see hooks/libraryRuns): the scan
 *  view that stands in for a library while it's being built, and the banner
 *  that asks about / shows the matching pass above a browsable library. */

/** The matching pass's phases, in the order the backend runs them (see
 *  music_mb::enrich). Artist images are NOT a phase any more — they're a
 *  background job the pass hands off to at its end. */
export const MATCH_STAGES = [
  ["albums", "Matching albums"],
  ["titles", "Applying track titles"],
  ["artist-ids", "Identifying artists"],
  ["artist-credits", "Reading album credits"],
  ["dates", "Filling release dates"],
  ["artist-search", "Searching artists"],
] as const;
const SCAN_STAGES = [
  ["read-tags", "Reading tags"],
  ["build", "Building the library"],
] as const;

/** Segmented progress across a run's stages: one thin segment per stage,
 *  filled as stages finish, the current one pulsing. Finished stages carry
 *  their item count in the segment's hover title. */
function StageBar({
  stages,
  currentKey,
  sub,
  className = "",
}: {
  stages: readonly (readonly [string, string])[];
  currentKey: string | null | undefined;
  sub: Record<string, { done: number; total: number }>;
  className?: string;
}) {
  const currentIdx = stages.findIndex(([k]) => k === currentKey);
  return (
    <div className={`flex gap-1 ${className}`}>
      {stages.map(([key, label], i) => {
        const state =
          currentIdx === -1 ? "pending" : i < currentIdx ? "done" : i === currentIdx ? "current" : "pending";
        const p = sub[key];
        return (
          <span
            key={key}
            title={state === "done" && p ? `${label} · ${p.total}` : label}
            className={`h-1 flex-1 rounded-full ${
              state === "done" ? "bg-primary" : state === "current" ? "animate-pulse bg-primary/60" : "bg-border"
            }`}
          />
        );
      })}
    </div>
  );
}

function stageLine(stages: readonly (readonly [string, string])[], currentKey: string | null | undefined) {
  const idx = stages.findIndex(([k]) => k === currentKey);
  if (idx === -1) return "Starting…";
  return `Stage ${idx + 1} of ${stages.length} · ${stages[idx][1]}`;
}

// ---------------------------------------------------------------------------
// Scan view
// ---------------------------------------------------------------------------

/** Stands in for the library's page while its scan runs. */
export function LibraryScanView({ run }: { run: ScanRun }) {
  const { stopScan } = useLibraryRuns();
  const phased = run.phase != null && run.total != null;
  const headline =
    run.phase === "read-tags"
      ? "Reading file tags"
      : run.phase === "build"
        ? "Building your library"
        : "Scanning your library…";
  return (
    <main className="flex flex-1 flex-col items-center justify-center overflow-hidden bg-background px-6 text-center">
      <div className="flex w-full max-w-md flex-col items-center gap-3">
        <Spinner className="size-6" />
        <p className="text-sm font-medium">
          {run.isCreate ? "Creating" : "Rescanning"} “{run.name}”
        </p>
        <p className="w-full min-w-0 truncate text-sm">
          {headline}
          {phased ? ` — ${Math.min((run.done ?? 0) + 1, run.total!)}/${run.total}` : ""}
        </p>
        <p className="min-h-4 w-full min-w-0 truncate text-xs text-muted-foreground">
          {run.folder || "Reading folders…"}
        </p>
        {/* Music scans have two honest halves with known totals; video scans
            emit no phase, so the bar never shows for them. */}
        {Object.keys(run.sub).length > 0 && (
          <div className="w-56">
            <StageBar stages={SCAN_STAGES} currentKey={run.phase} sub={run.sub} className="mt-1" />
            <p className="mt-1.5 text-[11px] text-muted-foreground">{stageLine(SCAN_STAGES, run.phase)}</p>
          </div>
        )}
        {/* Scan pace swings with drive spin-up and folder shape, so this gets
            an honest placeholder rather than a number that keeps revising
            itself. */}
        <p className="text-xs text-muted-foreground">indeterminate time remaining</p>
        {/* Rescans stop safely: the read phase writes nothing and the build
            phase stops between artists — a later rescan completes the rest.
            A stopped CREATE leaves the library resumable from the sidebar. */}
        <Button
          variant="outline"
          size="sm"
          className="mt-1"
          disabled={run.stopRequested}
          onClick={() => void stopScan(run.libraryId)}
        >
          {run.stopRequested ? "Stopping…" : run.isCreate ? "Stop & finish later" : "Stop rescan"}
        </Button>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Match banner
// ---------------------------------------------------------------------------

/** The match QUESTION, over the library page — the one interactive moment,
 *  shown until answered. The running pass is not a banner: it's a sidebar
 *  line (like the waveform preload) and the strip below on the Metadata page. */
/** The post-scan question. Video only: TMDB matching is elective (pass
 *  checkboxes, a token). Music libraries no longer get one — the Metadata
 *  page's pass banner lists the work and stays until a pass runs. */
export function LibraryRunBanner({ run, library }: { run: PromptRun; library: Library }) {
  if (run.format === "music") return null;
  return <VideoPrompt run={run} library={library} />;
}

/** The running pass's detail — stage bar, ETA, sweep, Skip remaining — at
 *  the top of the library's Metadata page (where the sidebar line leads). */
export function MatchRunStrip({ libraryId, className }: { libraryId: string; className?: string }) {
  const { runFor } = useLibraryRuns();
  const run = runFor(libraryId);
  if (run?.kind !== "match") return null;
  return <MatchRunning run={run} className={className} />;
}

function bannerClass(extra = "") {
  return `flex flex-col gap-2 border-b border-primary/25 bg-primary/5 px-4 py-2 ${extra}`;
}

/** Elective TMDB matching: the pass checkboxes + request estimate. The run
 *  itself is the shared engine (tmdbMatchEngine), hosted by the controller. */
function VideoPrompt({ run, library }: { run: PromptRun; library: Library }) {
  const { startMatch, skipMatch } = useLibraryRuns();
  const [busy, setBusy] = useState<"start" | "skip" | null>(null);
  const [targets, setTargets] = useState<TmdbBulkTargets | null>(null);
  const [hasToken, setHasToken] = useState(true);
  const [omdbEnabled, setOmdbEnabled] = useState(false);
  const [rtEnabled, setRtEnabled] = useState(false);
  const [doMovies, setDoMovies] = useState(true);
  const [doShows, setDoShows] = useState(true);
  const [doSeasons, setDoSeasons] = useState(true);
  const [doEpisodes, setDoEpisodes] = useState(true);
  const [doWebisodes, setDoWebisodes] = useState(false);
  const [doRatings, setDoRatings] = useState(false);

  // The token and OMDB flags come from Settings — re-read on every save so
  // adding a key while the banner is up clears the warning at once.
  const readSettings = useCallback(async () => {
    const settings = await invoke<Record<string, string>>("get_settings");
    setHasToken(Boolean(settings["tmdb_api_token"]?.trim()));
    setOmdbEnabled(settings["omdb_enabled"] === "true" && Boolean(settings["omdb_api_key"]?.trim()));
    setRtEnabled(settings["rt_scraper_enabled"] === "true");
  }, []);
  useEffect(() => {
    const onSaved = () => {
      readSettings().catch((e) => toast.error(String(e)));
    };
    window.addEventListener("waverunner:settings-saved", onSaved);
    return () => window.removeEventListener("waverunner:settings-saved", onSaved);
  }, [readSettings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t] = await Promise.all([
          invoke<TmdbBulkTargets>("get_tmdb_bulk_targets", { libraryId: run.libraryId }),
          readSettings(),
        ]);
        if (cancelled) return;
        setTargets(t);
        const willDoShows = t.shows.some((s) => !s.tmdb_id);
        setDoMovies(t.movies.length > 0);
        setDoShows(willDoShows);
        setDoSeasons(t.seasons.some((se) => !se.season_done));
        setDoEpisodes(t.seasons.some((se) => !se.episodes_done));
      } catch (e) {
        toast.error(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run.libraryId, readSettings]);

  const unmatchedShows = targets?.shows.filter((s) => !s.tmdb_id) ?? [];
  const matchableShowIds = new Set(
    (targets?.shows ?? []).filter((s) => s.tmdb_id != null || doShows).map((s) => s.id),
  );
  const seasonsNeeding = (targets?.seasons ?? []).filter(
    (se) => !se.season_done && matchableShowIds.has(se.show_id),
  );
  const episodeSeasonsNeeding = (targets?.seasons ?? []).filter(
    (se) => !se.episodes_done && matchableShowIds.has(se.show_id),
  );
  const eligibleWebisodeShows = (targets?.webisodes ?? []).filter((w) => matchableShowIds.has(w.show_id));
  const ratingsCount = (targets?.all_movies.length ?? 0) + (targets?.all_shows.length ?? 0);

  const workCount =
    (doMovies ? targets?.movies.length ?? 0 : 0) +
    (doShows ? unmatchedShows.length : 0) +
    (doSeasons ? seasonsNeeding.length : 0) +
    (doEpisodes ? episodeSeasonsNeeding.length : 0) +
    (doWebisodes ? eligibleWebisodeShows.length : 0) +
    (doRatings ? ratingsCount : 0);
  const apiHits =
    (doMovies ? (targets?.movies.length ?? 0) * 2 : 0) +
    (doShows ? unmatchedShows.length * 2 : 0) +
    (doSeasons ? seasonsNeeding.length : 0) +
    (doEpisodes ? episodeSeasonsNeeding.length : 0) +
    (doWebisodes ? eligibleWebisodeShows.length : 0) +
    (doRatings ? ratingsCount * (rtEnabled ? 3 : 1) : 0);
  const canStart = hasToken && !!targets && workCount > 0;

  const box = (label: string, count: number, checked: boolean, onChange: (v: boolean) => void, note?: string) => {
    const inert = count === 0;
    return (
      <label
        className={`flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs ${
          inert ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-accent/40"
        }`}
      >
        <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={inert} />
        <span className={count === 0 ? "text-muted-foreground" : ""}>{label}</span>
        <span className="text-muted-foreground">
          {count}
          {note ? ` ${note}` : ""}
        </span>
      </label>
    );
  };

  return (
    <div className={bannerClass()}>
      <div className="flex items-center gap-3">
        <Sparkles size={14} className="shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Match against TMDB?</p>
          <p className="text-xs text-muted-foreground">
            Fills in posters, plots, cast, genres and more. Only confident matches are applied
            automatically; anything ambiguous is set aside for your review.
            {targets ? (
              <>
                {" "}Estimated API requests: <span className="font-medium text-foreground">{apiHits}</span>
              </>
            ) : null}
          </p>
          {!hasToken && (
            <p className="mt-1 text-xs text-destructive">
              No TMDB API token configured. Add one in Settings first, or skip for now.
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 text-xs"
          disabled={busy !== null}
          onClick={async () => {
            setBusy("skip");
            await skipMatch(run.libraryId);
          }}
        >
          {busy === "skip" ? <Spinner className="size-3.5" /> : "Not now"}
        </Button>
        <Button
          size="sm"
          className="h-7 shrink-0 text-xs"
          disabled={busy !== null || !canStart}
          onClick={async () => {
            if (!targets) return;
            setBusy("start");
            await startMatch(library, {
              total: workCount,
              cfg: {
                targets,
                doMovies,
                doShows,
                doSeasons,
                doEpisodes,
                doWebisodes,
                doRatings,
                unmatchedShows,
                seasonsNeeding,
                episodeSeasonsNeeding,
                eligibleWebisodeShows,
              },
            });
            setBusy(null);
          }}
        >
          {busy === "start" ? <Spinner className="size-3.5" /> : "Start matching"}
        </Button>
      </div>
      {targets == null ? (
        <div className="flex items-center gap-2 pl-7 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Counting unmatched media…
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pl-7">
          {box("Movies", targets.movies.length, doMovies, setDoMovies, "unmatched")}
          {box("TV shows", unmatchedShows.length, doShows, (v) => {
            setDoShows(v);
            if (!v) {
              setDoSeasons(false);
              setDoEpisodes(false);
              setDoWebisodes(false);
            }
          }, "unmatched")}
          {box("Seasons", seasonsNeeding.length, doSeasons, setDoSeasons, "to fetch")}
          {box("Episodes", episodeSeasonsNeeding.length, doEpisodes, setDoEpisodes, "season fetches")}
          {omdbEnabled && box("Ratings", ratingsCount, doRatings, setDoRatings, "titles")}
          {targets.webisodes.length > 0 &&
            box("Webisodes", eligibleWebisodeShows.length, doWebisodes, setDoWebisodes, "shows (fuzzy)")}
        </div>
      )}
    </div>
  );
}

/** Full-bleed strip, as tall as its content; `className` carries the host's
 *  negative margins so it runs edge to edge of the section it tops. */
function MatchRunning({ run, className = "" }: { run: MatchRun; className?: string }) {
  const { skipMatch } = useLibraryRuns();
  // Two-step skip: the button is one click away from abandoning a long pass.
  const [confirmSkip, setConfirmSkip] = useState(false);
  const p = run.progress;
  const music = run.format === "music";
  const headline = !music
    ? "Matching against TMDB"
    : p?.phase === "artist-ids"
      ? "Identifying artists from matched albums"
      : p?.phase === "artist-credits"
        ? "Reading album credits on MusicBrainz"
        : p?.phase === "dates"
          ? "Fetching original release dates"
          : p?.phase === "titles"
            ? "Applying track titles from matched releases"
            : p?.phase === "artist-search"
              ? "Searching artists on MusicBrainz"
              : "Matching against MusicBrainz";
  return (
    <div className={`flex flex-col gap-2 bg-primary/5 px-4 py-2 ${className}`}>
      <div className="flex items-center gap-3">
        <Spinner className="size-3.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {headline}
            {p ? ` — ${Math.min(p.done + 1, p.total)}/${p.total}` : "…"}
            {music && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                sweep {run.sweep} of up to 3
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {p?.name ?? "Starting…"}
            {p?.etaSecs != null ? ` · ${fmtEta(p.etaSecs)}` : ""}
            {" · "}edits wait until the pass finishes
          </p>
        </div>
        {music && (
          <div className="hidden w-40 shrink-0 md:block">
            <StageBar stages={MATCH_STAGES} currentKey={p?.phase} sub={run.sub} />
            <p className="mt-1 truncate text-[10px] text-muted-foreground">{stageLine(MATCH_STAGES, p?.phase)}</p>
          </div>
        )}
        {run.skipRequested ? (
          <Button variant="outline" size="sm" disabled className="h-7 shrink-0 gap-1.5 text-xs">
            <Spinner className="size-3" />
            Skipping…
          </Button>
        ) : confirmSkip ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">Skip the rest?</span>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setConfirmSkip(false)}>
              Keep going
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setConfirmSkip(false);
                void skipMatch(run.libraryId);
              }}
            >
              Skip remaining
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={() => setConfirmSkip(true)}>
            Skip remaining
          </Button>
        )}
      </div>
    </div>
  );
}
