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
import { Library, MediaEntry, EntriesResponse, BreadcrumbItem, ViewSpec, PersonSummary, PersonRole, PlaylistSummary, PlaylistContents } from "@/types";
import { viewCacheKey } from "@/lib/complications";

function App() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  // Playlists per-library for the sidebar tree (each library's "Playlists" node shows its
  // playlists as children). Refreshed on libraries change + any onPlaylistChanged.
  const [sidebarPlaylists, setSidebarPlaylists] = useState<Record<string, PlaylistSummary[]>>({});
  const [activeView, setActiveView] = useState<ViewSpec | null>(null);
  const selectedLibrary = activeView
    ? libraries.find((l) => l.id === activeView.libraryId) ?? null
    : null;
  const [entries, setEntries] = useState<MediaEntry[]>([]);
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [forwardStack, setForwardStack] = useState<BreadcrumbItem[]>([]);
  const [sortMode, setSortMode] = useState("alpha");
  const [coverSize, setCoverSize] = useState(200);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<MediaEntry[] | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<MediaEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [playerState, playerActions] = usePlayer();

  const handlePlayFile = useCallback(
    async (path: string, title: string) => {
      try {
        await playerActions.play(path, title);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [playerActions]
  );

  const handlePlayEpisode = useCallback(
    async (args: { libraryId: string; showId: number; showTitle: string; startEpisodeId: number }) => {
      try {
        await playerActions.playEpisode(args);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [playerActions]
  );

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
  const entryCacheRef = useRef<Map<string, { entries: MediaEntry[]; sort_mode: string }>>(new Map());
  // Cache: viewCacheKey(view) -> entries (non-root MediaEntry views: movies-only / shows-only / person-detail)
  const viewEntriesCacheRef = useRef<Map<string, { entries: MediaEntry[]; sort_mode: string }>>(new Map());
  // Cache: viewCacheKey(view) -> people (people-list views)
  const peopleCacheRef = useRef<Map<string, PersonSummary[]>>(new Map());
  // Cache: viewCacheKey(view) -> playlists
  const playlistsCacheRef = useRef<Map<string, PlaylistSummary[]>>(new Map());
  // Scroll position cache: "libraryId:parentId" -> scrollTop
  const scrollCacheRef = useRef<Map<string, number>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Cache: cover file path -> blob URL of its thumbnail
  const thumbCacheRef = useRef<Map<string, string>>(new Map());

  function toThumbPath(coverPath: string): string {
    // coverPath: .../covers/filename.jpg -> .../covers_thumb/filename.jpg
    return coverPath.replace(/[/\\]covers[/\\]/, (m) =>
      m[0] + "covers_thumb" + m[m.length - 1]
    );
  }

  const preloadCovers = useCallback(async (entries: MediaEntry[]) => {
    await Promise.all(
      entries.map(async (entry) => {
        const cover =
          entry.selected_cover && entry.covers.includes(entry.selected_cover)
            ? entry.selected_cover
            : entry.covers[0];
        if (!cover || thumbCacheRef.current.has(cover)) return;
        try {
          const thumbPath = toThumbPath(cover);
          const resp = await fetch(convertFileSrc(thumbPath));
          if (!resp.ok) throw new Error();
          const blob = await resp.blob();
          thumbCacheRef.current.set(cover, URL.createObjectURL(blob));
        } catch {
          // Fallback: cache full-res as blob
          try {
            const resp = await fetch(convertFileSrc(cover));
            const blob = await resp.blob();
            thumbCacheRef.current.set(cover, URL.createObjectURL(blob));
          } catch { /* skip */ }
        }
      })
    );
  }, []);

  // For grid: returns cached thumbnail blob URL
  const getCoverUrl = useCallback((filePath: string): string => {
    return thumbCacheRef.current.get(filePath) || convertFileSrc(filePath);
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

  // Populate sidebar playlist children whenever the libraries list changes. Failures per
  // library are silently ignored — the Playlists sidebar node just won't show children.
  useEffect(() => {
    let cancelled = false;
    libraries.forEach(async (lib) => {
      try {
        const pls = await invoke<PlaylistSummary[]>("get_playlists", { libraryId: lib.id });
        if (!cancelled) {
          setSidebarPlaylists((prev) => ({ ...prev, [lib.id]: pls }));
        }
      } catch {
        // swallow — sidebar just renders with no playlist children for that library
      }
    });
    return () => { cancelled = true; };
  }, [libraries]);

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

  const saveScrollPosition = useCallback(() => {
    if (!selectedLibrary || !scrollContainerRef.current) return;
    const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
    const kind = activeView?.kind ?? "library-root";
    const key = `${selectedLibrary.id}:${kind}:${parentId}`;
    scrollCacheRef.current.set(key, scrollContainerRef.current.scrollTop);
  }, [selectedLibrary, breadcrumbs, activeView]);

  // restoreScrollPosition: apply the saved scroll for a (library, view-kind, parent) triple,
  // or reset to top when none is saved. Scroll keys include view kind so sidebar switches
  // don't leak scroll between views (library-root at parentId=null is distinct from movies-only at parentId=null).
  const restoreScrollPosition = useCallback((libraryId: string, kind: string, parentId: number | null) => {
    const key = `${libraryId}:${kind}:${parentId}`;
    const saved = scrollCacheRef.current.get(key) ?? 0;
    if (scrollContainerRef.current) {
      // Double rAF: first waits for React commit, second waits for layout/paint
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = saved;
          }
        });
      });
    }
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
    async (view: ViewSpec, parentId: number | null, breadcrumb: BreadcrumbItem[], restoreScroll: boolean = true) => {
      // people-list / people-all and playlists produce their own result types; everything else lands as MediaEntry[].
      if (view.kind === "people-list" || view.kind === "people-all") {
        const key = viewCacheKey(view);
        const cached = peopleCacheRef.current.get(key);
        setEntries([]);
        setPlaylists(null);
        if (cached) {
          setPeople(cached);
          setBreadcrumbs(breadcrumb);
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
          peopleCacheRef.current.set(key, res);
          setPeople(res);
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
        if (cached) {
          setPlaylists(cached);
          setBreadcrumbs(breadcrumb);
          return;
        }
        setBreadcrumbs(breadcrumb);
        setPlaylists(null);
        setLoading(true);
        try {
          const res = await invoke<PlaylistSummary[]>("get_playlists", {
            libraryId: view.libraryId,
          });
          playlistsCacheRef.current.set(key, res);
          setPlaylists(res);
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
        setBreadcrumbs(breadcrumb);
        if (restoreScroll && useRootCache) restoreScrollPosition(view.libraryId, view.kind, parentId);
        else if (!restoreScroll) resetScrollToTop();
        return;
      }

      // Update breadcrumb and clear the stale grid *before* awaiting the fetch, so the
      // spinner shows under the new breadcrumb instead of leaking the previous view's state.
      setBreadcrumbs(breadcrumb);
      setEntries([]);
      setLoading(true);
      try {
        let entries: MediaEntry[];
        let sort_mode: string;
        switch (view.kind) {
          case "library-root": {
            const res = await invoke<EntriesResponse>("get_entries", {
              libraryId: view.libraryId,
              parentId,
            });
            entries = res.entries;
            sort_mode = res.sort_mode;
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
            break;
          }
          case "person-detail": {
            entries = await invoke<MediaEntry[]>("get_entries_for_person", {
              libraryId: view.libraryId,
              personId: view.personId,
              role: view.role,
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
            break;
          }
        }
        await preloadCovers(entries);
        cache.set(cacheKey, { entries, sort_mode });
        setEntries(entries);
        setSortMode(sort_mode);
        if (restoreScroll && useRootCache) restoreScrollPosition(view.libraryId, view.kind, parentId);
        else if (!restoreScroll) resetScrollToTop();
      } catch (e) {
        console.error("Failed to load view:", e);
      } finally {
        setLoading(false);
      }
    },
    [restoreScrollPosition, resetScrollToTop, preloadCovers]
  );

  // Thin wrapper for the existing call sites that drive library-root navigation by (library, parentId).
  const loadEntries = useCallback(
    (library: Library, parentId: number | null, breadcrumb: BreadcrumbItem[]) =>
      loadView({ kind: "library-root", libraryId: library.id }, parentId, breadcrumb),
    [loadView]
  );

  // Re-fetch the grid entries behind the detail page without touching breadcrumbs or
  // navigating away. Fires after a detail-page edit so going back shows fresh year/covers/etc.
  const refreshGridInPlace = useCallback(async () => {
    if (!selectedLibrary || !activeView) return;
    const view = activeView;
    // The grid parent is the breadcrumb one above the detail entry; if the detail
    // page is at the top level, parent is null.
    const gridParentId = breadcrumbs.length >= 2
      ? breadcrumbs[breadcrumbs.length - 2]?.id ?? null
      : null;
    try {
      let fresh: MediaEntry[] = [];
      let fresh_sort = sortMode;
      if (view.kind === "library-root") {
        const res = await invoke<EntriesResponse>("get_entries", {
          libraryId: view.libraryId,
          parentId: gridParentId,
        });
        fresh = res.entries;
        fresh_sort = res.sort_mode;
        entryCacheRef.current.set(`${view.libraryId}:${gridParentId}`, { entries: fresh, sort_mode: fresh_sort });
      } else if (view.kind === "movies-only" || view.kind === "shows-only") {
        const res = await invoke<EntriesResponse>("get_entries", {
          libraryId: view.libraryId,
          parentId: null,
          entryTypeFilter: view.kind === "movies-only" ? "movie" : "show",
        });
        fresh = res.entries;
        fresh_sort = res.sort_mode;
        viewEntriesCacheRef.current.set(viewCacheKey(view), { entries: fresh, sort_mode: fresh_sort });
      } else if (view.kind === "person-detail") {
        fresh = await invoke<MediaEntry[]>("get_entries_for_person", {
          libraryId: view.libraryId,
          personId: view.personId,
          role: view.role,
        });
        fresh_sort = "alpha";
        viewEntriesCacheRef.current.set(viewCacheKey(view), { entries: fresh, sort_mode: fresh_sort });
      } else {
        return; // people-list / playlists don't render a media entry grid
      }
      await preloadCovers(fresh);
      setEntries(fresh);
      setSortMode(fresh_sort);
    } catch (e) {
      console.error("Failed to refresh grid:", e);
    }
  }, [selectedLibrary, activeView, breadcrumbs, sortMode, preloadCovers]);

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
          : "";
        return section ? `${libLabel} - ${section}` : libLabel;
      };

      let chain: BreadcrumbItem[];
      if (view.kind === "people-all") {
        chain = [{ id: null, title: rootLabel("people-all"), view }];
      } else if (view.kind === "people-list") {
        const peopleAll: ViewSpec = { kind: "people-all", libraryId: view.libraryId };
        const roleLabel =
          view.role === "actor" ? "Actors"
          : view.role === "director_creator" ? "Directors & Creators"
          : view.role === "composer" ? "Composers"
          : "People";
        chain = [
          { id: null, title: rootLabel("people-all"), view: peopleAll },
          { id: null, title: roleLabel, view },
        ];
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
  const navigateToPerson = useCallback(
    (person: PersonSummary, role: PersonRole) => {
      if (!selectedLibrary) return;
      const view: ViewSpec = {
        kind: "person-detail",
        libraryId: selectedLibrary.id,
        personId: person.id,
        role,
        personName: person.name,
        personImage: person.image_path,
      };
      const newBreadcrumbs: BreadcrumbItem[] = [
        ...breadcrumbs,
        { id: person.id, title: person.name, view },
      ];
      setActiveView(view);
      setSelectedEntry(null);
      setSearch("");
      setForwardStack([]);
      loadView(view, null, newBreadcrumbs, false);
    },
    [selectedLibrary, breadcrumbs, loadView]
  );

  // Drill into a playlist from the Playlists grid. Appends to the current breadcrumb chain
  // so clicking "Playlists" crumb returns to the list.
  const navigateToPlaylist = useCallback(
    (playlist: PlaylistSummary) => {
      if (!selectedLibrary) return;
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
    [selectedLibrary, breadcrumbs, loadView]
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

      const newBreadcrumbs = [...breadcrumbs, { id: entry.id, title: entry.title }];
      if (entry.entry_type === "movie" || entry.entry_type === "show") {
        setSelectedEntry(entry);
        setBreadcrumbs(newBreadcrumbs);
      } else if (entry.entry_type === "collection") {
        setSelectedEntry(null);
        loadEntries(selectedLibrary, entry.id, newBreadcrumbs);
      }
    },
    [selectedLibrary, breadcrumbs, activeView, loadEntries, loadView, saveScrollPosition]
  );

  const navigateBreadcrumb = useCallback(
    (index: number) => {
      if (!selectedLibrary) return;
      saveScrollPosition();
      setSelectedEntry(null);
      setForwardStack([]);
      const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
      const target = newBreadcrumbs[newBreadcrumbs.length - 1];
      if (target.view) {
        // Distinct view step — restore it.
        setActiveView(target.view);
        loadView(target.view, null, newBreadcrumbs, true);
      } else {
        // Drill-in within the current view (e.g. a collection chain in library-root).
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
      restoreScrollPosition(selectedLibrary.id, activeView?.kind ?? "library-root", newLast.id);
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
      const forwardEntry = entries.find((e) => e.id === next.id);
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
    } else {
      entryCacheRef.current.clear();
      viewEntriesCacheRef.current.clear();
      peopleCacheRef.current.clear();
      playlistsCacheRef.current.clear();
    }
  }, []);

  const updateCache = useCallback((libraryId: string, parentId: number | null, entries: MediaEntry[], sort_mode: string) => {
    entryCacheRef.current.set(`${libraryId}:${parentId}`, { entries, sort_mode });
  }, []);

  // Invoked after any playlist-scoped mutation (create/rename/delete/add-link/remove-link).
  // Wipes caches, re-fetches the active view if it's a playlist-* view in this library,
  // and refreshes the sidebar's per-library playlist children.
  const handlePlaylistChanged = useCallback((libraryId: string) => {
    invalidateCache(libraryId);
    (async () => {
      try {
        const pls = await invoke<PlaylistSummary[]>("get_playlists", { libraryId });
        setSidebarPlaylists((prev) => ({ ...prev, [libraryId]: pls }));
      } catch {
        // swallow
      }
    })();
    if (
      activeView &&
      activeView.libraryId === libraryId &&
      (activeView.kind === "playlists" || activeView.kind === "playlist-detail")
    ) {
      loadView(activeView, null, breadcrumbs, true);
    }
  }, [activeView, breadcrumbs, invalidateCache, loadView]);

  const changeSortMode = useCallback(
    async (mode: string) => {
      if (!selectedLibrary) return;

      // Playlist-detail has its own per-level sort_mode storage (playlist root vs nested collection)
      // and a limited vocabulary ("custom" | "alpha"). Route there instead of set_sort_mode.
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
          loadView(activeView, null, breadcrumbs, true);
        } catch (e) {
          console.error("Failed to set playlist sort mode:", e);
        }
        return;
      }

      const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
      try {
        await invoke("set_sort_mode", {
          libraryId: selectedLibrary.id,
          entryId: parentId,
          sortMode: mode,
        });
        setSortMode(mode);
        invalidateCache(selectedLibrary.id, parentId);
        loadEntries(selectedLibrary, parentId, breadcrumbs);
      } catch (e) {
        console.error("Failed to set sort mode:", e);
      }
    },
    [selectedLibrary, activeView, breadcrumbs, loadEntries, loadView, invalidateCache]
  );

  const updateSortOrder = useCallback(
    async (reordered: MediaEntry[]) => {
      if (!selectedLibrary) return;
      setEntries(reordered);

      // Playlist views carry a mix of media_link and media_playlist_collection items,
      // so the wire format differs from the library's flat entry_ids list.
      if (activeView?.kind === "playlist-detail") {
        const key = viewCacheKey(activeView);
        viewEntriesCacheRef.current.set(key, { entries: reordered, sort_mode: sortMode });
        const items = reordered.map((e) =>
          e.link_id != null
            ? { kind: "link", id: e.link_id }
            : { kind: "collection", id: e.id }
        );
        try {
          await invoke("update_playlist_sort_order", { items });
        } catch (e) {
          console.error("Failed to update playlist sort order:", e);
          viewEntriesCacheRef.current.delete(key);
          loadView(activeView, null, breadcrumbs, true);
        }
        return;
      }

      const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
      updateCache(selectedLibrary.id, parentId, reordered, sortMode);
      try {
        await invoke("update_sort_order", {
          libraryId: selectedLibrary.id,
          entryIds: reordered.map((e) => e.id),
        });
      } catch (e) {
        console.error("Failed to update sort order:", e);
        invalidateCache(selectedLibrary.id, parentId);
        loadEntries(selectedLibrary, parentId, breadcrumbs);
      }
    },
    [selectedLibrary, activeView, breadcrumbs, sortMode, loadEntries, loadView, invalidateCache, updateCache]
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
    async (entryId: number, newParentId: number | null, insertBeforeId: number | null) => {
      if (!selectedLibrary) return;
      try {
        await invoke("move_entry", {
          libraryId: selectedLibrary.id,
          entryId,
          newParentId,
          insertBeforeId,
        });
        // Save scroll before reload
        const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
        invalidateCache(selectedLibrary.id);
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        // Reload entries inline without showing spinner
        const res = await invoke<EntriesResponse>("get_entries", {
          libraryId: selectedLibrary.id,
          parentId,
        });
        await preloadCovers(res.entries);
        entryCacheRef.current.set(`${selectedLibrary.id}:${parentId}`, { entries: res.entries, sort_mode: res.sort_mode });
        setEntries(res.entries);
        setSortMode(res.sort_mode);
        // Restore scroll after React paints
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (scrollContainerRef.current) {
              scrollContainerRef.current.scrollTop = scrollTop;
            }
          });
        });
      } catch (e) {
        console.error("Failed to move entry:", e);
        toast.error(String(e));
      }
    },
    [selectedLibrary, breadcrumbs, invalidateCache, preloadCovers]
  );

  const createCollection = useCallback(
    async (name: string, basePath?: string) => {
      if (!selectedLibrary) return;
      try {
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        await invoke("create_collection", {
          libraryId: selectedLibrary.id,
          name,
          parentId,
          basePath: basePath ?? null,
        });
        invalidateCache(selectedLibrary.id, parentId);
        // Preserve current scroll across the reload. Without this the restore
        // falls through to a stale (or zero) saved value, and any side-effect
        // scroll (focus return from the dialog, dnd-kit mount re-layout, etc.)
        // can land the viewport wherever the new entry happens to sit in the
        // DOM — which in the user's case was at the ASCII-sorted tail when the
        // name was lowercase. Keeping the current scroll numerically stable
        // makes it case-insensitive by construction.
        saveScrollPosition();
        await loadEntries(selectedLibrary, parentId, breadcrumbs);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [selectedLibrary, breadcrumbs, invalidateCache, loadEntries, saveScrollPosition]
  );

  const deleteEntry = useCallback(
    async (entryId: number, deleteFromDisk: boolean) => {
      if (!selectedLibrary) return;
      try {
        await invoke("delete_entry", {
          libraryId: selectedLibrary.id,
          entryId,
          deleteFromDisk,
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
            viewEntriesCacheRef.current.set(viewCacheKey(activeView), { entries: updated, sort_mode: sortMode });
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
            viewEntriesCacheRef.current.set(viewCacheKey(activeView), { entries: updated, sort_mode: sortMode });
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
      setEntries((prev) => {
        const updated = prev.map((e) => (e.id === entryId ? { ...e, selected_cover: coverPath } : e));
        updateCache(selectedLibrary.id, parentId, updated, sortMode);
        return updated;
      });
      setSelectedEntry((prev) =>
        prev && prev.id === entryId ? { ...prev, selected_cover: coverPath } : prev
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
    [selectedLibrary, activeView, breadcrumbs, sortMode, loadEntries, loadView, invalidateCache, updateCache]
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
              viewEntriesCacheRef.current.set(viewCacheKey(activeView), { entries: updated, sort_mode: sortMode });
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
              viewEntriesCacheRef.current.set(viewCacheKey(activeView), { entries: updated, sort_mode: sortMode });
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
      switch (e.key) {
        case " ":
          e.preventDefault();
          playerActions.togglePause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          playerActions.seek(-10);
          break;
        case "ArrowRight":
          e.preventDefault();
          playerActions.seek(10);
          break;
        case "ArrowUp":
          e.preventDefault();
          playerActions.setVolume(Math.min(playerState.volume + 5, 100));
          break;
        case "ArrowDown":
          e.preventDefault();
          playerActions.setVolume(Math.max(playerState.volume - 5, 0));
          break;
        case "f":
        case "F":
          e.preventDefault();
          playerActions.toggleFullscreen();
          break;
        case "m":
        case "M":
          e.preventDefault();
          playerActions.toggleMute();
          break;
        case "Escape":
          e.preventDefault();
          if (playerState.isFullscreen) {
            playerActions.toggleFullscreen();
          } else {
            playerActions.close();
          }
          break;
      }
    };
    // Capture phase: run before React's root listener can be stopped by a
    // descendant's stopPropagation (e.g. the seek bar wrapper killing the
    // slider thumb's keydown also kills native bubble propagation).
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [playerState.isActive, playerState.volume, playerState.isFullscreen, playerActions]);

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
          activeView={activeView}
          onSelectLibrary={selectLibrary}
          onSelectView={selectView}
          onLibraryCreated={loadLibraries}
          onLibraryDeleted={() => {
            loadLibraries();
            invalidateCache();
            setActiveView(null);
            setEntries([]);
            setPeople(null);
            setPlaylists(null);
            setBreadcrumbs([]);
          }}
          onLibraryRescanned={() => {
            if (selectedLibrary) {
              invalidateCache(selectedLibrary.id);
              const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
              loadEntries(selectedLibrary, parentId, breadcrumbs);
            }
          }}
          onPlaylistChanged={handlePlaylistChanged}
          sidebarPlaylists={sidebarPlaylists}
          playerState={playerState}
          playerActions={playerActions}
        />
        <MainContent
          entries={entries}
          people={people}
          playlists={playlists}
          activeView={activeView}
          searchResults={searchResults}
          selectedEntry={selectedEntry}
          loading={loading}
          breadcrumbs={breadcrumbs}
          coverSize={coverSize}
          onCoverSizeChange={setCoverSize}
          search={search}
          onSearchChange={setSearch}
          onNavigate={navigateTo}
          onNavigateToPerson={navigateToPerson}
          onNavigateToPlaylist={navigateToPlaylist}
          onPlaylistChanged={handlePlaylistChanged}
          onBreadcrumbClick={navigateBreadcrumb}
          selectedLibrary={selectedLibrary}
          hasLibraries={libraries.length > 0}
          sortMode={sortMode}
          onSortModeChange={changeSortMode}
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
          getFullCoverUrl={getFullCoverUrl}
          scrollContainerRef={scrollContainerRef}
          onPlayFile={handlePlayFile}
          onPlayEpisode={handlePlayEpisode}
        />
      </div>
      <Toaster position="top-center" />
    </div>
  );
}

export default App;
