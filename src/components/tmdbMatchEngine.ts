// The TMDB bulk-match engine: field mapping, match confidence, and the serial
// matching run, shared by the standalone bulk dialog (TmdbBulkMatchDialog),
// the import wizard's video Match step, and the video metadata center.
// Only confident matches are auto-applied; failed tries are recorded in
// tmdb_match_attempt ('notfound' | 'ambiguous') so unmatched entries persist
// into the metadata center instead of evaporating with the run.
import { invoke } from "@tauri-apps/api/core";
import type {
  CastUpdateInfo,
  PersonUpdateInfo,
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

function castOf(credits: { cast?: { id: number; name: string; character?: string | null; profile_path?: string | null }[] } | null | undefined): CastUpdateInfo[] {
  if (!credits?.cast) return [];
  // Full cast — no cap (see TmdbMatchDialog). Applies to movies, shows, seasons.
  return credits.cast.map((c) => ({
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

export function movieFields(detail: TmdbMovieDetail): TmdbFieldSelection {
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

export function showFields(detail: TmdbTvDetail): TmdbShowFieldSelection {
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

export function seasonFields(detail: TmdbSeasonDetail): TmdbSeasonFieldSelection {
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
// normalization, and (with a known year) a release year within ±1. Anything
// ambiguous is recorded for manual review instead of being guessed.

export function normalizeTitle(s: string): string {
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

export function confidentMovieMatch(
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

export function confidentShowMatch(
  results: TmdbTvSearchResult[],
  title: string,
  year: string | null,
): TmdbTvSearchResult | null {
  const want = normalizeTitle(title);
  const exact = results.slice(0, 5).filter((r) => normalizeTitle(r.name) === want);
  if (year) {
    // First-air-year disambiguates same-title shows (e.g. "The Office" US vs UK).
    return exact.find((r) => yearsClose(r.first_air_date, year)) ?? null;
  }
  // Without a year, only trust a single exact title match.
  return exact.length === 1 ? exact[0] : null;
}

// ── The serial matching run ─────────────────────────────────────────

export interface BulkReviewItem {
  kind: "movie" | "show";
  id: number;
  title: string;
  year: string | null;
}

export interface BulkRunStats {
  moviesMatched: number;
  showsMatched: number;
  seasonsApplied: number;
  episodeSeasonsApplied: number;
  webisodesMatched: number;
  /** Movies the ratings pass actually queried — distinguishes "found nothing"
   *  from "didn't run" in the summary. */
  ratingsChecked: number;
  ratingsFetched: number;
  skipped: number;
  failed: number;
}

export const EMPTY_BULK_STATS: BulkRunStats = {
  moviesMatched: 0,
  showsMatched: 0,
  seasonsApplied: 0,
  episodeSeasonsApplied: 0,
  webisodesMatched: 0,
  ratingsChecked: 0,
  ratingsFetched: 0,
  skipped: 0,
  failed: 0,
};

export interface BulkRunConfig {
  targets: TmdbBulkTargets;
  doMovies: boolean;
  doShows: boolean;
  doSeasons: boolean;
  doEpisodes: boolean;
  doWebisodes: boolean;
  doRatings: boolean;
  /** Pre-filtered lists (the dialog derives them from checkbox state). */
  unmatchedShows: { id: number; title: string; year: string | null; tmdb_id: string | null }[];
  seasonsNeeding: { id: number; show_id: number; season_number: number }[];
  episodeSeasonsNeeding: { id: number; show_id: number; season_number: number }[];
  eligibleWebisodeShows: { show_id: number }[];
}

export interface BulkRunOutcome {
  stats: BulkRunStats;
  review: BulkReviewItem[];
  noResult: { title: string; year: string | null }[];
  ratingsMissing: { title: string; year: string | null }[];
  ratingsNoId: { title: string; year: string | null }[];
  ratingsFatal: string | null;
}

/** Record a failed auto-match outcome so it persists into the metadata
 *  center. Best-effort — a failed write never aborts the run. */
async function recordAttempt(entryId: number, status: "notfound" | "ambiguous") {
  try {
    await invoke("record_tmdb_match_attempt", { entryId, status, detail: null });
  } catch {
    /* report row is a nicety; the run result already carries the info */
  }
}

/** One serial matching run. `tick` fires before each item (drives progress /
 *  ETA); `isCancelled` is polled between items — cancelling finishes the
 *  current item then stops. */
export async function runBulkMatch(
  cfg: BulkRunConfig,
  tick: (label: string) => void,
  isCancelled: () => boolean,
): Promise<BulkRunOutcome> {
  const { targets } = cfg;
  const s: BulkRunStats = { ...EMPTY_BULK_STATS };
  const review: BulkReviewItem[] = [];
  const noResult: { title: string; year: string | null }[] = [];
  const noRatings: { title: string; year: string | null }[] = [];
  const noId: { title: string; year: string | null }[] = [];
  let ratingsAborted: string | null = null;
  // Live tmdb ids for shows: pre-matched ones plus those matched this run.
  const showTmdb = new Map<number, number>();
  const showTitle = new Map<number, string>();
  for (const sh of targets.shows) {
    if (sh.tmdb_id) showTmdb.set(sh.id, Number(sh.tmdb_id));
    showTitle.set(sh.id, sh.title);
  }

  if (cfg.doMovies) {
    for (const m of targets.movies) {
      if (isCancelled()) break;
      tick(m.title);
      try {
        const results = await invoke<TmdbSearchResult[]>("search_tmdb_movie", {
          query: m.title,
          year: m.year,
        });
        if (results.length === 0) {
          noResult.push({ title: m.title, year: m.year });
          await recordAttempt(m.id, "notfound");
          continue;
        }
        const pick = confidentMovieMatch(results, m.title, m.year);
        if (!pick) {
          review.push({ kind: "movie", id: m.id, title: m.title, year: m.year });
          await recordAttempt(m.id, "ambiguous");
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

  if (cfg.doShows && !isCancelled()) {
    for (const sh of cfg.unmatchedShows) {
      if (isCancelled()) break;
      tick(sh.title);
      try {
        const results = await invoke<TmdbTvSearchResult[]>("search_tmdb_show", {
          query: sh.title,
          year: sh.year,
        });
        if (results.length === 0) {
          noResult.push({ title: sh.title, year: sh.year });
          await recordAttempt(sh.id, "notfound");
          continue;
        }
        const pick = confidentShowMatch(results, sh.title, sh.year);
        if (!pick) {
          review.push({ kind: "show", id: sh.id, title: sh.title, year: sh.year });
          await recordAttempt(sh.id, "ambiguous");
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

  if (cfg.doSeasons && !isCancelled()) {
    for (const se of cfg.seasonsNeeding) {
      if (isCancelled()) break;
      const title = showTitle.get(se.show_id);
      tick(title ? `Season ${se.season_number} - ${title}` : `Season ${se.season_number}`);
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

  if (cfg.doEpisodes && !isCancelled()) {
    for (const se of cfg.episodeSeasonsNeeding) {
      if (isCancelled()) break;
      const title = showTitle.get(se.show_id);
      tick(title ? `Season ${se.season_number} episodes - ${title}` : `Season ${se.season_number} episodes`);
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

  if (cfg.doWebisodes && !isCancelled()) {
    for (const w of cfg.eligibleWebisodeShows) {
      if (isCancelled()) break;
      const title = showTitle.get(w.show_id) ?? "Webisodes";
      tick(`${title} webisodes`);
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

  if (cfg.doRatings && !isCancelled()) {
    let consecutiveNetFails = 0;
    for (const m of [...targets.all_movies, ...targets.all_shows]) {
      if (isCancelled()) break;
      tick(`${m.title} ratings`);
      try {
        const fetched = await invoke<unknown[]>("fetch_ratings", { entryId: m.id });
        s.ratingsChecked++;
        consecutiveNetFails = 0;
        if (fetched.length > 0) s.ratingsFetched++;
        else noRatings.push({ title: m.title, year: m.year });
      } catch (err) {
        const msg = String(err);
        // Configuration/quota problems won't fix themselves mid-run —
        // stop instead of hammering OMDB once per remaining title.
        if (
          msg.includes("rejected the API key") ||
          msg.includes("request limit") ||
          msg.includes("Enable OMDB") ||
          msg.includes("No OMDB API key")
        ) {
          ratingsAborted = `Ratings pass stopped: ${msg}`;
          break;
        }
        if (msg.includes("No IMDb ID")) {
          noId.push({ title: m.title, year: m.year });
          continue;
        }
        s.failed++;
        if (msg.includes("Couldn't reach OMDB")) {
          consecutiveNetFails++;
          if (consecutiveNetFails >= 5) {
            ratingsAborted = "Ratings pass stopped: OMDB unreachable (5 titles in a row failed).";
            break;
          }
        }
      }
    }
  }

  return {
    stats: s,
    review,
    noResult,
    ratingsMissing: noRatings,
    ratingsNoId: noId,
    ratingsFatal: ratingsAborted,
  };
}

/** After a show is manually confirmed, fetch its seasons/episodes (the bulk
 *  run deliberately skips them for unconfirmed shows so a wrong guess never
 *  fans out). Returns the number of failed fetches, or null when there was
 *  nothing to do. */
export async function fetchShowSeasons(
  libraryId: string,
  showId: number,
  opts: { seasons: boolean; episodes: boolean },
): Promise<{ seasons: number; failed: number } | null> {
  if (!opts.seasons && !opts.episodes) return null;
  const t = await invoke<TmdbBulkTargets>("get_tmdb_bulk_targets", { libraryId });
  const show = t.shows.find((s) => s.id === showId);
  const tmdbId = show?.tmdb_id ? Number(show.tmdb_id) : null;
  if (!tmdbId) return null;
  // Only passes that haven't run for a season — a confirmed rematch clears
  // the stamps backend-side, so this still refetches everything for it.
  const seasons = t.seasons.filter(
    (se) => se.show_id === showId && (!se.season_done || !se.episodes_done),
  );
  if (seasons.length === 0) return null;
  let failed = 0;
  for (const se of seasons) {
    if (opts.seasons && !se.season_done) {
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
    if (opts.episodes && !se.episodes_done) {
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
  return { seasons: seasons.length, failed };
}
