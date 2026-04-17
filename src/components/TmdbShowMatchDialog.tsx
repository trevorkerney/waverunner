import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Search, ArrowLeft } from "lucide-react";
import type {
  ShowDetail,
  TmdbTvSearchResult,
  TmdbTvDetail,
  TmdbShowFieldSelection,
  CastUpdateInfo,
  CrewUpdateInfo,
  PersonUpdateInfo,
} from "@/types";

const NOTABLE_CREW_JOBS = [
  "Writer",
  "Screenplay",
  "Story",
  "Composer",
  "Original Music Composer",
  "Director of Photography",
  "Cinematographer",
  "Editor",
];

interface TmdbShowMatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryId: number;
  entryTitle: string;
  entryYear: string | null;
  currentDetail: ShowDetail | null;
  onApplied: () => void;
}

type Step = "search" | "review";

interface FieldCheck {
  checked: boolean;
  isEmpty: boolean;
}

function extractYear(date: string | null | undefined): string {
  if (!date) return "";
  return date.substring(0, 4);
}

function getUSRating(tmdb: TmdbTvDetail): string {
  if (!tmdb.content_ratings?.results) return "";
  const us = tmdb.content_ratings.results.find((c) => c.iso_3166_1 === "US");
  return us?.rating ?? "";
}

function extractCreators(tmdb: TmdbTvDetail): PersonUpdateInfo[] {
  return tmdb.created_by.map((c) => ({ name: c.name, tmdb_id: c.id }));
}

function extractCast(tmdb: TmdbTvDetail, limit = 20): CastUpdateInfo[] {
  if (!tmdb.credits?.cast) return [];
  return tmdb.credits.cast.slice(0, limit).map((c) => ({
    name: c.name,
    role: c.character ?? null,
    tmdb_id: c.id,
  }));
}

function extractCrew(tmdb: TmdbTvDetail): CrewUpdateInfo[] {
  if (!tmdb.credits?.crew) return [];
  return tmdb.credits.crew
    .filter((c) => c.job && NOTABLE_CREW_JOBS.includes(c.job) && c.job !== "Director")
    .map((c) => ({ name: c.name, job: c.job ?? null, tmdb_id: c.id }));
}

function extractProducers(tmdb: TmdbTvDetail): PersonUpdateInfo[] {
  if (!tmdb.credits?.crew) return [];
  const seen = new Set<number>();
  return tmdb.credits.crew
    .filter(
      (c) =>
        c.job === "Producer" ||
        c.job === "Executive Producer" ||
        c.department === "Production"
    )
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .map((c) => ({ name: c.name, tmdb_id: c.id }));
}

function extractStudios(tmdb: TmdbTvDetail): string[] {
  return [
    ...tmdb.production_companies.map((c) => c.name),
    ...tmdb.networks.map((n) => n.name),
  ].filter((v, i, a) => a.indexOf(v) === i);
}

function extractKeywords(tmdb: TmdbTvDetail): string[] {
  return tmdb.keywords?.results.map((k) => k.name) ?? [];
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

function formatCrew(items: CrewUpdateInfo[]): string {
  if (items.length === 0) return "(empty)";
  return items
    .map((c) => (c.job ? `${c.name} (${c.job})` : c.name))
    .join(", ");
}

interface ReviewField {
  key: string;
  label: string;
  currentDisplay: string;
  tmdbDisplay: string;
  isEmpty: boolean;
}

function buildReviewFields(
  current: ShowDetail,
  tmdb: TmdbTvDetail,
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
    "maturity_rating",
    "Maturity Rating",
    current.maturity_rating,
    getUSRating(tmdb)
  );
  add("imdb_id", "IMDB ID", current.imdb_id, tmdb.external_ids?.imdb_id ?? "");

  fields.push({
    key: "genres",
    label: "Genres",
    currentDisplay: formatList(current.genres),
    tmdbDisplay: formatList(tmdb.genres.map((g) => g.name)),
    isEmpty: current.genres.length === 0,
  });
  fields.push({
    key: "creators",
    label: "Created By",
    currentDisplay: formatList(current.creators.map((c) => c.name)),
    tmdbDisplay: formatList(extractCreators(tmdb).map((c) => c.name)),
    isEmpty: current.creators.length === 0,
  });
  fields.push({
    key: "cast",
    label: "Cast",
    currentDisplay: formatCast(
      current.cast.map((c) => ({ name: c.name, role: c.role ?? null, tmdb_id: null }))
    ),
    tmdbDisplay: formatCast(extractCast(tmdb)),
    isEmpty: current.cast.length === 0,
  });
  fields.push({
    key: "crew",
    label: "Crew",
    currentDisplay: formatCrew(
      current.crew.map((c) => ({ name: c.name, job: c.job ?? null, tmdb_id: null }))
    ),
    tmdbDisplay: formatCrew(extractCrew(tmdb)),
    isEmpty: current.crew.length === 0,
  });
  fields.push({
    key: "producers",
    label: "Producers",
    currentDisplay: formatList(current.producers.map((p) => p.name)),
    tmdbDisplay: formatList(extractProducers(tmdb).map((p) => p.name)),
    isEmpty: current.producers.length === 0,
  });
  fields.push({
    key: "studios",
    label: "Studios / Networks",
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

export function TmdbShowMatchDialog({
  open,
  onOpenChange,
  entryId,
  entryTitle,
  entryYear,
  currentDetail,
  onApplied,
}: TmdbShowMatchDialogProps) {
  const [step, setStep] = useState<Step>("search");
  const [query, setQuery] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<TmdbTvSearchResult[]>([]);
  const [selectedTmdb, setSelectedTmdb] = useState<TmdbTvDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [fieldChecks, setFieldChecks] = useState<Record<string, FieldCheck>>({});
  const [applying, setApplying] = useState(false);

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
      const res = await invoke<TmdbTvSearchResult[]>("search_tmdb_show", {
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
    async (result: TmdbTvSearchResult) => {
      setLoadingDetail(true);
      try {
        const detail = await invoke<TmdbTvDetail>("get_tmdb_show_detail", {
          tmdbId: result.id,
        });
        setSelectedTmdb(detail);

        if (currentDetail) {
          const fields = buildReviewFields(currentDetail, detail);
          const checks: Record<string, FieldCheck> = {};
          for (const f of fields) {
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
      } finally {
        setLoadingDetail(false);
      }
    },
    [currentDetail, entryYear]
  );

  const applyMetadata = useCallback(async () => {
    if (!selectedTmdb || !currentDetail) return;
    setApplying(true);

    try {
      const sel: TmdbShowFieldSelection = {};

      sel.tmdb_id = String(selectedTmdb.id);

      const isChecked = (key: string) => fieldChecks[key]?.checked;

      if (isChecked("plot") && selectedTmdb.overview) {
        sel.plot = selectedTmdb.overview;
      }
      if (isChecked("tagline") && selectedTmdb.tagline) {
        sel.tagline = selectedTmdb.tagline;
      }
      if (isChecked("maturity_rating")) {
        const rating = getUSRating(selectedTmdb);
        if (rating) sel.maturity_rating = rating;
      }
      if (isChecked("imdb_id") && selectedTmdb.external_ids?.imdb_id) {
        sel.imdb_id = selectedTmdb.external_ids.imdb_id;
      }
      if (isChecked("genres")) {
        sel.genres = selectedTmdb.genres.map((g) => g.name);
      }
      if (isChecked("creators")) {
        sel.creators = extractCreators(selectedTmdb);
      }
      if (isChecked("cast")) {
        sel.cast = extractCast(selectedTmdb);
      }
      if (isChecked("crew")) {
        sel.crew = extractCrew(selectedTmdb);
      }
      if (isChecked("producers")) {
        sel.producers = extractProducers(selectedTmdb);
      }
      if (isChecked("studios")) {
        sel.studios = extractStudios(selectedTmdb);
      }
      if (isChecked("keywords")) {
        sel.keywords = extractKeywords(selectedTmdb);
      }

      await invoke("apply_tmdb_show_metadata", {
        showId: entryId,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[720px] max-w-[90vw] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>
            {step === "search" ? "Match with TMDB" : "Review TMDB Metadata"}
          </DialogTitle>
        </DialogHeader>

        {step === "search" && (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex gap-2 border-b px-6 py-3">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="TV show title..."
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
              <Button onClick={doSearch} disabled={searching || !query.trim()}>
                {searching ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Search size={14} />
                )}
                Search
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {loadingDetail && (
                <div className="flex items-center justify-center py-12">
                  <Spinner className="size-6" />
                </div>
              )}
              {!loadingDetail && results.length === 0 && !searching && (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">
                  Search for a TV show to match
                </p>
              )}
              {!loadingDetail &&
                results.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => selectResult(r)}
                    className="flex w-full gap-3 border-b px-6 py-3 text-left transition-colors hover:bg-accent/50"
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
                        {r.name}
                        {r.first_air_date && (
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            ({extractYear(r.first_air_date)})
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
                  </button>
                ))}
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b px-6 py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep("search")}
              >
                <ArrowLeft size={14} />
                Back
              </Button>
              <p className="text-sm text-muted-foreground">
                {selectedTmdb?.name}
                {selectedTmdb?.first_air_date &&
                  ` (${extractYear(selectedTmdb.first_air_date)})`}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-col divide-y">
                {reviewFields.map((field) => {
                  const check = fieldChecks[field.key];
                  if (!check) return null;
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
            </div>

            <DialogFooter className="m-0 shrink-0 border-t p-0 px-4 py-3">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={applying}
              >
                Cancel
              </Button>
              <Button
                onClick={applyMetadata}
                disabled={applying || !anyChecked}
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
