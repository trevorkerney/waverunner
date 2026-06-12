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
import type {
  CastUpdateInfo,
  MovieDetail,
  PersonUpdateInfo,
  ShowDetail,
  TmdbBulkTargets,
  TmdbFieldSelection,
  TmdbMovieDetail,
  TmdbSeasonDetail,
  TmdbSeasonFieldSelection,
  TmdbSearchResult,
  TmdbShowFieldSelection,
  TmdbTvDetail,
  TmdbTvSearchResult,
} from "@/types";

const COMPOSER_JOBS = ["Composer", "Original Music Composer"];

// ── Field mapping (mirrors the single-entry match dialogs, all fields on) ──

function castOf(credits: { cast?: { id: number; name: string; character?: string | null; profile_path?: string | null }[] } | null | undefined, limit = 20): CastUpdateInfo[] {
  if (!credits?.cast) return [];
  return credits.cast.slice(0, limit).map((c) => ({
    name: c.name,
    role: c.character ?? null,
    tmdb_id: c.id,
    profile_path: c.profile_path ?? null,
  }));
}

function crewByJob(credits: { crew?: { id: number; name: string; job?: string | null; profile_path?: string | null }[] } | null | undefined, jobs: string[]): PersonUpdateInfo[] {
  if (!credits?.crew) return [];
  const seen = new Set<number>();
  return credits.crew
    .filter((c) => c.job && jobs.includes(c.job))
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path ?? null }));
}

function movieFields(detail: TmdbMovieDetail): TmdbFieldSelection {
  const sel: TmdbFieldSelection = { tmdb_id: String(detail.id) };
  if (detail.overview) sel.plot = detail.overview;
  if (detail.tagline) sel.tagline = detail.tagline;
  if (detail.runtime != null) sel.runtime = detail.runtime;
  if (detail.release_date) sel.release_date = detail.release_date;
  const cert = detail.releases?.countries?.find((c) => c.iso_3166_1 === "US")?.certification;
  if (cert) sel.maturity_rating = cert;
  if (detail.external_ids?.imdb_id) sel.imdb_id = detail.external_ids.imdb_id;
  sel.genres = detail.genres.map((g) => g.name);
  sel.directors = crewByJob(detail.credits, ["Director"]);
  sel.cast = castOf(detail.credits);
  sel.composers = crewByJob(detail.credits, COMPOSER_JOBS);
  sel.studios = detail.production_companies.map((c) => c.name);
  sel.keywords = detail.keywords?.keywords.map((k) => k.name) ?? [];
  return sel;
}

function showFields(detail: TmdbTvDetail): TmdbShowFieldSelection {
  const sel: TmdbShowFieldSelection = { tmdb_id: String(detail.id) };
  if (detail.overview) sel.plot = detail.overview;
  if (detail.tagline) sel.tagline = detail.tagline;
  const rating = detail.content_ratings?.results?.find((c) => c.iso_3166_1 === "US")?.rating;
  if (rating) sel.maturity_rating = rating;
  if (detail.external_ids?.imdb_id) sel.imdb_id = detail.external_ids.imdb_id;
  sel.genres = detail.genres.map((g) => g.name);
  sel.creators = detail.created_by.map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path ?? null }));
  sel.cast = castOf(detail.credits);
  sel.composers = crewByJob(detail.credits, COMPOSER_JOBS);
  sel.studios = detail.production_companies.map((c) => c.name);
  sel.keywords = detail.keywords?.results.map((k) => k.name) ?? [];
  return sel;
}

function seasonFields(detail: TmdbSeasonDetail): TmdbSeasonFieldSelection {
  const sel: TmdbSeasonFieldSelection = {};
  if (detail.overview) sel.plot = detail.overview;
  const cast = castOf(detail.credits);
  if (cast.length > 0) sel.cast = cast;
  const directors = crewByJob(detail.credits, ["Director"]);
  if (directors.length > 0) sel.season_director = directors;
  return sel;
}

// ── Match confidence ────────────────────────────────────────────────
// A search result is only auto-applied when it *looks* right: same title after
// normalization, and (for movies with a known year) a release year within ±1.
// Anything ambiguous goes to the manual review queue instead of being guessed.

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

function yearsClose(candidate: string | null | undefined, local: string): boolean {
  const cy = candidate?.slice(0, 4);
  if (!cy || !/^\d{4}$/.test(cy)) return false;
  return Math.abs(Number(cy) - Number(local)) <= 1;
}

function confidentMovieMatch(
  results: TmdbSearchResult[],
  title: string,
  year: string | null,
): TmdbSearchResult | null {
  const want = normalizeTitle(title);
  const exact = results.slice(0, 5).filter((r) => normalizeTitle(r.title) === want);
  if (year) {
    return exact.find((r) => yearsClose(r.release_date, year)) ?? null;
  }
  // Without a year to disambiguate, only trust a title that matches exactly once —
  // "Mother" matches half a dozen films and guessing the first is a coin flip.
  return exact.length === 1 ? exact[0] : null;
}

function confidentShowMatch(
  results: TmdbTvSearchResult[],
  title: string,
): TmdbTvSearchResult | null {
  // Shows carry no local year, so the same single-exact-match rule applies
  // (e.g. "The Office" US vs UK must be picked by hand).
  const want = normalizeTitle(title);
  const exact = results.slice(0, 5).filter((r) => normalizeTitle(r.name) === want);
  return exact.length === 1 ? exact[0] : null;
}

// ── Dialog ──────────────────────────────────────────────────────────

type Phase = "loading" | "configure" | "running" | "done";

interface ReviewItem {
  kind: "movie" | "show";
  id: number;
  title: string;
  year: string | null;
}

interface RunStats {
  moviesMatched: number;
  showsMatched: number;
  seasonsApplied: number;
  episodeSeasonsApplied: number;
  webisodesMatched: number;
  ratingsFetched: number;
  skipped: number;
  failed: number;
}

const EMPTY_STATS: RunStats = {
  moviesMatched: 0,
  showsMatched: 0,
  seasonsApplied: 0,
  episodeSeasonsApplied: 0,
  webisodesMatched: 0,
  ratingsFetched: 0,
  skipped: 0,
  failed: 0,
};

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

  // Display counts stay stable regardless of the shows checkbox (the rows grey
  // out instead of dropping to 0); the run and the total estimate use
  // eligibleSeasons, which reflects what can actually be processed.
  const allSeasonsCount = targets?.seasons.length ?? 0;
  const allEpisodesCount = useMemo(
    () => targets?.seasons.reduce((sum, se) => sum + se.episode_count, 0) ?? 0,
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
    if (doSeasons) hits += eligibleSeasons.length;
    if (doEpisodes) hits += eligibleSeasons.length;
    if (doWebisodes) hits += eligibleWebisodeShows.length;
    // OMDB once per movie; the RT scrape adds up to 2 page requests per movie.
    if (doRatings) hits += targets.all_movies.length * (rtEnabled ? 3 : 1);
    return hits;
  }, [targets, doMovies, doShows, doSeasons, doEpisodes, doWebisodes, doRatings, rtEnabled, unmatchedShows, eligibleSeasons, eligibleWebisodeShows]);

  const nothingSelected =
    !targets ||
    ((doMovies ? targets.movies.length : 0) +
      (doShows ? unmatchedShows.length : 0) +
      ((doSeasons || doEpisodes) ? eligibleSeasons.length : 0) +
      (doWebisodes ? eligibleWebisodeShows.length : 0) +
      (doRatings ? targets.all_movies.length : 0)) === 0;

  const run = useCallback(async () => {
    if (!targets || !libraryId) return;
    setPhase("running");
    cancelRef.current = false;
    const s: RunStats = { ...EMPTY_STATS };
    const review: ReviewItem[] = [];
    const noResult: { title: string; year: string | null }[] = [];
    // Live tmdb ids for shows: pre-matched ones plus those matched this run.
    const showTmdb = new Map<number, number>();
    for (const sh of targets.shows) {
      if (sh.tmdb_id) showTmdb.set(sh.id, Number(sh.tmdb_id));
    }

    const totalSteps =
      (doMovies ? targets.movies.length : 0) +
      (doShows ? unmatchedShows.length : 0) +
      (doSeasons ? eligibleSeasons.length : 0) +
      (doEpisodes ? eligibleSeasons.length : 0) +
      (doWebisodes ? eligibleWebisodeShows.length : 0) +
      (doRatings ? targets.all_movies.length : 0);
    let step = 0;
    const tick = (label: string) => {
      step++;
      setProgress({ current: step, total: totalSteps, label });
    };

    try {
      if (doMovies) {
        for (const m of targets.movies) {
          if (cancelRef.current) break;
          tick(m.title);
          try {
            const results = await invoke<TmdbSearchResult[]>("search_tmdb_movie", {
              query: m.title,
              year: m.year,
            });
            if (results.length === 0) {
              noResult.push({ title: m.title, year: m.year });
              continue;
            }
            const pick = confidentMovieMatch(results, m.title, m.year);
            if (!pick) {
              review.push({ kind: "movie", id: m.id, title: m.title, year: m.year });
              continue;
            }
            const detail = await invoke<TmdbMovieDetail>("get_tmdb_movie_detail", {
              tmdbId: pick.id,
            });
            await invoke("apply_tmdb_metadata", { entryId: m.id, fields: movieFields(detail) });
            s.moviesMatched++;
          } catch {
            s.failed++;
          }
        }
      }

      if (doShows && !cancelRef.current) {
        for (const sh of unmatchedShows) {
          if (cancelRef.current) break;
          tick(sh.title);
          try {
            const results = await invoke<TmdbTvSearchResult[]>("search_tmdb_show", {
              query: sh.title,
              year: null,
            });
            if (results.length === 0) {
              noResult.push({ title: sh.title, year: null });
              continue;
            }
            const pick = confidentShowMatch(results, sh.title);
            if (!pick) {
              review.push({ kind: "show", id: sh.id, title: sh.title, year: null });
              continue;
            }
            const detail = await invoke<TmdbTvDetail>("get_tmdb_show_detail", {
              tmdbId: pick.id,
            });
            await invoke("apply_tmdb_show_metadata", { showId: sh.id, fields: showFields(detail) });
            showTmdb.set(sh.id, detail.id);
            s.showsMatched++;
          } catch {
            s.failed++;
          }
        }
      }

      // Seasons whose show never got a TMDB id — counted once per season, even
      // when both the seasons and episodes passes skip them.
      const skippedSeasonIds = new Set<number>();

      if (doSeasons && !cancelRef.current) {
        for (const se of eligibleSeasons) {
          if (cancelRef.current) break;
          tick(`Season ${se.season_number}`);
          const tmdbId = showTmdb.get(se.show_id);
          if (tmdbId == null) {
            skippedSeasonIds.add(se.id);
            continue;
          }
          try {
            const detail = await invoke<TmdbSeasonDetail>("get_tmdb_season_detail", {
              tmdbId,
              seasonNumber: se.season_number,
            });
            await invoke("apply_tmdb_season_metadata", {
              seasonId: se.id,
              fields: seasonFields(detail),
            });
            s.seasonsApplied++;
          } catch {
            s.failed++;
          }
        }
      }

      if (doEpisodes && !cancelRef.current) {
        for (const se of eligibleSeasons) {
          if (cancelRef.current) break;
          tick(`Season ${se.season_number} episodes`);
          const tmdbId = showTmdb.get(se.show_id);
          if (tmdbId == null) {
            skippedSeasonIds.add(se.id);
            continue;
          }
          try {
            await invoke("apply_tmdb_season_episodes", {
              seasonId: se.id,
              tmdbId,
              seasonNumber: se.season_number,
            });
            s.episodeSeasonsApplied++;
          } catch {
            s.failed++;
          }
        }
      }
      s.skipped = skippedSeasonIds.size;

      if (doWebisodes && !cancelRef.current) {
        for (const w of eligibleWebisodeShows) {
          if (cancelRef.current) break;
          const showTitle = targets.shows.find((sh) => sh.id === w.show_id)?.title ?? "Webisodes";
          tick(`${showTitle} webisodes`);
          if (!showTmdb.has(w.show_id)) continue;
          try {
            const matched = await invoke<number>("populate_extras_metadata", {
              ownerId: w.show_id,
              extraId: null,
            });
            s.webisodesMatched += matched;
          } catch {
            s.failed++;
          }
        }
      }

      if (doRatings && !cancelRef.current) {
        for (const m of targets.all_movies) {
          if (cancelRef.current) break;
          tick(`${m.title} ratings`);
          try {
            const fetched = await invoke<unknown[]>("fetch_ratings", { entryId: m.id });
            if (fetched.length > 0) s.ratingsFetched++;
          } catch {
            s.failed++;
          }
        }
      }
    } finally {
      setStats(s);
      setReviewItems(review);
      setNoResultItems(noResult);
      setPhase("done");
      onApplied();
    }
  }, [targets, libraryId, doMovies, doShows, doSeasons, doEpisodes, unmatchedShows, eligibleSeasons, onApplied]);

  // After a show is confirmed through the manual review dialog, fetch its
  // seasons/episodes (per the run's checkboxes) — the bulk run deliberately
  // skips them for unconfirmed shows so a wrong guess never fans out.
  const finishShowSeasons = useCallback(
    async (showId: number, title: string) => {
      if ((!doSeasons && !doEpisodes) || !libraryId) return;
      try {
        const t = await invoke<TmdbBulkTargets>("get_tmdb_bulk_targets", { libraryId });
        const show = t.shows.find((s) => s.id === showId);
        const tmdbId = show?.tmdb_id ? Number(show.tmdb_id) : null;
        if (!tmdbId) return;
        const seasons = t.seasons.filter((se) => se.show_id === showId);
        if (seasons.length === 0) return;
        const toastId = toast.loading(`${title}: fetching ${seasons.length} season${seasons.length === 1 ? "" : "s"}…`);
        let failed = 0;
        for (const se of seasons) {
          if (doSeasons) {
            try {
              const detail = await invoke<TmdbSeasonDetail>("get_tmdb_season_detail", {
                tmdbId,
                seasonNumber: se.season_number,
              });
              await invoke("apply_tmdb_season_metadata", { seasonId: se.id, fields: seasonFields(detail) });
            } catch {
              failed++;
            }
          }
          if (doEpisodes) {
            try {
              await invoke("apply_tmdb_season_episodes", {
                seasonId: se.id,
                tmdbId,
                seasonNumber: se.season_number,
              });
            } catch {
              failed++;
            }
          }
        }
        if (failed > 0) {
          toast.error(`${title}: ${failed} season fetches failed`, { id: toastId });
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
              {checkboxRow("Seasons", allSeasonsCount, doSeasons, setDoSeasons, `unmatched · ${allSeasonsCount} requests`, eligibleSeasons.length === 0)}
              {checkboxRow("Episodes", allEpisodesCount, doEpisodes, setDoEpisodes, `· ${allSeasonsCount} season fetches · ${allSeasonsCount} requests`, eligibleSeasons.length === 0)}
              {omdbEnabled &&
                checkboxRow(
                  "Ratings",
                  targets.all_movies.length,
                  doRatings,
                  setDoRatings,
                  `movies · ${targets.all_movies.length * (rtEnabled ? 3 : 1)} requests${rtEnabled ? " (incl. RT scrape)" : ""}`,
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
              {stats.ratingsFetched > 0 && (
                <p>
                  Ratings fetched for {stats.ratingsFetched}{" "}
                  {stats.ratingsFetched === 1 ? "movie" : "movies"}
                </p>
              )}
              {stats.skipped > 0 && (
                <p className="text-muted-foreground">
                  {stats.skipped} {stats.skipped === 1 ? "season" : "seasons"} skipped (show not matched)
                </p>
              )}
              {stats.failed > 0 && <p className="text-destructive">{stats.failed} failed</p>}
              {stats.moviesMatched + stats.showsMatched + stats.seasonsApplied + stats.episodeSeasonsApplied === 0 &&
                stats.skipped === 0 &&
                stats.failed === 0 &&
                noResultItems.length === 0 &&
                reviewItems.length === 0 && <p className="text-muted-foreground">Nothing to do.</p>}
            </div>
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
