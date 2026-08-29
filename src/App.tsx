import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { Titlebar } from "@/components/Titlebar";
import { Sidebar } from "@/components/Sidebar";
import { MainContent } from "@/components/MainContent";
import { PlayerView } from "@/components/PlayerView";
import { usePlayer } from "@/hooks/usePlayer";
import { useMusicPlayer, currentMusicItem } from "@/hooks/useMusicPlayer";
import { NowPlayingBar } from "@/components/player/NowPlayingBar";
import { MetadataCenterDialog } from "@/components/music/MetadataCenter";
import { VideoMetadataCenterDialog } from "@/components/VideoMetadataCenter";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { relaunch } from "@tauri-apps/plugin-process";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Library, MediaEntry, EntriesResponse, BreadcrumbItem, ViewSpec, PersonInfo, PersonSummary, PersonRole, PlaylistSummary, PlaylistsResponse, PlaylistContents, SortPreset, LibraryCounts, GenreSummary, EntryWatchFlags, MusicQueueItem } from "@/types";
import { KEYBINDS_SETTING, actionForKey, setRuntimeKeybinds } from "@/lib/playerKeybinds";
import { viewCacheKey, scopeKeyFor } from "@/lib/complications";

// Mirrors the backend's generate_sort_title: leading articles stripped,
// lowercase. Local re-sorts (music Artists / Albums) use it so their order
// matches what the backend serves on the next fresh load.
function sortTitleKey(t: string): string {
  let s = t.trim().toLowerCase();
  for (const a of ["the ", "a ", "an "]) {
    if (s.startsWith(a)) {
      s = s.slice(a.length).trim();
      break;
    }
  }
  return s;
}

// One visited page, restorable wholesale by history-true back/forward.
type NavSnapshot = {
  view: ViewSpec | null;
  entry: MediaEntry | null;
  crumbs: BreadcrumbItem[];
  search: string;
};

// Identity key for consecutive-duplicate suppression in the history stack.
function snapKey(s: NavSnapshot): string {
  return JSON.stringify([
    s.view,
    s.entry?.id ?? null,
    s.entry?.link_id ?? null,
    s.search,
    s.crumbs.map((c) => [c.id, c.title]),
  ]);
}

// Minimal MediaEntry for programmatic music navigation (now-playing bar links)
// — same shape the detail pages use for their cross-navigation stubs.
function fakeMusicEntry(entryType: "album" | "artist", id: number, title: string): MediaEntry {
  return {
    id,
    title,
    year: null,
    end_year: null,
    folder_path: "",
    parent_id: null,
    entry_type: entryType,
    covers: [],
    selected_cover: null,
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

function App() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  // Playlists per-library for the sidebar tree (each library's "Playlists" node shows its
  // playlists as children). Refreshed on libraries change + any onPlaylistChanged.
  const [sidebarPlaylists, setSidebarPlaylists] = useState<Record<string, PlaylistSummary[]>>({});
  // Per-library counts shown on sidebar nodes (movies/shows/people). Refreshed on
  // libraries change and after rescans.
  const [sidebarCounts, setSidebarCounts] = useState<Record<string, LibraryCounts>>({});
  // Per-library genre lists shown as children of the "Genres" sidebar node.
  const [sidebarGenres, setSidebarGenres] = useState<Record<string, GenreSummary[]>>({});
  // Library auto-opened on launch (settings key "default_library_id").
  // undefined = settings not hydrated yet; null = no default set ("" stored).
  const [defaultLibraryId, setDefaultLibraryId] = useState<string | null | undefined>(undefined);
  const [activeView, setActiveView] = useState<ViewSpec | null>(null);
  const selectedLibrary = activeView && "libraryId" in activeView
    ? libraries.find((l) => l.id === activeView.libraryId) ?? null
    : null;
  const [entries, setEntries] = useState<MediaEntry[]>([]);
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [genres, setGenres] = useState<GenreSummary[] | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [sortMode, setSortMode] = useState("alpha");
  const [selectedPresetId, setSelectedPresetId] = useState<number | null>(null);
  const [presets, setPresets] = useState<SortPreset[]>([]);
  // Albums/Sounds views: loose-track count for the header button — delivered
  // in the grid payload/cache so button and grid render in one commit.
  const [looseCount, setLooseCount] = useState<number | null>(null);
  const [coverSize, setCoverSize] = useState(200);
  const coverSizeTimerRef = useRef<number | null>(null);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<MediaEntry[] | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<MediaEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [playerState, playerActions] = usePlayer();
  const [musicState, musicActions] = useMusicPlayer();
  // Match-to-MusicBrainz review modal: opened from the sidebar context menu
  // or automatically when an enrichment pass leaves items needing review.
  const [mbReviewLibraryId, setMbReviewLibraryId] = useState<string | null>(null);
  // Video metadata center (TMDB match review), same shape.
  const [videoCenterLibraryId, setVideoCenterLibraryId] = useState<string | null>(null);
  // Surfaces that can't reach this state (the pending-work strip) open the
  // music metadata center through a window event, same pattern as open-rescan.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const libraryId = (e as CustomEvent).detail?.libraryId as string | undefined;
      if (libraryId) setMbReviewLibraryId(libraryId);
    };
    window.addEventListener("waverunner:open-music-center", onOpen);
    // The match-only wizard is about to open (Sidebar handles the launch) —
    // close the center so the modal isn't buried under it.
    const onOpenMatch = () => setMbReviewLibraryId(null);
    window.addEventListener("waverunner:open-match", onOpenMatch);
    return () => {
      window.removeEventListener("waverunner:open-music-center", onOpen);
      window.removeEventListener("waverunner:open-match", onOpenMatch);
    };
  }, []);

  // Video and music are fully mutually exclusive: starting either one STOPS
  // the other outright (bar/player gone), never just pauses it.
  const handlePlayFile = useCallback(
    async (path: string, title: string, opts?: { watch?: { kind: "movie" | "episode"; id: number }; startSecs?: number }) => {
      try {
        await musicActions.stop();
        await playerActions.play(path, title, opts);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [playerActions, musicActions]
  );

  const handlePlayEpisode = useCallback(
    async (args: { libraryId: string; showId: number; showTitle: string; startEpisodeId: number; startSecs?: number }) => {
      try {
        await musicActions.stop();
        await playerActions.playEpisode(args);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [playerActions, musicActions]
  );

  const handlePlayInteractive = useCallback(
    async (args: { libraryId: string; entryId: number; title: string; fresh?: boolean }) => {
      try {
        await musicActions.stop();
        await playerActions.playInteractive(args);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [playerActions, musicActions]
  );

  const handlePlayMusicQueue = useCallback(
    async (items: MusicQueueItem[], startIndex: number) => {
      try {
        if (playerState.isActive) {
          await playerActions.close();
        }
        await musicActions.playQueue(items, startIndex);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [playerState.isActive, playerActions, musicActions]
  );

  // "Play next" / "Add to queue" from context menus. An idle player just
  // starts playing (the hook handles that); a busy one queues.
  const handleEnqueueMusic = useCallback(
    (items: MusicQueueItem[], mode: "next" | "last") => {
      if (mode === "next") musicActions.enqueueNext(items);
      else musicActions.enqueueLast(items);
    },
    [musicActions]
  );

  // Detail pages refresh their watch indicators when the player closes —
  // that's the moment progress recording for the session settles — and the
  // grids get their baked-in flags patched at the same time (defined below,
  // after the entry caches it walks).
  const refreshWatchFlagsRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!playerState.isActive) {
      window.dispatchEvent(new Event("waverunner:player-closed"));
      refreshWatchFlagsRef.current();
    }
  }, [playerState.isActive]);

  // Watch state changed outside playback (Home's mark-watched menu) — patch
  // the baked-in flags across grids/caches the same way a player close does.
  useEffect(() => {
    const onChanged = () => refreshWatchFlagsRef.current();
    window.addEventListener("waverunner:watch-changed", onChanged);
    return () => window.removeEventListener("waverunner:watch-changed", onChanged);
  }, []);

  // Keep webview transparent while player is active (full or minimized), so
  // mpv video shows through the transparent dock/takeover region.
  useEffect(() => {
    if (playerState.isActive) {
      document.documentElement.classList.add("player-active");
    } else {
      document.documentElement.classList.remove("player-active");
    }
  }, [playerState.isActive]);

  // Cache: "libraryId:parentId" -> { entries, sortMode } (library-root view only)
  const entryCacheRef = useRef<Map<string, { entries: MediaEntry[]; sort_mode: string; selected_preset_id: number | null; presets: SortPreset[]; loose_count?: number | null }>>(new Map());
  // Cache: viewCacheKey(view) -> entries (non-root MediaEntry views: movies-only / shows-only / person-detail)
  const viewEntriesCacheRef = useRef<Map<string, { entries: MediaEntry[]; sort_mode: string; selected_preset_id: number | null; presets: SortPreset[]; loose_count?: number | null }>>(new Map());
  // Cache: viewCacheKey(view) -> people (people-list views)
  const peopleCacheRef = useRef<Map<string, PersonSummary[]>>(new Map());
  // Top-100/All mode per people view (keyed by viewCacheKey). Persisted to the settings
  // table (`people_mode:{key}`) and hydrated on mount, so the choice is remembered across
  // navigation and restarts.
  const peopleModeRef = useRef<Map<string, "top" | "all">>(new Map());
  // Cache: viewCacheKey(view) -> playlists + the list scope's preset state
  const playlistsCacheRef = useRef<Map<string, { playlists: PlaylistSummary[]; presets: SortPreset[]; selectedPresetId: number | null }>>(new Map());
  // Cache: libraryId -> genre list (so re-clicking Genres doesn't re-fetch/flash).
  const genresCacheRef = useRef<Map<string, GenreSummary[]>>(new Map());
  // Scroll position cache: scroll-key -> { pixel fallback, plus an element anchor
  // (the card at the viewport top + its offset) so restore survives content-
  // visibility height-estimation drift that a raw scrollTop can't.
  const scrollCacheRef = useRef<Map<string, { scrollTop: number; anchorId: string | null; anchorDelta: number }>>(new Map());

  // Watch flags (progress slivers, unwatched badges) are baked into entry
  // lists at fetch time, so after playback they're stale in the visible grid
  // AND every cached view. One batched query re-derives them and patches all
  // copies in place — no view refetch, no flash.
  const entriesStateRef = useRef<MediaEntry[]>([]);
  const searchResultsStateRef = useRef<MediaEntry[] | null>(null);
  useEffect(() => {
    entriesStateRef.current = entries;
  }, [entries]);
  useEffect(() => {
    searchResultsStateRef.current = searchResults;
  }, [searchResults]);
  refreshWatchFlagsRef.current = async () => {
    const ids = new Set<number>();
    const gather = (list?: MediaEntry[] | null) => {
      list?.forEach((e) => {
        if (e.entry_type === "movie" || e.entry_type === "show") ids.add(e.id);
      });
    };
    gather(entriesStateRef.current);
    gather(searchResultsStateRef.current);
    entryCacheRef.current.forEach((v) => gather(v.entries));
    viewEntriesCacheRef.current.forEach((v) => gather(v.entries));
    if (ids.size === 0) return;
    try {
      const rows = await invoke<EntryWatchFlags[]>("get_watch_flags", { entryIds: [...ids] });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const apply = (e: MediaEntry): MediaEntry => {
        const f = byId.get(e.id);
        return f
          ? { ...e, watched: f.watched, watch_progress: f.watch_progress, unwatched: f.unwatched, has_progress: f.has_progress }
          : e;
      };
      setEntries((prev) => prev.map(apply));
      setSearchResults((prev) => (prev ? prev.map(apply) : prev));
      entryCacheRef.current.forEach((v) => {
        v.entries = v.entries.map(apply);
      });
      viewEntriesCacheRef.current.forEach((v) => {
        v.entries = v.entries.map(apply);
      });
    } catch {
      // Best-effort; views re-derive flags on their next real fetch anyway.
    }
  };
  // Sort mode for the playlists-list view ("alpha" | "custom"). Held in a ref so
  // loadView reads it without a dep; the toolbar's sort dropdown drives it.
  const playlistsSortModeRef = useRef("custom");
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Cache: cover file path -> blob URL of its thumbnail
  const thumbCacheRef = useRef<Map<string, string>>(new Map());
  // Decoded cover aspect ratios (w/h), captured during preload so the grid can reserve the
  // exact cover height up front — otherwise a non-2:3 cover resizes its subgrid row on load
  // and shoves neighbours around ("covers drop in and shift").
  const coverAspectRef = useRef<Map<string, number>>(new Map());

  function toThumbPath(coverPath: string): string {
    // coverPath: .../covers/filename.jpg -> .../covers_thumb/filename.jpg
    return coverPath.replace(/[/\\]covers[/\\]/, (m) =>
      m[0] + "covers_thumb" + m[m.length - 1]
    );
  }

  // Only the first screenfuls are decode-gated before the grid swaps in; the
  // rest lazy-load their thumbnails as cards scroll near (content-visibility +
  // loading="lazy" on the cards keep offscreen work at zero).
  const PRELOAD_COVER_CAP = 150;

  const preloadCovers = useCallback(async (entries: MediaEntry[]) => {
    await Promise.all(
      entries.slice(0, PRELOAD_COVER_CAP).map(async (entry) => {
        const cover =
          entry.selected_cover && entry.covers.includes(entry.selected_cover)
            ? entry.selected_cover
            : entry.covers[0];
        if (!cover) return;
        let url = thumbCacheRef.current.get(cover);
        if (!url) {
          try {
            const thumbPath = toThumbPath(cover);
            const resp = await fetch(convertFileSrc(thumbPath));
            if (!resp.ok) throw new Error();
            const blob = await resp.blob();
            url = URL.createObjectURL(blob);
          } catch {
            // Fallback: cache full-res as blob
            try {
              const resp = await fetch(convertFileSrc(cover));
              const blob = await resp.blob();
              url = URL.createObjectURL(blob);
            } catch {
              return;
            }
          }
          thumbCacheRef.current.set(cover, url);
        }
        // Decode up front so the grid paints with covers already rasterized —
        // a bare <img> decodes lazily, making covers pop in one by one. Capture the
        // real aspect ratio while we're here so the grid reserves exact space.
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          if (img.naturalWidth && img.naturalHeight) {
            coverAspectRef.current.set(cover, img.naturalWidth / img.naturalHeight);
          }
        } catch { /* paint will decode it instead */ }
      })
    );
  }, []);

  // Real cover aspect ratio (w/h) if it was decoded during preload, else undefined.
  const getCoverAspect = useCallback((filePath: string) => coverAspectRef.current.get(filePath), []);

  // Same idea for non-entry grids (people faces, playlist covers): fetch and
  // decode before the grid swaps in, so it appears fully formed.
  const preloadImages = useCallback(async (paths: (string | null)[]) => {
    await Promise.all(
      paths
        .filter((p): p is string => !!p)
        .map(async (p) => {
          try {
            const img = new Image();
            img.src = convertFileSrc(p);
            await img.decode();
          } catch { /* paint will decode it instead */ }
        })
    );
  }, []);

  // For grid: returns cached thumbnail blob URL. Uncached (beyond the preload
  // cap) falls back to the on-disk thumbnail file — NOT the full-res cover —
  // so lazy-loaded tail entries stay cheap.
  const getCoverUrl = useCallback((filePath: string): string => {
    return thumbCacheRef.current.get(filePath) || convertFileSrc(toThumbPath(filePath));
  }, []);

  // For carousel: always full-res
  const getFullCoverUrl = useCallback((filePath: string): string => {
    return convertFileSrc(filePath);
  }, []);

  const loadLibraries = useCallback(async () => {
    try {
      const libs = await invoke<Library[]>("get_libraries");
      setLibraries(libs);
    } catch (e) {
      console.error("Failed to load libraries:", e);
    }
  }, []);

  useEffect(() => {
    loadLibraries();
  }, [loadLibraries]);

  // Dev only: React 19's development build emits a performance.measure() for
  // every component render (the browser "React" performance track). During
  // playback the app re-renders several times a second, so these pile up in the
  // performance buffer — which force-GC can't reclaim (native perf entries) —
  // and eventually OOM the dev webview. Periodically flush it. Production React
  // emits none of these, so this is unnecessary (and a no-op) there.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const id = setInterval(() => {
      performance.clearMeasures();
      performance.clearMarks();
    }, 3000);
    return () => clearInterval(id);
  }, []);

  // Populate sidebar playlist children whenever the libraries list changes. Failures per
  // library are silently ignored — the Playlists sidebar node just won't show children.
  useEffect(() => {
    let cancelled = false;
    libraries.forEach(async (lib) => {
      try {
        const res = await invoke<PlaylistsResponse>("get_playlists", { libraryId: lib.id });
        if (!cancelled) {
          setSidebarPlaylists((prev) => ({ ...prev, [lib.id]: res.playlists }));
        }
      } catch {
        // swallow — sidebar just renders with no playlist children for that library
      }
    });
    return () => { cancelled = true; };
  }, [libraries]);

  // Fetch the counts for one library and merge them into the sidebar map.
  const refreshCountsFor = useCallback(async (libraryId: string) => {
    try {
      const counts = await invoke<LibraryCounts>("get_library_counts", { libraryId });
      setSidebarCounts((prev) => ({ ...prev, [libraryId]: counts }));
    } catch {
      // swallow — sidebar nodes just render without counts for that library
    }
  }, []);

  // Fetch the genre list for one library (for the "Genres" node's children).
  const refreshGenresFor = useCallback(async (libraryId: string) => {
    try {
      const res = await invoke<GenreSummary[]>("get_genres_in_library", { libraryId });
      setSidebarGenres((prev) => ({ ...prev, [libraryId]: res }));
    } catch {
      // swallow — the Genres node just renders without children for that library
    }
  }, []);

  // Music libraries have their own counts shape (artists/albums/tracks/issues).
  const refreshMusicCountsFor = useCallback(async (libraryId: string) => {
    try {
      const counts = await invoke<LibraryCounts>("get_music_counts", { libraryId });
      setSidebarCounts((prev) => ({ ...prev, [libraryId]: counts }));
    } catch {
      // swallow — sidebar nodes just render without counts for that library
    }
  }, []);

  // Populate sidebar counts + genres whenever the libraries list changes.
  useEffect(() => {
    libraries.forEach((lib) => {
      if (lib.format === "video") {
        refreshCountsFor(lib.id);
        refreshGenresFor(lib.id);
      } else if (lib.format === "music") {
        refreshMusicCountsFor(lib.id);
        refreshGenresFor(lib.id);
      }
    });
  }, [libraries, refreshCountsFor, refreshGenresFor, refreshMusicCountsFor]);

  // Update check on launch. Never downloads on its own — the toast offers the
  // update and nothing happens until the user clicks Download (dismissing it
  // skips the update for this session).
  useEffect(() => {
    const endpoint =
      "https://github.com/trevorkerney/waverunner/releases/latest/download/latest.json";
    const downloadAndOfferRestart = async () => {
      toast(`Downloading update…`, {
        duration: Infinity,
        id: "auto-update",
        action: undefined,
      });
      try {
        await invoke("download_and_install_update", { endpoint });
        toast("Update ready", {
          description: "Restart to apply the update.",
          duration: Infinity,
          id: "auto-update",
          action: { label: "Restart", onClick: () => relaunch() },
        });
      } catch (e) {
        toast.error("Update failed", {
          description: String(e),
          id: "auto-update",
          duration: 6000,
        });
      }
    };
    (async () => {
      try {
        const settings = await invoke<Record<string, string>>("get_settings");
        if (settings["auto_update"] === "false") return;
        const result = await invoke<{ version: string } | null>(
          "check_for_update",
          { endpoint }
        );
        if (!result) return;
        toast(`Update v${result.version} available`, {
          duration: Infinity,
          id: "auto-update",
          action: { label: "Download", onClick: () => void downloadAndOfferRestart() },
        });
      } catch {
        // Silent fail — don't bother user if update check fails
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedLibrary || !search.trim()) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        const results = await invoke<MediaEntry[]>("search_entries", {
          libraryId: selectedLibrary.id,
          parentId,
          query: search.trim(),
        });
        // Scope results to the active sidebar view. In movies-only/shows-only the user
        // expects search to honor that scope; All (library-root) searches everything.
        const filtered =
          activeView?.kind === "movies-only" ? results.filter((r) => r.entry_type === "movie")
          : activeView?.kind === "shows-only" ? results.filter((r) => r.entry_type === "show")
          : results;
        await preloadCovers(filtered);
        setSearchResults(filtered);
      } catch (e) {
        console.error("Search failed:", e);
        setSearchResults(null);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [search, selectedLibrary, breadcrumbs, activeView, preloadCovers]);

  // Load the persisted playlists-list sort mode for the selected library.
  useEffect(() => {
    if (!selectedLibrary) return;
    invoke<Record<string, string>>("get_settings")
      .then((s) => {
        playlistsSortModeRef.current = s[`playlists_sort_mode:${selectedLibrary.id}`] === "alpha" ? "alpha" : "custom";
      })
      .catch(() => {});
  }, [selectedLibrary]);

  // The cover-size slider is global (shared by every grid) and persisted in the settings
  // table so it survives restarts. Load once on mount; `changeCoverSize` (below) writes
  // changes back, debounced so dragging the slider doesn't hammer the DB.
  useEffect(() => {
    invoke<Record<string, string>>("get_settings")
      .then((s) => {
        const v = parseInt(s["cover_size"] ?? "", 10);
        if (!Number.isNaN(v)) setCoverSize(v);
      })
      .catch(() => {});
  }, []);

  const changeCoverSize = useCallback((size: number) => {
    setCoverSize(size);
    if (coverSizeTimerRef.current) clearTimeout(coverSizeTimerRef.current);
    coverSizeTimerRef.current = window.setTimeout(() => {
      invoke("set_setting", { key: "cover_size", value: String(size) }).catch(() => {});
    }, 300);
  }, []);

  // Hydrate the per-view people mode, the default library, and the player
  // keybinds from settings on mount, so saved choices are in place before the
  // user navigates. (viewCacheKey already embeds the library id, so a single
  // global read covers every library.)
  useEffect(() => {
    invoke<Record<string, string>>("get_settings")
      .then((s) => {
        for (const [k, v] of Object.entries(s)) {
          if (k.startsWith("people_mode:") && (v === "top" || v === "all")) {
            peopleModeRef.current.set(k.slice("people_mode:".length), v);
          }
        }
        setDefaultLibraryId(s["default_library_id"] || null);
        setRuntimeKeybinds(s[KEYBINDS_SETTING]);
      })
      .catch(() => {
        // Settings unavailable: unblock the auto-select gate with "no default".
        setDefaultLibraryId(null);
      });
  }, []);

  // Scroll-key "kind": must uniquely identify a view so distinct pages don't share
  // a scroll slot (Actors vs Composers; two different people/genres/playlists).
  const scrollKindFor = useCallback((view: ViewSpec | null): string => {
    switch (view?.kind) {
      case "people-list":     return `people-list:${view.role}`;
      case "person-detail":   return `person-detail:${view.role}:${view.personId}`;
      case "genre-detail":    return `genre-detail:${view.genre}`;
      case "playlist-detail": return `playlist-detail:${view.playlistId}:${view.collectionId ?? "root"}`;
      default:                return view?.kind ?? "library-root";
    }
  }, []);

  const saveScrollPosition = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // Home is libraryless — it gets a fixed key; everything else is scoped to
    // the selected library.
    if (!selectedLibrary && activeView?.kind !== "home") return;
    const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
    const key = `${activeView?.kind === "home" ? "home" : selectedLibrary!.id}:${scrollKindFor(activeView)}:${parentId}`;
    // Anchor to the card currently at the top of the viewport so restore can
    // re-find it by id. A raw scrollTop drifts on the way back because off-screen
    // cards above are height-estimated (content-visibility) and never render to
    // correct themselves, so the saved pixel no longer points at the same card.
    const cTop = container.getBoundingClientRect().top;
    let anchorId: string | null = null;
    let anchorDelta = 0;
    for (const el of container.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const r = el.getBoundingClientRect();
      if (r.bottom > cTop + 1) {
        anchorId = el.dataset.flipId ?? null;
        anchorDelta = r.top - cTop;
        break;
      }
    }
    scrollCacheRef.current.set(key, { scrollTop: container.scrollTop, anchorId, anchorDelta });
  }, [selectedLibrary, breadcrumbs, activeView, scrollKindFor]);

  // restoreScrollPosition: apply the saved scroll for a (library, view-kind, parent) triple,
  // or reset to top when none is saved. Scroll keys include view kind so sidebar switches
  // don't leak scroll between views (library-root at parentId=null is distinct from movies-only at parentId=null).
  const restoreScrollPosition = useCallback((libraryId: string, kind: string, parentId: number | null) => {
    const key = `${libraryId}:${kind}:${parentId}`;
    const saved = scrollCacheRef.current.get(key);
    if (!scrollContainerRef.current) return;
    // Two restore strategies, both patient about content that isn't there yet:
    //  - Anchored (grids): re-align the card that sat at the top of the
    //    viewport. content-visibility cards above it settle over a few frames
    //    and nudge it, so re-align until the adjustment stops.
    //  - Raw offset (detail pages, Tracks, Home — no [data-flip-id] anchors):
    //    these pages fetch their own data AFTER mounting, so the container is
    //    near-empty on the first frames and an early scrollTop write just
    //    clamps to 0. Wait until the page has grown enough to hold the target
    //    (bounded — content may legitimately have shrunk since the save).
    const MAX_FRAMES = 120; // ~2s at 60fps — the async-content upper bound
    let attempts = 0;
    let alignFrames = 0;
    const settle = () => {
      const c = scrollContainerRef.current;
      if (!c) return;
      if (!saved) { c.scrollTop = 0; return; }
      attempts++;
      if (saved.anchorId) {
        const el = c.querySelector<HTMLElement>(`[data-flip-id="${window.CSS.escape(saved.anchorId)}"]`);
        if (el) {
          const before = c.scrollTop;
          const cTop = c.getBoundingClientRect().top;
          c.scrollTop += (el.getBoundingClientRect().top - cTop) - saved.anchorDelta;
          alignFrames++;
          if (alignFrames < 8 && Math.abs(c.scrollTop - before) > 1) requestAnimationFrame(settle);
          return;
        }
        // Anchor not in the DOM (yet): fall through to the raw-offset wait —
        // if the content is still loading the anchor may appear on a later
        // frame and the branch above takes over.
      }
      const reachable = c.scrollHeight - c.clientHeight >= saved.scrollTop - 1;
      if (reachable || attempts >= MAX_FRAMES) {
        c.scrollTop = saved.scrollTop;
        return;
      }
      requestAnimationFrame(settle);
    };
    // Double rAF: first waits for React commit, second for layout/paint.
    requestAnimationFrame(() => requestAnimationFrame(settle));
  }, []);

  const resetScrollToTop = useCallback(() => {
    if (!scrollContainerRef.current) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = 0;
        }
      });
    });
  }, []);

  // Monotonic id of the newest loadView call — older in-flight loads bail
  // instead of committing stale results over the current view.
  const loadSeqRef = useRef(0);

  const loadView = useCallback(
    async (
      view: ViewSpec,
      parentId: number | null,
      breadcrumb: BreadcrumbItem[],
      restoreScroll: boolean = true,
      // When true, skip the pre-fetch "clear grid + show spinner" dance. Use for same-view
      // refreshes (sort mode change, preset select/save/delete, in-place reorder refresh)
      // so the user doesn't see an empty flash while the fetch runs.
      inPlace: boolean = false,
    ) => {
      // Latest-wins guard: two loads can be in flight (fast navigation), and
      // the OLDER fetch resolving last would stomp the newer view's grid —
      // e.g. the Artists page rendering album entries. Every await below must
      // re-check before committing state.
      const seq = ++loadSeqRef.current;
      const stale = () => loadSeqRef.current !== seq;
      // Genres produce their own result type. (Display is intentionally basic for now — iterating.)
      if (view.kind === "genres") {
        setEntries([]);
        setPeople(null);
        setPlaylists(null);
        const cached = genresCacheRef.current.get(view.libraryId);
        if (cached) {
          setGenres(cached);
          setBreadcrumbs(breadcrumb);
          if (restoreScroll) restoreScrollPosition(view.libraryId, scrollKindFor(view), breadcrumb[breadcrumb.length - 1]?.id ?? null);
          else resetScrollToTop();
          return;
        }
        setBreadcrumbs(breadcrumb);
        setGenres(null);
        setLoading(true);
        try {
          const res = await invoke<GenreSummary[]>("get_genres_in_library", {
            libraryId: view.libraryId,
          });
          genresCacheRef.current.set(view.libraryId, res);
          if (stale()) return;
          setGenres(res);
          if (restoreScroll) restoreScrollPosition(view.libraryId, scrollKindFor(view), breadcrumb[breadcrumb.length - 1]?.id ?? null);
          else resetScrollToTop();
        } catch (e) {
          console.error("Failed to load genres:", e);
        } finally {
          setLoading(false);
        }
        return;
      }

      // These views fetch their own data inside their page components
      // (HomePage / MusicIssuesPage / TracksPage) — just clear grid state.
      // Scroll restores like any grid (the restore waits out the self-fetch);
      // Home is libraryless and keys under a fixed "home" prefix.
      if (view.kind === "home" || view.kind === "music-issues" || view.kind === "tracks" || view.kind === "loose-tracks") {
        setEntries([]);
        setPeople(null);
        setPlaylists(null);
        setGenres(null);
        setBreadcrumbs(breadcrumb);
        if (restoreScroll) {
          restoreScrollPosition(
            view.kind === "home" ? "home" : view.libraryId,
            scrollKindFor(view),
            breadcrumb[breadcrumb.length - 1]?.id ?? null,
          );
        } else {
          resetScrollToTop();
        }
        return;
      }

      // people-list / people-all and playlists produce their own result types; everything else lands as MediaEntry[].
      if (view.kind === "people-list" || view.kind === "people-all") {
        const key = viewCacheKey(view);
        const cached = peopleCacheRef.current.get(key);
        setEntries([]);
        setPlaylists(null);
        setGenres(null);
        if (cached) {
          setPeople(cached);
          setBreadcrumbs(breadcrumb);
          if (restoreScroll) restoreScrollPosition(view.libraryId, scrollKindFor(view), null);
          else resetScrollToTop();
          return;
        }
        // Update breadcrumb and clear the stale people list *before* awaiting the fetch,
        // so the loading spinner appears under the new breadcrumb instead of the previous view's.
        setBreadcrumbs(breadcrumb);
        setPeople(null);
        setLoading(true);
        try {
          const role = view.kind === "people-all" ? "all" : view.role;
          const res = await invoke<PersonSummary[]>("get_people_in_library", {
            libraryId: view.libraryId,
            role,
          });
          // Decode-gate only the first screenfuls of the default "Most credited"
          // ranking; everything below (and the A–Z view) lazy-loads on scroll.
          const topFaces = [...res]
            .sort((a, b) => b.work_count - a.work_count)
            .slice(0, 100)
            .map((p) => p.image_path);
          await preloadImages(topFaces);
          peopleCacheRef.current.set(key, res);
          if (stale()) return;
          setPeople(res);
          if (restoreScroll) restoreScrollPosition(view.libraryId, scrollKindFor(view), null);
          else resetScrollToTop();
        } catch (e) {
          console.error("Failed to load people:", e);
        } finally {
          setLoading(false);
        }
        return;
      }

      if (view.kind === "playlists") {
        const key = viewCacheKey(view);
        const cached = playlistsCacheRef.current.get(key);
        setEntries([]);
        setPeople(null);
        setGenres(null);
        setSortMode(playlistsSortModeRef.current);
        if (cached) {
          setPlaylists(cached.playlists);
          setPresets(cached.presets);
          setSelectedPresetId(cached.selectedPresetId);
          setBreadcrumbs(breadcrumb);
          if (restoreScroll) restoreScrollPosition(view.libraryId, scrollKindFor(view), breadcrumb[breadcrumb.length - 1]?.id ?? null);
          else resetScrollToTop();
          return;
        }
        setBreadcrumbs(breadcrumb);
        // In-place refreshes (sort change) keep the current cards visible while
        // the re-sorted list loads — same no-spinner behavior as the entry grids.
        if (!inPlace) {
          setPlaylists(null);
          setLoading(true);
        }
        try {
          const res = await invoke<PlaylistsResponse>("get_playlists", {
            libraryId: view.libraryId,
            sortMode: playlistsSortModeRef.current,
          });
          await preloadImages(res.playlists.map((pl) => pl.selected_cover));
          playlistsCacheRef.current.set(key, {
            playlists: res.playlists,
            presets: res.presets,
            selectedPresetId: res.selected_preset_id,
          });
          if (stale()) return;
          setPlaylists(res.playlists);
          setPresets(res.presets);
          setSelectedPresetId(res.selected_preset_id);
          if (!inPlace) {
            if (restoreScroll) restoreScrollPosition(view.libraryId, scrollKindFor(view), breadcrumb[breadcrumb.length - 1]?.id ?? null);
            else resetScrollToTop();
          }
        } catch (e) {
          console.error("Failed to load playlists:", e);
        } finally {
          setLoading(false);
        }
        return;
      }

      // All remaining views populate `entries`.
      setPeople(null);
      setPlaylists(null);
      setGenres(null);

      // library-root keeps the legacy parent-keyed cache so existing invalidate/update calls still work.
      const useRootCache = view.kind === "library-root";
      const cacheKey = useRootCache
        ? `${view.libraryId}:${parentId}`
        : viewCacheKey(view);
      const cache = useRootCache ? entryCacheRef.current : viewEntriesCacheRef.current;

      const cached = cache.get(cacheKey);
      if (cached) {
        setEntries(cached.entries);
        setSortMode(cached.sort_mode);
        setSelectedPresetId(cached.selected_preset_id);
        setPresets(cached.presets);
        setLooseCount(cached.loose_count ?? null);
        setBreadcrumbs(breadcrumb);
        if (restoreScroll) restoreScrollPosition(view.libraryId, scrollKindFor(view), breadcrumb[breadcrumb.length - 1]?.id ?? null);
        else resetScrollToTop();
        return;
      }

      // Update breadcrumb and clear the stale grid *before* awaiting the fetch, so the
      // spinner shows under the new breadcrumb instead of leaking the previous view's state.
      // Skipped for `inPlace` refreshes so the current grid stays visible until the new data lands.
      if (!inPlace) {
        setBreadcrumbs(breadcrumb);
        setEntries([]);
        setLoading(true);
        // A stale count from the previous grid must not linger under the
        // spinner — the button reappears with the new grid's data.
        setLooseCount(null);
        // This view's persisted sort rides in the response — until it lands the
        // mode is UNKNOWN, and showing the previous view's (or the "alpha"
        // default) flashes a wrong label in the toolbar. "" renders as a
        // placeholder in the sort dropdowns.
        setSortMode("");
      }
      try {
        let entries: MediaEntry[];
        let sort_mode: string;
        let selected_preset_id: number | null = null;
        let view_presets: SortPreset[] = [];
        let loose_count: number | null = null;
        switch (view.kind) {
          case "library-root": {
            const res = await invoke<EntriesResponse>("get_entries", {
              libraryId: view.libraryId,
              parentId,
            });
            entries = res.entries;
            sort_mode = res.sort_mode;
            selected_preset_id = res.selected_preset_id;
            view_presets = res.presets;
            break;
          }
          case "movies-only":
          case "shows-only":
          case "albums":
          case "sounds": {
            const res = await invoke<EntriesResponse>("get_entries", {
              libraryId: view.libraryId,
              parentId: null,
              entryTypeFilter:
                view.kind === "movies-only" ? "movie"
                : view.kind === "shows-only" ? "show"
                : view.kind === "sounds" ? "sound"
                : "album",
            });
            entries = res.entries;
            sort_mode = res.sort_mode;
            selected_preset_id = res.selected_preset_id;
            view_presets = res.presets;
            loose_count = res.loose_count ?? null;
            break;
          }
          case "person-detail": {
            // Always show the person's ENTIRE filmography, not just the works
            // relevant to the page they were clicked from (Actors/D&C/Composers).
            entries = await invoke<MediaEntry[]>("get_entries_for_person", {
              libraryId: view.libraryId,
              personId: view.personId,
              role: "all",
            });
            sort_mode = "alpha";
            break;
          }
          case "genre-detail": {
            entries = await invoke<MediaEntry[]>("get_entries_for_genre", {
              libraryId: view.libraryId,
              genre: view.genre,
            });
            sort_mode = "alpha";
            break;
          }
          case "playlist-detail": {
            const res = await invoke<PlaylistContents>("get_playlist_contents", {
              playlistId: view.playlistId,
              parentCollectionId: view.collectionId,
            });
            entries = res.entries;
            sort_mode = res.sort_mode;
            selected_preset_id = res.selected_preset_id;
            view_presets = res.presets;
            break;
          }
        }
        await preloadCovers(entries);
        cache.set(cacheKey, { entries, sort_mode, selected_preset_id, presets: view_presets, loose_count });
        if (stale()) return;
        setEntries(entries);
        setSortMode(sort_mode);
        setSelectedPresetId(selected_preset_id);
        setPresets(view_presets);
        setLooseCount(loose_count);
        // In-place refreshes never touch the scroll: the grid stayed mounted and
        // the user may be mid-page — restoring a stale saved offset would jump.
        if (!inPlace) {
          if (restoreScroll) restoreScrollPosition(view.libraryId, scrollKindFor(view), breadcrumb[breadcrumb.length - 1]?.id ?? null);
          else resetScrollToTop();
        }
      } catch (e) {
        console.error("Failed to load view:", e);
      } finally {
        setLoading(false);
      }
    },
    [restoreScrollPosition, resetScrollToTop, preloadCovers, preloadImages, scrollKindFor]
  );

  // Thin wrapper for the existing call sites that drive library-root navigation by (library, parentId).
  const loadEntries = useCallback(
    (library: Library, parentId: number | null, breadcrumb: BreadcrumbItem[]) =>
      loadView({ kind: "library-root", libraryId: library.id }, parentId, breadcrumb),
    [loadView]
  );

  // ── History-true back/forward ──────────────────────────────────────────────
  // Navigation history is a stack of visited-page SNAPSHOTS (view + detail
  // entry + breadcrumb chain + search text). Every navigation handler pushes
  // the page it is LEAVING; back/forward restore snapshots wholesale — "where
  // you actually were", not a walk of the breadcrumb hierarchy. Breadcrumbs
  // are pure location display (and clickable shortcuts — a crumb click is
  // just another navigation).
  const navStateRef = useRef<NavSnapshot>({ view: null, entry: null, crumbs: [], search: "" });
  useEffect(() => {
    navStateRef.current = { view: activeView, entry: selectedEntry, crumbs: breadcrumbs, search };
  }, [activeView, selectedEntry, breadcrumbs, search]);

  const historyRef = useRef<NavSnapshot[]>([]);
  const forwardHistRef = useRef<NavSnapshot[]>([]);

  const pushHistory = useCallback(() => {
    const s = navStateRef.current;
    if (!s.view) return; // startup — nothing to return to
    const snap: NavSnapshot = { ...s, crumbs: [...s.crumbs] };
    // Handlers push before their own "already here" early-outs — dropping
    // identical consecutive snapshots keeps no-op navigations out of history.
    const top = historyRef.current[historyRef.current.length - 1];
    if (!top || snapKey(top) !== snapKey(snap)) {
      historyRef.current.push(snap);
      if (historyRef.current.length > 100) historyRef.current.shift();
    }
    forwardHistRef.current = [];
  }, []);

  const applySnapshot = useCallback(
    (snap: NavSnapshot) => {
      setSearch(snap.search);
      if (!snap.view) return;
      setActiveView(snap.view);
      if (snap.entry) {
        // Detail page: restore it directly (the page fetches its own data),
        // and quietly reload the grid behind it so later actions stay sane.
        setSelectedEntry(snap.entry);
        setBreadcrumbs(snap.crumbs);
        const parentId = snap.crumbs[snap.crumbs.length - 2]?.id ?? null;
        loadView(snap.view, parentId, snap.crumbs, false, true);
        // Detail pages scroll in the same container as grids and save under
        // the detail crumb's id — restore where the user left the PAGE
        // (the patient restore waits out the page's own data fetch).
        restoreScrollPosition(
          snap.view.libraryId ?? "home",
          scrollKindFor(snap.view),
          snap.crumbs[snap.crumbs.length - 1]?.id ?? null,
        );
      } else {
        setSelectedEntry(null);
        const last = snap.crumbs[snap.crumbs.length - 1];
        const parentId = last && !last.view ? last.id ?? null : null;
        loadView(snap.view, parentId, snap.crumbs, true);
      }
    },
    [loadView, restoreScrollPosition, scrollKindFor]
  );

  // Re-fetch the active grid's entries without touching breadcrumbs, navigating,
  // or flashing the loading state. Fires after detail-page edits and bulk TMDB
  // matching so the grid quietly catches up.
  const refreshGridInPlace = useCallback(async () => {
    if (!selectedLibrary || !activeView) return;
    const view = activeView;
    // With a detail page open, the grid behind it belongs to the breadcrumb one
    // above the detail entry; when browsing, the last breadcrumb IS the parent.
    const gridParentId = selectedEntry
      ? (breadcrumbs.length >= 2 ? breadcrumbs[breadcrumbs.length - 2]?.id ?? null : null)
      : breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
    try {
      let fresh: MediaEntry[] = [];
      let fresh_sort = sortMode;
      let fresh_selected_preset_id: number | null = null;
      let fresh_presets: SortPreset[] = [];
      if (view.kind === "library-root") {
        const res = await invoke<EntriesResponse>("get_entries", {
          libraryId: view.libraryId,
          parentId: gridParentId,
        });
        fresh = res.entries;
        fresh_sort = res.sort_mode;
        fresh_selected_preset_id = res.selected_preset_id;
        fresh_presets = res.presets;
        entryCacheRef.current.set(`${view.libraryId}:${gridParentId}`, {
          entries: fresh, sort_mode: fresh_sort,
          selected_preset_id: fresh_selected_preset_id, presets: fresh_presets,
        });
      } else if (view.kind === "movies-only" || view.kind === "shows-only" || view.kind === "albums" || view.kind === "sounds") {
        const res = await invoke<EntriesResponse>("get_entries", {
          libraryId: view.libraryId,
          parentId: null,
          entryTypeFilter:
            view.kind === "movies-only" ? "movie"
            : view.kind === "shows-only" ? "show"
            : view.kind === "sounds" ? "sound"
            : "album",
        });
        fresh = res.entries;
        fresh_sort = res.sort_mode;
        fresh_selected_preset_id = res.selected_preset_id;
        fresh_presets = res.presets;
        viewEntriesCacheRef.current.set(viewCacheKey(view), {
          entries: fresh, sort_mode: fresh_sort,
          selected_preset_id: fresh_selected_preset_id, presets: fresh_presets,
          loose_count: res.loose_count ?? null,
        });
        setLooseCount(res.loose_count ?? null);
      } else if (view.kind === "person-detail") {
        fresh = await invoke<MediaEntry[]>("get_entries_for_person", {
          libraryId: view.libraryId,
          personId: view.personId,
          role: view.role,
        });
        fresh_sort = "alpha";
        viewEntriesCacheRef.current.set(viewCacheKey(view), {
          entries: fresh, sort_mode: fresh_sort,
          selected_preset_id: null, presets: [],
        });
      } else if (view.kind === "genre-detail") {
        // Detail pages opened from a genre grid live under this view; without a
        // refresh here a cover downloaded on such a page never reaches
        // selectedEntry (and the change-cover dialog reads covers off it).
        fresh = await invoke<MediaEntry[]>("get_entries_for_genre", {
          libraryId: view.libraryId,
          genre: view.genre,
        });
        fresh_sort = "alpha";
        viewEntriesCacheRef.current.set(viewCacheKey(view), {
          entries: fresh, sort_mode: fresh_sort,
          selected_preset_id: null, presets: [],
        });
      } else if (view.kind === "playlist-detail") {
        // A playlist grid renders media-link entries; their cover pool comes from
        // the same cached_images source as the library grid, so a cover added on a
        // detail page must refresh here too — otherwise the link entry keeps its
        // stale `covers` array and the new cover never appears as an option.
        const res = await invoke<PlaylistContents>("get_playlist_contents", {
          playlistId: view.playlistId,
          parentCollectionId: view.collectionId,
        });
        fresh = res.entries;
        fresh_sort = res.sort_mode;
        fresh_selected_preset_id = res.selected_preset_id;
        fresh_presets = res.presets;
        viewEntriesCacheRef.current.set(viewCacheKey(view), {
          entries: fresh, sort_mode: fresh_sort,
          selected_preset_id: fresh_selected_preset_id, presets: fresh_presets,
        });
      } else {
        return; // people-list doesn't render a media entry grid
      }
      await preloadCovers(fresh);
      setEntries(fresh);
      setSortMode(fresh_sort);
      setSelectedPresetId(fresh_selected_preset_id);
      setPresets(fresh_presets);
      // The open detail page (and its cover dialog) reads covers/year off
      // selectedEntry — patch it from the fresh list so e.g. a newly downloaded
      // cover shows up in the options without a restart. Same for the entry
      // snapshots breadcrumb crumbs carry for detail-page restore.
      setSelectedEntry((prev) => (prev && fresh.find((e) => e.id === prev.id)) || prev);
      setBreadcrumbs((prev) =>
        prev.map((c) => {
          const updated = c.entry ? fresh.find((e) => e.id === c.entry!.id) : undefined;
          return updated ? { ...c, entry: updated } : c;
        }),
      );
      // Search results are a parallel list over the same entries — refresh their
      // copies too (skipping link-backed rows, whose covers are pinned per link).
      setSearchResults((prev) =>
        prev
          ? prev.map((e) => fresh.find((f) => f.id === e.id && f.link_id == null) ?? e)
          : prev,
      );
    } catch (e) {
      console.error("Failed to refresh grid:", e);
    }
  }, [selectedLibrary, activeView, breadcrumbs, sortMode, preloadCovers, selectedEntry]);

  const selectLibrary = useCallback(
    (library: Library) => {
      // Unfinished imports aren't browsable — the sidebar routes their clicks
      // into the wizard; this guards the launch-default path too.
      if (library.setup_stage) return;
      // Sidebar library clicks land at the top like other sidebar switches.
      const view: ViewSpec = { kind: "library-root", libraryId: library.id };
      setActiveView(view);
      setSelectedEntry(null);
      setSearch("");
      pushHistory();
      // Clicking the library header lands on library-root. The top-level breadcrumb
      // always bakes the library name into its label so the user sees "<lib> - All".
      const libRoot: ViewSpec = { kind: "library-root", libraryId: library.id };
      loadView(view, null, [
        { id: null, title: `${library.name} - ${library.format === "music" ? "Artists" : "All"}`, view: libRoot },
      ], false);
    },
    [loadView]
  );

  // The Home hub — a pseudo-library pinned above the real ones. Renders its
  // own page (continue watching + recently played), no entries to load.
  const openHome = useCallback(() => {
    saveScrollPosition(); // the page being left, for its return trip
    const view: ViewSpec = { kind: "home" };
    setActiveView(view);
    setSelectedEntry(null);
    setSearch("");
    pushHistory();
    setBreadcrumbs([{ id: null, title: "Home", view }]);
  }, [saveScrollPosition]);

  // Libraries with a scan/rescan in flight. Mid-scan the DB is genuinely
  // inconsistent (albums reconciling, tracks reparenting), so these libraries
  // lock in the sidebar and anyone browsing one gets bounced to Home. Driven
  // by backend scan-state beacons so EVERY scan entry point (wizard create,
  // wizard rescan, grid context menu, combine-albums, manage-folders) counts.
  const [scanningLibs, setScanningLibs] = useState<Set<string>>(new Set());
  useEffect(() => {
    const unlisten = listen<{ libraryId: string; state: string }>("scan-state", (event) => {
      const { libraryId, state: scanState } = event.payload;
      setScanningLibs((prev) => {
        const next = new Set(prev);
        if (scanState === "started") next.add(libraryId);
        else next.delete(libraryId);
        return next;
      });
      if (scanState === "started") {
        const v = navStateRef.current.view;
        if (v && "libraryId" in v && v.libraryId === libraryId) openHome();
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [openHome]);

  // A matching pass rewrites albums, artists and credits as it runs, so the
  // library it's working on is locked exactly like a scanning one: bounce out
  // of it when a pass starts, and let the sidebar render it as busy. Without
  // this, minimizing the match modal left the library fully browsable and
  // editable underneath a live pass.
  const [passLibs, setPassLibs] = useState<Set<string>>(new Set());
  useEffect(() => {
    const unIter = listen<{ libraryId: string }>("music-enrich-iteration", (e) => {
      const { libraryId } = e.payload;
      setPassLibs((prev) => (prev.has(libraryId) ? prev : new Set(prev).add(libraryId)));
      const v = navStateRef.current.view;
      if (v && "libraryId" in v && v.libraryId === libraryId) openHome();
    });
    const unDone = listen<{ libraryId: string }>("music-enrich-done", (e) => {
      setPassLibs((prev) => {
        if (!prev.has(e.payload.libraryId)) return prev;
        const next = new Set(prev);
        next.delete(e.payload.libraryId);
        return next;
      });
    });
    return () => {
      unIter.then((fn) => fn());
      unDone.then((fn) => fn());
    };
  }, [openHome]);

  // The metadata centers read (and write) the library they're showing —
  // mid-scan that data is the same inconsistent state the grids get bounced
  // off of, so they close too. Catches both directions: a rescan starting
  // under an open center (split from the standalone center, backed-out
  // wizard) and opening a center onto an already-scanning library.
  useEffect(() => {
    if (mbReviewLibraryId && scanningLibs.has(mbReviewLibraryId)) {
      setMbReviewLibraryId(null);
    }
    if (videoCenterLibraryId && scanningLibs.has(videoCenterLibraryId)) {
      setVideoCenterLibraryId(null);
    }
  }, [scanningLibs, mbReviewLibraryId, videoCenterLibraryId]);

  // Pending "Needs a decision" entries do NOT lock the library — the user
  // decided metadata questions are the metadata center's business, not a
  // toll booth on playback. The gate lives inside the center itself: while
  // decisions pend, its other panes (bar History) stay locked.

  // "Go to page" from a Home card — detail navigation that may cross into a
  // different library than whatever was last selected. Sets up the target
  // library's root as the crumb base; Back re-loads its grid via the crumb.
  // focusTrackId (album navigations): scroll to that track and highlight it,
  // same one-shot request the now-playing bar's title link uses.
  const openEntryFromHome = useCallback(
    (libraryId: string, entry: MediaEntry, focusTrackId?: number) => {
      const lib = libraries.find((l) => l.id === libraryId);
      if (!lib || lib.setup_stage) return;
      if (scanningLibs.has(libraryId)) {
        // Say WHY the click did nothing — a silent no-op reads as broken.
        toast.info(`“${lib.name}” is rescanning — available again when it finishes.`);
        return;
      }
      saveScrollPosition(); // Home's scroll, for the return trip
      // Albums root under the Albums grid (that's what the tile was);
      // movies/shows root at the library's All.
      const root: ViewSpec =
        entry.entry_type === "album"
          ? { kind: "albums", libraryId }
          : { kind: "library-root", libraryId };
      const rootLabel =
        entry.entry_type === "album"
          ? `${lib.name} - Albums`
          : `${lib.name} - ${lib.format === "music" ? "Artists" : "All"}`;
      setActiveView(root);
      setSearch("");
      pushHistory();
      setSelectedEntry(entry);
      setBreadcrumbs([
        { id: null, title: rootLabel, view: root },
        { id: entry.id, title: entry.title, entry },
      ]);
      if (focusTrackId != null && entry.entry_type === "album") {
        musicFocusNonceRef.current += 1;
        setMusicFocusRequest({ albumId: entry.id, trackId: focusTrackId, nonce: musicFocusNonceRef.current });
      }
    },
    [libraries, saveScrollPosition, scanningLibs]
  );

  // Album-less recently-played tiles land on the LOOSE TRACKS page (their
  // album-side home) — scrolled to the track and highlighted. Chain roots
  // under Albums, matching the page's normal entrance.
  const openTrackFromHome = useCallback(
    (libraryId: string, trackId: number) => {
      const lib = libraries.find((l) => l.id === libraryId);
      if (!lib || lib.setup_stage) return;
      if (scanningLibs.has(libraryId)) {
        // Say WHY the click did nothing — a silent no-op reads as broken.
        toast.info(`“${lib.name}” is rescanning — available again when it finishes.`);
        return;
      }
      saveScrollPosition(); // Home's scroll, for the return trip
      const view: ViewSpec = { kind: "loose-tracks", libraryId, sounds: false };
      setActiveView(view);
      setSelectedEntry(null);
      setSearch("");
      pushHistory();
      setBreadcrumbs([
        {
          id: null,
          title: `${lib.name} - Albums`,
          view: { kind: "albums", libraryId },
          synthetic: true,
        },
        { id: null, title: "Loose tracks", view },
      ]);
      musicFocusNonceRef.current += 1;
      setTracksFocusRequest({ trackId, nonce: musicFocusNonceRef.current });
    },
    [libraries, saveScrollPosition, scanningLibs]
  );

  // Open the default library on launch, once libraries AND settings have both
  // loaded. One-shot: later library-list refreshes (rescan, create, delete)
  // must not yank navigation, and a user click always beats a slow settings read.
  // No user-set default → Home is the default.
  const didAutoSelectRef = useRef(false);
  useEffect(() => {
    if (didAutoSelectRef.current) return;
    if (defaultLibraryId === undefined || libraries.length === 0) return;
    didAutoSelectRef.current = true;
    if (activeView !== null) return;
    const lib = defaultLibraryId != null ? libraries.find((l) => l.id === defaultLibraryId) : undefined;
    if (lib) selectLibrary(lib);
    else openHome();
  }, [libraries, defaultLibraryId, activeView, selectLibrary, openHome]);

  // "Set as default" / "Unset as default" in a library's sidebar context menu.
  // Unset stores "" (settings rows are blanked, not deleted).
  const changeDefaultLibrary = useCallback((libraryId: string | null) => {
    setDefaultLibraryId(libraryId);
    invoke("set_setting", { key: "default_library_id", value: libraryId ?? "" }).catch(() => {});
  }, []);

  const selectView = useCallback(
    (view: ViewSpec) => {
      // Sidebar view switches intentionally discard scroll — they always land at the top.
      // Don't save outgoing scroll; pass restoreScroll=false so loadView resets to 0.
      // Also clear the forward stack so mouse-forward can't cross into a stale view's history.
      setActiveView(view);
      setSelectedEntry(null);
      setSearch("");
      pushHistory();
      const lib = libraries.find((l) => l.id === view.libraryId);
      const libLabel = lib?.name ?? "Library";
      // Top-level sidebar views render as a single "<library> - <section>" crumb; deeper
      // views keep their own sub-crumbs after. No standalone library button.
      const rootLabel = (kind: ViewSpec["kind"]): string => {
        const section =
          kind === "library-root" ? (lib?.format === "music" ? "Artists" : "All")
          : kind === "movies-only" ? "Movies"
          : kind === "shows-only" ? "TV"
          : kind === "people-all" || kind === "people-list" || kind === "person-detail" ? "People"
          : kind === "playlists" || kind === "playlist-detail" ? "Playlists"
          : kind === "genres" ? "Genres"
          : kind === "albums" ? "Albums"
          : kind === "sounds" ? "Sounds"
          : kind === "tracks" ? "Tracks"
          : kind === "music-issues" ? "Needs attention"
          : "";
        return section ? `${libLabel} - ${section}` : libLabel;
      };

      let chain: BreadcrumbItem[];
      if (view.kind === "people-all") {
        chain = [{ id: null, title: rootLabel("people-all"), view }];
      } else if (view.kind === "people-list") {
        // Role lists are top-level sections like Movies/TV: one "<lib> - Actors" crumb.
        const roleLabel =
          view.role === "actor" ? "Actors"
          : view.role === "director_creator" ? "Directors & Creators"
          : view.role === "composer" ? "Composers"
          : "People";
        chain = [{ id: null, title: `${libLabel} - ${roleLabel}`, view }];
      } else if (view.kind === "person-detail") {
        // Sidebar doesn't click person-detail directly; this branch is a safety net
        // for programmatic selectView() calls with person-detail. Use navigateToPerson for drilling.
        chain = [{ id: null, title: view.personName, view }];
      } else if (view.kind === "playlist-detail") {
        const playlistsRoot: ViewSpec = { kind: "playlists", libraryId: view.libraryId };
        chain = [
          { id: null, title: rootLabel("playlists"), view: playlistsRoot },
          { id: view.playlistId, title: view.playlistName, view },
        ];
      } else if (view.kind === "genre-detail") {
        const genresRoot: ViewSpec = { kind: "genres", libraryId: view.libraryId };
        chain = [
          { id: null, title: rootLabel("genres"), view: genresRoot },
          { id: null, title: view.genre, view },
        ];
      } else {
        chain = [{ id: null, title: rootLabel(view.kind), view }];
      }

      loadView(view, null, chain, false);
    },
    [libraries, loadView]
  );

  // Drill into a person-detail view while preserving the current breadcrumb chain.
  // Called from PeopleGrid — click on a card anywhere (Actors, People-all, Composers etc.)
  // appends this step so "People > Actors > Clark Gregg" is preserved on subsequent navigation.
  // ── Breadcrumb loop collapse ─────────────────────────────────────────────
  // Navigating to something already in the chain would grow it forever
  // (All > Movie A > Actor B > Movie A > …). Instead we keep the NEWEST tail —
  // preserving back-button recency — drop the old occurrence and everything
  // before it, and re-root the tail's first crumb at its canonical sidebar
  // location. So the chain above becomes People > Actors > Actor B > Movie A.

  // Canonical sidebar path for a crumb that ends up leading the chain. Crumbs are
  // flagged `synthetic` — the user didn't actually travel through them, which the
  // sidebar-highlight rule cares about.
  const canonicalPrefix = useCallback(
    (head: BreadcrumbItem, libraryId: string): BreadcrumbItem[] => {
      const libLabel = libraries.find((l) => l.id === libraryId)?.name ?? "Library";
      const v = head.view;
      if (v?.kind === "people-list") return []; // role lists are root crumbs themselves
      if (v?.kind === "person-detail") {
        if (v.role === "all") {
          return [{ id: null, title: `${libLabel} - People`, view: { kind: "people-all", libraryId }, synthetic: true }];
        }
        const roleLabel =
          v.role === "actor" ? "Actors"
          : v.role === "director_creator" ? "Directors & Creators"
          : "Composers";
        return [{ id: null, title: `${libLabel} - ${roleLabel}`, view: { kind: "people-list", libraryId, role: v.role }, synthetic: true }];
      }
      if (v?.kind === "playlist-detail") {
        const crumbs: BreadcrumbItem[] = [
          { id: null, title: `${libLabel} - Playlists`, view: { kind: "playlists", libraryId }, synthetic: true },
        ];
        if (v.collectionId !== null) {
          // Nested playlist-collection — keep the owning playlist in the path.
          crumbs.push({
            id: v.playlistId,
            title: v.playlistName,
            view: { kind: "playlist-detail", libraryId, playlistId: v.playlistId, playlistName: v.playlistName, collectionId: null },
            synthetic: true,
          });
        }
        return crumbs;
      }
      if (v?.kind === "genre-detail") {
        // Genre grids sit under the Genres root (like playlists under Playlists).
        return [{ id: null, title: `${libLabel} - Genres`, view: { kind: "genres", libraryId }, synthetic: true }];
      }
      if (v) return []; // other view kinds are already chain roots
      // Detail crumbs root under their type's section (TV > Breaking Bad reads
      // better than All > Breaking Bad); collections under the library's All root.
      // (Collection ancestors are deliberately not reconstructed.)
      if (head.entry?.entry_type === "movie") {
        return [{ id: null, title: `${libLabel} - Movies`, view: { kind: "movies-only", libraryId }, synthetic: true }];
      }
      if (head.entry?.entry_type === "show") {
        return [{ id: null, title: `${libLabel} - TV`, view: { kind: "shows-only", libraryId }, synthetic: true }];
      }
      if (head.entry?.entry_type === "album") {
        return [{ id: null, title: `${libLabel} - Albums`, view: { kind: "albums", libraryId }, synthetic: true }];
      }
      if (head.entry?.entry_type === "artist") {
        return [{ id: null, title: `${libLabel} - Artists`, view: { kind: "library-root", libraryId }, synthetic: true }];
      }
      return [{ id: null, title: `${libLabel} - All`, view: { kind: "library-root", libraryId }, synthetic: true }];
    },
    [libraries]
  );

  // Chain to build the new crumb on after a loop to chain[dupIndex] was detected.
  const collapseLoop = useCallback(
    (chain: BreadcrumbItem[], dupIndex: number, libraryId: string): BreadcrumbItem[] => {
      const tail = chain.slice(dupIndex + 1);
      if (tail.length === 0) return []; // duplicate was the last crumb — callers no-op before this
      return [...canonicalPrefix(tail[0], libraryId), ...tail];
    },
    [canonicalPrefix]
  );

  const navigateToPerson = useCallback(
    // Takes the minimal person shape — cast cards on detail pages navigate with
    // just {id, name, image_path}; only real PersonSummary rows know `favorite`.
    (person: PersonInfo, role: PersonRole) => {
      if (!selectedLibrary) return;
      const view: ViewSpec = {
        kind: "person-detail",
        libraryId: selectedLibrary.id,
        personId: person.id,
        role,
        personName: person.name,
        personImage: person.image_path,
      };
      const dupIndex = breadcrumbs.findIndex(
        (c) => c.view?.kind === "person-detail" && c.view.personId === person.id && c.view.role === role,
      );
      if (dupIndex !== -1 && dupIndex === breadcrumbs.length - 1) return; // already on this person
      // Save the outgoing scroll (e.g. position in a people grid) so back restores it.
      saveScrollPosition();
      const base = dupIndex === -1 ? breadcrumbs : collapseLoop(breadcrumbs, dupIndex, selectedLibrary.id);
      const newBreadcrumbs: BreadcrumbItem[] = [
        ...base,
        { id: person.id, title: person.name, view },
      ];
      setActiveView(view);
      setSelectedEntry(null);
      setSearch("");
      pushHistory();
      loadView(view, null, newBreadcrumbs, false);
    },
    [selectedLibrary, breadcrumbs, loadView, collapseLoop, saveScrollPosition]
  );

  // Drill into a playlist from the Playlists grid. Appends to the current breadcrumb chain
  // so clicking "Playlists" crumb returns to the list.
  const togglePersonFavorite = useCallback(async (person: PersonSummary) => {
    try {
      await invoke("set_person_favorite", { personId: person.id, favorite: !person.favorite });
      // Patch the live list in place; drop the people caches so the other role
      // views re-fetch with fresh favorite flags.
      setPeople((prev) =>
        prev ? prev.map((p) => (p.id === person.id ? { ...p, favorite: !person.favorite } : p)) : prev,
      );
      peopleCacheRef.current.clear();
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  const navigateToPlaylist = useCallback(
    (playlist: PlaylistSummary) => {
      if (!selectedLibrary) return;
      saveScrollPosition(); // remember the Playlists list scroll for the return trip
      const view: ViewSpec = {
        kind: "playlist-detail",
        libraryId: selectedLibrary.id,
        playlistId: playlist.id,
        playlistName: playlist.title,
        collectionId: null,
      };
      const newBreadcrumbs: BreadcrumbItem[] = [
        ...breadcrumbs,
        { id: playlist.id, title: playlist.title, view },
      ];
      setActiveView(view);
      setSelectedEntry(null);
      setSearch("");
      pushHistory();
      loadView(view, null, newBreadcrumbs, false);
    },
    [selectedLibrary, breadcrumbs, loadView, saveScrollPosition]
  );

  // Genre pages open IN CONTEXT: the genre crumb is appended to the current
  // chain, so a chip on a detail page reads "Lib - Movies > Cars > Comedy" and
  // the Genres view reads "Lib - Genres > Comedy" (its chain is the prefix).
  // Revisiting a genre already in the chain collapses the loop instead of
  // duplicating it ("Genres > SciFi > Godzilla > SciFi" becomes
  // "Movies > Godzilla > SciFi"). Sidebar genre nodes go through selectView
  // instead — fresh navigations keep the canonical "Lib - Genres > X" root.
  const navigateToGenre = useCallback(
    (libraryId: string, genre: string) => {
      const view: ViewSpec = { kind: "genre-detail", libraryId, genre };
      const dupIndex = breadcrumbs.findIndex(
        (c) => c.view?.kind === "genre-detail" && c.view.libraryId === libraryId && c.view.genre === genre,
      );
      if (dupIndex !== -1 && dupIndex === breadcrumbs.length - 1) return; // already on this genre
      saveScrollPosition(); // remember the source page's scroll for the return trip
      const base = dupIndex === -1 ? breadcrumbs : collapseLoop(breadcrumbs, dupIndex, libraryId);
      const newBreadcrumbs: BreadcrumbItem[] = [
        ...base,
        { id: null, title: genre, view },
      ];
      setActiveView(view);
      setSelectedEntry(null);
      setSearch("");
      pushHistory();
      loadView(view, null, newBreadcrumbs, false);
    },
    [breadcrumbs, loadView, collapseLoop, saveScrollPosition]
  );

  // Loose-tracks page (Albums/Sounds header button): appended to the current
  // chain like a genre — "Music - Albums > Loose tracks"; back returns to the
  // grid via the history stack.
  const openLooseTracks = useCallback(
    (libraryId: string, sounds: boolean) => {
      if (
        activeView?.kind === "loose-tracks" &&
        activeView.libraryId === libraryId &&
        activeView.sounds === sounds
      ) {
        return; // already there
      }
      saveScrollPosition();
      const view: ViewSpec = { kind: "loose-tracks", libraryId, sounds };
      const newBreadcrumbs: BreadcrumbItem[] = [
        ...breadcrumbs,
        { id: null, title: "Loose tracks", view },
      ];
      setActiveView(view);
      setSelectedEntry(null);
      setSearch("");
      pushHistory();
      loadView(view, null, newBreadcrumbs, false);
    },
    [activeView, breadcrumbs, loadView, saveScrollPosition]
  );

  // Loving a track changes the artists grid's loved AGGREGATES ("N loved"
  // subtitles, Most-loved order) which are baked into the cached grid.
  // Debounced refetch straight into the cache (and the live grid when the
  // artists page is the current view), so returning to the grid is instant
  // AND fresh. Listener attaches once; live state comes through a ref.
  const lovedCtxRef = useRef<{ lib: Library | null; view: ViewSpec | null }>({
    lib: null,
    view: null,
  });
  lovedCtxRef.current = { lib: selectedLibrary, view: activeView };
  useEffect(() => {
    let timer: number | undefined;
    let lastTrackId: number | null = null;
    const onLoved = (e: Event) => {
      lastTrackId = (e as CustomEvent<{ trackId: number }>).detail?.trackId ?? null;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const { lib } = lovedCtxRef.current;
        const target = lib && lib.format === "music" ? lib : null;
        if (!target) {
          // Loved from outside a music library (e.g. Home's recently played):
          // resolve the owning library and just drop its cached artists grid —
          // the next visit refetches fresh.
          if (lastTrackId == null) return;
          try {
            const libId = await invoke<string | null>("get_entry_library", {
              entryId: lastTrackId,
            });
            if (libId) entryCacheRef.current.delete(`${libId}:null`);
          } catch {
            /* best-effort */
          }
          return;
        }
        try {
          const res = await invoke<EntriesResponse>("get_entries", {
            libraryId: target.id,
            parentId: null,
          });
          entryCacheRef.current.set(`${target.id}:null`, {
            entries: res.entries,
            sort_mode: res.sort_mode,
            selected_preset_id: res.selected_preset_id,
            presets: res.presets,
          });
          const v = lovedCtxRef.current.view;
          if (v?.kind === "library-root" && v.libraryId === target.id) {
            setEntries(res.entries);
          }
        } catch {
          /* best-effort — worst case the grid stays a refetch behind */
        }
      }, 500);
    };
    window.addEventListener("waverunner:loved-changed", onLoved);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("waverunner:loved-changed", onLoved);
    };
  }, []);

  const navigateTo = useCallback(
    (entry: MediaEntry) => {
      if (!selectedLibrary) return;
      // Already on this exact detail page — a no-op that must not touch
      // history (the branch-level guards below are now just belt-and-braces).
      if (
        (entry.entry_type === "movie" ||
          entry.entry_type === "show" ||
          entry.entry_type === "artist" ||
          entry.entry_type === "album") &&
        breadcrumbs[breadcrumbs.length - 1]?.entry?.id === entry.id
      ) {
        return;
      }
      saveScrollPosition();
      pushHistory();

      // Playlist-collection nodes live inside a playlist view — drill within it by updating
      // the view's collectionId, so the breadcrumb chain reads "Playlists > PL > Star Wars".
      if (entry.entry_type === "playlist_collection" && activeView?.kind === "playlist-detail") {
        const newView: ViewSpec = {
          kind: "playlist-detail",
          libraryId: activeView.libraryId,
          playlistId: activeView.playlistId,
          playlistName: activeView.playlistName,
          collectionId: entry.id,
        };
        const newBreadcrumbs = [
          ...breadcrumbs,
          { id: entry.id, title: entry.title, view: newView },
        ];
        setActiveView(newView);
        setSelectedEntry(null);
        loadView(newView, null, newBreadcrumbs, false);
        return;
      }

      // Opening an album from its artist page APPENDS to the chain (the artist
      // crumb must survive: "Lib - Artists > Radiohead > Kid A"). The generic
      // detail branch below strips entry crumbs, which would eat the artist.
      if (
        entry.entry_type === "album" &&
        breadcrumbs[breadcrumbs.length - 1]?.entry?.entry_type === "artist"
      ) {
        if (breadcrumbs[breadcrumbs.length - 1]?.entry?.id === entry.id) return;
        setSelectedEntry(entry);
        setBreadcrumbs([...breadcrumbs, { id: entry.id, title: entry.title, entry }]);
        return;
      }

      if (
        entry.entry_type === "movie" ||
        entry.entry_type === "show" ||
        entry.entry_type === "artist" ||
        entry.entry_type === "album"
      ) {
        if (breadcrumbs[breadcrumbs.length - 1]?.entry?.id === entry.id) return; // already on this page
        // Views that render their own page (People/Genres/Playlists/Tracks/…)
        // early-return in MainContent without ever consulting selectedEntry —
        // a detail navigation from one of them (e.g. a now-playing bar link)
        // would update state but keep showing the old page. Retarget the view
        // at the library root so the detail page actually renders.
        if (
          activeView &&
          ["people-list", "people-all", "genres", "playlists", "tracks", "loose-tracks", "music-issues"].includes(
            activeView.kind,
          )
        ) {
          setActiveView({ kind: "library-root", libraryId: selectedLibrary.id });
        }
        // Opening a detail page RESETS the chain to the current location's canonical
        // path: drop all history before the current view's crumb, re-root that crumb
        // at its sidebar home, append the movie. Without this, alternating
        // movie → person → movie grows the chain without bound. Collection drill-ins
        // survive because their crumbs sit after the view crumb (All > Coll > Movie).
        let lastViewIdx = -1;
        for (let i = breadcrumbs.length - 1; i >= 0; i--) {
          if (breadcrumbs[i].view) { lastViewIdx = i; break; }
        }
        // Drop detail crumbs from the location tail too — e.g. jumping movie-to-movie
        // via search shouldn't leave the old movie's crumb mid-chain.
        const location = (lastViewIdx === -1 ? breadcrumbs : breadcrumbs.slice(lastViewIdx)).filter((c) => !c.entry);
        const base = lastViewIdx === -1 || location.length === 0
          ? breadcrumbs.filter((c) => !c.entry)
          : [...canonicalPrefix(location[0], selectedLibrary.id), ...location];
        // `entry` on the crumb marks it as a detail page for breadcrumb/back navigation.
        setSelectedEntry(entry);
        setBreadcrumbs([...base, { id: entry.id, title: entry.title, entry }]);
      } else if (entry.entry_type === "collection") {
        const dupIndex = breadcrumbs.findIndex((c) => !c.view && !c.entry && c.id === entry.id);
        if (dupIndex !== -1 && dupIndex === breadcrumbs.length - 1) return; // already here
        const base = dupIndex === -1 ? breadcrumbs : collapseLoop(breadcrumbs, dupIndex, selectedLibrary.id);
        setSelectedEntry(null);
        loadEntries(selectedLibrary, entry.id, [...base, { id: entry.id, title: entry.title }]);
      }
    },
    [selectedLibrary, breadcrumbs, activeView, loadEntries, loadView, saveScrollPosition, collapseLoop]
  );

  // Now-playing cover docked up into the sidebar (session state — the bar's
  // up/down arrow toggles it; art follows the current track automatically).
  const [musicCoverDocked, setMusicCoverDocked] = useState(false);

  // One-shot "scroll to this track and highlight it" request for the album
  // page, minted by the now-playing bar's title link. The nonce makes every
  // click a fresh request (re-clicking while already on the page re-scrolls).
  const musicFocusNonceRef = useRef(0);
  const [musicFocusRequest, setMusicFocusRequest] = useState<{
    albumId: number;
    trackId: number;
    nonce: number;
  } | null>(null);

  // Same one-shot idea for the TRACKS page (album-less tracks from Home).
  const [tracksFocusRequest, setTracksFocusRequest] = useState<{
    trackId: number;
    nonce: number;
  } | null>(null);

  // Bar links must work from ANYWHERE — another library's pages, Home — so
  // they resolve the entry's owning library first and switch context when it
  // isn't the selected one. (navigateTo assumes the entry belongs to
  // selectedLibrary; fed a music entry while a video library is selected it
  // threads music crumbs onto the video chain — "Videos - Genres > Album".)
  const openMusicEntryFromBar = useCallback(
    async (entry: MediaEntry) => {
      let libId: string | null = null;
      try {
        libId = await invoke<string | null>("get_entry_library", { entryId: entry.id });
      } catch {
        /* resolution is best-effort; fall through to the no-op below */
      }
      if (!libId) return; // entry vanished (rescan) — dead click beats a broken page
      if (selectedLibrary?.id === libId) {
        navigateTo(entry);
        return;
      }
      // Cross-library jump (or from Home): open the detail page on a canonical
      // chain rooted in the music library ("Music - Artists > X") — the same
      // shape navigateTo builds when that library is already selected.
      saveScrollPosition();
      pushHistory();
      const crumb: BreadcrumbItem = { id: entry.id, title: entry.title, entry };
      setActiveView({
        kind: entry.entry_type === "album" ? "albums" : "library-root",
        libraryId: libId,
      });
      setSelectedEntry(entry);
      setSearch("");
      setBreadcrumbs([...canonicalPrefix(crumb, libId), crumb]);
    },
    [selectedLibrary, navigateTo, canonicalPrefix, saveScrollPosition, pushHistory]
  );

  const openMusicAlbumFromBar = useCallback(
    (albumId: number, albumTitle: string, trackId?: number) => {
      if (trackId != null) {
        musicFocusNonceRef.current += 1;
        setMusicFocusRequest({ albumId, trackId, nonce: musicFocusNonceRef.current });
      }
      void openMusicEntryFromBar(fakeMusicEntry("album", albumId, albumTitle));
    },
    [openMusicEntryFromBar]
  );

  const openMusicArtistFromBar = useCallback(
    (artistId: number, artistName: string) => {
      void openMusicEntryFromBar(fakeMusicEntry("artist", artistId, artistName));
    },
    [openMusicEntryFromBar]
  );

  const navigateBreadcrumb = useCallback(
    (index: number) => {
      if (!selectedLibrary) return;
      saveScrollPosition();
      pushHistory();
      const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
      const target = newBreadcrumbs[newBreadcrumbs.length - 1];
      if (target.view) {
        // Distinct view step — restore it.
        setSelectedEntry(null);
        setActiveView(target.view);
        loadView(target.view, null, newBreadcrumbs, true);
      } else if (target.entry) {
        // Movie/show detail crumb (e.g. clicked back to a movie from a cast member's
        // page). Restore the detail page and the view that owns the grid behind it,
        // then quietly reload that grid so a later back lands somewhere sane.
        const ownerView =
          [...newBreadcrumbs].reverse().find((c) => c.view)?.view ??
          ({ kind: "library-root", libraryId: selectedLibrary.id } as ViewSpec);
        const parentId = newBreadcrumbs[newBreadcrumbs.length - 2]?.id ?? null;
        setSelectedEntry(target.entry);
        setActiveView(ownerView);
        setBreadcrumbs(newBreadcrumbs);
        loadView(ownerView, parentId, newBreadcrumbs, false, true);
      } else {
        // Drill-in within the current view (e.g. a collection chain in library-root).
        setSelectedEntry(null);
        loadEntries(selectedLibrary, target.id, newBreadcrumbs);
      }
    },
    [selectedLibrary, breadcrumbs, loadView, loadEntries, saveScrollPosition]
  );

  // History-true: pop a visited-page snapshot and restore it exactly. The
  // page being left goes onto the opposite stack, so back/forward are
  // symmetric — and neither cares what the breadcrumbs claim.
  const goBack = useCallback(() => {
    if (historyRef.current.length === 0) return;
    saveScrollPosition();
    const cur = navStateRef.current;
    if (cur.view) forwardHistRef.current.push({ ...cur, crumbs: [...cur.crumbs] });
    const snap = historyRef.current.pop()!;
    applySnapshot(snap);
  }, [saveScrollPosition, applySnapshot]);

  const goForward = useCallback(() => {
    if (forwardHistRef.current.length === 0) return;
    saveScrollPosition();
    const cur = navStateRef.current;
    if (cur.view) historyRef.current.push({ ...cur, crumbs: [...cur.crumbs] });
    const snap = forwardHistRef.current.pop()!;
    applySnapshot(snap);
  }, [saveScrollPosition, applySnapshot]);

  const invalidateCache = useCallback((libraryId?: string, parentId?: number | null) => {
    if (libraryId != null && parentId !== undefined) {
      entryCacheRef.current.delete(`${libraryId}:${parentId}`);
      // Filtered views (movies-only/shows-only/person-detail) flatten across the library,
      // so any parent-scoped mutation can leave them stale. Wipe them for this library.
      // People and playlists caches likewise aggregate across all entries — a TMDB apply
      // that adds new people should surface them in the sidebar people views without F5.
      const prefix = `${libraryId}:`;
      for (const key of viewEntriesCacheRef.current.keys()) {
        if (key.startsWith(prefix)) viewEntriesCacheRef.current.delete(key);
      }
      for (const key of peopleCacheRef.current.keys()) {
        if (key.startsWith(prefix)) peopleCacheRef.current.delete(key);
      }
      for (const key of playlistsCacheRef.current.keys()) {
        if (key.startsWith(prefix)) playlistsCacheRef.current.delete(key);
      }
      genresCacheRef.current.delete(libraryId);
    } else if (libraryId != null) {
      // Invalidate everything for this library across all view caches.
      const prefix = `${libraryId}:`;
      for (const key of entryCacheRef.current.keys()) {
        if (key.startsWith(prefix)) entryCacheRef.current.delete(key);
      }
      for (const key of viewEntriesCacheRef.current.keys()) {
        if (key.startsWith(prefix)) viewEntriesCacheRef.current.delete(key);
      }
      for (const key of peopleCacheRef.current.keys()) {
        if (key.startsWith(prefix)) peopleCacheRef.current.delete(key);
      }
      for (const key of playlistsCacheRef.current.keys()) {
        if (key.startsWith(prefix)) playlistsCacheRef.current.delete(key);
      }
      genresCacheRef.current.delete(libraryId);
    } else {
      entryCacheRef.current.clear();
      viewEntriesCacheRef.current.clear();
      peopleCacheRef.current.clear();
      playlistsCacheRef.current.clear();
      genresCacheRef.current.clear();
    }
  }, []);

  // The MusicBrainz matching pass is wizard/center-driven now (never a silent
  // background surprise). When one lands, quietly drop the library's caches
  // and refresh counts so MBID-backed data surfaces on the next view — the
  // wizard's review step / metadata center handle all user-facing follow-up.
  useEffect(() => {
    const unlisten = listen<{ libraryId: string }>("music-enrich-done", (event) => {
      invalidateCache(event.payload.libraryId);
      refreshMusicCountsFor(event.payload.libraryId);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [invalidateCache, refreshMusicCountsFor]);

  // A play just crossed the scrobble threshold — relay to the window event
  // the self-fetching pages listen on, so visible play counts tick without a
  // manual refresh.
  useEffect(() => {
    const unlisten = listen("music-scrobbled", () => {
      window.dispatchEvent(new Event("waverunner:track-scrobbled"));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);


  const updateCache = useCallback((libraryId: string, parentId: number | null, entries: MediaEntry[], sort_mode: string) => {
    // Merge with existing entry so preset metadata (selected_preset_id, presets) survives
    // mutations that don't touch preset state (rename, cover change, etc).
    const key = `${libraryId}:${parentId}`;
    const prev = entryCacheRef.current.get(key);
    entryCacheRef.current.set(key, {
      entries,
      sort_mode,
      selected_preset_id: prev?.selected_preset_id ?? null,
      presets: prev?.presets ?? [],
    });
  }, []);

  // Cache put that carries preset metadata forward from any existing entry at the same key.
  // Used by optimistic-update paths that don't know the fresh preset state.
  const cacheSetMerging = useCallback((
    cache: Map<string, { entries: MediaEntry[]; sort_mode: string; selected_preset_id: number | null; presets: SortPreset[] }>,
    key: string,
    entries: MediaEntry[],
    sort_mode: string,
  ) => {
    const prev = cache.get(key);
    cache.set(key, {
      entries,
      sort_mode,
      selected_preset_id: prev?.selected_preset_id ?? null,
      presets: prev?.presets ?? [],
    });
  }, []);

  // Invoked after any playlist-scoped mutation (create/rename/delete/add-link/remove-link).
  // Wipes caches, re-fetches the active view if it's a playlist-* view in this library,
  // and refreshes the sidebar's per-library playlist children.
  const handlePlaylistChanged = useCallback((libraryId: string) => {
    invalidateCache(libraryId);
    (async () => {
      try {
        const res = await invoke<PlaylistsResponse>("get_playlists", { libraryId });
        setSidebarPlaylists((prev) => ({ ...prev, [libraryId]: res.playlists }));
      } catch {
        // swallow
      }
    })();
    if (
      activeView &&
      activeView.libraryId === libraryId &&
      (activeView.kind === "playlists" || activeView.kind === "playlist-detail")
    ) {
      // playlist-detail refreshes IN PLACE: dropping a link into a collection
      // (or removing/moving one) must just shift the grid like the library
      // grids do — a full reload unmounts the grid and replays the page
      // drop-in, which reads as a flash.
      loadView(activeView, null, breadcrumbs, true, activeView.kind === "playlist-detail");
    }
  }, [activeView, breadcrumbs, invalidateCache, loadView]);

  const changeSortMode = useCallback(
    async (mode: string) => {
      if (!selectedLibrary) return;
      // Capture the current scroll BEFORE the reload. Library-root restores scroll
      // on an in-place sort refresh; without a fresh save it would restore a stale
      // value (the "jumps ~15-20% down" bug). Saving now means re-clicking the same
      // sort is a no-op and a real sort change keeps your top item in view.
      saveScrollPosition();

      // Playlists-LIST view: only alpha / custom (custom = manual sort_order). Held
      // in a ref; drop the cache and re-fetch so get_playlists re-sorts.
      if (activeView?.kind === "playlists") {
        playlistsSortModeRef.current = mode === "alpha" ? "alpha" : "custom";
        setSortMode(playlistsSortModeRef.current);
        invoke("set_setting", { key: `playlists_sort_mode:${selectedLibrary.id}`, value: playlistsSortModeRef.current }).catch(() => {});
        playlistsCacheRef.current.delete(viewCacheKey(activeView));
        loadView(activeView, null, breadcrumbs, true, true);
        return;
      }

      // Playlist-detail has its own per-level sort_mode storage (playlist root vs nested collection)
      // and its own vocabulary ("custom" | "alpha" | "date"). Route there instead of set_sort_mode.
      if (activeView?.kind === "playlist-detail") {
        try {
          if (activeView.collectionId !== null) {
            await invoke("set_playlist_collection_sort_mode", {
              collectionId: activeView.collectionId,
              mode,
            });
          } else {
            await invoke("set_playlist_sort_mode", {
              playlistId: activeView.playlistId,
              mode,
            });
          }
          setSortMode(mode);
          invalidateCache(selectedLibrary.id);
          loadView(activeView, null, breadcrumbs, true, true);
        } catch (e) {
          console.error("Failed to set playlist sort mode:", e);
        }
        return;
      }

      // Music Artists page: People-page-style sort vocabulary (alphabetical /
      // most credited / most loved) stored in a settings key. Sorting happens
      // LOCALLY — credits ride in child_count, loved counts are one cheap
      // fetch — so the switch is as instant as the People pages; the setting
      // persists in the background and the backend applies it on fresh loads.
      if (activeView?.kind === "library-root" && selectedLibrary.format === "music") {
        const next = mode === "credits" ? "credits" : mode === "loved" ? "loved" : "alpha";
        setSortMode(next);
        invoke("set_setting", { key: `music_artists_sort_mode:${selectedLibrary.id}`, value: next }).catch(() => {});
        const byTitle = (a: MediaEntry, b: MediaEntry) =>
          sortTitleKey(a.title).localeCompare(sortTitleKey(b.title));
        let lovedByArtist: Map<number, number> | null = null;
        if (next === "loved") {
          try {
            const rows = await invoke<[number, number][]>("get_artist_loved_counts", {
              libraryId: selectedLibrary.id,
            });
            lovedByArtist = new Map(rows);
          } catch (e) {
            console.error("Failed to load loved counts:", e);
            lovedByArtist = new Map();
          }
        }
        setEntries((prev) => {
          const sorted = [...prev].sort((a, b) =>
            next === "credits"
              ? b.child_count - a.child_count || byTitle(a, b)
              : next === "loved"
                ? (lovedByArtist!.get(b.id) ?? 0) - (lovedByArtist!.get(a.id) ?? 0) || byTitle(a, b)
                : byTitle(a, b),
          );
          updateCache(selectedLibrary.id, null, sorted, next);
          return sorted;
        });
        return;
      }

      // Music Albums page: its sort lives in a settings key — a music
      // library's default_sort_mode belongs to the Artists view, and writing
      // it from here would silently re-sort that page too. Sorting happens
      // LOCALLY (album entries carry sort_date), mirroring the backend's
      // order clauses — the reorder commits on the click frame, with no
      // refetch gap stuttering the start of the FLIP animation.
      if (activeView?.kind === "albums" || activeView?.kind === "sounds") {
        const next = mode === "date" || mode === "date-desc" ? mode : "alpha";
        setSortMode(next);
        const sortKey =
          activeView.kind === "sounds"
            ? `music_sounds_sort_mode:${selectedLibrary.id}`
            : `music_albums_sort_mode:${selectedLibrary.id}`;
        invoke("set_setting", { key: sortKey, value: next }).catch(() => {});
        const byTitle = (a: MediaEntry, b: MediaEntry) =>
          sortTitleKey(a.title).localeCompare(sortTitleKey(b.title));
        const cmp = (a: MediaEntry, b: MediaEntry): number => {
          if (next === "alpha") return byTitle(a, b);
          const ad = a.sort_date ?? null;
          const bd = b.sort_date ?? null;
          if (ad === null || bd === null) {
            // Undated albums sink to the bottom in both directions.
            return ad === bd ? byTitle(a, b) : ad === null ? 1 : -1;
          }
          if (ad !== bd) {
            return next === "date" ? (ad < bd ? -1 : 1) : ad < bd ? 1 : -1;
          }
          return byTitle(a, b);
        };
        const key = viewCacheKey(activeView);
        setEntries((prev) => {
          const sorted = [...prev].sort(cmp);
          const cached = viewEntriesCacheRef.current.get(key);
          if (cached) {
            viewEntriesCacheRef.current.set(key, { ...cached, entries: sorted, sort_mode: next });
          }
          return sorted;
        });
        return;
      }

      const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
      // Disambiguate library-root / movies-only / shows-only when entry_id is null — all three
      // currently share library.default_sort_mode + have their own *_sort_mode columns.
      const scopeKind =
        parentId !== null ? null
        : activeView?.kind === "movies-only" ? "movies-only"
        : activeView?.kind === "shows-only" ? "shows-only"
        : "library-root";
      try {
        await invoke("set_sort_mode", {
          libraryId: selectedLibrary.id,
          entryId: parentId,
          scopeKind,
          sortMode: mode,
        });
        setSortMode(mode);
        invalidateCache(selectedLibrary.id, parentId);
        // In-place refresh so the grid doesn't blank out during the sort_mode swap.
        loadView(activeView ?? { kind: "library-root", libraryId: selectedLibrary.id }, parentId, breadcrumbs, true, true);
      } catch (e) {
        console.error("Failed to set sort mode:", e);
      }
    },
    [selectedLibrary, activeView, breadcrumbs, loadEntries, loadView, invalidateCache, saveScrollPosition, updateCache]
  );

  const updateSortOrder = useCallback(
    async (reordered: MediaEntry[]) => {
      if (!selectedLibrary) return;
      setEntries(reordered);

      // Playlist views carry a mix of media_link and media_playlist_collection items,
      // so the wire format differs from the library's flat entry_ids list.
      if (activeView?.kind === "playlist-detail") {
        const key = viewCacheKey(activeView);
        cacheSetMerging(viewEntriesCacheRef.current, key, reordered, sortMode);
        const items = reordered.map((e) =>
          e.link_id != null
            ? { kind: "link", id: e.link_id }
            : { kind: "collection", id: e.id }
        );
        try {
          await invoke("update_playlist_sort_order", {
            playlistId: activeView.collectionId === null ? activeView.playlistId : null,
            parentCollectionId: activeView.collectionId,
            items,
          });
          // Mirror the backend's same-txn clear so the UI drops the preset selection immediately.
          setSelectedPresetId(null);
          const prev = viewEntriesCacheRef.current.get(key);
          if (prev) viewEntriesCacheRef.current.set(key, { ...prev, selected_preset_id: null });
        } catch (e) {
          console.error("Failed to update playlist sort order:", e);
          viewEntriesCacheRef.current.delete(key);
          loadView(activeView, null, breadcrumbs, true);
        }
        return;
      }

      const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
      const scopeKind =
        parentId !== null ? null
        : activeView?.kind === "movies-only" ? "movies-only"
        : activeView?.kind === "shows-only" ? "shows-only"
        : "library-root";
      updateCache(selectedLibrary.id, parentId, reordered, sortMode);
      try {
        await invoke("update_sort_order", {
          libraryId: selectedLibrary.id,
          entryId: parentId,
          scopeKind,
          entryIds: reordered.map((e) => e.id),
        });
        // Backend cleared selected_preset_id at this scope — mirror it in state + cache.
        setSelectedPresetId(null);
        const rootKey = `${selectedLibrary.id}:${parentId}`;
        const rootPrev = entryCacheRef.current.get(rootKey);
        if (rootPrev) entryCacheRef.current.set(rootKey, { ...rootPrev, selected_preset_id: null });
        if (activeView?.kind === "movies-only" || activeView?.kind === "shows-only") {
          const vk = viewCacheKey(activeView);
          const vp = viewEntriesCacheRef.current.get(vk);
          if (vp) viewEntriesCacheRef.current.set(vk, { ...vp, selected_preset_id: null });
        }
      } catch (e) {
        console.error("Failed to update sort order:", e);
        invalidateCache(selectedLibrary.id, parentId);
        loadEntries(selectedLibrary, parentId, breadcrumbs);
      }
    },
    [selectedLibrary, activeView, breadcrumbs, sortMode, loadEntries, loadView, invalidateCache, updateCache, cacheSetMerging]
  );

  // ── Custom sort presets ────────────────────────────────────────────
  // Every change goes through the backend which is scope-aware. Frontend refreshes from
  // the response's `presets` + `selected_preset_id` fields (read by loadView).

  const changePreset = useCallback(
    async (presetId: number | null) => {
      if (!activeView) return;
      const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
      const scopeKey = scopeKeyFor(activeView, parentId);
      if (!scopeKey) return;
      try {
        await invoke("set_selected_preset", { scopeKey, presetId });
        if (presetId !== null) {
          // Selecting a preset switches the scope into custom sort (the backend does the same) —
          // otherwise an "alpha" scope would hard-override the preset and ignore it. Mirror it
          // locally so the reload runs in custom; the playlists-LIST reads its mode from a ref.
          setSortMode("custom");
          if (activeView.kind === "playlists") playlistsSortModeRef.current = "custom";
        }
        invalidateCache(activeView.libraryId, parentId);
        loadView(activeView, parentId, breadcrumbs, true, true);
      } catch (e) {
        console.error("Failed to set selected preset:", e);
      }
    },
    [activeView, breadcrumbs, invalidateCache, loadView]
  );

  const savePreset = useCallback(
    async (name: string, overwrite: boolean) => {
      if (!activeView) return;
      const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
      const scopeKey = scopeKeyFor(activeView, parentId);
      if (!scopeKey) return;
      // Shape the items list based on the scope: library scopes → {kind:"entry",id}; playlist
      // scopes → {kind:"link",id} for media_link rows and {kind:"collection",id} for nested
      // playlist_collection rows; the playlists-LIST → {kind:"playlist",id} in current order.
      const items = activeView.kind === "playlists"
        ? (playlists ?? []).map((p) => ({ kind: "playlist", id: p.id }))
        : activeView.kind === "playlist-detail"
        ? entries.map((e) =>
            e.link_id != null
              ? { kind: "link", id: e.link_id }
              : { kind: "collection", id: e.id }
          )
        : entries.map((e) => ({ kind: "entry", id: e.id }));
      // Let "exists" bubble up so the caller (SortPresetSaveDialog) can prompt for overwrite.
      await invoke("save_sort_preset", { scopeKey, name, items, overwrite });
      invalidateCache(activeView.libraryId, parentId);
      loadView(activeView, parentId, breadcrumbs, true, true);
    },
    [activeView, breadcrumbs, entries, playlists, invalidateCache, loadView]
  );

  const deletePreset = useCallback(
    async (presetId: number) => {
      if (!activeView) return;
      const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
      try {
        await invoke("delete_sort_preset", { presetId });
        invalidateCache(activeView.libraryId, parentId);
        loadView(activeView, parentId, breadcrumbs, true, true);
      } catch (e) {
        console.error("Failed to delete preset:", e);
      }
    },
    [activeView, breadcrumbs, invalidateCache, loadView]
  );

  const applyTitleChange = useCallback((entryId: number, newTitle: string) => {
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, title: newTitle } : e)));
    setSelectedEntry((prev) => (prev && prev.id === entryId ? { ...prev, title: newTitle } : prev));
    setBreadcrumbs((prev) => prev.map((b) => (b.id === entryId ? { ...b, title: newTitle } : b)));
    // History snapshots hold their own crumb/entry copies — patch those too so
    // going back after a rename shows the new title.
    const patchStack = (stack: NavSnapshot[]) => {
      for (const s of stack) {
        s.crumbs = s.crumbs.map((b) => (b.id === entryId ? { ...b, title: newTitle } : b));
        if (s.entry && s.entry.id === entryId) s.entry = { ...s.entry, title: newTitle };
      }
    };
    patchStack(historyRef.current);
    patchStack(forwardHistRef.current);
  }, []);

  const renameEntry = useCallback(
    async (entryId: number, newTitle: string): Promise<string | null> => {
      if (!selectedLibrary) return "No library selected";
      try {
        await invoke("rename_entry", {
          libraryId: selectedLibrary.id,
          entryId,
          newTitle,
        });
        applyTitleChange(entryId, newTitle);
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        invalidateCache(selectedLibrary.id, parentId);
        return null;
      } catch (e) {
        return String(e);
      }
    },
    [selectedLibrary, breadcrumbs, invalidateCache, applyTitleChange]
  );

  const moveEntry = useCallback(
    async (entryId: number, newParentId: number | null, insertBeforeId: number | null, anchor?: { id: number; viewportTop: number }) => {
      if (!selectedLibrary) return;
      // When dropping INTO a collection, keep that collection pinned to exactly
      // where it sat at drop — every frame, from now until just after the reload
      // settles. The reload is async (two IPC round-trips), and during that gap
      // the scroll can otherwise drift to the source row (auto-scroll settling /
      // the moved card leaving the grid / FLIP), which shows as a flash before
      // the final position lands. Re-pinning each frame corrects it pre-paint.
      let pinning = anchor != null;
      const pinAnchor = () => {
        const c = scrollContainerRef.current;
        if (!c || !anchor) return;
        const el = c.querySelector<HTMLElement>(`[data-flip-id="${window.CSS.escape(String(anchor.id))}"]`);
        if (!el) return;
        const curTop = el.getBoundingClientRect().top - c.getBoundingClientRect().top;
        if (Math.abs(curTop - anchor.viewportTop) > 0.5) c.scrollTop += curTop - anchor.viewportTop;
      };
      const pinLoop = () => { if (pinning) { pinAnchor(); requestAnimationFrame(pinLoop); } };
      if (pinning) requestAnimationFrame(pinLoop);
      try {
        await invoke("move_entry", {
          libraryId: selectedLibrary.id,
          entryId,
          newParentId,
          insertBeforeId,
        });
        // Save scroll before reload (fallback for non-anchored moves)
        const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
        invalidateCache(selectedLibrary.id);
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        // Reload entries inline without showing spinner
        const res = await invoke<EntriesResponse>("get_entries", {
          libraryId: selectedLibrary.id,
          parentId,
        });
        await preloadCovers(res.entries);
        entryCacheRef.current.set(`${selectedLibrary.id}:${parentId}`, {
          entries: res.entries,
          sort_mode: res.sort_mode,
          selected_preset_id: res.selected_preset_id,
          presets: res.presets,
        });
        setEntries(res.entries);
        setSortMode(res.sort_mode);
        setSelectedPresetId(res.selected_preset_id);
        setPresets(res.presets);
        if (pinning) {
          // Let the reloaded grid paint, then stop pinning shortly after.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            window.setTimeout(() => { pinning = false; }, 150);
          }));
        } else {
          // Non-anchored move (e.g. move-up zone): just restore the raw scroll.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = scrollTop;
          }));
        }
      } catch (e) {
        pinning = false;
        console.error("Failed to move entry:", e);
        toast.error(String(e));
      }
    },
    [selectedLibrary, breadcrumbs, invalidateCache, preloadCovers]
  );

  const createCollection = useCallback(
    async (name: string): Promise<number | null> => {
      if (!selectedLibrary) return null;
      try {
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        const newId = await invoke<number>("create_collection", {
          libraryId: selectedLibrary.id,
          name,
          parentId,
        });
        invalidateCache(selectedLibrary.id, parentId);
        // Refresh the grid in place (no clear-and-reload) so the new collection
        // slides into its sorted slot while the existing cards animate down past
        // it via FLIP, instead of the whole grid flashing. In-place refresh also
        // leaves scroll untouched, so a lowercase name can't yank the viewport to
        // the ASCII-sorted tail (the bug the old saveScrollPosition guarded).
        await refreshGridInPlace();
        return newId;
      } catch (e) {
        toast.error(String(e));
        return null;
      }
    },
    [selectedLibrary, breadcrumbs, invalidateCache, refreshGridInPlace]
  );

  // Collections only — movies/shows mirror the filesystem and leave via rescan.
  const deleteEntry = useCallback(
    async (entryId: number) => {
      if (!selectedLibrary) return;
      try {
        await invoke("delete_entry", {
          libraryId: selectedLibrary.id,
          entryId,
        });
        setEntries((prev) => prev.filter((e) => e.id !== entryId));
        invalidateCache(selectedLibrary.id);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [selectedLibrary, breadcrumbs, invalidateCache]
  );

  // Patch one entry's fields in EVERY place a copy can live: the live grid,
  // every cached list for the library (root cache + per-view caches like
  // albums/movies-only), the open detail page, and search results. Cover and
  // metadata mutations must go through this or the old value resurfaces when
  // navigating back to a view whose cached copy went stale. Link-backed
  // copies keep their own pinned covers, so they're skipped.
  const patchEntryEverywhere = useCallback(
    (parentId: number | null, patch: (e: MediaEntry) => MediaEntry) => {
      if (!selectedLibrary) return;
      const guarded = (e: MediaEntry) => (e.link_id == null ? patch(e) : e);
      const libPrefix = `${selectedLibrary.id}:`;
      for (const [key, val] of entryCacheRef.current.entries()) {
        if (key.startsWith(libPrefix)) {
          entryCacheRef.current.set(key, { ...val, entries: val.entries.map(guarded) });
        }
      }
      for (const [key, val] of viewEntriesCacheRef.current.entries()) {
        if (key.startsWith(libPrefix)) {
          viewEntriesCacheRef.current.set(key, { ...val, entries: val.entries.map(guarded) });
        }
      }
      setEntries((prev) => {
        const updated = prev.map(guarded);
        // Write the live list to the cache slot matching the ACTIVE view — writing a
        // filtered view's list into the root slot would poison the root grid.
        if (activeView && activeView.kind !== "library-root") {
          cacheSetMerging(viewEntriesCacheRef.current, viewCacheKey(activeView), updated, sortMode);
        } else {
          updateCache(selectedLibrary.id, parentId, updated, sortMode);
        }
        return updated;
      });
      setSelectedEntry((prev) => (prev ? guarded(prev) : prev));
      // The search grid renders searchResults, a parallel list over the same
      // entries — patch its copy too or the change only shows after re-searching.
      setSearchResults((prev) => (prev ? prev.map(guarded) : prev));
    },
    [selectedLibrary, activeView, sortMode, updateCache, cacheSetMerging],
  );

  const setCover = useCallback(
    async (
      entryId: number,
      coverPath: string | null,
      opts?: { linkId?: number | null; playlistCollection?: boolean },
    ) => {
      const linkId = opts?.linkId ?? null;
      const isPlaylistCollection = opts?.playlistCollection === true;

      // Playlist-collection cover: the id here is a media_playlist_collection.id. We patch
      // the matching card in the current playlist view and invoke the collection-scoped command.
      if (isPlaylistCollection) {
        setEntries((prev) => {
          const updated = prev.map((e) =>
            e.id === entryId && e.entry_type === "playlist_collection"
              ? { ...e, selected_cover: coverPath }
              : e,
          );
          if (activeView?.kind === "playlist-detail") {
            cacheSetMerging(viewEntriesCacheRef.current, viewCacheKey(activeView), updated, sortMode);
          }
          return updated;
        });
        try {
          await invoke("set_playlist_collection_cover", { collectionId: entryId, coverPath });
        } catch (e) {
          console.error("Failed to set playlist-collection cover:", e);
          if (activeView?.kind === "playlist-detail") {
            viewEntriesCacheRef.current.delete(viewCacheKey(activeView));
            loadView(activeView, null, breadcrumbs, true);
          }
        }
        return;
      }

      if (!selectedLibrary) return;

      // Playlist-link cover override: only mutates the specific media_link row, never the
      // target entry. Optimistically patch the matching link in the current playlist view
      // and its cached entries so other copies of the same media stay on their own covers.
      if (linkId != null) {
        setEntries((prev) => {
          const updated = prev.map((e) => (e.link_id === linkId ? { ...e, selected_cover: coverPath } : e));
          if (activeView?.kind === "playlist-detail") {
            cacheSetMerging(viewEntriesCacheRef.current, viewCacheKey(activeView), updated, sortMode);
          }
          return updated;
        });
        try {
          await invoke("set_link_cover", { linkId, coverPath });
        } catch (e) {
          console.error("Failed to set link cover:", e);
          if (activeView?.kind === "playlist-detail") {
            viewEntriesCacheRef.current.delete(viewCacheKey(activeView));
            loadView(activeView, null, breadcrumbs, true);
          }
        }
        return;
      }

      const last = breadcrumbs[breadcrumbs.length - 1];
      const parentId = last?.id === entryId
        ? (breadcrumbs[breadcrumbs.length - 2]?.id ?? null)
        : (last?.id ?? null);
      patchEntryEverywhere(parentId, (e) =>
        e.id === entryId ? { ...e, selected_cover: coverPath } : e,
      );
      try {
        await invoke("set_cover", {
          libraryId: selectedLibrary.id,
          entryId,
          coverPath,
        });
      } catch (e) {
        console.error("Failed to set cover:", e);
        invalidateCache(selectedLibrary.id, parentId);
        loadEntries(selectedLibrary, parentId, breadcrumbs);
      }
    },
    [selectedLibrary, activeView, breadcrumbs, sortMode, loadEntries, loadView, invalidateCache, cacheSetMerging, patchEntryEverywhere]
  );

  const addCover = useCallback(
    async (entryId: number, opts?: { playlistCollection?: boolean }) => {
      const isPlaylistCollection = opts?.playlistCollection === true;
      if (!isPlaylistCollection && !selectedLibrary) return;

      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
      });
      if (!selected || typeof selected !== "string") return;

      if (isPlaylistCollection) {
        try {
          const newCoverPath = await invoke<string>("add_playlist_collection_cover", {
            collectionId: entryId,
            sourcePath: selected,
          });
          setEntries((prev) => {
            const updated = prev.map((e) =>
              e.id === entryId && e.entry_type === "playlist_collection"
                ? { ...e, covers: [...e.covers, newCoverPath], selected_cover: newCoverPath }
                : e,
            );
            if (activeView?.kind === "playlist-detail") {
              cacheSetMerging(viewEntriesCacheRef.current, viewCacheKey(activeView), updated, sortMode);
            }
            return updated;
          });
        } catch (e) {
          toast.error(String(e));
        }
        return;
      }

      try {
        const newCoverPath = await invoke<string>("add_cover", {
          libraryId: selectedLibrary!.id,
          entryId,
          sourcePath: selected,
        });
        const last = breadcrumbs[breadcrumbs.length - 1];
        const parentId = last?.id === entryId
          ? (breadcrumbs[breadcrumbs.length - 2]?.id ?? null)
          : (last?.id ?? null);
        patchEntryEverywhere(parentId, (e) =>
          e.id === entryId
            ? { ...e, covers: [...e.covers, newCoverPath], selected_cover: newCoverPath }
            : e,
        );
        await invoke("set_cover", {
          libraryId: selectedLibrary!.id,
          entryId,
          coverPath: newCoverPath,
        });
      } catch (e) {
        toast.error(String(e));
      }
    },
    [selectedLibrary, breadcrumbs, patchEntryEverywhere]
  );

  const deleteCover = useCallback(
    async (entryId: number, coverPath: string, opts?: { playlistCollection?: boolean }) => {
      const isPlaylistCollection = opts?.playlistCollection === true;

      if (isPlaylistCollection) {
        try {
          const newSelected = await invoke<string | null>("delete_playlist_collection_cover", {
            collectionId: entryId,
            coverPath,
          });
          setEntries((prev) => {
            const updated = prev.map((e) =>
              e.id === entryId && e.entry_type === "playlist_collection"
                ? {
                    ...e,
                    covers: e.covers.filter((c) => c !== coverPath),
                    selected_cover: newSelected,
                  }
                : e,
            );
            if (activeView?.kind === "playlist-detail") {
              cacheSetMerging(viewEntriesCacheRef.current, viewCacheKey(activeView), updated, sortMode);
            }
            return updated;
          });
        } catch (e) {
          toast.error(String(e));
        }
        return;
      }

      if (!selectedLibrary) return;
      try {
        const newSelected = await invoke<string | null>("delete_cover", {
          libraryId: selectedLibrary.id,
          entryId,
          coverPath,
        });
        const last = breadcrumbs[breadcrumbs.length - 1];
        const parentId = last?.id === entryId
          ? (breadcrumbs[breadcrumbs.length - 2]?.id ?? null)
          : (last?.id ?? null);
        patchEntryEverywhere(parentId, (e) =>
          e.id === entryId
            ? { ...e, covers: e.covers.filter((c) => c !== coverPath), selected_cover: newSelected }
            : e,
        );
      } catch (e) {
        toast.error(String(e));
      }
    },
    [selectedLibrary, activeView, breadcrumbs, sortMode, patchEntryEverywhere]
  );

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      // A modal is open (metadata center, wizard, match dialogs, …): the page
      // behind it must not navigate under the overlay. Every modal renders
      // through ui/dialog, so one DOM probe covers them all — swallow the
      // press entirely rather than letting it fall through.
      if (document.querySelector('[data-slot="dialog-content"]')) {
        e.preventDefault();
        return;
      }
      if (e.button === 3) {
        e.preventDefault();
        goBack();
      } else {
        e.preventDefault();
        goForward();
      }
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [goBack, goForward]);

  // Global player keyboard shortcuts. Live at the App level so they fire
  // whether the player is in full-takeover mode or minimized into the dock,
  // and regardless of whatever the user last clicked in the library/sidebar.
  useEffect(() => {
    if (!playerState.isActive) return;
    const handleKey = (e: KeyboardEvent) => {
      const t = e.target;
      // Ignore when the user is typing in a text field. The slider thumb
      // renders as <input type="range">, so don't blanket-skip all inputs —
      // we explicitly want arrow keys to seek even when the seek bar has
      // focus from a prior click.
      if (
        (t instanceof HTMLInputElement &&
          !["range", "checkbox", "radio", "button", "submit", "reset"].includes(
            t.type
          )) ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      // A player overlay (e.g. the Previous-choices timeline) owns the keys
      // while it's up — it flags itself on the root element.
      if (document.documentElement.dataset.wrOverlay) return;
      // Escape is fixed (never rebindable) so the player can always be exited.
      if (e.key === "Escape") {
        e.preventDefault();
        if (playerState.isFullscreen) {
          playerActions.toggleFullscreen();
        } else {
          playerActions.close();
        }
        return;
      }
      // Everything else routes through the rebindable map (Settings → Keybinds).
      // Modifier chords stay out of it — Ctrl+, must still open settings, etc.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const action = actionForKey(e.key);
      if (!action) return;
      // Interactive titles: frame-stepping would walk across unrelated
      // branches, so it stays dead; seeking becomes the engine's bounded
      // ±10s skip. Arrows still navigate an open choice overlay — the skip
      // is simply refused while a choice is up, so both can claim the key.
      if (playerState.context.kind === "interactive") {
        if (action === "prev_frame" || action === "next_frame") return;
        if (action === "seek_back" || action === "seek_forward") {
          e.preventDefault();
          playerActions.interactiveSkip(action === "seek_back" ? -10 : 10);
          return;
        }
      }
      e.preventDefault();
      switch (action) {
        case "play_pause":
          playerActions.togglePause();
          break;
        case "seek_back":
          playerActions.seek(-10);
          break;
        case "seek_forward":
          playerActions.seek(10);
          break;
        case "volume_up":
          playerActions.setVolume(Math.min(playerState.volume + 5, 100));
          break;
        case "volume_down":
          playerActions.setVolume(Math.max(playerState.volume - 5, 0));
          break;
        case "prev_frame":
          playerActions.frameBackStep();
          break;
        case "next_frame":
          playerActions.frameStep();
          break;
        case "fullscreen":
          playerActions.toggleFullscreen();
          break;
        case "mute":
          playerActions.toggleMute();
          break;
      }
    };
    // Capture phase: run before React's root listener can be stopped by a
    // descendant's stopPropagation (e.g. the seek bar wrapper killing the
    // slider thumb's keydown also kills native bubble propagation).
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [playerState.isActive, playerState.volume, playerState.isFullscreen, playerState.context.kind, playerActions]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {!(playerState.isActive && playerState.isFullscreen) && <Titlebar />}
      {playerState.isActive && !playerState.isMinimized && (
        <PlayerView state={playerState} actions={playerActions} />
      )}
      <div className={`flex flex-1 overflow-hidden${playerState.isActive && !playerState.isMinimized ? " hidden" : ""}`}>
        <Sidebar
          libraries={libraries}
          selectedLibrary={selectedLibrary}
          // Sidebar highlight follows the CURRENT page (the last breadcrumb):
          //  1. A movie/show detail highlights its home section (Movies/TV) by type.
          //  2. A person detail highlights their role list (People when all-roles, since
          //     a person can hold several roles and has no single child list).
          //  3. Any grid (a section root, a role list, a specific playlist/genre) is
          //     itself the node to light up.
          activeView={(() => {
            if (!activeView || activeView.kind === "home") return activeView;
            if (selectedEntry?.entry_type === "movie" || selectedEntry?.entry_type === "show") {
              return selectedEntry.entry_type === "movie"
                ? { kind: "movies-only", libraryId: activeView.libraryId }
                : { kind: "shows-only", libraryId: activeView.libraryId };
            }
            // Artist/album details highlight the section they were reached
            // from (Albums when browsing the albums grid, Artists otherwise).
            if (selectedEntry?.entry_type === "artist" || selectedEntry?.entry_type === "album") {
              return activeView.kind === "albums" || activeView.kind === "sounds"
                ? { kind: activeView.kind, libraryId: activeView.libraryId }
                : { kind: "library-root", libraryId: activeView.libraryId };
            }
            if (activeView.kind === "person-detail") {
              return activeView.role === "all"
                ? { kind: "people-all", libraryId: activeView.libraryId }
                : { kind: "people-list", libraryId: activeView.libraryId, role: activeView.role };
            }
            return activeView;
          })()}
          onSelectLibrary={selectLibrary}
          onSelectView={selectView}
          defaultLibraryId={defaultLibraryId ?? null}
          onSetDefaultLibrary={changeDefaultLibrary}
          onLibraryCreated={loadLibraries}
          onLibraryDeleted={async (deletedId) => {
            invalidateCache();
            try {
              const libs = await invoke<Library[]>("get_libraries");
              setLibraries(libs);
              if (activeView?.libraryId !== deletedId) {
                // Deleted a library we weren't looking at — nothing else changes.
                return;
              }
              // Clear ALL view state — selectedEntry especially, or MainContent
              // keeps rendering a detail page whose library no longer exists.
              // History too: snapshots may point into the deleted library.
              setSelectedEntry(null);
              setSearch("");
              historyRef.current = [];
              forwardHistRef.current = [];
              setEntries([]);
              setPeople(null);
              setPlaylists(null);
              setBreadcrumbs([]);
              setActiveView(null);
              // Land somewhere sensible: the first remaining library, or the
              // empty state when none are left.
              if (libs.length > 0) {
                selectLibrary(libs[0]);
              }
            } catch (e) {
              console.error("Failed to reload libraries after delete:", e);
            }
          }}
          onLibraryRenamed={(libraryId, oldName, newName) => {
            // selectedLibrary derives from this list, so the sidebar and most UI
            // pick the new name up automatically…
            loadLibraries();
            // …but breadcrumb labels bake the library name in ("<lib> - All"), so
            // patch the top-level crumb if it belongs to the renamed library.
            if (activeView?.libraryId === libraryId) {
              setBreadcrumbs((prev) =>
                prev.map((b, i) =>
                  i === 0 && b.title.startsWith(`${oldName} - `)
                    ? { ...b, title: `${newName} - ${b.title.slice(oldName.length + 3)}` }
                    : b,
                ),
              );
            }
          }}
          onLibraryRescanned={(libId) => {
            // Prefer the wizard-reported library — the SELECTED one can be
            // anything by completion time (rescans bounce the user to Home).
            const lib = (libId && libraries.find((l) => l.id === libId)) || selectedLibrary;
            if (lib) {
              invalidateCache(lib.id);
              // Silent in-place refresh — no loading flash; the grid (and any
              // open detail page's backing grid) quietly picks up new metadata.
              refreshGridInPlace();
              // Self-fetching pages (Tracks, needs-attention) aren't backed by
              // the grid caches above — they refetch on this event.
              window.dispatchEvent(new Event("waverunner:library-rescanned"));
              // Counts and genres may have changed after a rescan. Music
              // libraries have their own counts shape.
              if (lib.format === "music") {
                refreshMusicCountsFor(lib.id);
                refreshGenresFor(lib.id);
              } else {
                refreshCountsFor(lib.id);
                refreshGenresFor(lib.id);
              }
            }
          }}
          onPlaylistChanged={handlePlaylistChanged}
          onOpenMusicBrainzReview={(libraryId) => setMbReviewLibraryId(libraryId)}
          onOpenVideoMetadataCenter={(libraryId) => setVideoCenterLibraryId(libraryId)}
          sidebarPlaylists={sidebarPlaylists}
          sidebarCounts={sidebarCounts}
          sidebarGenres={sidebarGenres}
          playerState={playerState}
          playerActions={playerActions}
          onOpenHome={openHome}
          homeActive={activeView?.kind === "home"}
          scanningLibs={scanningLibs}
          passLibs={passLibs}
          dockedMusic={
            musicCoverDocked && musicState.isActive
              ? (() => {
                  const c = currentMusicItem(musicState)?.cover;
                  // coverUrl null = docked but artless — the dock shows a
                  // placeholder instead of collapsing.
                  return { coverUrl: c ? convertFileSrc(c) : null };
                })()
              : null
          }
        />
        <MainContent
          entries={entries}
          people={people}
          playlists={playlists}
          genres={genres}
          activeView={activeView}
          searchResults={searchResults}
          selectedEntry={selectedEntry}
          loading={loading}
          breadcrumbs={breadcrumbs}
          coverSize={coverSize}
          onCoverSizeChange={changeCoverSize}
          search={search}
          onSearchChange={setSearch}
          onNavigate={navigateTo}
          musicFocusRequest={musicFocusRequest}
          onNavigateToPerson={navigateToPerson}
          onTogglePersonFavorite={togglePersonFavorite}
          peopleMode={
            activeView && (activeView.kind === "people-all" || activeView.kind === "people-list")
              ? peopleModeRef.current.get(viewCacheKey(activeView)) ?? "all"
              : "all"
          }
          onPeopleModeChange={(mode) => {
            if (activeView && (activeView.kind === "people-all" || activeView.kind === "people-list")) {
              const key = viewCacheKey(activeView);
              peopleModeRef.current.set(key, mode);
              invoke("set_setting", { key: `people_mode:${key}`, value: mode }).catch(() => {});
            }
          }}
          onNavigateToPlaylist={navigateToPlaylist}
          onSelectGenre={navigateToGenre}
          onPlaylistChanged={handlePlaylistChanged}
          onSoundCollectionsChanged={(libId) => {
            // Same recipe as a rescan landing: drop caches, refresh the grid
            // silently, and let self-fetching surfaces (loose sections, open
            // collection pages) refetch off the event.
            invalidateCache(libId);
            refreshGridInPlace();
            window.dispatchEvent(new Event("waverunner:library-rescanned"));
            refreshMusicCountsFor(libId);
          }}
          onOpenLooseTracks={openLooseTracks}
          looseCount={looseCount}
          onBreadcrumbClick={navigateBreadcrumb}
          selectedLibrary={selectedLibrary}
          hasLibraries={libraries.length > 0}
          sortMode={sortMode}
          onSortModeChange={changeSortMode}
          presets={presets}
          selectedPresetId={selectedPresetId}
          onChangePreset={changePreset}
          onSavePreset={savePreset}
          onDeletePreset={deletePreset}
          onSortOrderChange={updateSortOrder}
          onRenameEntry={renameEntry}
          onTitleChanged={applyTitleChange}
          onSetCover={setCover}
          onAddCover={addCover}
          onDeleteCover={deleteCover}
          onMoveEntry={moveEntry}
          onCreateCollection={createCollection}
          onDeleteEntry={deleteEntry}
          onEntryChanged={() => {
            if (selectedLibrary) {
              // Invalidate all ancestor grids so going back shows fresh data (e.g. updated year ranges on collections)
              for (let i = 0; i < breadcrumbs.length - 1; i++) {
                invalidateCache(selectedLibrary.id, breadcrumbs[i]?.id ?? null);
              }
              // Aggregate views (movies-only, shows-only, playlists) also reference
              // this entry and cache its cover pool, but they aren't ancestors — and
              // a filtered-view detail page may have no ancestor crumb at all, so the
              // loop above can skip them entirely. Explicitly drop the library's
              // view-entry caches so a newly added cover/metadata shows up next time
              // any of them is opened (e.g. the same movie referenced in a playlist).
              invalidateCache(selectedLibrary.id, breadcrumbs[breadcrumbs.length - 1]?.id ?? null);
              // Also refresh the in-memory grid entries behind the detail page so
              // derived fields (year, end_year, covers, season_display) update when
              // the user hits back — cache invalidation alone only helps on view-switch.
              refreshGridInPlace();
            }
          }}
          getCoverUrl={getCoverUrl}
          getCoverAspect={getCoverAspect}
          getFullCoverUrl={getFullCoverUrl}
          scrollContainerRef={scrollContainerRef}
          onPlayFile={handlePlayFile}
          onPlayInteractive={handlePlayInteractive}
          onPlayEpisode={handlePlayEpisode}
          onPlayMusicQueue={handlePlayMusicQueue}
          onEnqueueMusic={handleEnqueueMusic}
          onOpenMusicAlbum={openMusicAlbumFromBar}
          onOpenMusicArtist={openMusicArtistFromBar}
          onOpenLibraryEntry={openEntryFromHome}
          onOpenLibraryTrack={openTrackFromHome}
          musicTracksFocusRequest={tracksFocusRequest}
          musicCurrentTrackId={
            musicState.isActive ? currentMusicItem(musicState)?.trackId ?? null : null
          }
          musicPlaying={musicState.isActive && musicState.isPlaying}
        />
      </div>
      {/* Persistent music bar — spans under sidebar + content, survives every
          view switch. Suppressed while the video player takes the window. */}
      <NowPlayingBar
        state={musicState}
        actions={musicActions}
        onOpenAlbum={openMusicAlbumFromBar}
        onOpenArtist={openMusicArtistFromBar}
        coverDocked={musicCoverDocked}
        onToggleCoverDock={() => setMusicCoverDocked((v) => !v)}
        hidden={playerState.isActive && !playerState.isMinimized}
      />
      <MetadataCenterDialog
        libraryId={mbReviewLibraryId}
        open={mbReviewLibraryId !== null}
        onOpenChange={(o) => {
          if (!o) setMbReviewLibraryId(null);
        }}
        onChanged={() => {
          // A match/undo landed behind the dialog — same recipe as a rescan:
          // drop caches, silently refresh the grid, and let self-fetching
          // pages (Tracks, open album/artist details) refetch off the event.
          if (!mbReviewLibraryId) return;
          invalidateCache(mbReviewLibraryId);
          refreshGridInPlace();
          window.dispatchEvent(new Event("waverunner:library-rescanned"));
          refreshMusicCountsFor(mbReviewLibraryId);
          refreshGenresFor(mbReviewLibraryId);
        }}
      />
      <VideoMetadataCenterDialog
        libraryId={videoCenterLibraryId}
        open={videoCenterLibraryId !== null}
        onOpenChange={(o) => {
          if (!o) setVideoCenterLibraryId(null);
        }}
        onChanged={() => {
          if (videoCenterLibraryId) invalidateCache(videoCenterLibraryId);
        }}
      />
      <Toaster position="top-center" />
    </div>
  );
}

export default App;
