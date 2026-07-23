import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { TmdbMatchDialog } from "@/components/TmdbMatchDialog";
import { TmdbShowMatchDialog } from "@/components/TmdbShowMatchDialog";
import {
  runBulkMatch,
  fetchShowSeasons,
  EMPTY_BULK_STATS,
  type BulkReviewItem,
  type BulkRunStats,
} from "@/components/tmdbMatchEngine";
import type { MovieDetail, ShowDetail, TmdbBulkTargets } from "@/types";

// ── Dialog ──────────────────────────────────────────────────────────
// The matching machinery itself lives in tmdbMatchEngine.ts (shared with the
// import wizard's Match step and the video metadata center).

type Phase = "loading" | "configure" | "running" | "done";

type ReviewItem = BulkReviewItem;
type RunStats = BulkRunStats;

const EMPTY_STATS: RunStats = EMPTY_BULK_STATS;

export function TmdbBulkMatchDialog({
  libraryId,
  open,
  onOpenChange,
  onApplied,
}: {
  libraryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once after a run finishes so the caller can refresh caches/views. */
  onApplied: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [targets, setTargets] = useState<TmdbBulkTargets | null>(null);
  const [hasToken, setHasToken] = useState(true);
  const [omdbEnabled, setOmdbEnabled] = useState(false);
  const [rtEnabled, setRtEnabled] = useState(false);

  const [doMovies, setDoMovies] = useState(true);
  const [doShows, setDoShows] = useState(true);
  const [doSeasons, setDoSeasons] = useState(true);
  const [doEpisodes, setDoEpisodes] = useState(true);
  // Off by default: webisode↔TMDB matching is fuzzy (filenames vs season-0
  // episode names), so it's opt-in.
  const [doWebisodes, setDoWebisodes] = useState(false);
  // Off by default: hits OMDB (and optionally the RT scraper) once per movie.
  const [doRatings, setDoRatings] = useState(false);

  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [stats, setStats] = useState<RunStats>(EMPTY_STATS);
  const cancelRef = useRef(false);
  // Items the confidence check refused to auto-match; resolved manually via the
  // per-entry match dialogs from the summary screen.
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  // Items whose TMDB search returned nothing at all — listed by name in the
  // summary (when there aren't absurdly many) so the user knows what to rename.
  const [noResultItems, setNoResultItems] = useState<{ title: string; year: string | null }[]>([]);
  // Titles OMDB confirmed it has nothing for.
  const [ratingsMissing, setRatingsMissing] = useState<{ title: string; year: string | null }[]>([]);
  // Titles skipped because they have no IMDb id (need a TMDB match first).
  const [ratingsNoId, setRatingsNoId] = useState<{ title: string; year: string | null }[]>([]);
  // Fatal ratings error (rejected key, quota, repeated network failures) that
  // aborted the pass — shown prominently in the summary.
  const [ratingsFatal, setRatingsFatal] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ReviewItem | null>(null);
  // The entry's current metadata — the match dialogs need it to build their
  // field-comparison list (passing null renders an empty, unusable review step).
  const [reviewingDetail, setReviewingDetail] = useState<MovieDetail | ShowDetail | null>(null);

  const openReview = useCallback(async (item: ReviewItem) => {
    try {
      if (item.kind === "movie") {
        setReviewingDetail(await invoke<MovieDetail>("get_movie_detail", { entryId: item.id }));
      } else {
        setReviewingDetail(await invoke<ShowDetail>("get_show_detail", { showId: item.id }));
      }
      setReviewing(item);
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  useEffect(() => {
    if (!open || !libraryId) return;
    setPhase("loading");
    setTargets(null);
    setStats(EMPTY_STATS);
    setReviewItems([]);
    setNoResultItems([]);
    setRatingsMissing([]);
    setRatingsNoId([]);
    setRatingsFatal(null);
    setReviewing(null);
    cancelRef.current = false;
    (async () => {
      try {
        const [t, settings] = await Promise.all([
          invoke<TmdbBulkTargets>("get_tmdb_bulk_targets", { libraryId }),
          invoke<Record<string, string>>("get_settings"),
        ]);
        setTargets(t);
        setHasToken(Boolean(settings["tmdb_api_token"]?.trim()));
        setOmdbEnabled(settings["omdb_enabled"] === "true" && Boolean(settings["omdb_api_key"]?.trim()));
        setRtEnabled(settings["rt_scraper_enabled"] === "true");
        // Empty passes start unchecked instead of greyed-out-but-checked.
        const willDoShows = t.shows.some((s) => !s.tmdb_id);
        const showMatchable = (showId: number) => {
          const show = t.shows.find((s) => s.id === showId);
          return show != null && (show.tmdb_id != null || willDoShows);
        };
        setDoMovies(t.movies.length > 0);
        setDoShows(willDoShows);
        setDoSeasons(t.seasons.some((se) => !se.season_done && showMatchable(se.show_id)));
        setDoEpisodes(t.seasons.some((se) => !se.episodes_done && showMatchable(se.show_id)));
        setPhase("configure");
      } catch (e) {
        toast.error(String(e));
        onOpenChange(false);
      }
    })();
    // onOpenChange is intentionally not a dependency: callers pass inline
    // lambdas, and re-running this effect mid-flow would reset the dialog
    // back to the configure screen (e.g. when a finished run refreshes the app).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, libraryId]);

  const unmatchedShows = useMemo(
    () => targets?.shows.filter((s) => !s.tmdb_id) ?? [],
    [targets],
  );

  // Seasons can only be processed for shows that have (or are about to get) a
  // TMDB match. The counts react to the shows checkbox accordingly.
  const eligibleSeasons = useMemo(() => {
    if (!targets) return [];
    const matchable = new Set(
      targets.shows.filter((s) => s.tmdb_id != null || doShows).map((s) => s.id),
    );
    return targets.seasons.filter((se) => matchable.has(se.show_id));
  }, [targets, doShows]);

  const eligibleWebisodeShows = useMemo(() => {
    if (!targets) return [];
    const matchable = new Set(
      targets.shows.filter((s) => s.tmdb_id != null || doShows).map((s) => s.id),
    );
    return targets.webisodes.filter((w) => matchable.has(w.show_id));
  }, [targets, doShows]);

  // Each pass only targets seasons it hasn't run for yet — a fully matched
  // library counts (and fetches) zero here.
  const seasonsNeeding = useMemo(
    () => eligibleSeasons.filter((se) => !se.season_done),
    [eligibleSeasons],
  );
  const episodeSeasonsNeeding = useMemo(
    () => eligibleSeasons.filter((se) => !se.episodes_done),
    [eligibleSeasons],
  );

  // Display counts stay stable regardless of the shows checkbox (the rows grey
  // out instead of dropping to 0); the run and the total estimate use the
  // needing lists, which reflect what can actually be processed.
  const allSeasonsCount = useMemo(
    () => targets?.seasons.filter((se) => !se.season_done).length ?? 0,
    [targets],
  );
  const episodeFetchCount = useMemo(
    () => targets?.seasons.filter((se) => !se.episodes_done).length ?? 0,
    [targets],
  );
  const allEpisodesCount = useMemo(
    () =>
      targets?.seasons
        .filter((se) => !se.episodes_done)
        .reduce((sum, se) => sum + se.episode_count, 0) ?? 0,
    [targets],
  );
  const allWebisodesCount = useMemo(
    () => targets?.webisodes.reduce((sum, w) => sum + w.extra_count, 0) ?? 0,
    [targets],
  );

  // API request estimate: movies/shows cost a search + a detail fetch each;
  // the seasons pass and the episodes pass each fetch every season once.
  const apiHits = useMemo(() => {
    if (!targets) return 0;
    let hits = 0;
    if (doMovies) hits += targets.movies.length * 2;
    if (doShows) hits += unmatchedShows.length * 2;
    if (doSeasons) hits += seasonsNeeding.length;
    if (doEpisodes) hits += episodeSeasonsNeeding.length;
    if (doWebisodes) hits += eligibleWebisodeShows.length;
    // OMDB once per title; the RT scrape adds up to 2 page requests per title.
    if (doRatings) hits += (targets.all_movies.length + targets.all_shows.length) * (rtEnabled ? 3 : 1);
    return hits;
  }, [targets, doMovies, doShows, doSeasons, doEpisodes, doWebisodes, doRatings, rtEnabled, unmatchedShows, seasonsNeeding, episodeSeasonsNeeding, eligibleWebisodeShows]);

  const nothingSelected =
    !targets ||
    ((doMovies ? targets.movies.length : 0) +
      (doShows ? unmatchedShows.length : 0) +
      (doSeasons ? seasonsNeeding.length : 0) +
      (doEpisodes ? episodeSeasonsNeeding.length : 0) +
      (doWebisodes ? eligibleWebisodeShows.length : 0) +
      (doRatings ? targets.all_movies.length + targets.all_shows.length : 0)) === 0;

  const run = useCallback(async () => {
    if (!targets || !libraryId) return;
    setPhase("running");
    cancelRef.current = false;

    const totalSteps =
      (doMovies ? targets.movies.length : 0) +
      (doShows ? unmatchedShows.length : 0) +
      (doSeasons ? seasonsNeeding.length : 0) +
      (doEpisodes ? episodeSeasonsNeeding.length : 0) +
      (doWebisodes ? eligibleWebisodeShows.length : 0) +
      (doRatings ? targets.all_movies.length + targets.all_shows.length : 0);
    let step = 0;
    const tick = (label: string) => {
      step++;
      setProgress({ current: step, total: totalSteps, label });
    };

    const outcome = await runBulkMatch(
      {
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
      tick,
      () => cancelRef.current,
    );
    setStats(outcome.stats);
    setReviewItems(outcome.review);
    setNoResultItems(outcome.noResult);
    setRatingsMissing(outcome.ratingsMissing);
    setRatingsNoId(outcome.ratingsNoId);
    setRatingsFatal(outcome.ratingsFatal);
    setPhase("done");
    onApplied();
  }, [targets, libraryId, doMovies, doShows, doSeasons, doEpisodes, doWebisodes, doRatings, unmatchedShows, seasonsNeeding, episodeSeasonsNeeding, eligibleWebisodeShows, onApplied]);

  // After a show is confirmed through the manual review dialog, fetch its
  // seasons/episodes (per the run's checkboxes) — the bulk run deliberately
  // skips them for unconfirmed shows so a wrong guess never fans out.
  const finishShowSeasons = useCallback(
    async (showId: number, title: string) => {
      if ((!doSeasons && !doEpisodes) || !libraryId) return;
      try {
        const toastId = toast.loading(`${title}: fetching seasons…`);
        const result = await fetchShowSeasons(libraryId, showId, {
          seasons: doSeasons,
          episodes: doEpisodes,
        });
        if (result == null) {
          toast.dismiss(toastId);
          return;
        }
        if (result.failed > 0) {
          toast.error(`${title}: ${result.failed} season fetches failed`, { id: toastId });
        } else {
          toast.success(`${title}: seasons & episodes updated`, { id: toastId });
        }
        onApplied();
      } catch (e) {
        toast.error(String(e));
      }
    },
    [doSeasons, doEpisodes, libraryId, onApplied],
  );

  const handleClose = (next: boolean) => {
    if (!next && phase === "running") {
      // Closing mid-run cancels gracefully after the current item.
      cancelRef.current = true;
      return;
    }
    onOpenChange(next);
  };

  const checkboxRow = (
    label: string,
    count: number,
    checked: boolean,
    onChange: (v: boolean) => void,
    note?: string,
    disabled?: boolean,
  ) => {
    const inert = disabled || count === 0;
    return (
      <label
        className={`flex items-center gap-3 rounded-md border border-border px-3 py-2.5 ${
          inert ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-accent/40"
        }`}
      >
        <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={inert} />
        <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
          <span className={`text-sm ${count === 0 ? "text-muted-foreground" : ""}`}>{label}</span>
          <span className="text-xs text-muted-foreground">
            {count}
            {note ? ` ${note}` : ""}
          </span>
        </div>
      </label>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      {/* Fixed header/footer with only the body scrolling: keeps the actions
          always visible and the scrollbar inside the padding (clear of the
          rounded corners). grid-cols-[minmax(0,1fr)]: the default auto column
          sizes to the widest unbreakable title and overflows horizontally;
          pinning it to the container width lets truncation engage. */}
      <DialogContent
        showCloseButton={false}
        className="grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Match library to TMDB</DialogTitle>
          <DialogDescription>
            Automatically match media to TMDB and fill in metadata. Only confident
            matches are applied — anything ambiguous is set aside for you to review.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overflow-x-hidden">
        {phase === "loading" && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Counting unmatched media…
          </div>
        )}

        {phase === "configure" && targets && (
          <>
            {!hasToken && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                No TMDB API token configured. Add one in Settings first.
              </p>
            )}
            <div className="grid gap-2">
              {checkboxRow("Movies", targets.movies.length, doMovies, setDoMovies, `unmatched · ${targets.movies.length * 2} requests`)}
              {checkboxRow("TV shows", unmatchedShows.length, doShows, (v) => {
                setDoShows(v);
                // Seasons/episodes/webisodes hang off the shows pass — unchecking
                // it unchecks them too instead of leaving them greyed-but-checked.
                if (!v) {
                  setDoSeasons(false);
                  setDoEpisodes(false);
                  setDoWebisodes(false);
                }
              }, `unmatched · ${unmatchedShows.length * 2} requests`)}
              {checkboxRow("Seasons", allSeasonsCount, doSeasons, setDoSeasons, `to fetch · ${allSeasonsCount} requests`, seasonsNeeding.length === 0)}
              {checkboxRow("Episodes", allEpisodesCount, doEpisodes, setDoEpisodes, `· ${episodeFetchCount} season fetches · ${episodeFetchCount} requests`, episodeSeasonsNeeding.length === 0)}
              {omdbEnabled &&
                checkboxRow(
                  "Ratings",
                  targets.all_movies.length + targets.all_shows.length,
                  doRatings,
                  setDoRatings,
                  `titles · ${(targets.all_movies.length + targets.all_shows.length) * (rtEnabled ? 3 : 1)} requests${rtEnabled ? " (incl. RT scrape)" : ""}`,
                )}
              {allWebisodesCount > 0 &&
                checkboxRow("Webisodes", allWebisodesCount, doWebisodes, setDoWebisodes, `· ${eligibleWebisodeShows.length} ${eligibleWebisodeShows.length === 1 ? "request" : "requests"} (fuzzy matching)`, eligibleWebisodeShows.length === 0)}
            </div>
            <p className="text-xs text-muted-foreground">
              Estimated API requests: <span className="font-medium text-foreground">{apiHits}</span>
            </p>
          </>
        )}

        {phase === "running" && (
          <>
            <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <Spinner className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{progress.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {progress.current}/{progress.total}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-200"
                  style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          </>
        )}

        {phase === "done" && (
          <>
            <div className="flex flex-col gap-1 text-sm">
              {stats.moviesMatched > 0 && (
                <p>{stats.moviesMatched} {stats.moviesMatched === 1 ? "movie" : "movies"} matched</p>
              )}
              {stats.showsMatched > 0 && (
                <p>{stats.showsMatched} TV {stats.showsMatched === 1 ? "show" : "shows"} matched</p>
              )}
              {stats.seasonsApplied > 0 && (
                <p>{stats.seasonsApplied} {stats.seasonsApplied === 1 ? "season" : "seasons"} updated</p>
              )}
              {stats.episodeSeasonsApplied > 0 && (
                <p>
                  Episodes updated across {stats.episodeSeasonsApplied}{" "}
                  {stats.episodeSeasonsApplied === 1 ? "season" : "seasons"}
                </p>
              )}
              {stats.webisodesMatched > 0 && (
                <p>
                  Metadata found for {stats.webisodesMatched}{" "}
                  {stats.webisodesMatched === 1 ? "webisode" : "webisodes"}
                </p>
              )}
              {stats.ratingsChecked > 0 && (
                <p>
                  Ratings fetched for {stats.ratingsFetched} of {stats.ratingsChecked}{" "}
                  {stats.ratingsChecked === 1 ? "title" : "titles"}
                </p>
              )}
              {stats.skipped > 0 && (
                <p className="text-muted-foreground">
                  {stats.skipped} {stats.skipped === 1 ? "season" : "seasons"} skipped (show not matched)
                </p>
              )}
              {stats.failed > 0 && <p className="text-destructive">{stats.failed} failed</p>}
              {ratingsFatal && <p className="text-destructive">{ratingsFatal}</p>}
              {stats.moviesMatched + stats.showsMatched + stats.seasonsApplied + stats.episodeSeasonsApplied + stats.webisodesMatched + stats.ratingsChecked === 0 &&
                stats.skipped === 0 &&
                stats.failed === 0 &&
                !ratingsFatal &&
                ratingsNoId.length === 0 &&
                noResultItems.length === 0 &&
                reviewItems.length === 0 && <p className="text-muted-foreground">Nothing to do.</p>}
            </div>
            {ratingsNoId.length > 0 && (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm text-muted-foreground">
                  {ratingsNoId.length} {ratingsNoId.length === 1 ? "title has" : "titles have"} no IMDb ID — match to TMDB first:
                </p>
                <div className="flex flex-col gap-0.5">
                  {ratingsNoId.map((item, i) => (
                    <p key={i} className="shrink-0 truncate text-sm">
                      {item.title}
                      {item.year ? ` (${item.year})` : ""}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {ratingsMissing.length > 0 && (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm text-muted-foreground">
                  No ratings found for {ratingsMissing.length} {ratingsMissing.length === 1 ? "title" : "titles"}:
                </p>
                <div className="flex flex-col gap-0.5">
                  {ratingsMissing.map((item, i) => (
                    <p key={i} className="shrink-0 truncate text-sm">
                      {item.title}
                      {item.year ? ` (${item.year})` : ""}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {noResultItems.length > 0 && (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm text-muted-foreground">
                  No TMDB results for {noResultItems.length} {noResultItems.length === 1 ? "item" : "items"}:
                </p>
                <div className="flex flex-col gap-0.5">
                  {noResultItems.map((item, i) => (
                    <p key={i} className="shrink-0 truncate text-sm">
                      {item.title}
                      {item.year ? ` (${item.year})` : ""}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {reviewItems.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm text-muted-foreground">
                  {reviewItems.length} ambiguous {reviewItems.length === 1 ? "match needs" : "matches need"} a manual pick:
                </p>
                <div className="flex flex-col gap-1">
                  {reviewItems.map((item) => (
                    <div
                      key={`${item.kind}-${item.id}`}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {item.title}
                        {item.year ? ` (${item.year})` : ""}
                      </span>
                      <Button size="sm" variant="outline" onClick={() => openReview(item)}>
                        Review
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        </div>

        <DialogFooter>
          {phase === "configure" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={run} disabled={nothingSelected || !hasToken || apiHits === 0}>
                Start
              </Button>
            </>
          )}
          {phase === "running" && (
            <Button variant="outline" onClick={() => (cancelRef.current = true)}>
              Cancel
            </Button>
          )}
          {phase === "done" && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>

      {/* Manual review of ambiguous items, via the existing per-entry dialogs */}
      {reviewing?.kind === "movie" && (
        <TmdbMatchDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setReviewing(null);
              setReviewingDetail(null);
            }
          }}
          entryId={reviewing.id}
          entryTitle={reviewing.title}
          entryYear={reviewing.year}
          currentDetail={reviewingDetail as MovieDetail | null}
          onApplied={() => {
            setReviewItems((prev) =>
              prev.filter((i) => !(i.kind === "movie" && i.id === reviewing.id)),
            );
            onApplied();
          }}
        />
      )}
      {reviewing?.kind === "show" && (
        <TmdbShowMatchDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setReviewing(null);
              setReviewingDetail(null);
            }
          }}
          entryId={reviewing.id}
          entryTitle={reviewing.title}
          entryYear={reviewing.year}
          currentDetail={reviewingDetail as ShowDetail | null}
          onApplied={() => {
            const { id, title } = reviewing;
            setReviewItems((prev) => prev.filter((i) => !(i.kind === "show" && i.id === id)));
            onApplied();
            finishShowSeasons(id, title);
          }}
        />
      )}
    </Dialog>
  );
}
