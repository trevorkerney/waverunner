import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TmdbMatchDialog } from "@/components/TmdbMatchDialog";
import { TmdbShowMatchDialog } from "@/components/TmdbShowMatchDialog";
import { fetchShowSeasons } from "@/components/tmdbMatchEngine";
import type { MovieDetail, ShowDetail } from "@/types";
import { Film, Tv } from "lucide-react";

/** The video metadata center — the persistent analog of the music one: how
 *  matched the library is, every unmatched movie/show with its last attempt
 *  status ('notfound' / 'ambiguous' / never tried), each resolvable through
 *  the per-entry match dialogs, and a re-run entry into the bulk matcher.
 *  Rendered inside the import wizard's Review step and as a standalone dialog
 *  from the sidebar. */

interface UnmatchedRow {
  id: number;
  title: string;
  year: string | null;
  status: string | null;
  detail: string | null;
}

interface VideoMatchReport {
  movies: UnmatchedRow[];
  shows: UnmatchedRow[];
  total_movies: number;
  matched_movies: number;
  total_shows: number;
  matched_shows: number;
}

function statusLabel(status: string | null): { text: string; className: string } {
  if (status === "notfound") return { text: "no TMDB results", className: "text-destructive" };
  if (status === "ambiguous") return { text: "needs review", className: "text-primary" };
  return { text: "not attempted", className: "text-muted-foreground" };
}

export function VideoMetadataCenter({
  libraryId,
  reloadKey = 0,
  onChanged,
}: {
  libraryId: string;
  /** Bump to refetch (e.g. when the hosting dialog reopens). */
  reloadKey?: number;
  /** Metadata changed (a match applied) — the host invalidates caches. */
  onChanged?: () => void;
}) {
  const [report, setReport] = useState<VideoMatchReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState<{ kind: "movie" | "show"; row: UnmatchedRow } | null>(null);
  const [reviewingDetail, setReviewingDetail] = useState<MovieDetail | ShowDetail | null>(null);
  // Row whose Match… button is fetching its detail — that button shows a spinner.
  const [openingId, setOpeningId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setReport(await invoke<VideoMatchReport>("get_video_match_report", { libraryId }));
    } catch (e) {
      console.error("Failed to load match report:", e);
    } finally {
      setLoading(false);
    }
  }, [libraryId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh, reloadKey]);

  const openReview = useCallback(async (kind: "movie" | "show", row: UnmatchedRow) => {
    setOpeningId(row.id);
    try {
      if (kind === "movie") {
        setReviewingDetail(await invoke<MovieDetail>("get_movie_detail", { entryId: row.id }));
      } else {
        setReviewingDetail(await invoke<ShowDetail>("get_show_detail", { showId: row.id }));
      }
      setReviewing({ kind, row });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setOpeningId(null);
    }
  }, []);

  const applied = useCallback(() => {
    onChanged?.();
    void refresh();
  }, [onChanged, refresh]);

  const section = (kind: "movie" | "show", label: string, rows: UnmatchedRow[]) =>
    rows.length > 0 && (
      <div className="flex flex-col gap-1.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {kind === "movie" ? <Film size={13} /> : <Tv size={13} />}
          {label}
        </p>
        <div className="flex flex-col gap-1">
          {rows.map((row) => {
            const st = statusLabel(row.status);
            return (
              <div
                key={row.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {row.title}
                  {row.year ? ` (${row.year})` : ""}
                </span>
                <span className={`shrink-0 text-xs ${st.className}`}>{st.text}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={openingId !== null}
                  onClick={() => void openReview(kind, row)}
                >
                  {openingId === row.id && <Spinner className="size-3" />}
                  Match…
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden pb-4">
      {loading || !report ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Checking match status…
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {[
              report.total_movies > 0
                ? `${report.matched_movies} of ${report.total_movies} movies matched`
                : null,
              report.total_shows > 0
                ? `${report.matched_shows} of ${report.total_shows} shows matched`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || "No movies or shows in this library."}
          </p>

          {report.movies.length === 0 && report.shows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Everything is matched to TMDB. New files picked up by a rescan will show
              up here until they're matched.
            </p>
          )}

          {section("movie", "Unmatched movies", report.movies)}
          {section("show", "Unmatched shows", report.shows)}
        </>
      )}

      {reviewing?.kind === "movie" && (
        <TmdbMatchDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setReviewing(null);
              setReviewingDetail(null);
            }
          }}
          entryId={reviewing.row.id}
          entryTitle={reviewing.row.title}
          entryYear={reviewing.row.year}
          currentDetail={reviewingDetail as MovieDetail | null}
          onApplied={applied}
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
          entryId={reviewing.row.id}
          entryTitle={reviewing.row.title}
          entryYear={reviewing.row.year}
          currentDetail={reviewingDetail as ShowDetail | null}
          onApplied={() => {
            const { id, title } = reviewing.row;
            applied();
            // A confirmed show pulls its seasons/episodes — the bulk pass
            // deliberately skips them for unconfirmed shows.
            void (async () => {
              try {
                const toastId = toast.loading(`${title}: fetching seasons…`);
                const result = await fetchShowSeasons(libraryId, id, { seasons: true, episodes: true });
                if (result == null) {
                  toast.dismiss(toastId);
                  return;
                }
                if (result.failed > 0) {
                  toast.error(`${title}: ${result.failed} season fetches failed`, { id: toastId });
                } else {
                  toast.success(`${title}: seasons & episodes updated`, { id: toastId });
                }
                onChanged?.();
              } catch (e) {
                toast.error(String(e));
              }
            })();
          }}
        />
      )}
    </div>
  );
}

/** Standalone host for the center (sidebar → "Metadata center" on a video
 *  library), mirroring the music MetadataCenterDialog. */
export function VideoMetadataCenterDialog({
  libraryId,
  open,
  onOpenChange,
  onChanged,
}: {
  libraryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  // Per-library opt-out: the whole video center is TMDB/OMDB-backed, so an
  // opted-out library gets the notice (with the way back on) instead.
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    if (open) setReloadKey((k) => k + 1);
  }, [open]);
  useEffect(() => {
    if (!open || !libraryId) return;
    setOnline(null);
    void invoke<Record<string, string>>("get_library_settings", { libraryId })
      .then((ls) => setOnline(ls["online_metadata"] !== "off"))
      .catch(() => setOnline(true));
  }, [open, libraryId, reloadKey]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-[min(72rem,calc(100vw-3rem))] max-w-none flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Metadata center</DialogTitle>
        </DialogHeader>
        {open && libraryId && online === null && (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        )}
        {open && libraryId && online === false && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <p className="max-w-md text-sm text-muted-foreground">
              Online metadata is off for this library — nothing here talks to TMDB or OMDB, and
              movies and shows aren’t matched.
            </p>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await invoke("set_library_setting", {
                    libraryId,
                    key: "online_metadata",
                    value: "on",
                  });
                  setOnline(true);
                } catch (e) {
                  toast.error(String(e));
                }
              }}
            >
              Turn on
            </Button>
          </div>
        )}
        {open && libraryId && online === true && (
          <VideoMetadataCenter libraryId={libraryId} reloadKey={reloadKey} onChanged={onChanged} />
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
