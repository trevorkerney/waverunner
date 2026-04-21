import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Image as ImageIcon,
  Trash2,
  Pencil,
  Play,
  Film,
  Tv,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { TmdbShowMatchDialog } from "@/components/TmdbShowMatchDialog";
import { TmdbImageBrowserDialog } from "@/components/TmdbImageBrowserDialog";
import { useCoverUrl } from "@/context/CoverUrlContext";
import { useSelectedLibrary } from "@/context/LibraryContext";
import { getDisplayCover } from "@/components/cards/SortableCoverCard";
import { EditField } from "@/views/video/detail/parts/EditField";
import { PersonPickerList } from "@/views/video/detail/parts/PersonPickerList";
import { TruncatedList } from "@/views/video/detail/parts/TruncatedList";
import type {
  MediaEntry,
  SeasonInfo,
  EpisodeInfo,
  ShowDetail,
  SeasonDetailLocal,
  EpisodeDetailLocal,
  TmdbSeasonDetail,
  TmdbEpisodeDetail,
  TmdbShowFieldSelection,
  TmdbSeasonFieldSelection,
  TmdbEpisodeFieldSelection,
} from "@/types";

function formatReleaseDate(date: string | null | undefined): string | null {
  if (!date) return null;
  if (/^\d{4}$/.test(date)) return date;
  if (/^\d{4}-\d{2}$/.test(date)) {
    const [y, m] = date.split("-");
    return new Date(+y, +m - 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split("-");
    return new Date(+y, +m - 1, +d).toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  return date;
}

export function ShowDetailPage({
  entry,
  onEntryChanged,
  onTitleChanged,
  onChangeCover,
  onAddCover,
  onDeleteCover,
  onPlayEpisode,
}: {
  entry: MediaEntry;
  onEntryChanged: () => void;
  onTitleChanged: (entryId: number, newTitle: string) => void;
  onChangeCover: () => void;
  onAddCover: () => void;
  onDeleteCover: () => void;
  onPlayEpisode?: (args: {
    libraryId: string;
    showId: number;
    showTitle: string;
    startEpisodeId: number;
  }) => void;
}) {
  const { getFullCoverUrl } = useCoverUrl();
  const selectedLibrary = useSelectedLibrary();
  const [detail, setDetail] = useState<ShowDetail | null>(null);
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [selectedSeasonId, setSelectedSeasonId] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [tmdbDialogOpen, setTmdbDialogOpen] = useState(false);
  const [tmdbImagesOpen, setTmdbImagesOpen] = useState(false);
  const [seasonDetail, setSeasonDetail] = useState<SeasonDetailLocal | null>(null);
  const [episodeDetails, setEpisodeDetails] = useState<Map<number, EpisodeDetailLocal>>(new Map());
  const [expandedEpisodeId, setExpandedEpisodeId] = useState<number | null>(null);
  const [seasonTmdbLoading, setSeasonTmdbLoading] = useState(false);
  const [bulkEpisodesLoading, setBulkEpisodesLoading] = useState(false);
  const [episodeTmdbLoading, setEpisodeTmdbLoading] = useState<number | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [showEditing, setShowEditing] = useState(false);
  const [showDraft, setShowDraft] = useState<TmdbShowFieldSelection>({});
  const [showSaving, setShowSaving] = useState(false);
  const [seasonEditing, setSeasonEditing] = useState(false);
  const [seasonDraft, setSeasonDraft] = useState<TmdbSeasonFieldSelection>({});
  const [seasonSaving, setSeasonSaving] = useState(false);
  const [editingEpisodeId, setEditingEpisodeId] = useState<number | null>(null);
  const [episodeDraft, setEpisodeDraft] = useState<TmdbEpisodeFieldSelection>({});
  const [episodeSaving, setEpisodeSaving] = useState(false);
  const selectedSeason = seasons.find((s) => s.id === selectedSeasonId);
  const selectedSeasonLabel = selectedSeason
    ? (selectedSeason.season_number != null
        ? `Season ${selectedSeason.season_number}`
        : selectedSeason.title)
    : "Select season";

  const loadDetail = useCallback(async () => {
    try {
      const d = await invoke<ShowDetail>("get_show_detail", {
        showId: entry.id,
      });
      setDetail(d);
    } catch (e) {
      console.error("Failed to load show detail:", e);
    }
  }, [entry.id]);

  const loadSeasonDetail = useCallback(async (seasonId: number) => {
    try {
      const d = await invoke<SeasonDetailLocal>("get_season_detail_local", {
        seasonId,
      });
      setSeasonDetail(d);
    } catch (e) {
      console.error("Failed to load season detail:", e);
    }
  }, []);

  const loadEpisodeDetail = useCallback(async (episodeId: number) => {
    try {
      const d = await invoke<EpisodeDetailLocal>("get_episode_detail_local", {
        episodeId,
      });
      setEpisodeDetails((prev) => new Map(prev).set(episodeId, d));
    } catch (e) {
      console.error("Failed to load episode detail:", e);
    }
  }, []);

  /** Re-fetch the season dropdown. Called on mount and after any apply/edit that may have
   *  renamed seasons (TMDB apply, manual season title edit). */
  const loadSeasons = useCallback(
    async (opts?: { pickFirstIfNone?: boolean }) => {
      try {
        const s = await invoke<SeasonInfo[]>("get_show_seasons", {
          showId: entry.id,
        });
        setSeasons(s);
        if (opts?.pickFirstIfNone && s.length > 0) {
          setSelectedSeasonId((current) => current ?? s[0].id);
        }
      } catch (e) {
        console.error("Failed to load seasons:", e);
      }
    },
    [entry.id],
  );

  /** Re-fetch the selected season's episodes list. Called when selectedSeasonId changes
   *  and after any apply/edit that may have renamed episodes. */
  const loadEpisodes = useCallback(async (seasonId: number) => {
    try {
      const eps = await invoke<EpisodeInfo[]>("get_season_episodes", {
        seasonId,
      });
      setEpisodes(eps);
    } catch (e) {
      console.error("Failed to load episodes:", e);
    }
  }, []);

  useEffect(() => {
    loadDetail();
    loadSeasons({ pickFirstIfNone: true });
  }, [loadDetail, loadSeasons]);

  useEffect(() => {
    if (selectedSeasonId == null) return;
    setSeasonDetail(null);
    setEpisodeDetails(new Map());
    setExpandedEpisodeId(null);
    loadSeasonDetail(selectedSeasonId);
    loadEpisodes(selectedSeasonId);
  }, [selectedSeasonId, loadSeasonDetail, loadEpisodes]);

  const handleSeasonTmdb = useCallback(async () => {
    if (!detail?.tmdb_id || !selectedSeason || selectedSeason.season_number == null) return;
    setSeasonTmdbLoading(true);
    try {
      const tmdbSeason = await invoke<TmdbSeasonDetail>("get_tmdb_season_detail", {
        tmdbId: Number(detail.tmdb_id),
        seasonNumber: selectedSeason.season_number,
      });
      const fields: TmdbSeasonFieldSelection = {};
      if (tmdbSeason.name) fields.title = tmdbSeason.name;
      if (tmdbSeason.overview) fields.plot = tmdbSeason.overview;
      if (tmdbSeason.credits?.cast && tmdbSeason.credits.cast.length > 0) {
        fields.cast = tmdbSeason.credits.cast.slice(0, 20).map((c) => ({
          name: c.name,
          role: c.character ?? null,
          tmdb_id: c.id,
          profile_path: c.profile_path,
        }));
      }
      if (tmdbSeason.credits?.crew) {
        const directors = tmdbSeason.credits.crew
          .filter((c) => c.job === "Director")
          .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
        if (directors.length > 0) fields.season_director = directors;
      }
      await invoke("apply_tmdb_season_metadata", {
        seasonId: selectedSeason.id,
        fields,
      });
      toast.success("Season metadata populated from TMDB");
      // Refresh the season dropdown (title may have changed) and the current season's
      // detail panel so the user sees changes without having to navigate away.
      loadSeasons();
      loadSeasonDetail(selectedSeason.id);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSeasonTmdbLoading(false);
    }
  }, [detail, selectedSeason, loadSeasons, loadSeasonDetail]);

  const handleBulkEpisodes = useCallback(async () => {
    if (!detail?.tmdb_id || !selectedSeason || selectedSeason.season_number == null) return;
    setBulkConfirmOpen(false);
    setBulkEpisodesLoading(true);
    try {
      const count = await invoke<number>("apply_tmdb_season_episodes", {
        seasonId: selectedSeason.id,
        tmdbId: Number(detail.tmdb_id),
        seasonNumber: selectedSeason.season_number,
      });
      toast.success(`Populated ${count} episode(s) from TMDB`);
      setEpisodeDetails(new Map());
      setExpandedEpisodeId(null);
      // Season title AND every episode title may have been rewritten by the bulk apply.
      // Refresh both lists so the user sees the new names live without re-navigating.
      loadSeasons();
      loadEpisodes(selectedSeason.id);
      onEntryChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBulkEpisodesLoading(false);
    }
  }, [detail, selectedSeason, loadSeasons, loadEpisodes, onEntryChanged]);

  const handleEpisodeTmdb = useCallback(
    async (ep: EpisodeInfo) => {
      if (
        !detail?.tmdb_id ||
        !selectedSeason ||
        selectedSeason.season_number == null ||
        ep.episode_number == null
      )
        return;
      setEpisodeTmdbLoading(ep.id);
      try {
        const tmdbEp = await invoke<TmdbEpisodeDetail>("get_tmdb_episode_detail", {
          tmdbId: Number(detail.tmdb_id),
          seasonNumber: selectedSeason.season_number,
          episodeNumber: ep.episode_number,
        });
        const fields: TmdbEpisodeFieldSelection = {};
        if (tmdbEp.name) fields.title = tmdbEp.name;
        if (tmdbEp.overview) fields.plot = tmdbEp.overview;
        if (tmdbEp.runtime) fields.runtime = tmdbEp.runtime;
        if (tmdbEp.air_date) fields.release_date = tmdbEp.air_date;
        if (tmdbEp.guest_stars && tmdbEp.guest_stars.length > 0) {
          fields.cast = tmdbEp.guest_stars.map((c) => ({
            name: c.name,
            role: c.character ?? null,
            tmdb_id: c.id,
            profile_path: c.profile_path,
          }));
        }
        if (tmdbEp.crew && tmdbEp.crew.length > 0) {
          const directors = tmdbEp.crew
            .filter((c) => c.job === "Director")
            .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
          const composers = tmdbEp.crew
            .filter((c) => c.job === "Composer" || c.job === "Original Music Composer")
            .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
          if (directors.length > 0) fields.director = directors;
          if (composers.length > 0) fields.composer = composers;
        }
        await invoke("apply_tmdb_episode_metadata", {
          episodeId: ep.id,
          fields,
        });
        toast.success(`Episode ${ep.episode_number} metadata populated`);
        // Title may have changed — refresh the episode list so the row name updates live.
        if (selectedSeason) loadEpisodes(selectedSeason.id);
        loadEpisodeDetail(ep.id);
        onEntryChanged();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setEpisodeTmdbLoading(null);
      }
    },
    [detail, selectedSeason, loadEpisodes, loadEpisodeDetail, onEntryChanged],
  );

  const startEditShow = useCallback(() => {
    if (!detail) return;
    setSeasonEditing(false);
    setEditingEpisodeId(null);
    setShowDraft({
      title: entry.title,
      plot: detail.plot ?? "",
      tagline: detail.tagline ?? "",
      maturity_rating: detail.maturity_rating ?? "",
      genres: [...detail.genres],
      creators: detail.creators.map((p) => ({
        name: p.name,
        tmdb_id: null,
        profile_path: null,
      })),
      cast: detail.cast.map((c) => ({
        name: c.name,
        role: c.role,
        tmdb_id: null,
        profile_path: null,
      })),
      composers: detail.composers.map((p) => ({
        name: p.name,
        tmdb_id: null,
        profile_path: null,
      })),
      studios: [...detail.studios],
      keywords: [...detail.keywords],
      is_anthology: detail.is_anthology,
    });
    setShowEditing(true);
  }, [detail, entry.title]);

  const saveShow = useCallback(async () => {
    setShowSaving(true);
    try {
      await invoke("apply_tmdb_show_metadata", {
        showId: entry.id,
        fields: showDraft,
      });
      // Propagate the title change to the parent's caches so the sidebar/library grid
      // reflect it immediately. Folder on disk is deliberately NOT renamed — that's the
      // library card's rename flow.
      const newTitle = showDraft.title?.trim();
      if (newTitle && newTitle !== entry.title) {
        onTitleChanged(entry.id, newTitle);
      }
      await loadDetail();
      onEntryChanged();
      setShowEditing(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setShowSaving(false);
    }
  }, [entry.id, entry.title, showDraft, loadDetail, onEntryChanged, onTitleChanged]);

  const startEditSeason = useCallback(() => {
    if (!seasonDetail) return;
    setShowEditing(false);
    setEditingEpisodeId(null);
    setSeasonDraft({
      title: seasonDetail.title,
      plot: seasonDetail.plot ?? "",
      cast: seasonDetail.cast.map((c) => ({
        name: c.name,
        role: c.role,
        tmdb_id: null,
        profile_path: null,
      })),
    });
    setSeasonEditing(true);
  }, [seasonDetail]);

  const saveSeason = useCallback(async () => {
    if (!selectedSeason) return;
    setSeasonSaving(true);
    try {
      await invoke("apply_tmdb_season_metadata", {
        seasonId: selectedSeason.id,
        fields: seasonDraft,
      });
      // If the user edited the title, refresh the seasons dropdown so it reflects live.
      if (seasonDraft.title !== undefined) loadSeasons();
      loadSeasonDetail(selectedSeason.id);
      setSeasonEditing(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSeasonSaving(false);
    }
  }, [selectedSeason, seasonDraft, loadSeasons, loadSeasonDetail]);

  const startEditEpisode = useCallback(
    (ep: EpisodeInfo) => {
      setShowEditing(false);
      setSeasonEditing(false);
      const d = episodeDetails.get(ep.id);
      // Title comes from the episode row (`ep.title`) — the per-episode detail fetch
      // (`EpisodeDetailLocal`) would also have it, but when the user opens edit without
      // having fetched detail first, we still need a reasonable initial value.
      setEpisodeDraft({
        title: d?.title ?? ep.title,
        plot: d?.plot ?? "",
        runtime: d?.runtime ?? undefined,
        release_date: d?.release_date ?? "",
        cast:
          d?.cast.map((c) => ({
            name: c.name,
            role: c.role,
            tmdb_id: null,
            profile_path: null,
          })) ?? [],
        director:
          d?.directors.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })) ?? [],
        composer:
          d?.composers.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })) ?? [],
      });
      setEditingEpisodeId(ep.id);
    },
    [episodeDetails],
  );

  const saveEpisode = useCallback(async () => {
    if (editingEpisodeId == null) return;
    setEpisodeSaving(true);
    try {
      await invoke("apply_tmdb_episode_metadata", {
        episodeId: editingEpisodeId,
        fields: episodeDraft,
      });
      // Title edit propagates to the episode list row live.
      if (episodeDraft.title !== undefined && selectedSeason) {
        loadEpisodes(selectedSeason.id);
      }
      loadEpisodeDetail(editingEpisodeId);
      onEntryChanged();
      setEditingEpisodeId(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setEpisodeSaving(false);
    }
  }, [editingEpisodeId, episodeDraft, selectedSeason, loadEpisodes, loadEpisodeDetail, onEntryChanged]);

  const toggleEpisode = useCallback(
    (epId: number) => {
      if (expandedEpisodeId === epId) {
        setExpandedEpisodeId(null);
      } else {
        setExpandedEpisodeId(epId);
        if (!episodeDetails.has(epId)) {
          loadEpisodeDetail(epId);
        }
      }
    },
    [expandedEpisodeId, episodeDetails, loadEpisodeDetail],
  );

  if (!selectedLibrary) return null;

  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getFullCoverUrl(coverPath) : null;
  const hasTmdb = !!detail?.tmdb_id;
  const canSeasonTmdb = hasTmdb && selectedSeason?.season_number != null;

  return (
    <div className="flex gap-8 p-4">
      {coverSrc && (
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <img
                src={coverSrc}
                alt={entry.title}
                className="h-auto max-h-[500px] w-auto shrink-0 rounded-lg object-contain shadow-lg"
              />
            }
          />
          <ContextMenuContent>
            <ContextMenuItem onClick={onAddCover}>
              <ImageIcon size={14} />
              Add local cover
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setTmdbImagesOpen(true)} disabled={!detail?.tmdb_id}>
              <ImageIcon size={14} />
              Add cover from TMDB
            </ContextMenuItem>
            <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
              <ImageIcon size={14} />
              Change cover
            </ContextMenuItem>
            <ContextMenuItem onClick={onDeleteCover} disabled={entry.covers.length < 1}>
              <Trash2 size={14} />
              Delete cover
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-w-0 flex-1 flex-col gap-4" />}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold">{entry.title}</h1>
              {(entry.season_display || entry.collection_display || entry.year) && (
                <p className="text-lg text-muted-foreground">
                  {[
                    entry.season_display || entry.collection_display,
                    entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              )}
            </div>
          </div>

          {detail && !showEditing && (
            <div className="flex flex-col gap-3">
              {detail.tagline && (
                <p className="text-sm italic text-muted-foreground">{detail.tagline}</p>
              )}
              {detail.plot && <p className="text-sm">{detail.plot}</p>}
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                {detail.maturity_rating && (
                  <div>
                    <span className="text-muted-foreground">Rating: </span>
                    {detail.maturity_rating}
                  </div>
                )}
                {detail.genres.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">Genres: </span>
                    {detail.genres.join(", ")}
                  </div>
                )}
                {detail.studios.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">Studios: </span>
                    {detail.studios.join(", ")}
                  </div>
                )}
              </div>
              <TruncatedList
                label="Cast"
                items={detail.cast.map((c) => (c.role ? `${c.name} (${c.role})` : c.name))}
              />
              <TruncatedList label="Created By" items={detail.creators.map((c) => c.name)} />
              <TruncatedList label="Composers" items={detail.composers.map((c) => c.name)} />
              {detail.keywords.length > 0 && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Keywords: </span>
                  {detail.keywords.join(", ")}
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {detail.tmdb_id && <span>TMDB: {detail.tmdb_id}</span>}
                {detail.imdb_id && <span>IMDB: {detail.imdb_id}</span>}
              </div>
            </div>
          )}

          {showEditing && (
            <div className="flex flex-col gap-3 text-sm">
              <EditField
                label="Title"
                value={showDraft.title ?? ""}
                onChange={(v) => setShowDraft((p) => ({ ...p, title: v }))}
              />
              <EditField
                label="Tagline"
                value={showDraft.tagline ?? ""}
                onChange={(v) => setShowDraft((p) => ({ ...p, tagline: v }))}
              />
              <EditField
                label="Plot"
                value={showDraft.plot ?? ""}
                onChange={(v) => setShowDraft((p) => ({ ...p, plot: v }))}
                multiline
              />
              <EditField
                label="Maturity Rating"
                value={showDraft.maturity_rating ?? ""}
                onChange={(v) => setShowDraft((p) => ({ ...p, maturity_rating: v }))}
              />
              <EditField
                label="Genres (comma-separated)"
                value={(showDraft.genres ?? []).join(", ")}
                onChange={(v) =>
                  setShowDraft((p) => ({
                    ...p,
                    genres: v.split(",").map((s) => s.trim()).filter(Boolean),
                  }))
                }
              />
              <PersonPickerList
                label="Creators"
                items={showDraft.creators ?? []}
                onChange={(items) => setShowDraft((p) => ({ ...p, creators: items }))}
              />
              <PersonPickerList
                label="Composers"
                items={showDraft.composers ?? []}
                onChange={(items) => setShowDraft((p) => ({ ...p, composers: items }))}
              />
              <PersonPickerList
                label="Cast"
                items={showDraft.cast ?? []}
                onChange={(items) => setShowDraft((p) => ({ ...p, cast: items }))}
                secondaryField="role"
                secondaryLabel="Character"
              />
              <EditField
                label="Studios (comma-separated)"
                value={(showDraft.studios ?? []).join(", ")}
                onChange={(v) =>
                  setShowDraft((p) => ({
                    ...p,
                    studios: v.split(",").map((s) => s.trim()).filter(Boolean),
                  }))
                }
              />
              <EditField
                label="Keywords (comma-separated)"
                value={(showDraft.keywords ?? []).join(", ")}
                onChange={(v) =>
                  setShowDraft((p) => ({
                    ...p,
                    keywords: v.split(",").map((s) => s.trim()).filter(Boolean),
                  }))
                }
              />
              {/* Anthology flag — gates whether the person-detail page is allowed to show
                   episode-level involvement (episode titles, counts) without risking spoilers.
                   Auto-populated from TMDB's `anthology` keyword during apply; manually
                   toggleable here when coverage misses. */}
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Anthology series</label>
                <Switch
                  checked={showDraft.is_anthology ?? false}
                  onCheckedChange={(checked) =>
                    setShowDraft((p) => ({ ...p, is_anthology: checked }))
                  }
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setShowEditing(false)} disabled={showSaving}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveShow} disabled={showSaving}>
                  {showSaving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          )}

          {seasons.length > 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Select
                  value={String(selectedSeasonId)}
                  onValueChange={(val) => setSelectedSeasonId(Number(val))}
                >
                  <SelectTrigger className="w-48">{selectedSeasonLabel}</SelectTrigger>
                  <SelectContent>
                    {seasons.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.season_number != null ? `Season ${s.season_number}` : s.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedSeason && !seasonEditing && (() => {
                const hasMeta = seasonDetail && (seasonDetail.plot || seasonDetail.cast.length > 0);
                const episodesNumbered =
                  episodes.length > 0 && episodes.every((e) => e.episode_number != null);
                return (
                  <ContextMenu>
                    <ContextMenuTrigger
                      render={<div className="flex flex-col gap-2 rounded-md border p-3" />}
                    >
                      {!seasonDetail && <Spinner className="h-4 w-4" />}
                      {seasonDetail && !hasMeta && (
                        <p className="text-sm text-muted-foreground">No metadata</p>
                      )}
                      {seasonDetail && hasMeta && (
                        <>
                          {seasonDetail.plot && <p className="text-sm">{seasonDetail.plot}</p>}
                          <TruncatedList
                            label="Cast"
                            items={seasonDetail.cast.map((c) =>
                              c.role ? `${c.name} (${c.role})` : c.name,
                            )}
                          />
                        </>
                      )}
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={startEditSeason} disabled={!seasonDetail}>
                        <Pencil size={14} />
                        Edit
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={handleSeasonTmdb}
                        disabled={!canSeasonTmdb || seasonTmdbLoading}
                      >
                        <Tv size={14} />
                        {seasonTmdbLoading ? "Loading..." : "Populate season from TMDB"}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => setBulkConfirmOpen(true)}
                        disabled={!canSeasonTmdb || bulkEpisodesLoading || !episodesNumbered}
                      >
                        <Film size={14} />
                        {bulkEpisodesLoading ? "Loading..." : "Fetch all episodes' details"}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })()}

              {selectedSeason && seasonEditing && (
                <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
                  <EditField
                    label="Title"
                    value={seasonDraft.title ?? ""}
                    onChange={(v) => setSeasonDraft((p) => ({ ...p, title: v }))}
                  />
                  <EditField
                    label="Plot"
                    value={seasonDraft.plot ?? ""}
                    onChange={(v) => setSeasonDraft((p) => ({ ...p, plot: v }))}
                    multiline
                  />
                  <PersonPickerList
                    label="Season-wide Director (applied to every episode)"
                    items={seasonDraft.season_director ?? []}
                    onChange={(items) => setSeasonDraft((p) => ({ ...p, season_director: items }))}
                  />
                  <PersonPickerList
                    label="Cast"
                    items={seasonDraft.cast ?? []}
                    onChange={(items) => setSeasonDraft((p) => ({ ...p, cast: items }))}
                    secondaryField="role"
                    secondaryLabel="Character"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setSeasonEditing(false)} disabled={seasonSaving}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={saveSeason} disabled={seasonSaving}>
                      {seasonSaving ? "Saving..." : "Save"}
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1">
                {episodes.map((ep) => {
                  const isExpanded = expandedEpisodeId === ep.id;
                  const epDetail = episodeDetails.get(ep.id);
                  const hasDetail =
                    epDetail &&
                    (epDetail.release_date ||
                      epDetail.plot ||
                      epDetail.runtime ||
                      epDetail.cast.length > 0 ||
                      epDetail.directors.length > 0 ||
                      epDetail.composers.length > 0);
                  return (
                    <div key={ep.id} className="flex flex-col">
                      <ContextMenu>
                        <ContextMenuTrigger
                          render={
                            <div
                              className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-accent"
                              onClick={() => toggleEpisode(ep.id)}
                            />
                          }
                        >
                          {isExpanded ? (
                            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
                          )}
                          <span className="w-8 text-right text-sm text-muted-foreground">
                            {ep.episode_number != null ? ep.episode_number : "–"}
                          </span>
                          <span className="flex-1 truncate text-sm">{ep.title}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              try {
                                onPlayEpisode?.({
                                  libraryId: selectedLibrary.id,
                                  showId: entry.id,
                                  showTitle: entry.title,
                                  startEpisodeId: ep.id,
                                });
                              } catch (err) {
                                toast.error(String(err));
                              }
                            }}
                          >
                            <Play size={14} />
                          </Button>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onClick={() => handleEpisodeTmdb(ep)}
                            disabled={
                              !canSeasonTmdb ||
                              ep.episode_number == null ||
                              episodeTmdbLoading === ep.id
                            }
                          >
                            <Film size={14} />
                            {episodeTmdbLoading === ep.id ? "Loading..." : "Fetch from TMDB"}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                      {isExpanded && editingEpisodeId !== ep.id && (
                        <ContextMenu>
                          <ContextMenuTrigger
                            render={
                              <div className="ml-14 mb-1 flex flex-col gap-1 rounded-md border p-3 text-sm" />
                            }
                          >
                            {!epDetail && <Spinner className="h-4 w-4" />}
                            {epDetail && !hasDetail && (
                              <p className="text-muted-foreground">No metadata</p>
                            )}
                            {epDetail && hasDetail && (
                              <>
                                {epDetail.release_date && (
                                  <div>
                                    <span className="text-muted-foreground">Air Date: </span>
                                    {formatReleaseDate(epDetail.release_date)}
                                  </div>
                                )}
                                {epDetail.runtime && (
                                  <div>
                                    <span className="text-muted-foreground">Runtime: </span>
                                    {epDetail.runtime} min
                                  </div>
                                )}
                                {epDetail.plot && <p>{epDetail.plot}</p>}
                                <TruncatedList
                                  label="Guest Stars"
                                  items={epDetail.cast.map((c) =>
                                    c.role ? `${c.name} (${c.role})` : c.name,
                                  )}
                                />
                                <TruncatedList
                                  label="Directors"
                                  items={epDetail.directors.map((d) => d.name)}
                                />
                                <TruncatedList
                                  label="Composers"
                                  items={epDetail.composers.map((c) => c.name)}
                                />
                              </>
                            )}
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onClick={() => startEditEpisode(ep)} disabled={!epDetail}>
                              <Pencil size={14} />
                              Edit
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => handleEpisodeTmdb(ep)}
                              disabled={
                                !canSeasonTmdb ||
                                ep.episode_number == null ||
                                episodeTmdbLoading === ep.id
                              }
                            >
                              <Film size={14} />
                              {episodeTmdbLoading === ep.id ? "Loading..." : "Fetch from TMDB"}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      )}
                      {isExpanded && editingEpisodeId === ep.id && (
                        <div className="ml-14 mb-1 flex flex-col gap-3 rounded-md border p-3 text-sm">
                          <EditField
                            label="Title"
                            value={episodeDraft.title ?? ""}
                            onChange={(v) => setEpisodeDraft((p) => ({ ...p, title: v }))}
                          />
                          <EditField
                            label="Air Date"
                            value={episodeDraft.release_date ?? ""}
                            onChange={(v) => setEpisodeDraft((p) => ({ ...p, release_date: v }))}
                          />
                          <EditField
                            label="Runtime (min)"
                            value={episodeDraft.runtime != null ? String(episodeDraft.runtime) : ""}
                            onChange={(v) =>
                              setEpisodeDraft((p) => ({
                                ...p,
                                runtime: v ? Number(v) : undefined,
                              }))
                            }
                          />
                          <EditField
                            label="Plot"
                            value={episodeDraft.plot ?? ""}
                            onChange={(v) => setEpisodeDraft((p) => ({ ...p, plot: v }))}
                            multiline
                          />
                          <PersonPickerList
                            label="Guest Stars"
                            items={episodeDraft.cast ?? []}
                            onChange={(items) =>
                              setEpisodeDraft((p) => ({ ...p, cast: items }))
                            }
                            secondaryField="role"
                            secondaryLabel="Character"
                          />
                          <PersonPickerList
                            label="Director"
                            items={episodeDraft.director ?? []}
                            onChange={(items) => setEpisodeDraft((p) => ({ ...p, director: items }))}
                          />
                          <PersonPickerList
                            label="Composer"
                            items={episodeDraft.composer ?? []}
                            onChange={(items) => setEpisodeDraft((p) => ({ ...p, composer: items }))}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingEpisodeId(null)}
                              disabled={episodeSaving}
                            >
                              Cancel
                            </Button>
                            <Button size="sm" onClick={saveEpisode} disabled={episodeSaving}>
                              {episodeSaving ? "Saving..." : "Save"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {episodes.length === 0 && (
                  <p className="text-sm text-muted-foreground">No episodes</p>
                )}
              </div>
            </div>
          )}

          {seasons.length === 0 && (
            <p className="text-sm text-muted-foreground">No seasons</p>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setTmdbDialogOpen(true)}>
            <Film size={14} />
            {detail?.tmdb_id ? "Rematch TMDB" : "Match TMDB"}
          </ContextMenuItem>
          <ContextMenuItem onClick={startEditShow} disabled={!detail}>
            <Pencil size={14} />
            Edit
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <TmdbShowMatchDialog
        open={tmdbDialogOpen}
        onOpenChange={setTmdbDialogOpen}
        entryId={entry.id}
        entryTitle={entry.title}
        entryYear={entry.year}
        currentDetail={detail}
        onApplied={() => {
          loadDetail();
          onEntryChanged();
        }}
      />

      {detail?.tmdb_id && (
        <TmdbImageBrowserDialog
          open={tmdbImagesOpen}
          onOpenChange={setTmdbImagesOpen}
          libraryId={selectedLibrary.id}
          entryId={entry.id}
          tmdbId={detail.tmdb_id}
          onDownloaded={() => {
            loadDetail();
            onEntryChanged();
          }}
        />
      )}

      <Dialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fetch Episode Details</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            This will fetch metadata (plot, runtime, guest stars, crew) for all episodes in this
            season from TMDB. Only empty fields will be populated. Doing this multiple times in
            quick succession may cause you to hit TMDB's rate limit.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleBulkEpisodes}>Fetch All Episodes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
