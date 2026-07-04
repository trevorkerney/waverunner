import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "./App.css";
import { Titlebar } from "@/components/Titlebar";
import { Sidebar } from "@/components/Sidebar";
import { MainContent } from "@/components/MainContent";
import { PlayerView } from "@/components/PlayerView";
import { usePlayer } from "@/hooks/usePlayer";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { relaunch } from "@tauri-apps/plugin-process";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Library, MediaEntry, EntriesResponse, BreadcrumbItem, ViewSpec, PersonInfo, PersonSummary, PersonRole, PlaylistSummary, PlaylistsResponse, PlaylistContents, SortPreset, LibraryCounts, GenreSummary } from "@/types";
import { KEYBINDS_SETTING, actionForKey, setRuntimeKeybinds } from "@/lib/playerKeybinds";
import { viewCacheKey, scopeKeyFor } from "@/lib/complications";

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
  const selectedLibrary = activeView
    ? libraries.find((l) => l.id === activeView.libraryId) ?? null
    : null;
  const [entries, setEntries] = useState<MediaEntry[]>([]);
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [genres, setGenres] = useState<GenreSummary[] | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [forwardStack, setForwardStack] = useState<BreadcrumbItem[]>([]);
  const [sortMode, setSortMode] = useState("alpha");
  const [selectedPresetId, setSelectedPresetId] = useState<number | null>(null);
  const [presets, setPresets] = useState<SortPreset[]>([]);
  const [coverSize, setCoverSize] = useState(200);
  const coverSizeTimerRef = useRef<number | null>(null);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<MediaEntry[] | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<MediaEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [playerState, playerActions] = usePlayer();

  const handlePlayFile = useCallback(
    async (path: string, title: string, opts?: { watch?: { kind: "movie" | "episode"; id: number }; startSecs?: number }) => {
      try {
        await playerActions.play(path, title, opts);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [playerActions]
  );

  const handlePlayEpisode = useCallback(
    async (args: { libraryId: string; showId: number; showTitle: string; startEpisodeId: number; startSecs?: number }) => {
      try {
        await playerActions.playEpisode(args);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [playerActions]
  );

  const handlePlayInteractive = useCallback(
    async (args: { libraryId: string; entryId: number; title: string; fresh?: boolean }) => {
      try {
        await playerActions.playInteractive(args);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [playerActions]
  );

  // Detail pages refresh their watch indicators when the player closes —
  // that's the moment progress recording for the session settles.
  useEffect(() => {
    if (!playerState.isActive) {
      window.dispatchEvent(new Event("waverunner:player-closed"));
    }
  }, [playerState.isActive]);

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
  const entryCacheRef = useRef<Map<string, { entries: MediaEntry[]; sort_mode: string; selected_preset_id: number | null; presets: SortPreset[] }>>(new Map());
  // Cache: viewCacheKey(view) -> entries (non-root MediaEntry views: movies-only / shows-only / person-detail)
  const viewEntriesCacheRef = useRef<Map<string, { entries: MediaEntry[]; sort_mode: string; selected_preset_id: number | null; presets: SortPreset[] }>>(new Map());
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

  // Populate sidebar counts + genres whenever the libraries list changes.
  useEffect(() => {
    libraries.forEach((lib) => {
      if (lib.format === "video") {
        refreshCountsFor(lib.id);
        refreshGenresFor(lib.id);
      }
    });
  }, [libraries, refreshCountsFor, refreshGenresFor]);

  // Auto-update on launch
  useEffect(() => {
    const endpoint =
      "https://github.com/trevorkerney/waverunner/releases/latest/download/latest.json";
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
          description: "Downloading...",
          duration: Infinity,
          id: "auto-update",
        });
        await invoke("download_and_install_update", { endpoint });
        toast("Update ready", {
          description: "Restart to apply the update.",
          duration: Infinity,
          id: "auto-update",
          action: { label: "Restart", onClick: () => relaunch() },
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
    if (!selectedLibrary || !container) return;
    const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
    const key = `${selectedLibrary.id}:${scrollKindFor(activeView)}:${parentId}`;
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
    // Re-align the anchored card to where it sat when we left. As content-
    // visibility cards above it finish laying out they can nudge it, so settle
    // over a few frames until the adjustment stops (or we give up). Falls back to
    // the raw scrollTop when there's no anchor (e.g. non-grid views).
    const applyAnchor = (): { aligned: boolean; delta: number } => {
      const c = scrollContainerRef.current;
      if (!c) return { aligned: true, delta: 0 };
      if (!saved) { c.scrollTop = 0; return { aligned: true, delta: 0 }; }
      if (!saved.anchorId) { c.scrollTop = saved.scrollTop; return { aligned: true, delta: 0 }; }
      const el = c.querySelector<HTMLElement>(`[data-flip-id="${window.CSS.escape(saved.anchorId)}"]`);
      if (!el) { c.scrollTop = saved.scrollTop; return { aligned: false, delta: Infinity }; }
      const before = c.scrollTop;
      const cTop = c.getBoundingClientRect().top;
      const elTop = el.getBoundingClientRect().top;
      c.scrollTop += (elTop - cTop) - saved.anchorDelta;
      return { aligned: true, delta: Math.abs(c.scrollTop - before) };
    };
    let attempts = 0;
    const settle = () => {
      if (!scrollContainerRef.current) return;
      const { aligned, delta } = applyAnchor();
      attempts++;
      if (attempts < 8 && (!aligned || delta > 1)) requestAnimationFrame(settle);
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
        setPlaylists(null);
        setLoading(true);
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
          setPlaylists(res.playlists);
          setPresets(res.presets);
          setSelectedPresetId(res.selected_preset_id);
          if (restoreScroll) restoreScrollPosition(view.libraryId, scrollKindFor(view), breadcrumb[breadcrumb.length - 1]?.id ?? null);
          else resetScrollToTop();
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
      }
      try {
        let entries: MediaEntry[];
        let sort_mode: string;
        let selected_preset_id: number | null = null;
        let view_presets: SortPreset[] = [];
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
          case "shows-only": {
            const res = await invoke<EntriesResponse>("get_entries", {
              libraryId: view.libraryId,
              parentId: null,
              entryTypeFilter: view.kind === "movies-only" ? "movie" : "show",
            });
            entries = res.entries;
            sort_mode = res.sort_mode;
            selected_preset_id = res.selected_preset_id;
            view_presets = res.presets;
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
        cache.set(cacheKey, { entries, sort_mode, selected_preset_id, presets: view_presets });
        setEntries(entries);
        setSortMode(sort_mode);
        setSelectedPresetId(selected_preset_id);
        setPresets(view_presets);
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
      } else if (view.kind === "movies-only" || view.kind === "shows-only") {
        const res = await invoke<EntriesResponse>("get_entries", {
          libraryId: view.libraryId,
          parentId: null,
          entryTypeFilter: view.kind === "movies-only" ? "movie" : "show",
        });
        fresh = res.entries;
        fresh_sort = res.sort_mode;
        fresh_selected_preset_id = res.selected_preset_id;
        fresh_presets = res.presets;
        viewEntriesCacheRef.current.set(viewCacheKey(view), {
          entries: fresh, sort_mode: fresh_sort,
          selected_preset_id: fresh_selected_preset_id, presets: fresh_presets,
        });
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
      // Sidebar library clicks land at the top like other sidebar switches.
      const view: ViewSpec = { kind: "library-root", libraryId: library.id };
      setActiveView(view);
      setSelectedEntry(null);
      setSearch("");
      setForwardStack([]);
      // Clicking the library header lands on library-root. The top-level breadcrumb
      // always bakes the library name into its label so the user sees "<lib> - All".
      const libRoot: ViewSpec = { kind: "library-root", libraryId: library.id };
      loadView(view, null, [
        { id: null, title: `${library.name} - All`, view: libRoot },
      ], false);
    },
    [loadView]
  );

  // Open the default library on launch, once libraries AND settings have both
  // loaded. One-shot: later library-list refreshes (rescan, create, delete)
  // must not yank navigation, and a user click always beats a slow settings read.
  const didAutoSelectRef = useRef(false);
  useEffect(() => {
    if (didAutoSelectRef.current) return;
    if (defaultLibraryId === undefined || libraries.length === 0) return;
    didAutoSelectRef.current = true;
    if (defaultLibraryId === null || activeView !== null) return;
    const lib = libraries.find((l) => l.id === defaultLibraryId);
    if (lib) selectLibrary(lib);
  }, [libraries, defaultLibraryId, activeView, selectLibrary]);

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
      setForwardStack([]);
      const lib = libraries.find((l) => l.id === view.libraryId);
      const libLabel = lib?.name ?? "Library";
      // Top-level sidebar views render as a single "<library> - <section>" crumb; deeper
      // views keep their own sub-crumbs after. No standalone library button.
      const rootLabel = (kind: ViewSpec["kind"]): string => {
        const section =
          kind === "library-root" ? "All"
          : kind === "movies-only" ? "Movies"
          : kind === "shows-only" ? "TV"
          : kind === "people-all" || kind === "people-list" || kind === "person-detail" ? "People"
          : kind === "playlists" || kind === "playlist-detail" ? "Playlists"
          : kind === "genres" ? "Genres"
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
      setForwardStack([]);
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
      setForwardStack([]);
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
      setForwardStack([]);
      loadView(view, null, newBreadcrumbs, false);
    },
    [breadcrumbs, loadView, collapseLoop, saveScrollPosition]
  );

  const navigateTo = useCallback(
    (entry: MediaEntry) => {
      if (!selectedLibrary) return;
      saveScrollPosition();
      setForwardStack([]);

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

      if (entry.entry_type === "movie" || entry.entry_type === "show") {
        if (breadcrumbs[breadcrumbs.length - 1]?.entry?.id === entry.id) return; // already on this page
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

  const navigateBreadcrumb = useCallback(
    (index: number) => {
      if (!selectedLibrary) return;
      saveScrollPosition();
      setForwardStack([]);
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

  const goBack = useCallback(() => {
    if (!selectedLibrary || breadcrumbs.length <= 1) return;
    saveScrollPosition();
    const removed = breadcrumbs[breadcrumbs.length - 1];
    setForwardStack((prev) => [...prev, removed]);
    const newBreadcrumbs = breadcrumbs.slice(0, -1);
    const newLast = newBreadcrumbs[newBreadcrumbs.length - 1];
    if (newLast.view) {
      // Popping to a distinct-view step (covers "back out of detail within a view"
      // AND "back from person-detail to people-list" AND "back to sidebar root").
      setSelectedEntry(null);
      setActiveView(newLast.view);
      loadView(newLast.view, null, newBreadcrumbs, true);
    } else if (selectedEntry) {
      // Popping out of a movie/show detail page within the current view's grid.
      setSelectedEntry(null);
      setBreadcrumbs(newBreadcrumbs);
      restoreScrollPosition(selectedLibrary.id, scrollKindFor(activeView), newLast.id);
    } else if (newLast.entry) {
      // Popping back onto a movie/show detail page (e.g. from a cast member's page).
      // Restore the detail page + owning view, and quietly reload the grid behind it.
      const ownerView =
        [...newBreadcrumbs].reverse().find((c) => c.view)?.view ??
        ({ kind: "library-root", libraryId: selectedLibrary.id } as ViewSpec);
      const parentId = newBreadcrumbs[newBreadcrumbs.length - 2]?.id ?? null;
      setSelectedEntry(newLast.entry);
      setActiveView(ownerView);
      setBreadcrumbs(newBreadcrumbs);
      loadView(ownerView, parentId, newBreadcrumbs, false, true);
    } else {
      // Popping to a shallower drill-in (collection chain) within the current view.
      loadEntries(selectedLibrary, newLast.id, newBreadcrumbs);
    }
  }, [selectedLibrary, breadcrumbs, selectedEntry, loadView, loadEntries, saveScrollPosition, restoreScrollPosition, activeView]);

  const goForward = useCallback(() => {
    if (!selectedLibrary || forwardStack.length === 0) return;
    saveScrollPosition();
    const next = forwardStack[forwardStack.length - 1];
    setForwardStack((prev) => prev.slice(0, -1));
    const newBreadcrumbs = [...breadcrumbs, next];
    if (next.view) {
      setSelectedEntry(null);
      setActiveView(next.view);
      loadView(next.view, null, newBreadcrumbs, true);
    } else {
      // Non-view crumb — either a collection drill-in or a movie/show detail page.
      // Detail crumbs carry their entry; the entries-list lookup is a fallback for
      // forward stacks recorded before the crumb was created with one.
      const forwardEntry = next.entry ?? entries.find((e) => e.id === next.id);
      if (forwardEntry && forwardEntry.entry_type !== "collection") {
        setSelectedEntry(forwardEntry);
        setBreadcrumbs(newBreadcrumbs);
      } else {
        setSelectedEntry(null);
        loadEntries(selectedLibrary, next.id, newBreadcrumbs);
      }
    }
  }, [selectedLibrary, forwardStack, breadcrumbs, entries, loadView, loadEntries, saveScrollPosition]);

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
    [selectedLibrary, activeView, breadcrumbs, loadEntries, loadView, invalidateCache, saveScrollPosition]
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
    setForwardStack((prev) => prev.map((b) => (b.id === entryId ? { ...b, title: newTitle } : b)));
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
      // Every cached list for this library holds its own copy of the entry (root
      // cache + per-view caches like movies-only/shows-only) — patch them all, or
      // the old cover resurfaces when navigating back to a view whose copy went
      // stale. Link-backed copies keep their own pinned covers.
      const patchCover = (e: MediaEntry) =>
        e.id === entryId && e.link_id == null ? { ...e, selected_cover: coverPath } : e;
      const libPrefix = `${selectedLibrary.id}:`;
      for (const [key, val] of entryCacheRef.current.entries()) {
        if (key.startsWith(libPrefix)) {
          entryCacheRef.current.set(key, { ...val, entries: val.entries.map(patchCover) });
        }
      }
      for (const [key, val] of viewEntriesCacheRef.current.entries()) {
        if (key.startsWith(libPrefix)) {
          viewEntriesCacheRef.current.set(key, { ...val, entries: val.entries.map(patchCover) });
        }
      }
      setEntries((prev) => {
        const updated = prev.map(patchCover);
        // Write the live list to the cache slot matching the ACTIVE view — writing a
        // filtered view's list into the root slot would poison the root grid.
        if (activeView && activeView.kind !== "library-root") {
          cacheSetMerging(viewEntriesCacheRef.current, viewCacheKey(activeView), updated, sortMode);
        } else {
          updateCache(selectedLibrary.id, parentId, updated, sortMode);
        }
        return updated;
      });
      setSelectedEntry((prev) =>
        prev && prev.id === entryId ? { ...prev, selected_cover: coverPath } : prev
      );
      // The search grid renders searchResults, a parallel list over the same
      // entries — patch its copy too or the change only shows after re-searching.
      setSearchResults((prev) => (prev ? prev.map(patchCover) : prev));
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
    [selectedLibrary, activeView, breadcrumbs, sortMode, loadEntries, loadView, invalidateCache, updateCache, cacheSetMerging]
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
        const updateEntry = (e: MediaEntry) =>
          e.id === entryId
            ? { ...e, covers: [...e.covers, newCoverPath], selected_cover: newCoverPath }
            : e;
        const last = breadcrumbs[breadcrumbs.length - 1];
        const parentId = last?.id === entryId
          ? (breadcrumbs[breadcrumbs.length - 2]?.id ?? null)
          : (last?.id ?? null);
        setEntries((prev) => {
          const updated = prev.map(updateEntry);
          updateCache(selectedLibrary!.id, parentId, updated, sortMode);
          return updated;
        });
        setSelectedEntry((prev) => (prev && prev.id === entryId ? updateEntry(prev) : prev));
        setSearchResults((prev) => (prev ? prev.map(updateEntry) : prev));
        await invoke("set_cover", {
          libraryId: selectedLibrary!.id,
          entryId,
          coverPath: newCoverPath,
        });
      } catch (e) {
        toast.error(String(e));
      }
    },
    [selectedLibrary, activeView, breadcrumbs, sortMode, updateCache]
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
        const updateEntry = (e: MediaEntry) =>
          e.id === entryId
            ? { ...e, covers: e.covers.filter((c) => c !== coverPath), selected_cover: newSelected }
            : e;
        const last = breadcrumbs[breadcrumbs.length - 1];
        const parentId = last?.id === entryId
          ? (breadcrumbs[breadcrumbs.length - 2]?.id ?? null)
          : (last?.id ?? null);
        setEntries((prev) => {
          const updated = prev.map(updateEntry);
          updateCache(selectedLibrary.id, parentId, updated, sortMode);
          return updated;
        });
        setSelectedEntry((prev) => (prev && prev.id === entryId ? updateEntry(prev) : prev));
        setSearchResults((prev) => (prev ? prev.map(updateEntry) : prev));
      } catch (e) {
        toast.error(String(e));
      }
    },
    [selectedLibrary, activeView, breadcrumbs, sortMode, updateCache]
  );

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        goBack();
      } else if (e.button === 4) {
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
            if (!activeView) return activeView;
            if (selectedEntry?.entry_type === "movie" || selectedEntry?.entry_type === "show") {
              return selectedEntry.entry_type === "movie"
                ? { kind: "movies-only", libraryId: activeView.libraryId }
                : { kind: "shows-only", libraryId: activeView.libraryId };
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
              setSelectedEntry(null);
              setSearch("");
              setForwardStack([]);
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
          onLibraryRescanned={() => {
            if (selectedLibrary) {
              invalidateCache(selectedLibrary.id);
              // Silent in-place refresh — no loading flash; the grid (and any
              // open detail page's backing grid) quietly picks up new metadata.
              refreshGridInPlace();
              // Counts and genres may have changed after a rescan.
              refreshCountsFor(selectedLibrary.id);
              refreshGenresFor(selectedLibrary.id);
            }
          }}
          onPlaylistChanged={handlePlaylistChanged}
          sidebarPlaylists={sidebarPlaylists}
          sidebarCounts={sidebarCounts}
          sidebarGenres={sidebarGenres}
          playerState={playerState}
          playerActions={playerActions}
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
          onNavigateToPerson={navigateToPerson}
          onTogglePersonFavorite={togglePersonFavorite}
          peopleMode={
            activeView && (activeView.kind === "people-all" || activeView.kind === "people-list")
              ? peopleModeRef.current.get(viewCacheKey(activeView)) ?? "top"
              : "top"
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
          onRescan={() => {
            if (selectedLibrary) {
              invalidateCache(selectedLibrary.id);
              const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
              loadEntries(selectedLibrary, parentId, breadcrumbs);
            }
          }}
          getCoverUrl={getCoverUrl}
          getCoverAspect={getCoverAspect}
          getFullCoverUrl={getFullCoverUrl}
          scrollContainerRef={scrollContainerRef}
          onPlayFile={handlePlayFile}
          onPlayInteractive={handlePlayInteractive}
          onPlayEpisode={handlePlayEpisode}
        />
      </div>
      <Toaster position="top-center" />
    </div>
  );
}

export default App;
