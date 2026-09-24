import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  useContentSwap,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton, useHandoff } from "@/components/ui/skeleton";
import { Search, ArrowLeft } from "lucide-react";
import type {
  MovieDetail,
  TmdbSearchResult,
  TmdbMovieDetail,
  TmdbFieldSelection,
  CastUpdateInfo,
  PersonUpdateInfo,
} from "@/types";

const COMPOSER_JOBS = ["Composer", "Original Music Composer"];

interface TmdbMatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryId: number;
  entryTitle: string;
  entryYear: string | null;
  currentDetail: MovieDetail | null;
  onApplied: () => void;
}

type Step = "search" | "review";

interface FieldCheck {
  checked: boolean;
  isEmpty: boolean; // whether local field is empty
}

function extractYear(releaseDate: string | null | undefined): string {
  if (!releaseDate) return "";
  return releaseDate.substring(0, 4);
}

// Returns 0 (empty), 1 (year), 2 (year-month), or 3 (year-month-day)
function datePrecision(date: string | null | undefined): number {
  if (!date) return 0;
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) return 3;
  if (/^\d{4}-\d{2}/.test(date)) return 2;
  if (/^\d{4}/.test(date)) return 1;
  return 0;
}

function getUSCertification(tmdb: TmdbMovieDetail): string {
  if (!tmdb.releases?.countries) return "";
  const us = tmdb.releases.countries.find((c) => c.iso_3166_1 === "US");
  return us?.certification ?? "";
}

function extractDirectors(tmdb: TmdbMovieDetail): PersonUpdateInfo[] {
  if (!tmdb.credits?.crew) return [];
  return tmdb.credits.crew
    .filter((c) => c.job === "Director")
    .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
}

function extractCast(tmdb: TmdbMovieDetail): CastUpdateInfo[] {
  if (!tmdb.credits?.cast) return [];
  // Full cast in TMDB billing order — no cap (a flat top-20 dropped real but
  // deep-billed roles, e.g. Harley Keener at 72/105 in Endgame).
  return tmdb.credits.cast.map((c) => ({
    name: c.name,
    role: c.character ?? null,
    tmdb_id: c.id,
    profile_path: c.profile_path,
  }));
}

function extractComposers(tmdb: TmdbMovieDetail): PersonUpdateInfo[] {
  if (!tmdb.credits?.crew) return [];
  const seen = new Set<number>();
  return tmdb.credits.crew
    .filter((c) => c.job && COMPOSER_JOBS.includes(c.job))
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
}

function extractStudios(tmdb: TmdbMovieDetail): string[] {
  return tmdb.production_companies.map((c) => c.name);
}

function extractKeywords(tmdb: TmdbMovieDetail): string[] {
  return tmdb.keywords?.keywords.map((k) => k.name) ?? [];
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "(empty)";
}

function formatCast(items: CastUpdateInfo[]): string {
  if (items.length === 0) return "(empty)";
  return items
    .map((c) => (c.role ? `${c.name} (${c.role})` : c.name))
    .join(", ");
}

// Per-field data for the review step
interface ReviewField {
  key: string;
  label: string;
  currentDisplay: string;
  tmdbDisplay: string;
  isEmpty: boolean;
}

function buildReviewFields(
  current: MovieDetail,
  tmdb: TmdbMovieDetail
): ReviewField[] {
  const fields: ReviewField[] = [];

  const add = (
    key: string,
    label: string,
    currentVal: string | null | undefined,
    tmdbVal: string
  ) => {
    const cur = currentVal ?? "";
    fields.push({
      key,
      label,
      currentDisplay: cur || "(empty)",
      tmdbDisplay: tmdbVal || "(empty)",
      isEmpty: !cur,
    });
  };

  add("plot", "Plot", current.plot, tmdb.overview ?? "");
  add("tagline", "Tagline", current.tagline, tmdb.tagline ?? "");
  add(
    "runtime",
    "Runtime",
    current.runtime != null ? `${current.runtime} min` : null,
    tmdb.runtime != null ? `${tmdb.runtime} min` : ""
  );
  // Release date: treat as "empty" (pre-checked) if TMDB has more precision than current.
  // e.g. current = "2024" + tmdb = "2024-06-15" → pre-check to upgrade precision.
  const curRelease = current.release_date ?? "";
  const tmdbRelease = tmdb.release_date ?? "";
  const releaseNeedsUpgrade =
    datePrecision(tmdbRelease) > datePrecision(curRelease);
  fields.push({
    key: "release_date",
    label: "Release Date",
    currentDisplay: curRelease || "(empty)",
    tmdbDisplay: tmdbRelease || "(empty)",
    isEmpty: releaseNeedsUpgrade,
  });
  add(
    "maturity_rating",
    "Maturity Rating",
    current.maturity_rating,
    getUSCertification(tmdb)
  );
  add("imdb_id", "IMDB ID", current.imdb_id, tmdb.external_ids?.imdb_id ?? "");

  // List fields
  fields.push({
    key: "genres",
    label: "Genres",
    currentDisplay: formatList(current.genres),
    tmdbDisplay: formatList(tmdb.genres.map((g) => g.name)),
    isEmpty: current.genres.length === 0,
  });
  fields.push({
    key: "directors",
    label: "Directors",
    currentDisplay: formatList(current.directors.map((d) => d.name)),
    tmdbDisplay: formatList(extractDirectors(tmdb).map((d) => d.name)),
    isEmpty: current.directors.length === 0,
  });
  fields.push({
    key: "cast",
    label: "Cast",
    currentDisplay: formatCast(
      current.cast.map((c) => ({ name: c.name, role: c.role ?? null, tmdb_id: null, profile_path: null }))
    ),
    tmdbDisplay: formatCast(extractCast(tmdb)),
    isEmpty: current.cast.length === 0,
  });
  fields.push({
    key: "composers",
    label: "Composers",
    currentDisplay: formatList(current.composers.map((c) => c.name)),
    tmdbDisplay: formatList(extractComposers(tmdb).map((c) => c.name)),
    isEmpty: current.composers.length === 0,
  });
  fields.push({
    key: "studios",
    label: "Studios",
    currentDisplay: formatList(current.studios),
    tmdbDisplay: formatList(extractStudios(tmdb)),
    isEmpty: current.studios.length === 0,
  });
  fields.push({
    key: "keywords",
    label: "Keywords",
    currentDisplay: formatList(current.keywords),
    tmdbDisplay: formatList(extractKeywords(tmdb)),
    isEmpty: current.keywords.length === 0,
  });

  return fields;
}

export function TmdbMatchDialog({
  open,
  onOpenChange,
  entryId,
  entryTitle,
  entryYear,
  currentDetail,
  onApplied,
}: TmdbMatchDialogProps) {
  const [step, setStep] = useState<Step>("search");
  const [query, setQuery] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<TmdbSearchResult[]>([]);
  const [selectedTmdb, setSelectedTmdb] = useState<TmdbMovieDetail | null>(null);
  const [fieldChecks, setFieldChecks] = useState<Record<string, FieldCheck>>({});
  const [applying, setApplying] = useState(false);

  // Reset when dialog opens
  useEffect(() => {
    if (open) {
      setStep("search");
      setQuery(entryTitle);
      setYearFilter(entryYear ?? "");
      setResults([]);
      setSelectedTmdb(null);
      setFieldChecks({});
    }
  }, [open, entryTitle, entryYear]);

  const doSearch = useCallback(async () => {
    setSearching(true);
    try {
      const res = await invoke<TmdbSearchResult[]>("search_tmdb_movie", {
        query,
        year: yearFilter || null,
      });
      setResults(res);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSearching(false);
    }
  }, [query, yearFilter]);

  const selectResult = useCallback(
    async (result: TmdbSearchResult) => {
      try {
        const detail = await invoke<TmdbMovieDetail>("get_tmdb_movie_detail", {
          tmdbId: result.id,
        });
        setSelectedTmdb(detail);

        // Build initial check state — pre-check empty fields
        if (currentDetail) {
          const fields = buildReviewFields(currentDetail, detail);
          const checks: Record<string, FieldCheck> = {};
          for (const f of fields) {
            // Only pre-check if TMDB actually has data for this field
            const tmdbHasData = f.tmdbDisplay !== "(empty)";
            checks[f.key] = {
              checked: f.isEmpty && tmdbHasData,
              isEmpty: f.isEmpty,
            };
          }
          setFieldChecks(checks);
        }

        setStep("review");
      } catch (e) {
        toast.error(String(e));
      }
    },
    [currentDetail]
  );

  const applyMetadata = useCallback(async () => {
    if (!selectedTmdb || !currentDetail) return;
    setApplying(true);

    try {
      const sel: TmdbFieldSelection = {};

      // Always set tmdb_id when applying
      sel.tmdb_id = String(selectedTmdb.id);

      const isChecked = (key: string) => fieldChecks[key]?.checked;

      if (isChecked("plot") && selectedTmdb.overview) {
        sel.plot = selectedTmdb.overview;
      }
      if (isChecked("tagline") && selectedTmdb.tagline) {
        sel.tagline = selectedTmdb.tagline;
      }
      if (isChecked("runtime") && selectedTmdb.runtime != null) {
        sel.runtime = selectedTmdb.runtime;
      }
      if (isChecked("release_date") && selectedTmdb.release_date) {
        sel.release_date = selectedTmdb.release_date;
      }
      if (isChecked("maturity_rating")) {
        const cert = getUSCertification(selectedTmdb);
        if (cert) sel.maturity_rating = cert;
      }
      if (isChecked("imdb_id") && selectedTmdb.external_ids?.imdb_id) {
        sel.imdb_id = selectedTmdb.external_ids.imdb_id;
      }
      if (isChecked("genres")) {
        sel.genres = selectedTmdb.genres.map((g) => g.name);
      }
      if (isChecked("directors")) {
        sel.directors = extractDirectors(selectedTmdb);
      }
      if (isChecked("cast")) {
        sel.cast = extractCast(selectedTmdb);
      }
      if (isChecked("composers")) {
        sel.composers = extractComposers(selectedTmdb);
      }
      if (isChecked("studios")) {
        sel.studios = extractStudios(selectedTmdb);
      }
      if (isChecked("keywords")) {
        sel.keywords = extractKeywords(selectedTmdb);
      }

      await invoke("apply_tmdb_metadata", {
        entryId,
        fields: sel,
      });

      toast.success("TMDB metadata applied");
      onApplied();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setApplying(false);
    }
  }, [
    selectedTmdb,
    currentDetail,
    fieldChecks,
    entryId,
    onApplied,
    onOpenChange,
  ]);

  const reviewFields =
    currentDetail && selectedTmdb
      ? buildReviewFields(currentDetail, selectedTmdb)
      : [];

  const anyChecked = Object.values(fieldChecks).some((f) => f.checked);

  // The search → review swap: everything fades out, the step changes,
  // everything fades in. Both steps share one static frame, so no resize.
  const { shown, visible } = useContentSwap(step);
  // Search results: skeleton rows after 500ms, then the hand-off.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const handoff = useHandoff(!searching, bodyRef);
  const [pickingId, setPickingId] = useState<number | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Static, both steps: 720px wide, 34rem tall; the results and the
          field list scroll. */}
      <DialogContent width="45rem" height="34rem" className="gap-0 p-0">
        <div
          className={`flex h-full min-h-0 flex-col transition-opacity duration-200 ${
            visible ? "opacity-100" : "opacity-0"
          }`}
        >
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>
            {shown === "search" ? "Match with TMDB" : "Review TMDB Metadata"}
          </DialogTitle>
        </DialogHeader>

        {shown === "search" && (
          <>
            {/* Search bar */}
            <div className="flex shrink-0 gap-2 border-b px-6 py-3">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Movie title..."
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter") doSearch();
                }}
              />
              <Input
                value={yearFilter}
                onChange={(e) => setYearFilter(e.target.value)}
                placeholder="Year"
                className="w-20"
                onKeyDown={(e) => {
                  if (e.key === "Enter") doSearch();
                }}
              />
              <Button onClick={doSearch} disabled={searching || !query.trim() || !visible}>
                {searching ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Search size={14} />
                )}
                Search
              </Button>
            </div>

            {/* Results */}
            <DialogBody ref={bodyRef} className="relative">
              {results.length === 0 && !searching && (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">
                  Search for a movie to match
                </p>
              )}
              <div
                className={`transition-opacity duration-200 will-change-[opacity] ${
                  handoff.contentVisible ? "opacity-100" : "opacity-0"
                }`}
              >
                {results.map((r) => (
                  <button
                    key={r.id}
                    disabled={pickingId !== null || !visible}
                    onClick={async () => {
                      setPickingId(r.id);
                      try {
                        await selectResult(r);
                      } finally {
                        setPickingId(null);
                      }
                    }}
                    className="flex w-full gap-3 border-b px-6 py-3 text-left transition-colors hover:bg-accent/50 disabled:opacity-60"
                  >
                    {r.poster_path ? (
                      <img
                        src={`https://image.tmdb.org/t/p/w92${r.poster_path}`}
                        alt=""
                        className="h-[84px] w-14 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="flex h-[84px] w-14 shrink-0 items-center justify-center rounded bg-muted text-xs text-muted-foreground">
                        N/A
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {r.title}
                        {r.release_date && (
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            ({extractYear(r.release_date)})
                          </span>
                        )}
                      </p>
                      {r.overview && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {r.overview}
                        </p>
                      )}
                      {r.vote_average != null && r.vote_average > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Rating: {r.vote_average.toFixed(1)}/10
                        </p>
                      )}
                    </div>
                    {/* The row I clicked is working (its detail fetch). */}
                    {pickingId === r.id && <Spinner className="size-4 shrink-0 self-center" />}
                  </button>
                ))}
              </div>
              {!handoff.shown && handoff.skeletonSeen && (
                <div
                  className={`absolute inset-x-0 top-0 transition-opacity duration-200 ${
                    handoff.stage === "hidden" ? "" : "opacity-0"
                  }`}
                >
                  {Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="flex w-full gap-3 border-b px-6 py-3">
                      <Skeleton className="h-[84px] w-14 shrink-0 rounded" />
                      <div className="flex flex-1 flex-col gap-2 pt-1">
                        <Skeleton className="h-3.5 w-1/3" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-3/4" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </DialogBody>
          </>
        )}

        {shown === "review" && (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b px-6 py-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={!visible}
                onClick={() => setStep("search")}
              >
                <ArrowLeft size={14} />
                Back
              </Button>
              <p className="text-sm text-muted-foreground">
                {selectedTmdb?.title}
                {selectedTmdb?.release_date &&
                  ` (${extractYear(selectedTmdb.release_date)})`}
              </p>
            </div>

            <DialogBody>
              <div className="flex flex-col divide-y">
                {reviewFields.map((field) => {
                  const check = fieldChecks[field.key];
                  if (!check) return null;
                  // Skip if TMDB has no data for this field
                  if (field.tmdbDisplay === "(empty)") return null;

                  return (
                    <label
                      key={field.key}
                      className="flex cursor-pointer items-start gap-3 px-6 py-3 hover:bg-accent/30"
                    >
                      <Checkbox
                        checked={check.checked}
                        onCheckedChange={(checked) =>
                          setFieldChecks((prev) => ({
                            ...prev,
                            [field.key]: {
                              ...prev[field.key],
                              checked: !!checked,
                            },
                          }))
                        }
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {field.label}
                          {!field.isEmpty && (
                            <span className="ml-1.5 text-xs font-normal text-yellow-500">
                              (has data — will overwrite)
                            </span>
                          )}
                        </p>
                        {!field.isEmpty && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            <span className="font-medium">Current:</span>{" "}
                            <span className="line-clamp-2">
                              {field.currentDisplay}
                            </span>
                          </p>
                        )}
                        <p className="mt-1 text-xs text-foreground/80">
                          <span className="font-medium">TMDB:</span>{" "}
                          <span className="line-clamp-2">
                            {field.tmdbDisplay}
                          </span>
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </DialogBody>

            <DialogFooter className="m-0 shrink-0 border-t p-0 px-4 py-3">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={applying || !visible}
              >
                Cancel
              </Button>
              <Button
                onClick={applyMetadata}
                disabled={applying || !anyChecked || !visible}
              >
                {applying ? (
                  <>
                    <Spinner className="size-3.5" />
                    Applying...
                  </>
                ) : (
                  "Apply Selected"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
