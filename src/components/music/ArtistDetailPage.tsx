import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Music2, Pencil, Scissors, LayoutGrid, List, ArrowUpDown, Disc3, ListPlus, ListStart, ListEnd, VenetianMask, HardDriveDownload } from "lucide-react";
import { CoversDialog, CoversMenuItem } from "../CoversDialog";
import { RenameDialog } from "../RenameDialog";
import { ReleasePicker } from "./ReleasePicker";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import { Spinner } from "../ui/spinner";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";
import { TrackEditDialog, ArtistEditDialog, SplitArtistDialog } from "./EditDialogs";
import { MatchDialog, MbStatusChip } from "./MatchDialog";
import { PersonaDialog } from "./PersonaDialog";
import { PlayingIndicator } from "./PlayingIndicator";
import { LoveButton, LoveMenuItem } from "./LoveButton";
import { RevealMenuItem } from "./RevealMenuItem";
import { useMbHidden } from "@/lib/mbVisibility";
import { MbDot } from "./MbDot";
import { useTagWriting } from "@/lib/tagWriting";
import { TagWriteDialog, TagWriteScope } from "./TagWriteDialog";
import type { LoveLevel } from "../../types";
import { CodecBadge } from "./CodecBadge";
import { MusicArtistDetail, MusicAlbumCard, MusicAlbumDetail, MusicQueueItem, MusicRelease, MusicTrack } from "../../types";
import { queueFromRelease, defaultRelease, releaseCover, releaseTitle, trackDisplayTitle, fmtTrackTime, fmtAlbumRuntime } from "./musicQueue";
import { useDeselectOnBackgroundClick } from "./useTrackSelection";

// Artist-page view + sort preferences — implicit in-app prefs (instant apply,
// persisted in the background). Cached module-wide so later page mounts don't
// flash the defaults before the settings load. Sort uses the app-wide date
// vocabulary: "date" = oldest first, "date-desc" = newest first.
let cachedArtistView: "grid" | "list" | null = null;
let cachedArtistSort: "date" | "date-desc" | null = null;
// Detail-view heart filter — "hearts" = liked or loved, "loved" = loved only.
// Session-sticky (module cache, not a setting): it's a lens you flip on to
// browse, not a preference to come back to next launch.
type HeartFilter = "all" | "hearts" | "loved";
let cachedHeartFilter: HeartFilter = "all";

interface ArtistDetailPageProps {
  entryId: number;
  /** Scopes the persona picker's artist search to this library. */
  libraryId: string;
  /** Grid thumbnail resolver (covers → covers_thumb), from App. */
  getCoverUrl: (filePath: string) => string;
  getFullCoverUrl: (filePath: string) => string;
  onOpenAlbum: (album: MusicAlbumCard) => void;
  /** Detail-view artist links (album owners, track credits) → artist pages. */
  onNavigateToArtist?: (artistId: number, artistTitle: string) => void;
  onPlayQueue: (items: MusicQueueItem[], startIndex: number) => void;
  /** Track id in the now-playing bar, for list-view row highlighting. */
  currentTrackId?: number | null;
  /** Whether that track is actively playing — freezes the equalizer when false. */
  playing?: boolean;
  /** Metadata was edited — the host invalidates its grid caches. */
  onMetadataChanged?: () => void;
  /** Title changed via an edit — the host patches breadcrumbs/nav state. */
  onTitleChanged?: (entryId: number, newTitle: string) => void;
  /** Opens the host's add-to-playlist dialog for a track row. */
  onAddToPlaylist?: (track: { id: number; title: string }) => void;
  /** "Play next" / "Add to queue" context items. */
  onEnqueue?: (items: MusicQueueItem[], mode: "next" | "last") => void;
}

function displayCover(covers: string[], selected: string | null): string | null {
  if (selected && covers.includes(selected)) return selected;
  return covers[0] ?? null;
}

export function ArtistDetailPage({
  entryId,
  libraryId,
  getCoverUrl,
  getFullCoverUrl,
  onOpenAlbum,
  onNavigateToArtist,
  onPlayQueue,
  currentTrackId,
  playing,
  onMetadataChanged,
  onTitleChanged,
  onAddToPlaylist,
  onEnqueue,
}: ArtistDetailPageProps) {
  const [detail, setDetail] = useState<MusicArtistDetail | null>(null);
  // Per-library "hide MusicBrainz outside the center" (center map toggle).
  const mbHidden = useMbHidden(libraryId);
  // Per-library tag-writing opt-in: the Write-to-files actions exist only when on.
  const tagWriting = useTagWriting(libraryId);
  const [writeScope, setWriteScope] = useState<TagWriteScope | null>(null);
  const [loading, setLoading] = useState(true);
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  const [editArtistOpen, setEditArtistOpen] = useState(false);
  const [splitArtistOpen, setSplitArtistOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  // MusicBrainz matching for this artist, plus a nonce so the chip refetches.
  const [matchOpen, setMatchOpen] = useState(false);
  const [matchTrack, setMatchTrack] = useState<number | null>(null);
  const [mbKey, setMbKey] = useState(0);
  // Detail-view album chip → the album match dialog, scoped to the block's
  // (default) release like the album page's own chip.
  const [matchAlbum, setMatchAlbum] = useState<{ id: number; releaseId: number; label: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /** Covers menu target — an album card's DEFAULT release. */
  const [coversFor, setCoversFor] = useState<{ id: number; title: string } | null>(null);
  // Persona links, both directions: "Persona of J. Cole" on the mask's page,
  // "Also performs as kiLL edward" on the human's.
  const [personaLinks, setPersonaLinks] = useState<{
    parent: { artist_id: number; title: string } | null;
    personas: { artist_id: number; title: string }[];
  } | null>(null);
  useEffect(() => {
    if (!detail?.id) return;
    let alive = true;
    invoke<{
      parent: { artist_id: number; title: string } | null;
      personas: { artist_id: number; title: string }[];
    }>("get_artist_personas", { artistId: detail.id })
      .then((r) => alive && setPersonaLinks(r))
      .catch(() => alive && setPersonaLinks(null));
    return () => {
      alive = false;
    };
  }, [detail?.id, mbKey]);
  const [viewMode, setViewMode] = useState<"grid" | "list">(cachedArtistView ?? "grid");
  const [sortDir, setSortDir] = useState<"date" | "date-desc">(cachedArtistSort ?? "date");
  const [heartFilter, setHeartFilterState] = useState<HeartFilter>(cachedHeartFilter);
  const setHeartFilter = (f: HeartFilter) => {
    cachedHeartFilter = f;
    setHeartFilterState(f);
  };
  // List view: per-release full details (tracks, type, genres), fetched when
  // the view is first shown and rebuilt after edits (detail changes).
  const [releaseDetails, setReleaseDetails] = useState<Map<number, MusicAlbumDetail> | null>(null);
  // Detail view: which release each multi-release album's block shows —
  // the album page's picker, per block. Unpicked = the default release.
  // (Hooks live up here, ABOVE the loading early-return.)
  const [pickedRelease, setPickedRelease] = useState<Map<number, number>>(new Map());
  // The picker's "rename label" target (the album page's dialog, here).
  const [renameRelease, setRenameRelease] = useState<{ albumId: number; release: MusicRelease } | null>(null);
  // One context menu serves every list-view track row (TracksPage pattern);
  // the row under the pointer records itself here as the event bubbles up.
  const menuTrackRef = useRef<{
    id: number;
    title: string;
    loved: LoveLevel;
    /** Ready-to-queue shape of this row, for Play next / Add to queue. */
    queueItem: MusicQueueItem;
  } | null>(null);
  // Detail-view row selection — album-page semantics (click selects, right-click
  // selects + opens the menu, background click deselects).
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  useDeselectOnBackgroundClick(useCallback(() => setSelectedTrackId(null), []));

  useEffect(() => {
    if (cachedArtistView !== null && cachedArtistSort !== null) return;
    invoke<Record<string, string>>("get_settings")
      .then((s) => {
        if (cachedArtistView === null) {
          cachedArtistView = s["artist_page_view"] === "list" ? "list" : "grid";
          setViewMode(cachedArtistView);
        }
        if (cachedArtistSort === null) {
          cachedArtistSort = s["artist_page_sort"] === "date-desc" ? "date-desc" : "date";
          setSortDir(cachedArtistSort);
        }
      })
      .catch(() => {});
  }, []);

  const changeView = (v: "grid" | "list") => {
    setViewMode(v);
    cachedArtistView = v;
    invoke("set_setting", { key: "artist_page_view", value: v }).catch(() => {});
  };

  const changeSort = (v: "date" | "date-desc") => {
    setSortDir(v);
    cachedArtistSort = v;
    invoke("set_setting", { key: "artist_page_sort", value: v }).catch(() => {});
  };

  const handleSaved = () => {
    setReloadKey((k) => k + 1);
    onMetadataChanged?.();
  };

  // Navigations clear the page (spinner); edit-triggered refetches are silent.
  const lastEntryRef = useRef(entryId);
  // Last loaded title, so a silent post-edit refetch can tell the host about
  // a rename (breadcrumb label) without firing on ordinary navigations.
  const lastTitleRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const navigated = lastEntryRef.current !== entryId;
    lastEntryRef.current = entryId;
    if (navigated) {
      setLoading(true);
      setDetail(null);
      lastTitleRef.current = null;
    }
    invoke<MusicArtistDetail>("get_artist_detail", { entryId })
      .then((d) => {
        if (cancelled) return;
        if (!navigated && lastTitleRef.current !== null && lastTitleRef.current !== d.title) {
          onTitleChanged?.(entryId, d.title);
        }
        lastTitleRef.current = d.title;
        setDetail(d);
      })
      .catch((e) => console.error("Failed to load artist:", e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, reloadKey]);

  // A metadata-center apply/undo (or rescan) landed while this page is open —
  // silently refetch so per-album credit lines and subtitles update in place.
  // Scrobbles too: list view shows play counts.
  useEffect(() => {
    const onRescanned = () => {
      setReloadKey((k) => k + 1);
      // The MB chip fetches its own status and keys off mbKey — without this
      // it keeps showing the state from before a metadata-center match/undo
      // until you navigate away and back.
      setMbKey((k) => k + 1);
    };
    window.addEventListener("waverunner:library-rescanned", onRescanned);
    window.addEventListener("waverunner:track-scrobbled", onRescanned);
    return () => {
      window.removeEventListener("waverunner:library-rescanned", onRescanned);
      window.removeEventListener("waverunner:track-scrobbled", onRescanned);
    };
  }, []);

  // Any detail refresh (navigation or silent post-edit refetch) invalidates the
  // per-release details so the list view reflects edits.
  //
  // Stale-while-revalidate: only a NAVIGATION clears the rows (a fresh page
  // earns its spinner). Silent detail refetches — scrobble count ticks,
  // edits — keep the old rows on screen and swap when the fresh per-album
  // fetches land. Nulling on every `detail` identity change collapsed the
  // list to a spinner once per scrobbled track, clamping the scroll to the
  // top mid-browse (the "jumps while music is playing" bug).
  useEffect(() => {
    setReleaseDetails(null);
  }, [entryId]);

  useEffect(() => {
    if (
      viewMode !== "list" ||
      !detail ||
      detail.albums.length + detail.appears_on.length === 0
    ) {
      return;
    }
    let cancelled = false;
    Promise.all(
      [...detail.albums, ...detail.appears_on].map((a) =>
        invoke<MusicAlbumDetail>("get_album_detail", { entryId: a.id }).catch((e) => {
          console.error("Failed to load release detail:", e);
          return null;
        }),
      ),
    ).then((ds) => {
      if (cancelled) return;
      const map = new Map<number, MusicAlbumDetail>();
      for (const d of ds) {
        if (d) map.set(d.id, d);
      }
      setReleaseDetails(map);
    });
    return () => {
      cancelled = true;
    };
  }, [viewMode, detail]);

  const playAlbum = async (albumId: number) => {
    try {
      const album = await invoke<MusicAlbumDetail>("get_album_detail", { entryId: albumId });
      const release = defaultRelease(album);
      if (!release || release.tracks.length === 0) return;
      onPlayQueue(queueFromRelease(album, release), 0);
    } catch (e) {
      console.error("Failed to play album:", e);
    }
  };

  if (loading || !detail) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  const cover = displayCover(detail.covers, detail.selected_cover);

  // Date sort, mirroring the grid pages' order clauses: undated releases LEAD
  // in both directions (user rule — they're the ones needing a look), title
  // breaks ties.
  const sortCards = (cards: MusicAlbumCard[]): MusicAlbumCard[] =>
    [...cards].sort((a, b) => {
      const ad = a.release_date;
      const bd = b.release_date;
      if (!ad || !bd) {
        if (!ad !== !bd) return !ad ? -1 : 1;
      } else if (ad !== bd) {
        return sortDir === "date-desc" ? (ad < bd ? 1 : -1) : ad < bd ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    });
  const albumsSorted = sortCards(detail.albums);
  const appearsSorted = sortCards(detail.appears_on);

  // Heart filter — detail view only (the grid has no track rows to filter).
  // Blocks whose rows all fall out are hidden entirely rather than left as
  // empty headers; the section headers follow the LISTED blocks below.
  const heartOn = viewMode === "list" && heartFilter !== "all";
  const passesHeart = (t: { loved: LoveLevel }) =>
    !heartOn || (heartFilter === "loved" ? t.loved === "loved" : t.loved != null);
  // Rows a release block shows: appears-on blocks list only the tracks this
  // artist is credited on, own releases list everything — then the hearts.
  const shownRelease = (d: MusicAlbumDetail) => {
    const picked = pickedRelease.get(d.id);
    return (picked != null ? d.releases.find((r) => r.id === picked) : null) ?? defaultRelease(d);
  };
  const blockTracks = (album: MusicAlbumCard, onlyCredited: boolean): MusicTrack[] => {
    const d = releaseDetails?.get(album.id);
    const release = d ? shownRelease(d) : null;
    if (!release) return [];
    const base = onlyCredited
      ? release.tracks.filter((t) => t.credits.some((c) => c.artist_id === entryId))
      : release.tracks;
    return base.filter(passesHeart);
  };
  const albumsListed =
    heartOn && releaseDetails ? albumsSorted.filter((a) => blockTracks(a, false).length > 0) : albumsSorted;
  const appearsListed =
    heartOn && releaseDetails ? appearsSorted.filter((a) => blockTracks(a, true).length > 0) : appearsSorted;
  const looseListed = detail.loose_tracks.filter(passesHeart);
  const heartEmpty =
    heartOn &&
    releaseDetails !== null &&
    albumsListed.length === 0 &&
    appearsListed.length === 0 &&
    looseListed.length === 0;

  // One release block in detail view: cover + album-page details + track
  // rows. Shared between own releases and (credit-filtered) appears-on.
  const renderReleaseBlock = (album: MusicAlbumCard, onlyCredited: boolean) => {
              const d = releaseDetails?.get(album.id) ?? null;
              const release = d ? shownRelease(d) : null;
              // The block shows its picked release (default until picked) —
              // ITS cover/title/year once loaded; the card's album-level
              // look until then.
              const albumCoverPath =
                d && release ? releaseCover(d, release) : displayCover(album.covers, album.selected_cover);
              const queue = d && release ? queueFromRelease(d, release) : [];
              const totalSecs = release
                ? release.tracks.reduce((s, t) => s + (t.runtime_secs ?? 0), 0)
                : 0;
              const shownTracks = blockTracks(album, onlyCredited);
              return (
                <section key={album.id}>
                  <div className="flex items-center gap-5">
                    {/* Right-click the art: the covers menu for the album's
                        DEFAULT release (this view pins the default). */}
                    <ContextMenu>
                      <ContextMenuTrigger
                        render={
                          // Fixed width, natural height (grid-page rule) —
                          // a non-square cover shows whole; the empty box
                          // stays square.
                          <div
                            className="group/cover relative w-56 shrink-0 cursor-pointer overflow-hidden rounded-[3px] bg-muted shadow-sm"
                            onClick={() => onOpenAlbum(album)}
                          />
                        }
                      >
                      {albumCoverPath ? (
                        <img
                          src={getCoverUrl(albumCoverPath)}
                          alt=""
                          className="block h-auto w-full"
                          loading="lazy"
                          draggable={false}
                        />
                      ) : (
                        <div className="flex aspect-square w-full items-center justify-center text-muted-foreground">
                          <Disc3 size={40} />
                        </div>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (queue.length > 0) onPlayQueue(queue, 0);
                          else playAlbum(album.id);
                        }}
                        className="absolute bottom-2 right-2 rounded-full bg-black/60 p-2.5 text-white opacity-0 shadow transition-opacity hover:bg-black/80 group-hover/cover:opacity-100"
                        title="Play album"
                      >
                        <Play size={16} className="translate-x-px" />
                      </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <CoversMenuItem onOpen={() => setCoversFor({ id: album.id, title: album.title })} />
                      </ContextMenuContent>
                    </ContextMenu>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {d?.album_type || "album"}
                      </p>
                      <button
                        onClick={() => onOpenAlbum(album)}
                        className="block max-w-full truncate text-left font-heading text-xl font-bold hover:underline"
                        title={d && release ? releaseTitle(d, release) : album.title}
                      >
                        {d && release ? releaseTitle(d, release) : album.title}
                        {!mbHidden && <MbDot state={album.mb_state} className="ml-2" />}
                      </button>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {/* Album-page parity: every credited owner, linked —
                            except the artist whose page this already is. */}
                        {album.artists.length > 0 && (
                          <>
                            {album.artists.map((a, ai) => (
                              <span key={`${a.name}-${ai}`}>
                                {ai > 0 && " · "}
                                {a.artist_id != null && a.artist_id !== entryId && onNavigateToArtist ? (
                                  <span
                                    role="link"
                                    className="cursor-pointer font-medium text-foreground hover:underline"
                                    onClick={() => onNavigateToArtist(a.artist_id!, a.name)}
                                  >
                                    {a.name}
                                  </span>
                                ) : (
                                  <span className="font-medium text-foreground">{a.name}</span>
                                )}
                              </span>
                            ))}
                            {" · "}
                          </>
                        )}
                        {[
                          release?.year ?? album.year,
                          release
                            ? `${release.tracks.length} ${release.tracks.length === 1 ? "track" : "tracks"}`
                            : null,
                          totalSecs > 0 ? fmtAlbumRuntime(totalSecs) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {d && d.genres.length > 0 && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {d.genres.join(", ")}
                        </p>
                      )}
                      {/* Album-page parity: the release picker on albums
                          with more than one release — pick swaps this
                          block's cover, title, year and tracks. */}
                      {d && release && d.releases.length > 1 && (
                        <div className="mt-1.5">
                          <ReleasePicker
                            detail={d}
                            releaseId={release.id}
                            onPick={(id) =>
                              setPickedRelease((m) => {
                                const next = new Map(m);
                                next.set(d.id, id);
                                return next;
                              })
                            }
                            getFullCoverUrl={getFullCoverUrl}
                            onRename={(r) => setRenameRelease({ albumId: d.id, release: r })}
                            onChanged={() => setReloadKey((k) => k + 1)}
                            mbHidden={mbHidden}
                          />
                        </div>
                      )}
                      {/* Album-page parity: the MusicBrainz status chip for
                          the release this block shows, opening its matcher. */}
                      {!mbHidden && d && release && !d.is_sound && (
                        <div className="mt-1.5">
                          <MbStatusChip
                            kind="album"
                            entityId={album.id}
                            reloadKey={mbKey}
                            releaseId={release.id}
                            onClick={() => {
                              const label = release.label ?? "1";
                              setMatchAlbum({
                                id: album.id,
                                releaseId: release.id,
                                label: release.year ? `${label} (${release.year})` : label,
                              });
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {release && shownTracks.length > 0 && (
                    // Album-page-parity track list: disc headers on multi-disc
                    // releases, every row naming its artist.
                    <div className="mt-3">
                      {(() => {
                        const byDisc = new Map<number, MusicTrack[]>();
                        for (const t of shownTracks) {
                          const dn = t.disc_number ?? 1;
                          const g = byDisc.get(dn);
                          if (g) g.push(t);
                          else byDisc.set(dn, [t]);
                        }
                        return [...byDisc.entries()]
                          .sort((a, b) => a[0] - b[0])
                          .map(([discNo, tracks]) => (
                            <div key={discNo} className="mb-2">
                              {(release.disc_count ?? 1) > 1 && (
                                <p className="mb-1 flex items-center gap-1.5 px-2 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  <Disc3 size={13} /> Disc {discNo}
                                </p>
                              )}
                              {tracks.map((t) => {
                                const queueIndex = release.tracks.indexOf(t);
                                const trackArtist = t.artist_name ?? detail.title;
                                const isCurrent = currentTrackId === t.id;
                                return (
                                  <div
                                    key={t.id}
                                    data-track-row
                                    className={`group/track flex w-full cursor-default items-center gap-3 rounded-md px-2 py-1.5 ${
                                      selectedTrackId === t.id ? "bg-accent" : "hover:bg-accent/50"
                                    }`}
                                    onClick={() => setSelectedTrackId(t.id)}
                                    onDoubleClick={() => onPlayQueue(queue, queueIndex)}
                                    onContextMenu={() => {
                                      setSelectedTrackId(t.id);
                                      menuTrackRef.current = {
                                        id: t.id,
                                        title: trackDisplayTitle(t.title, t.file_path),
                                        loved: t.loved,
                                        queueItem: queue[queueIndex],
                                      };
                                    }}
                                  >
                                    <span className="relative w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
                                      <span className="group-hover/track:invisible">
                                        {t.track_number ?? "–"}
                                      </span>
                                      <Play
                                        size={13}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          onPlayQueue(queue, queueIndex);
                                        }}
                                        className="invisible absolute right-0 top-1/2 -translate-y-1/2 cursor-pointer group-hover/track:visible"
                                      />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
                                        <span className={`truncate ${isCurrent ? "font-semibold text-primary" : ""}`}>
                                          {trackDisplayTitle(t.title, t.file_path)}
                                        </span>
                                        {isCurrent && <PlayingIndicator paused={!playing} className="shrink-0" />}
                                        <LoveButton
                                          trackId={t.id}
                                          loved={t.loved}
                                          reveal="group-hover/track:opacity-100"
                                          className="ml-1.5"
                                        />
                                      </span>
                                      <span className="block truncate text-xs text-muted-foreground">
                                        {t.credits.length > 0
                                          ? t.credits.map((c, ci) => (
                                              <span key={`${c.name}-${ci}`}>
                                                {ci > 0 && ", "}
                                                {/* No self-link: this is already their page. */}
                                                {c.artist_id != null && c.artist_id !== entryId && onNavigateToArtist ? (
                                                  <span
                                                    role="link"
                                                    className="cursor-pointer hover:underline"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      onNavigateToArtist(c.artist_id!, c.name);
                                                    }}
                                                  >
                                                    {c.name}
                                                  </span>
                                                ) : (
                                                  c.name
                                                )}
                                              </span>
                                            ))
                                          : trackArtist}
                                      </span>
                                    </span>
                                    {t.play_count > 0 && (
                                      <span className="shrink-0 text-[10px] text-muted-foreground" title="Play count">
                                        {t.play_count}
                                        {"×"}
                                      </span>
                                    )}
                                    <CodecBadge
                                      codec={t.codec}
                                      bitrate={t.bitrate_kbps}
                                      mode={t.bitrate_mode}
                                    />
                                    <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">
                                      {fmtTrackTime(t.runtime_secs)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          ));
                      })()}
                    </div>
                  )}
                </section>
              );
  };

  return (
    <div className="px-6 pb-8">
      {/* Header */}
      <div className="flex items-center gap-5 pb-10 pt-6">
        {cover ? (
          <img
            src={getFullCoverUrl(cover)}
            alt=""
            className="h-36 w-36 shrink-0 rounded-full object-cover shadow-md"
            draggable={false}
          />
        ) : (
          <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Music2 size={48} />
          </div>
        )}
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Artist</p>
          <h1 className="group/title flex min-w-0 items-center gap-2 font-heading text-3xl font-bold">
            <span className="truncate">{detail.title}</span>
            <button
              onClick={() => setEditArtistOpen(true)}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100"
              title="Edit artist metadata"
            >
              <Pencil size={16} />
            </button>
            <button
              onClick={() => setSplitArtistOpen(true)}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100"
              title="Split into multiple artists"
            >
              <Scissors size={16} />
            </button>
            <button
              onClick={() => setPersonaOpen(true)}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100"
              title="Link as a persona of another artist"
            >
              <VenetianMask size={16} />
            </button>
            {tagWriting && (
              <button
                onClick={() => setWriteScope({ kind: "artist", id: detail.id })}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100"
                title="Write tags to this artist's files"
              >
                <HardDriveDownload size={16} />
              </button>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[
              detail.album_count > 0
                ? `${detail.album_count} ${detail.album_count === 1 ? "album" : "albums"}`
                : null,
              detail.track_count > 0
                ? `${detail.track_count} ${detail.track_count === 1 ? "track" : "tracks"}`
                : null,
              detail.appears_on.length > 0
                ? `appears on ${detail.appears_on.length} ${detail.appears_on.length === 1 ? "album" : "albums"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {!mbHidden && (
            <div className="mt-1.5">
              <MbStatusChip
                kind="artist"
                entityId={detail.id}
                reloadKey={mbKey}
                onClick={() => setMatchOpen(true)}
              />
            </div>
          )}
          {/* Persona links, whichever direction this page sits on. The names
              are the links — one human, several masks, all reachable. */}
          {personaLinks && (personaLinks.parent || personaLinks.personas.length > 0) && (
            <p className="mt-1.5 flex items-start gap-x-1.5 text-sm text-muted-foreground">
              <VenetianMask size={14} className="mt-0.5 shrink-0" />
              {/* Inline text, not flex items: the words and names are a
                  sentence, so real spaces separate them — a flex gap next
                  to a word space read as a double space. */}
              {personaLinks.parent ? (
                <span>
                  Persona of{" "}
                  {onNavigateToArtist ? (
                    <button
                      onClick={() =>
                        onNavigateToArtist(
                          personaLinks.parent!.artist_id,
                          personaLinks.parent!.title,
                        )
                      }
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      {personaLinks.parent.title}
                    </button>
                  ) : (
                    <span className="text-foreground">{personaLinks.parent.title}</span>
                  )}
                </span>
              ) : (
                <span>
                  Also performs as{" "}
                  {personaLinks.personas.map((p, i) => (
                    <span key={p.artist_id}>
                      {i > 0 && " · "}
                      {onNavigateToArtist ? (
                        <button
                          onClick={() => onNavigateToArtist(p.artist_id, p.title)}
                          className="text-foreground underline-offset-2 hover:underline"
                        >
                          {p.title}
                        </button>
                      ) : (
                        <span className="text-foreground">{p.title}</span>
                      )}
                    </span>
                  ))}
                </span>
              )}
            </p>
          )}
          {detail.biography && (
            <p className="mt-2 line-clamp-3 max-w-2xl whitespace-pre-line text-sm text-muted-foreground" title={detail.biography}>
              {detail.biography}
            </p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 self-start">
          {/* Heart filter — detail view only; the grid has no rows to filter. */}
          {viewMode === "list" &&
            (detail.albums.length > 0 || detail.appears_on.length > 0 || detail.loose_tracks.length > 0) && (
              <div className="flex h-8 items-center gap-0.5 rounded-md border p-0.5 text-xs">
                {(
                  [
                    ["all", "All", "Every track"],
                    ["hearts", "Liked", "Liked tracks (loved ones count too)"],
                    ["loved", "Loved", "Only loved tracks"],
                  ] as const
                ).map(([id, label, title]) => (
                  <button
                    key={id}
                    onClick={() => setHeartFilter(id)}
                    className={`rounded px-2 py-1 transition-colors ${
                      heartFilter === id
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    title={title}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          {(detail.albums.length > 0 || detail.appears_on.length > 0) && (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                <ArrowUpDown size={12} />
                {sortDir === "date-desc" ? "Newest first" : "Oldest first"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => changeSort("date")}>
                  Oldest first
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => changeSort("date-desc")}>
                  Newest first
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {detail.albums.length > 0 && (
            <div className="flex items-center gap-1 rounded-md border p-0.5">
              <button
                onClick={() => changeView("grid")}
                className={`rounded p-1.5 transition-colors ${viewMode === "grid" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                title="Grid view"
              >
                <LayoutGrid size={15} />
              </button>
              <button
                onClick={() => changeView("list")}
                className={`rounded p-1.5 transition-colors ${viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                title="Detail view"
              >
                <List size={15} />
              </button>
            </div>
          )}
        </div>
      </div>

      {heartEmpty && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {heartFilter === "loved" ? "No loved tracks yet." : "No liked or loved tracks yet."}
        </p>
      )}

      {/* Own albums */}
      {albumsListed.length > 0 && appearsListed.length > 0 && (
        <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Releases
        </p>
      )}
      {viewMode === "grid" ? (
      <div
        className="grid gap-x-4 gap-y-1.5"
        // 224px floor = the detail view's w-56 cover, so switching views
        // doesn't resize the artwork. Cards span two rows and subgrid onto
        // them (the Albums-page recipe): every cover in a row shares one
        // bottom-aligned track and every title the next, so a taller cover
        // grows its row without pushing its neighbours' titles out of line.
        // The row gap is what separates cover from title (subgrid rows
        // inherit it), so it's the small one; the title block's bottom
        // padding makes up the distance to the next row of covers.
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(224px, 1fr))" }}
      >
        {/* albumsSorted, NOT detail.albums — the date sort toggle was being
            computed and then ignored by this view. */}
        {albumsSorted.map((album) => {
          const albumCoverPath = displayCover(album.covers, album.selected_cover);
          return (
            <div
              key={album.id}
              className="group grid min-w-0"
              style={{ gridRow: "span 2", gridTemplateRows: "subgrid" }}
            >
              <ContextMenu>
                <ContextMenuTrigger
                  render={
                    <div
                      className="relative cursor-pointer self-end overflow-hidden rounded-[3px] bg-muted shadow-sm"
                      onClick={() => onOpenAlbum(album)}
                    />
                  }
                >
                {albumCoverPath ? (
                  <img
                    src={getCoverUrl(albumCoverPath)}
                    alt=""
                    className="block h-auto w-full"
                    loading="lazy"
                    draggable={false}
                  />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center text-muted-foreground">
                    <Disc3 size={40} />
                  </div>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    playAlbum(album.id);
                  }}
                  className="absolute bottom-2 right-2 rounded-full bg-black/60 p-2.5 text-white opacity-0 shadow transition-opacity hover:bg-black/80 group-hover:opacity-100"
                  title="Play album"
                >
                  <Play size={16} className="translate-x-px" />
                </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {/* Grid cards manage the DEFAULT release's covers. */}
                  <CoversMenuItem onOpen={() => setCoversFor({ id: album.id, title: album.title })} />
                </ContextMenuContent>
              </ContextMenu>
              {/* One element for the title track (the subgrid has two rows). */}
              <div className="min-w-0 pb-2.5">
              <button
                onClick={() => onOpenAlbum(album)}
                className="block w-full truncate text-left text-sm font-medium hover:underline"
                title={album.release_count > 1 ? `${album.title} · ${album.release_count} releases` : album.title}
              >
                {album.title}
                {/* Albums-page parity: the record icon + count on
                    multi-release albums, after the title. */}
                {album.release_count > 1 && (
                  <span className="ml-1.5 inline-flex -translate-y-px items-center gap-0.5 align-middle text-xs font-normal text-muted-foreground">
                    <Disc3 size={12} />
                    {album.release_count}
                  </span>
                )}
                {!mbHidden && <MbDot state={album.mb_state} className="ml-1.5 -translate-y-px" />}
              </button>
              <p className="truncate text-xs text-muted-foreground">
                {[album.year]
                  .filter(Boolean)
                  .join(" · ") || " "}
              </p>
              </div>
            </div>
          );
        })}
      </div>
      ) : releaseDetails === null && detail.albums.length > 0 ? (
        <div className="flex justify-center py-10 text-muted-foreground">
          <Spinner className="size-5" />
        </div>
      ) : (
        // List view — each release rendered like a compact album page: cover +
        // details beside it, that release's tracks beneath. One shared context
        // menu serves every track row (TracksPage pattern). The trigger wraps
        // whole release blocks (covers, details, gaps), so opening is cancelled
        // unless the right-click actually landed on a track row — otherwise the
        // menu would show items for whatever row was right-clicked LAST.
        <ContextMenu
          onOpenChange={(open, details) => {
            const target = details.event?.target;
            if (open && !(target instanceof Element && target.closest("[data-track-row]"))) {
              details.cancel();
            }
          }}
        >
          <ContextMenuTrigger render={<div className="flex flex-col gap-14" />}>
            {albumsListed.map((album) => renderReleaseBlock(album, false))}
          </ContextMenuTrigger>
          <ContextMenuContent>
            {onEnqueue && (
              <>
                <ContextMenuItem
                  onClick={() => {
                    const m = menuTrackRef.current;
                    if (m) onEnqueue([m.queueItem], "next");
                  }}
                >
                  <ListStart size={14} />
                  Play next
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => {
                    const m = menuTrackRef.current;
                    if (m) onEnqueue([m.queueItem], "last");
                  }}
                >
                  <ListEnd size={14} />
                  Add to queue
                </ContextMenuItem>
              </>
            )}
            <ContextMenuItem onClick={() => setEditTrackId(menuTrackRef.current?.id ?? null)}>
              <Pencil size={14} />
              Edit metadata
            </ContextMenuItem>
            {tagWriting && (
              <ContextMenuItem
                onClick={() => {
                  const m = menuTrackRef.current;
                  if (m) setWriteScope({ kind: "track", id: m.id });
                }}
              >
                <HardDriveDownload size={14} />
                Write tags to file…
              </ContextMenuItem>
            )}
            <LoveMenuItem
              resolve={() =>
                menuTrackRef.current
                  ? { id: menuTrackRef.current.id, loved: menuTrackRef.current.loved }
                  : null
              }
            />
            {onAddToPlaylist && (
              <ContextMenuItem
                onClick={() => {
                  if (menuTrackRef.current) onAddToPlaylist(menuTrackRef.current);
                }}
              >
                <ListPlus size={14} />
                Add to playlist
              </ContextMenuItem>
            )}
            <RevealMenuItem resolve={() => menuTrackRef.current?.id ?? null} />
          </ContextMenuContent>
        </ContextMenu>
      )}

      {/* Loose tracks — album-less files credited to this artist. */}
      {looseListed.length > 0 && (
        <>
          <p className={`mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground ${albumsListed.length > 0 ? "mt-6" : ""}`}>
            Tracks
          </p>
          <div>
            {looseListed.map((t) => {
              // Queue = every loose track (the heart filter narrows what's
              // listed, not what plays), so index into the full list.
              const i = detail.loose_tracks.indexOf(t);
              const queue: MusicQueueItem[] = detail.loose_tracks.map((lt) => ({
                trackId: lt.id,
                title: trackDisplayTitle(lt.title, lt.file_path),
                artistName:
                  lt.credits.length > 0
                    ? lt.credits.map((c) => c.name).join(", ")
                    : lt.artist_name ?? detail.title,
                artistId: lt.credits.find((c) => c.artist_id != null)?.artist_id ?? entryId,
                artists:
                  lt.credits.length > 0
                    ? lt.credits.map((c) => ({ name: c.name, artistId: c.artist_id }))
                    : [{ name: lt.artist_name ?? detail.title, artistId: entryId }],
                albumId: null,
                albumTitle: null,
                cover: null,
                path: lt.file_path,
                durationSecs: lt.runtime_secs,
              }));
              return (
                <ContextMenu key={t.id}>
                  <ContextMenuTrigger
                    render={
                      <div
                        data-track-row
                        className={`group/track flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 text-sm ${
                          selectedTrackId === t.id ? "bg-accent" : "hover:bg-accent/50"
                        }`}
                        onClick={() => setSelectedTrackId(t.id)}
                        onDoubleClick={() => onPlayQueue(queue, i)}
                        onContextMenu={() => setSelectedTrackId(t.id)}
                      />
                    }
                  >
                  <button
                    onClick={() => onPlayQueue(queue, i)}
                    className="flex w-5 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/track:opacity-100"
                    title="Play"
                  >
                    <Play size={13} className="translate-x-px" />
                  </button>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className={`truncate ${currentTrackId === t.id ? "font-medium text-primary" : ""}`}>
                        {trackDisplayTitle(t.title, t.file_path)}
                      </span>
                      {currentTrackId === t.id && (
                        <PlayingIndicator paused={!playing} className="shrink-0" />
                      )}
                      <LoveButton
                        trackId={t.id}
                        loved={t.loved}
                        reveal="group-hover/track:opacity-100"
                        className="ml-1.5"
                      />
                    </span>
                    {t.credits.length > 0 && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.credits.map((c) => c.name).join(", ")}
                      </span>
                    )}
                  </span>
                  <CodecBadge codec={t.codec} bitrate={t.bitrate_kbps} mode={t.bitrate_mode} />
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {fmtTrackTime(t.runtime_secs)}
                  </span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {onEnqueue && (
                      <>
                        <ContextMenuItem onClick={() => onEnqueue([queue[i]], "next")}>
                          <ListStart size={14} />
                          Play next
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => onEnqueue([queue[i]], "last")}>
                          <ListEnd size={14} />
                          Add to queue
                        </ContextMenuItem>
                      </>
                    )}
                    <ContextMenuItem onClick={() => setEditTrackId(t.id)}>
                      <Pencil size={14} />
                      Edit metadata
                    </ContextMenuItem>
                    {tagWriting && (
                      <ContextMenuItem onClick={() => setWriteScope({ kind: "track", id: t.id })}>
                        <HardDriveDownload size={14} />
                        Write tags to file…
                      </ContextMenuItem>
                    )}
                    {!mbHidden && (
                      <ContextMenuItem onClick={() => setMatchTrack(t.id)}>
                        <Disc3 size={14} />
                        Match to MusicBrainz…
                      </ContextMenuItem>
                    )}
                    <LoveMenuItem resolve={() => ({ id: t.id, loved: t.loved })} />
                    {onAddToPlaylist && (
                      <ContextMenuItem
                        onClick={() =>
                          onAddToPlaylist({ id: t.id, title: trackDisplayTitle(t.title, t.file_path) })
                        }
                      >
                        <ListPlus size={14} />
                        Add to playlist
                      </ContextMenuItem>
                    )}
                    <RevealMenuItem resolve={() => t.id} />
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </>
      )}

      {/* Feature credits on other artists' albums — the whole page for
          feature-only artists. */}
      {appearsListed.length > 0 && (
        <>
          <p className={`mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground ${albumsListed.length > 0 || looseListed.length > 0 ? "mt-6" : ""}`}>
            Appears On
          </p>
          {viewMode === "grid" ? (
          <div
            className="grid gap-x-4 gap-y-1.5"
            // Same subgrid rows and spacing as the Releases grid above.
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(224px, 1fr))" }}
          >
            {appearsSorted.map((album) => {
              const albumCoverPath = displayCover(album.covers, album.selected_cover);
              return (
                <div
                  key={album.id}
                  className="group grid min-w-0"
                  style={{ gridRow: "span 2", gridTemplateRows: "subgrid" }}
                >
                  <div
                    className="relative cursor-pointer self-end overflow-hidden rounded-[3px] bg-muted shadow-sm"
                    onClick={() => onOpenAlbum(album)}
                  >
                    {albumCoverPath ? (
                      <img
                        src={getCoverUrl(albumCoverPath)}
                        alt=""
                        className="block h-auto w-full"
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <div className="flex aspect-square w-full items-center justify-center text-muted-foreground">
                        <Disc3 size={40} />
                      </div>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        playAlbum(album.id);
                      }}
                      className="absolute bottom-2 right-2 rounded-full bg-black/60 p-2.5 text-white opacity-0 shadow transition-opacity hover:bg-black/80 group-hover:opacity-100"
                      title="Play album"
                    >
                      <Play size={16} className="translate-x-px" />
                    </button>
                  </div>
                  <div className="min-w-0 pb-2.5">
                    <button
                      onClick={() => onOpenAlbum(album)}
                      className="block w-full truncate text-left text-sm font-medium hover:underline"
                      title={album.title}
                    >
                      {album.title}
                      {!mbHidden && <MbDot state={album.mb_state} className="ml-1.5 -translate-y-px" />}
                    </button>
                    <p className="truncate text-xs text-muted-foreground">
                      {[album.artist_title, album.year].filter(Boolean).join(", ") || " "}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          ) : releaseDetails === null ? (
            <div className="flex justify-center py-10 text-muted-foreground">
              <Spinner className="size-5" />
            </div>
          ) : (
            <ContextMenu
              onOpenChange={(open, details) => {
                // Same off-row cancel as the Releases section's menu.
                const target = details.event?.target;
                if (open && !(target instanceof Element && target.closest("[data-track-row]"))) {
                  details.cancel();
                }
              }}
            >
              <ContextMenuTrigger render={<div className="flex flex-col gap-14" />}>
                {appearsListed.map((album) => renderReleaseBlock(album, true))}
              </ContextMenuTrigger>
              <ContextMenuContent>
                {onEnqueue && (
                  <>
                    <ContextMenuItem
                      onClick={() => {
                        const m = menuTrackRef.current;
                        if (m) onEnqueue([m.queueItem], "next");
                      }}
                    >
                      <ListStart size={14} />
                      Play next
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => {
                        const m = menuTrackRef.current;
                        if (m) onEnqueue([m.queueItem], "last");
                      }}
                    >
                      <ListEnd size={14} />
                      Add to queue
                    </ContextMenuItem>
                  </>
                )}
                <ContextMenuItem onClick={() => setEditTrackId(menuTrackRef.current?.id ?? null)}>
                  <Pencil size={14} />
                  Edit metadata
                </ContextMenuItem>
                {tagWriting && (
                  <ContextMenuItem
                    onClick={() => {
                      const m = menuTrackRef.current;
                      if (m) setWriteScope({ kind: "track", id: m.id });
                    }}
                  >
                    <HardDriveDownload size={14} />
                    Write tags to file…
                  </ContextMenuItem>
                )}
                <LoveMenuItem
                  resolve={() =>
                    menuTrackRef.current
                      ? { id: menuTrackRef.current.id, loved: menuTrackRef.current.loved }
                      : null
                  }
                />
                {onAddToPlaylist && (
                  <ContextMenuItem
                    onClick={() => {
                      if (menuTrackRef.current) onAddToPlaylist(menuTrackRef.current);
                    }}
                  >
                    <ListPlus size={14} />
                    Add to playlist
                  </ContextMenuItem>
                )}
                <RevealMenuItem resolve={() => menuTrackRef.current?.id ?? null} />
              </ContextMenuContent>
            </ContextMenu>
          )}
        </>
      )}
      <TrackEditDialog
        trackId={editTrackId}
        open={editTrackId !== null}
        onOpenChange={(o) => {
          if (!o) setEditTrackId(null);
        }}
        onSaved={handleSaved}
      />
      <ArtistEditDialog
        artistId={editArtistOpen ? entryId : null}
        open={editArtistOpen}
        onOpenChange={setEditArtistOpen}
        onSaved={handleSaved}
      />
      <TagWriteDialog
        scope={writeScope}
        onOpenChange={(o) => {
          if (!o) setWriteScope(null);
        }}
        onDone={handleSaved}
      />
      <RenameDialog
        open={renameRelease !== null}
        onOpenChange={(o) => {
          if (!o) setRenameRelease(null);
        }}
        title="Rename release label"
        initialValue={renameRelease?.release.label ?? "1"}
        onSubmit={async (v) => {
          if (!renameRelease) return;
          await invoke("set_release_label", { releaseId: renameRelease.release.id, label: v });
          setReloadKey((k) => k + 1);
        }}
      />
      <SplitArtistDialog
        artistId={splitArtistOpen ? entryId : null}
        artistName={detail?.title ?? ""}
        open={splitArtistOpen}
        onOpenChange={setSplitArtistOpen}
      />
      {personaOpen && (
        <PersonaDialog
          libraryId={libraryId}
          personaId={entryId}
          personaName={detail?.title ?? ""}
          onOpenChange={setPersonaOpen}
          onDone={() => {
            // mbKey drives the persona-links effect above.
            setMbKey((k) => k + 1);
            handleSaved();
          }}
        />
      )}
      <MatchDialog
        kind="artist"
        entityId={entryId}
        open={matchOpen}
        onOpenChange={setMatchOpen}
        onChanged={() => {
          setMbKey((k) => k + 1);
          handleSaved();
        }}
      />
      {matchAlbum != null && (
        <MatchDialog
          kind="album"
          entityId={matchAlbum.id}
          open
          onOpenChange={(o) => !o && setMatchAlbum(null)}
          releaseId={matchAlbum.releaseId}
          releaseLabel={matchAlbum.label}
          onChanged={() => {
            setMbKey((k) => k + 1);
            handleSaved();
          }}
        />
      )}
      {matchTrack != null && (
        <MatchDialog
          kind="track"
          entityId={matchTrack}
          open={matchTrack != null}
          onOpenChange={(o) => !o && setMatchTrack(null)}
          onChanged={() => {
            setMbKey((k) => k + 1);
            handleSaved();
          }}
        />
      )}
      <CoversDialog
        open={coversFor !== null}
        onOpenChange={(o) => {
          if (!o) setCoversFor(null);
        }}
        target={
          coversFor && {
            kind: "release",
            libraryId,
            albumId: coversFor.id,
            releaseId: null,
            title: coversFor.title,
          }
        }
        getCoverUrl={getFullCoverUrl}
        onChanged={handleSaved}
      />
    </div>
  );
}
