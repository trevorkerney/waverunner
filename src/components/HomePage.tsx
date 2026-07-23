import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Play, Info, Film, Tv, Music2, ChevronLeft, ChevronRight } from "lucide-react";
import { Spinner } from "./ui/spinner";
import { ContinueWatchingItem, MediaEntry, RecentPlay } from "../types";
import { trackDisplayTitle } from "./music/musicQueue";

interface HomePageProps {
  getCoverUrl: (filePath: string) => string;
  onPlayFile?: (
    path: string,
    title: string,
    opts?: { watch?: { kind: "movie" | "episode"; id: number }; startSecs?: number }
  ) => void;
  onPlayEpisode?: (args: {
    libraryId: string;
    showId: number;
    showTitle: string;
    startEpisodeId: number;
    startSecs?: number;
  }) => void;
  /** "Go to page" — cross-library detail navigation, handled by App.
   *  focusTrackId (albums): scroll to and highlight that track on arrival. */
  onOpenLibraryEntry?: (libraryId: string, entry: MediaEntry, focusTrackId?: number) => void;
  /** Album-less tiles → the Tracks page, scrolled to the track. */
  onOpenLibraryTrack?: (libraryId: string, trackId: number) => void;
}

/** Minimal MediaEntry for detail navigation — the detail page fetches its own
 *  data by id; these fields just seed the header/crumb. */
function fakeVideoEntry(item: ContinueWatchingItem): MediaEntry {
  return {
    id: item.entry_id,
    title: item.title,
    year: null,
    end_year: null,
    folder_path: "",
    parent_id: null,
    entry_type: item.kind,
    covers: item.cover ? [item.cover] : [],
    selected_cover: item.cover,
    child_count: 0,
    season_display: null,
    collection_display: null,
    tmdb_id: null,
    link_id: null,
    interactive: false,
    watched: false,
    watch_progress: null,
    unwatched: false,
    has_progress: false,
  };
}

function fmtTimeLeft(position: number | null, duration: number | null): string | null {
  if (position == null || duration == null || duration <= 0) return null;
  const left = Math.max(0, duration - position);
  const mins = Math.round(left / 60);
  return mins <= 1 ? "less than a minute left" : `${mins} min left`;
}

/** Horizontal shelf: hidden native scrollbar, edge fades where content
 *  continues, and hover chevrons that page a viewport at a time. Wheel and
 *  trackpad scrolling still work as usual. `artCenterPx` vertically centers
 *  the chevrons on the card ART (the rail itself also holds captions and
 *  padding, so its own center sits too low). */
function HomeRail({ children, artCenterPx }: { children: ReactNode; artCenterPx: number }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  useEffect(() => {
    update();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // Re-measure when the rail's contents change (data loads after mount).
  }, [children]);

  const page = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 1.05, behavior: "smooth" });
  };

  // The scroll container clips overflow on every side (rings, shadows, hover
  // lift/grow would lose their edges) — internal padding gives cards headroom
  // INSIDE the clip box, and negative margins cancel it so nothing shifts.
  const LIFT_PAD = 8;

  return (
    <div className="group/rail relative">
      <div
        ref={scrollRef}
        onScroll={update}
        className="scrollbar-none -mx-2 -mt-2 flex gap-4 overflow-x-auto px-2 pb-3 pt-2"
      >
        {children}
      </div>
      {canLeft && (
        <>
          <div className="pointer-events-none absolute inset-y-0 -left-2 z-10 w-12 bg-gradient-to-r from-background to-transparent" />
          <button
            onClick={() => page(-1)}
            style={{ top: artCenterPx + LIFT_PAD }}
            className="absolute left-1 z-10 -translate-y-1/2 rounded-full bg-background/90 p-1.5 text-foreground shadow-md ring-1 ring-border opacity-0 transition-opacity hover:bg-accent group-hover/rail:opacity-100"
            title="Scroll left"
          >
            <ChevronLeft size={22} />
          </button>
        </>
      )}
      {canRight && (
        <>
          <div className="pointer-events-none absolute inset-y-0 -right-2 z-10 w-12 bg-gradient-to-l from-background to-transparent" />
          <button
            onClick={() => page(1)}
            style={{ top: artCenterPx + LIFT_PAD }}
            className="absolute right-1 z-10 -translate-y-1/2 rounded-full bg-background/90 p-1.5 text-foreground shadow-md ring-1 ring-border opacity-0 transition-opacity hover:bg-accent group-hover/rail:opacity-100"
            title="Scroll right"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** The app's front door: where you left off across every video library, and
 *  the always-available half of music's recently-played. Content here grows
 *  over time — these two sections are just the opening tenants. */
export function HomePage({
  getCoverUrl,
  onPlayFile,
  onPlayEpisode,
  onOpenLibraryEntry,
  onOpenLibraryTrack,
}: HomePageProps) {
  const [continueItems, setContinueItems] = useState<ContinueWatchingItem[] | null>(null);
  const [recent, setRecent] = useState<RecentPlay[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    invoke<ContinueWatchingItem[]>("get_continue_watching", { limit: 20 })
      .then((rows) => {
        if (!cancelled) setContinueItems(rows);
      })
      .catch((e) => console.error("Failed to load continue watching:", e));
    invoke<RecentPlay[]>("get_recent_music_plays", { libraryId: null, limit: 50 })
      .then((rows) => {
        if (!cancelled) setRecent(rows);
      })
      .catch((e) => console.error("Failed to load recent plays:", e));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Player close = progress settled AND the resume frame just got written —
  // refetch so the rail (and its frame) updates the moment the X is clicked.
  // Old data stays visible during the refetch; no spinner flash.
  useEffect(() => {
    const onClosed = () => setReloadKey((k) => k + 1);
    window.addEventListener("waverunner:player-closed", onClosed);
    return () => window.removeEventListener("waverunner:player-closed", onClosed);
  }, []);

  const resume = async (item: ContinueWatchingItem) => {
    try {
      if (item.kind === "movie") {
        const path = await invoke<string>("get_movie_file_path", {
          libraryId: item.library_id,
          entryId: item.entry_id,
        });
        onPlayFile?.(path, item.title, {
          watch: { kind: "movie", id: item.entry_id },
          startSecs: item.position_secs ?? undefined,
        });
      } else if (item.episode_id != null) {
        onPlayEpisode?.({
          libraryId: item.library_id,
          showId: item.entry_id,
          showTitle: item.title,
          startEpisodeId: item.episode_id,
          startSecs: item.position_secs ?? undefined,
        });
      }
    } catch (e) {
      toast.error(String(e));
    }
  };

  // Tiles navigate to their album page (cross-library, like the video cards),
  // scrolling to the played track and highlighting it on arrival. Album-less
  // tracks have no album page — they land on the Tracks page instead, same
  // scroll-and-highlight treatment.
  const openAlbum = (p: RecentPlay) => {
    if (p.album_id == null) {
      onOpenLibraryTrack?.(p.library_id, p.track_id);
      return;
    }
    onOpenLibraryEntry?.(
      p.library_id,
      {
        id: p.album_id,
        title: p.album_title ?? "",
        year: null,
        end_year: null,
        folder_path: "",
        parent_id: null,
        entry_type: "album",
        covers: p.cover ? [p.cover] : [],
        selected_cover: p.cover,
        child_count: 0,
        season_display: null,
        collection_display: null,
        tmdb_id: null,
        link_id: null,
        interactive: false,
        watched: false,
        watch_progress: null,
        unwatched: false,
        has_progress: false,
      },
      p.track_id
    );
  };

  // The rail dedupes repeat plays of the same track (the Up Next panel's
  // history tab keeps the raw every-start list) — identical tiles in a row
  // read as a rendering bug, not history.
  const recentTiles = (() => {
    if (!recent) return null;
    const seen = new Set<number>();
    const out: RecentPlay[] = [];
    for (const p of recent) {
      if (seen.has(p.track_id)) continue;
      seen.add(p.track_id);
      out.push(p);
      if (out.length >= 14) break;
    }
    return out;
  })();

  const loading = continueItems == null || recentTiles == null;
  const empty = !loading && continueItems.length === 0 && recentTiles.length === 0;

  return (
    <div className="px-6 pb-8">
      <div className="py-5">
        <h1 className="font-heading text-2xl font-bold">{greeting()}</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-6" />
        </div>
      ) : empty ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          Nothing here yet — watch or listen to something and it'll show up.
        </p>
      ) : (
        <>
          {continueItems.length > 0 && (
            <>
              <p className="mb-2.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Continue watching
              </p>
              {/* 28rem (448px) 16:9 cards → art is 252px tall, center 126. */}
              <HomeRail artCenterPx={126}>
                {continueItems.map((item) => {
                  const progress =
                    item.position_secs != null && item.duration_secs != null && item.duration_secs > 0
                      ? Math.min(1, item.position_secs / item.duration_secs)
                      : null;
                  const epLabel =
                    item.kind === "show"
                      ? [
                          item.season_number != null && item.episode_number != null
                            ? `S${item.season_number} E${item.episode_number}`
                            : null,
                          item.episode_title,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : null;
                  const subtitle = [epLabel, fmtTimeLeft(item.position_secs, item.duration_secs)]
                    .filter(Boolean)
                    .join(" · ");
                  // Card art ladder: the frame you left at → backdrop → a
                  // blurred-cover treatment → bare icon. The frame file is
                  // OVERWRITTEN in place each session, so its URL carries a
                  // cache-buster (last_played_at changes every session).
                  const wide = item.frame
                    ? `${convertFileSrc(item.frame)}?v=${encodeURIComponent(item.last_played_at)}`
                    : item.backdrop
                      ? convertFileSrc(item.backdrop)
                      : null;
                  return (
                    <div
                      key={`${item.kind}-${item.entry_id}`}
                      className="group relative aspect-video w-[28rem] shrink-0 overflow-hidden rounded-[3px] bg-muted shadow-md ring-1 ring-foreground/10"
                    >
                      {wide ? (
                        <img
                          src={wide}
                          alt={item.title}
                          loading="lazy"
                          decoding="async"
                          className="absolute inset-0 h-full w-full object-cover"
                          draggable={false}
                        />
                      ) : item.cover ? (
                        <>
                          {/* No wide art — the cover fills as a blurred wash
                              with the sharp poster inset on the left. */}
                          <img
                            src={getCoverUrl(item.cover)}
                            alt=""
                            aria-hidden
                            className="absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-lg"
                            draggable={false}
                          />
                          <img
                            src={getCoverUrl(item.cover)}
                            alt={item.title}
                            className="absolute left-0 top-0 h-full w-auto object-cover shadow-lg"
                            draggable={false}
                          />
                        </>
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                          {item.kind === "movie" ? <Film size={36} /> : <Tv size={36} />}
                        </div>
                      )}

                      {/* Title/subtitle over a bottom gradient, always visible. */}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pb-2 pt-8">
                        <p className="truncate text-sm font-medium text-white" title={item.title}>
                          {item.title}
                        </p>
                        <p className="truncate text-xs text-white/70">{subtitle || " "}</p>
                      </div>

                      {/* Two explicit actions on hover — resume, or go to page. */}
                      <div className="absolute inset-0 flex items-center justify-center gap-5 bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => void resume(item)}
                          className="text-white/90 drop-shadow transition-transform hover:scale-110 hover:text-white"
                          title={item.position_secs != null ? "Resume" : "Play"}
                        >
                          <Play size={30} fill="currentColor" />
                        </button>
                        <button
                          onClick={() => onOpenLibraryEntry?.(item.library_id, fakeVideoEntry(item))}
                          className="text-white/90 drop-shadow transition-transform hover:scale-110 hover:text-white"
                          title={item.kind === "movie" ? "Go to movie page" : "Go to show page"}
                        >
                          <Info size={26} />
                        </button>
                      </div>

                      {progress != null && (
                        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                          <div className="h-full bg-primary" style={{ width: `${progress * 100}%` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </HomeRail>
            </>
          )}

          {recentTiles.length > 0 && (
            <>
              <p
                className={`mb-2.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground ${
                  continueItems.length > 0 ? "mt-7" : ""
                }`}
              >
                Recently played
              </p>
              {/* w-44 (176px) square covers → center 88. */}
              <HomeRail artCenterPx={88}>
                {recentTiles.map((p) => (
                  <button
                    key={p.track_id}
                    onClick={() => openAlbum(p)}
                    // flex-col: buttons vertically CENTER their content by
                    // default — when the rail stretches tiles to equal height,
                    // short-caption tiles would sink their covers off the line.
                    className="group flex w-44 shrink-0 flex-col text-left"
                    title={p.album_title ? `Go to "${p.album_title}"` : "Go to track"}
                  >
                    <div className="relative aspect-square overflow-hidden rounded-[3px] bg-muted shadow-md ring-1 ring-foreground/10 transition-[translate,scale] duration-200 group-hover:-translate-y-1 group-hover:scale-[1.03] group-hover:shadow-xl">
                      {p.cover ? (
                        <img
                          src={getCoverUrl(p.cover)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                          draggable={false}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          <Music2 size={32} />
                        </div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                        <Info size={26} className="text-white/90 drop-shadow" />
                      </div>
                    </div>
                    {/* Titles wrap freely; covers stay aligned because they sit
                        above the captions (tiles are top-anchored). The artist
                        row keeps its height even when empty. */}
                    <p className="mt-1.5 break-words text-sm font-medium">
                      {trackDisplayTitle(p.track_title, p.file_path)}
                    </p>
                    <p className="h-4 truncate text-xs text-muted-foreground">{p.artist_name ?? ""}</p>
                  </button>
                ))}
              </HomeRail>
            </>
          )}
        </>
      )}
    </div>
  );
}
