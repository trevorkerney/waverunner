import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { PersonDetailHeader } from "@/components/PersonDetailHeader";
import { EditCharacterNameDialog } from "@/components/dialogs/EditCharacterNameDialog";
import { TmdbPersonMatchDialog } from "@/components/dialogs/TmdbPersonMatchDialog";
import { CoverCarouselDialog } from "@/components/dialogs/CoverCarouselDialog";
import { PersonRoleSection } from "@/views/video/parts/PersonRoleSection";
import { MovieDetailPage } from "@/views/video/detail/MovieDetailPage";
import { ShowDetailPage } from "@/views/video/detail/ShowDetailPage";
import type { MediaEntry, PersonDetail, PersonEntriesResponse, ViewSpec } from "@/types";

/** Person-detail page: profile header + bio + per-role sections (Actor / Director /
 *  Composer). Header/bio region is wrapped in a ContextMenu so right-click there opens
 *  TMDB match / refresh / clear actions. Right-click inside the role grid still shows
 *  the per-card menu (or nothing for the grid void). */
export function PersonDetailView({
  view,
  breadcrumbBar,
  personEntries,
  selectedEntry,
  loading,
  coverSize,
  onNavigate,
  onPersonEntriesChanged,
  onEntryChanged,
  onTitleChanged,
  onSetCover,
  onAddCover,
  onDeleteCover,
  onPlayFile,
  onPlayEpisode,
  scrollContainerRef,
}: {
  view: Extract<ViewSpec, { kind: "person-detail" }>;
  breadcrumbBar: ReactNode;
  personEntries: PersonEntriesResponse | null;
  /** When set, a role-section card was clicked and we render the movie/show detail
   *  page in place of the grid. Mirrors the pattern in LibraryGridView/PlaylistDetailView. */
  selectedEntry: MediaEntry | null;
  loading: boolean;
  coverSize: number;
  onNavigate: (entry: MediaEntry) => void;
  /** Tells App to invalidate the cached PersonEntriesResponse for this view and refetch.
   *  Called after character-name edits (via the Actor section cards). Does NOT cover
   *  header-level changes like TMDB match/refresh — those only change `PersonDetail` and
   *  we refetch that locally. */
  onPersonEntriesChanged: () => void;
  onEntryChanged: () => void;
  onTitleChanged: (entryId: number, newTitle: string) => void;
  onSetCover: (
    entryId: number,
    coverPath: string | null,
    opts?: { linkId?: number | null; playlistCollection?: boolean },
  ) => void;
  onAddCover: (entryId: number, opts?: { playlistCollection?: boolean }) => Promise<void>;
  onDeleteCover: (
    entryId: number,
    coverPath: string,
    opts?: { playlistCollection?: boolean },
  ) => Promise<void>;
  onPlayFile?: (path: string, title: string) => void;
  onPlayEpisode?: (args: {
    libraryId: string;
    showId: number;
    showTitle: string;
    startEpisodeId: number;
  }) => void;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const [editTarget, setEditTarget] = useState<MediaEntry | null>(null);
  const [matchDialogOpen, setMatchDialogOpen] = useState(false);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [coverDialogEntry, setCoverDialogEntry] = useState<MediaEntry | null>(null);
  const [coverDialogMode, setCoverDialogMode] = useState<"select" | "delete">("select");

  const openCoverDialog = useCallback((entry: MediaEntry, mode: "select" | "delete") => {
    setCoverDialogMode(mode);
    setCoverDialogEntry(entry);
  }, []);

  // Look up the freshest copy of the dialog's entry. selectedEntry wins when it matches
  // (the covers array there reflects post-save state); otherwise scan the three role lists.
  const liveCoverDialogEntry = useMemo(() => {
    if (!coverDialogEntry) return null;
    if (selectedEntry?.id === coverDialogEntry.id) return selectedEntry;
    if (personEntries) {
      for (const list of [personEntries.actor, personEntries.director, personEntries.composer]) {
        const found = list.find((e) => e.id === coverDialogEntry.id);
        if (found) return found;
      }
    }
    return coverDialogEntry;
  }, [coverDialogEntry, personEntries, selectedEntry]);

  // Fetch PersonDetail on mount + whenever the viewed person changes. Re-fetched after
  // TMDB match / refresh / clear so the header + bio reflect the new data.
  const loadDetail = useCallback(async () => {
    try {
      const d = await invoke<PersonDetail>("get_person_detail", { personId: view.personId });
      setDetail(d);
    } catch (e) {
      console.error("Failed to load person detail:", e);
    }
  }, [view.personId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const handleRefresh = async () => {
    try {
      await invoke("refresh_tmdb_person", { personId: view.personId });
      await loadDetail();
      toast.success("Refreshed from TMDB");
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleClear = async () => {
    try {
      await invoke("clear_tmdb_person_match", { personId: view.personId });
      await loadDetail();
    } catch (e) {
      toast.error(String(e));
    }
  };

  // De-duplicated movie / show counts across all three role sections. Eastwood directing
  // AND acting in Million Dollar Baby counts as 1 movie, not 2.
  const { movieCount, showCount } = useMemo(() => {
    if (!personEntries) return { movieCount: 0, showCount: 0 };
    const movies = new Set<number>();
    const shows = new Set<number>();
    for (const list of [personEntries.actor, personEntries.director, personEntries.composer]) {
      for (const e of list) {
        if (e.entry_type === "movie") movies.add(e.id);
        else if (e.entry_type === "show") shows.add(e.id);
      }
    }
    return { movieCount: movies.size, showCount: shows.size };
  }, [personEntries]);

  const isMatched = detail?.tmdb_id != null;

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {breadcrumbBar}
      {!selectedEntry && (
        <ContextMenu>
          <ContextMenuTrigger render={<div />}>
            <PersonDetailHeader
              name={detail?.name ?? view.personName}
              imagePath={detail?.image_path ?? view.personImage}
              movieCount={movieCount}
              showCount={showCount}
            />
            {detail?.bio && <CollapsibleBio text={detail.bio} />}
          </ContextMenuTrigger>
          <ContextMenuContent>
            {/* For matched persons the primary action is pulling their full TMDB data
                 (bio + canonical name + portrait). Media-level match only gives us
                 tmdb_id + portrait; bios come from /person/{id} which we only hit on
                 demand. Re-matching to a different TMDB person is a rarer path, so it
                 sits below. */}
            {isMatched ? (
              <>
                <ContextMenuItem onClick={handleRefresh}>Fetch TMDB data</ContextMenuItem>
                <ContextMenuItem onClick={() => setMatchDialogOpen(true)}>
                  Change TMDB match…
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={handleClear}
                  className="text-destructive focus:text-destructive"
                >
                  Clear TMDB match
                </ContextMenuItem>
              </>
            ) : (
              <ContextMenuItem onClick={() => setMatchDialogOpen(true)}>
                Match to TMDB…
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
      )}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden p-4"
        onContextMenu={(e) => {
          // Block the empty background context menu — sections only allow per-card menus.
          if (e.target === e.currentTarget) e.preventDefault();
        }}
      >
        {selectedEntry ? (
          selectedEntry.entry_type === "show" ? (
            <ShowDetailPage
              entry={selectedEntry}
              onEntryChanged={onEntryChanged}
              onTitleChanged={onTitleChanged}
              onChangeCover={() => openCoverDialog(selectedEntry, "select")}
              onAddCover={() => onAddCover(selectedEntry.id)}
              onDeleteCover={() => openCoverDialog(selectedEntry, "delete")}
              onPlayEpisode={onPlayEpisode}
            />
          ) : (
            <MovieDetailPage
              entry={selectedEntry}
              onEntryChanged={onEntryChanged}
              onTitleChanged={onTitleChanged}
              onChangeCover={() => openCoverDialog(selectedEntry, "select")}
              onAddCover={() => onAddCover(selectedEntry.id)}
              onDeleteCover={() => openCoverDialog(selectedEntry, "delete")}
              onPlayFile={onPlayFile}
            />
          )
        ) : loading && !personEntries ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : !personEntries ? null : (
          <div className="flex flex-col gap-6">
            {personEntries.actor.length > 0 && (
              <PersonRoleSection
                label="actor"
                entries={personEntries.actor}
                coverSize={coverSize}
                onNavigate={onNavigate}
                onEditCharacterName={(entry) => setEditTarget(entry)}
              />
            )}
            {personEntries.director.length > 0 && (
              <PersonRoleSection
                label="director"
                entries={personEntries.director}
                coverSize={coverSize}
                onNavigate={onNavigate}
              />
            )}
            {personEntries.composer.length > 0 && (
              <PersonRoleSection
                label="composer"
                entries={personEntries.composer}
                coverSize={coverSize}
                onNavigate={onNavigate}
              />
            )}
            {personEntries.actor.length === 0 &&
              personEntries.director.length === 0 &&
              personEntries.composer.length === 0 && (
                <p className="text-sm text-muted-foreground">No works in this library.</p>
              )}
          </div>
        )}
      </div>

      {liveCoverDialogEntry && (
        <CoverCarouselDialog
          entry={liveCoverDialogEntry}
          mode={coverDialogMode}
          open={!!coverDialogEntry}
          onOpenChange={(open) => {
            if (!open) setCoverDialogEntry(null);
          }}
          onSelect={(coverPath) => {
            onSetCover(liveCoverDialogEntry.id, coverPath, {
              linkId: liveCoverDialogEntry.link_id,
              playlistCollection: liveCoverDialogEntry.entry_type === "playlist_collection",
            });
            setCoverDialogEntry(null);
          }}
          onDelete={async (coverPath) => {
            const wasLast = liveCoverDialogEntry.covers.length <= 1;
            await onDeleteCover(liveCoverDialogEntry.id, coverPath, {
              playlistCollection: liveCoverDialogEntry.entry_type === "playlist_collection",
            });
            if (wasLast) setCoverDialogEntry(null);
          }}
        />
      )}

      <EditCharacterNameDialog
        open={editTarget !== null}
        onOpenChange={(o) => {
          if (!o) setEditTarget(null);
        }}
        personId={view.personId}
        personName={detail?.name ?? view.personName}
        entry={editTarget}
        initialRole={extractRoleFromLabel(editTarget?.season_display ?? null)}
        onSaved={() => {
          setEditTarget(null);
          onPersonEntriesChanged();
        }}
      />

      <TmdbPersonMatchDialog
        open={matchDialogOpen}
        onOpenChange={setMatchDialogOpen}
        personId={view.personId}
        personName={detail?.name ?? view.personName}
        onApplied={() => {
          loadDetail();
          // Person name may have changed on TMDB apply (canonical spelling), which
          // affects role-section labels since compute_person_entry_label reads the
          // latest role/name. Refetch entries too.
          onPersonEntriesChanged();
        }}
      />
    </main>
  );
}

/** Pull the character name out of an involvement label. Labels start with `as ` for
 *  named cast credits (e.g. `as Walter White`, `as Lacie in "Nosedive"`). For anything
 *  else (generic forms), we don't have a meaningful initial value — leave blank so the
 *  user types from scratch. */
function extractRoleFromLabel(label: string | null): string | null {
  if (!label) return null;
  if (!label.startsWith("as ")) return null;
  const rest = label.slice(3);
  const inIdx = rest.lastIndexOf(' in "');
  return inIdx >= 0 ? rest.slice(0, inIdx) : rest;
}

function CollapsibleBio({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // Cheap heuristic — bios that fit on two lines don't need the toggle. The actual
  // display uses line-clamp-2 regardless, which handles the visual cut.
  const showToggle = text.length > 180;

  return (
    <div className="border-b border-border px-4 pb-3 pt-1">
      <p className={`text-sm text-muted-foreground ${expanded ? "" : "line-clamp-2"}`}>{text}</p>
      {showToggle && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-muted-foreground underline hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
