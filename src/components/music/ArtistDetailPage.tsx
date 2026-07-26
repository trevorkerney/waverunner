import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Music2, Pencil, Scissors, LayoutGrid, List, ArrowUpDown, Disc3, ListPlus, ListStart, ListEnd } from "lucide-react";
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
import { PlayingIndicator } from "./PlayingIndicator";
import { LoveButton, LoveMenuItem } from "./LoveButton";
import { MusicArtistDetail, MusicAlbumCard, MusicAlbumDetail, MusicQueueItem, MusicTrack } from "../../types";
import { queueFromRelease, defaultRelease, trackDisplayTitle, fmtTrackTime, fmtAlbumRuntime } from "./musicQueue";
import { useDeselectOnBackgroundClick } from "./useTrackSelection";

// Artist-page view + sort preferences — implicit in-app prefs (instant apply,
// persisted in the background). Cached module-wide so later page mounts don't
// flash the defaults before the settings load. Sort uses the app-wide date
// vocabulary: "date" = oldest first, "date-desc" = newest first.
let cachedArtistView: "grid" | "list" | null = null;
let cachedArtistSort: "date" | "date-desc" | null = null;

interface ArtistDetailPageProps {
  entryId: number;
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
  const [loading, setLoading] = useState(true);
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  const [editArtistOpen, setEditArtistOpen] = useState(false);
  const [splitArtistOpen, setSplitArtistOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [viewMode, setViewMode] = useState<"grid" | "list">(cachedArtistView ?? "grid");
  const [sortDir, setSortDir] = useState<"date" | "date-desc">(cachedArtistSort ?? "date");
  // List view: per-release full details (tracks, type, genres), fetched when
  // the view is first shown and rebuilt after edits (detail changes).
  const [releaseDetails, setReleaseDetails] = useState<Map<number, MusicAlbumDetail> | null>(null);
  // One context menu serves every list-view track row (TracksPage pattern);
  // the row under the pointer records itself here as the event bubbles up.
  const menuTrackRef = useRef<{
    id: number;
    title: string;
    loved: boolean;
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
  useEffect(() => {
    const onRescanned = () => setReloadKey((k) => k + 1);
    window.addEventListener("waverunner:library-rescanned", onRescanned);
    return () => window.removeEventListener("waverunner:library-rescanned", onRescanned);
  }, []);

  // Any detail refresh (navigation or silent post-edit refetch) invalidates the
  // per-release details so the list view reflects edits.
  useEffect(() => {
    setReleaseDetails(null);
  }, [detail]);

  useEffect(() => {
    if (
      viewMode !== "list" ||
      !detail ||
      releaseDetails !== null ||
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
  }, [viewMode, detail, releaseDetails]);

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

  // Date sort, mirroring the grid pages' order clauses: undated releases sink
  // to the bottom in both directions, title breaks ties.
  const sortCards = (cards: MusicAlbumCard[]): MusicAlbumCard[] =>
    [...cards].sort((a, b) => {
      const ad = a.release_date;
      const bd = b.release_date;
      if (!ad || !bd) {
        if (ad !== bd) return !ad ? 1 : -1;
      } else if (ad !== bd) {
        return sortDir === "date-desc" ? (ad < bd ? 1 : -1) : ad < bd ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    });
  const albumsSorted = sortCards(detail.albums);
  const appearsSorted = sortCards(detail.appears_on);

  // One release block in detail view: cover + album-page details + track
  // rows. Shared between own releases and (credit-filtered) appears-on.
  const renderReleaseBlock = (album: MusicAlbumCard, onlyCredited: boolean) => {
              const d = releaseDetails?.get(album.id) ?? null;
              const release = d ? defaultRelease(d) : null;
              const albumCoverPath = displayCover(album.covers, album.selected_cover);
              const queue = d && release ? queueFromRelease(d, release) : [];
              const totalSecs = release
                ? release.tracks.reduce((s, t) => s + (t.runtime_secs ?? 0), 0)
                : 0;
              // Appears-on blocks list only the tracks this artist is
              // credited on; own releases list everything.
              const shownTracks =
                release == null
                  ? []
                  : onlyCredited
                    ? release.tracks.filter((t) => t.credits.some((c) => c.artist_id === entryId))
                    : release.tracks;
              return (
                <section key={album.id}>
                  <div className="flex items-center gap-5">
                    <div
                      className="group/cover relative h-56 w-56 shrink-0 cursor-pointer overflow-hidden rounded-[3px] bg-muted shadow-sm"
                      onClick={() => onOpenAlbum(album)}
                    >
                      {albumCoverPath ? (
                        <img
                          src={getCoverUrl(albumCoverPath)}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          draggable={false}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
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
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {d?.album_type || "album"}
                      </p>
                      <button
                        onClick={() => onOpenAlbum(album)}
                        className="block max-w-full truncate text-left font-heading text-xl font-bold hover:underline"
                        title={album.title}
                      >
                        {album.title}
                      </button>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {/* Album-page parity: every credited owner, linked —
                            even when it's just the artist whose page this is. */}
                        {album.artists.length > 0 && (
                          <>
                            {album.artists.map((a, ai) => (
                              <span key={`${a.name}-${ai}`}>
                                {ai > 0 && " · "}
                                {a.artist_id != null && onNavigateToArtist ? (
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
                          album.year,
                          release
                            ? `${release.tracks.length} ${release.tracks.length === 1 ? "track" : "tracks"}`
                            : null,
                          totalSecs > 0 ? fmtAlbumRuntime(totalSecs) : null,
                          album.release_count > 1 ? `${album.release_count} versions` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {d && d.genres.length > 0 && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {d.genres.join(", ")}
                        </p>
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
                                      </span>
                                      <span className="block truncate text-xs text-muted-foreground">
                                        {t.credits.length > 0
                                          ? t.credits.map((c, ci) => (
                                              <span key={`${c.name}-${ci}`}>
                                                {ci > 0 && ", "}
                                                {c.artist_id != null && onNavigateToArtist ? (
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
                                    <LoveButton
                                      trackId={t.id}
                                      loved={t.loved}
                                      reveal="group-hover/track:opacity-100"
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
          {detail.biography && (
            <p className="mt-2 line-clamp-3 max-w-2xl whitespace-pre-line text-sm text-muted-foreground" title={detail.biography}>
              {detail.biography}
            </p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 self-start">
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

      {/* Own albums */}
      {detail.albums.length > 0 && detail.appears_on.length > 0 && (
        <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Releases
        </p>
      )}
      {viewMode === "grid" ? (
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
      >
        {detail.albums.map((album) => {
          const albumCoverPath = displayCover(album.covers, album.selected_cover);
          return (
            <div key={album.id} className="group min-w-0">
              <div
                className="relative aspect-square cursor-pointer overflow-hidden rounded-[3px] bg-muted shadow-sm"
                onClick={() => onOpenAlbum(album)}
              >
                {albumCoverPath ? (
                  <img
                    src={getCoverUrl(albumCoverPath)}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
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
              <button
                onClick={() => onOpenAlbum(album)}
                className="mt-1.5 block w-full truncate text-left text-sm font-medium hover:underline"
                title={album.title}
              >
                {album.title}
              </button>
              <p className="truncate text-xs text-muted-foreground">
                {[album.year, album.release_count > 1 ? `${album.release_count} versions` : null]
                  .filter(Boolean)
                  .join(" · ") || " "}
              </p>
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
            {albumsSorted.map((album) => renderReleaseBlock(album, false))}
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
          </ContextMenuContent>
        </ContextMenu>
      )}

      {/* Loose tracks — album-less files credited to this artist. */}
      {detail.loose_tracks.length > 0 && (
        <>
          <p className={`mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground ${detail.albums.length > 0 ? "mt-6" : ""}`}>
            Tracks
          </p>
          <div>
            {detail.loose_tracks.map((t, i) => {
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
                    </span>
                    {t.credits.length > 0 && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.credits.map((c) => c.name).join(", ")}
                      </span>
                    )}
                  </span>
                  <LoveButton trackId={t.id} loved={t.loved} reveal="group-hover/track:opacity-100" />
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
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
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </>
      )}

      {/* Feature credits on other artists' albums — the whole page for
          feature-only artists. */}
      {detail.appears_on.length > 0 && (
        <>
          <p className={`mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground ${detail.albums.length > 0 || detail.loose_tracks.length > 0 ? "mt-6" : ""}`}>
            Appears On
          </p>
          {viewMode === "grid" ? (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
          >
            {appearsSorted.map((album) => {
              const albumCoverPath = displayCover(album.covers, album.selected_cover);
              return (
                <div key={album.id} className="group min-w-0">
                  <div
                    className="relative aspect-square cursor-pointer overflow-hidden rounded-[3px] bg-muted shadow-sm"
                    onClick={() => onOpenAlbum(album)}
                  >
                    {albumCoverPath ? (
                      <img
                        src={getCoverUrl(albumCoverPath)}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
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
                  <button
                    onClick={() => onOpenAlbum(album)}
                    className="mt-1.5 block w-full truncate text-left text-sm font-medium hover:underline"
                    title={album.title}
                  >
                    {album.title}
                  </button>
                  <p className="truncate text-xs text-muted-foreground">
                    {[album.artist_title, album.year].filter(Boolean).join(", ") || " "}
                  </p>
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
                {appearsSorted.map((album) => renderReleaseBlock(album, true))}
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
      <SplitArtistDialog
        artistId={splitArtistOpen ? entryId : null}
        artistName={detail?.title ?? ""}
        open={splitArtistOpen}
        onOpenChange={setSplitArtistOpen}
      />
    </div>
  );
}
