import { useState, useEffect } from "react";
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
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { TmdbTvDetail, TmdbSeasonDetail, TmdbSeasonStub, TmdbEpisodeSummary } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tmdbId: number | null;
  /** Local season/episode numbers — used to pre-select a sensible default. */
  defaultSeason: number | null;
  defaultEpisode: number | null;
  onFetch: (season: number, episode: number) => void;
}

function seasonLabel(s: TmdbSeasonStub): string {
  return `${s.name} · ${s.episode_count} ${s.episode_count === 1 ? "episode" : "episodes"}`;
}

function episodeLabel(e: TmdbEpisodeSummary): string {
  return `${e.episode_number} · ${e.name}`;
}

/**
 * Lets the user point an episode's metadata pull at a *different* TMDB
 * season/episode by browsing TMDB's actual structure (find by title), for the
 * case where TMDB files content inline that the user keeps as a special.
 * Falls back to plain number inputs if the season list can't be loaded.
 */
export function TmdbEpisodeSourceDialog({ open, onOpenChange, tmdbId, defaultSeason, defaultEpisode, onFetch }: Props) {
  const [seasons, setSeasons] = useState<TmdbSeasonStub[]>([]);
  const [seasonsLoading, setSeasonsLoading] = useState(false);
  const [manual, setManual] = useState(false); // fallback: no season list available

  const [selSeason, setSelSeason] = useState<string>("");
  const [episodes, setEpisodes] = useState<TmdbEpisodeSummary[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [selEpisode, setSelEpisode] = useState<string>("");

  // Manual-mode fields (only used when the season list can't be fetched).
  const [manSeason, setManSeason] = useState("");
  const [manEpisode, setManEpisode] = useState("");

  // Load the show's TMDB season list when the dialog opens.
  useEffect(() => {
    if (!open || tmdbId == null) return;
    let cancelled = false;
    setSeasonsLoading(true);
    setManual(false);
    setManSeason(defaultSeason != null ? String(defaultSeason) : "");
    setManEpisode(defaultEpisode != null ? String(defaultEpisode) : "");
    (async () => {
      try {
        const detail = await invoke<TmdbTvDetail>("get_tmdb_show_detail", { tmdbId });
        if (cancelled) return;
        const list = detail.seasons ?? [];
        if (list.length === 0) {
          setManual(true);
          return;
        }
        setSeasons(list);
        const pick = defaultSeason != null && list.some((s) => s.season_number === defaultSeason)
          ? defaultSeason
          : list[0].season_number;
        setSelSeason(String(pick));
      } catch (e) {
        if (cancelled) return;
        toast.error(String(e));
        setManual(true);
      } finally {
        if (!cancelled) setSeasonsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, tmdbId, defaultSeason, defaultEpisode]);

  // Load the selected season's episodes whenever the season changes.
  useEffect(() => {
    if (!open || tmdbId == null || manual || selSeason === "") return;
    let cancelled = false;
    const seasonNum = Number(selSeason);
    setEpisodesLoading(true);
    (async () => {
      try {
        const detail = await invoke<TmdbSeasonDetail>("get_tmdb_season_detail", {
          tmdbId,
          seasonNumber: seasonNum,
        });
        if (cancelled) return;
        const eps = detail.episodes ?? [];
        setEpisodes(eps);
        // Prefer the local episode number, but only when we're on the local season.
        const preferred = seasonNum === defaultSeason && defaultEpisode != null ? defaultEpisode : null;
        const pick = preferred != null && eps.some((e) => e.episode_number === preferred)
          ? preferred
          : eps[0]?.episode_number;
        setSelEpisode(pick != null ? String(pick) : "");
      } catch (e) {
        if (cancelled) return;
        toast.error(String(e));
        setEpisodes([]);
        setSelEpisode("");
      } finally {
        if (!cancelled) setEpisodesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, tmdbId, manual, selSeason, defaultSeason, defaultEpisode]);

  // Reset transient state on close so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setSeasons([]);
      setSelSeason("");
      setEpisodes([]);
      setSelEpisode("");
    }
  }, [open]);

  const submit = () => {
    if (manual) {
      const season = Number(manSeason);
      const episode = Number(manEpisode);
      if (manSeason.trim() === "" || manEpisode.trim() === "" || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) {
        toast.error("Enter a valid TMDB season and episode number");
        return;
      }
      onFetch(season, episode);
      onOpenChange(false);
      return;
    }
    if (selSeason === "" || selEpisode === "") {
      toast.error("Choose a season and episode");
      return;
    }
    onFetch(Number(selSeason), Number(selEpisode));
    onOpenChange(false);
  };

  const selectedSeasonObj = seasons.find((s) => String(s.season_number) === selSeason);
  const selectedEpisodeObj = episodes.find((e) => String(e.episode_number) === selEpisode);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fetch from a specific TMDB episode</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Pull this episode&rsquo;s metadata from a different TMDB season/episode — useful when TMDB
          files content inline that you keep as a special (e.g. Black Mirror&rsquo;s &ldquo;White
          Christmas&rdquo; is in Season&nbsp;2 on TMDB, not a special). Your file stays where it is;
          only the metadata is copied in.
        </p>

        {seasonsLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Loading seasons…
          </div>
        ) : manual ? (
          <div className="flex justify-center gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">TMDB Season</span>
              <input
                value={manSeason}
                onChange={(e) => setManSeason(e.target.value)}
                inputMode="numeric"
                className="w-24 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">TMDB Episode</span>
              <input
                value={manEpisode}
                onChange={(e) => setManEpisode(e.target.value)}
                inputMode="numeric"
                className="w-24 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
              />
            </label>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Season</span>
              <Select value={selSeason} onValueChange={(v) => v && setSelSeason(v)}>
                <SelectTrigger className="w-full">
                  <span className="line-clamp-1 text-left">
                    {selectedSeasonObj ? seasonLabel(selectedSeasonObj) : "Select a season"}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {seasons.map((s) => (
                    <SelectItem key={s.season_number} value={String(s.season_number)}>
                      {seasonLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Episode</span>
              {episodesLoading ? (
                <div className="flex items-center gap-2 py-1.5 text-sm text-muted-foreground">
                  <Spinner className="h-4 w-4" /> Loading episodes…
                </div>
              ) : episodes.length === 0 ? (
                <p className="py-1.5 text-sm text-muted-foreground">No episodes in this season.</p>
              ) : (
                <Select value={selEpisode} onValueChange={(v) => v && setSelEpisode(v)}>
                  <SelectTrigger className="w-full">
                    <span className="line-clamp-1 text-left">
                      {selectedEpisodeObj ? episodeLabel(selectedEpisodeObj) : "Select an episode"}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {episodes.map((e) => (
                      <SelectItem key={e.episode_number} value={String(e.episode_number)}>
                        {episodeLabel(e)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={seasonsLoading}>Fetch</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
