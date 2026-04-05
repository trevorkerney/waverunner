import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "./App.css";
import { Titlebar } from "@/components/Titlebar";
import { Sidebar } from "@/components/Sidebar";
import { MainContent } from "@/components/MainContent";
import { Toaster } from "@/components/ui/sonner";
import { Library, MediaEntry, EntriesResponse, BreadcrumbItem } from "@/types";

function App() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [selectedLibrary, setSelectedLibrary] = useState<Library | null>(null);
  const [entries, setEntries] = useState<MediaEntry[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [forwardStack, setForwardStack] = useState<BreadcrumbItem[]>([]);
  const [sortMode, setSortMode] = useState("alpha");
  const [coverSize, setCoverSize] = useState(200);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<MediaEntry[] | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<MediaEntry | null>(null);
  const [loading, setLoading] = useState(false);

  // Cache: "libraryId:parentId" -> { entries, sortMode }
  const entryCacheRef = useRef<Map<string, { entries: MediaEntry[]; sort_mode: string }>>(new Map());
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
        await preloadCovers(results);
        setSearchResults(results);
      } catch (e) {
        console.error("Search failed:", e);
        setSearchResults(null);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [search, selectedLibrary, breadcrumbs, preloadCovers]);

  const saveScrollPosition = useCallback(() => {
    if (!selectedLibrary || !scrollContainerRef.current) return;
    const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
    const key = `${selectedLibrary.id}:${parentId}`;
    scrollCacheRef.current.set(key, scrollContainerRef.current.scrollTop);
  }, [selectedLibrary, breadcrumbs]);

  const restoreScrollPosition = useCallback((libraryId: string, parentId: number | null) => {
    const key = `${libraryId}:${parentId}`;
    const saved = scrollCacheRef.current.get(key);
    if (saved != null && scrollContainerRef.current) {
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

  const loadEntries = useCallback(
    async (library: Library, parentId: number | null, breadcrumb: BreadcrumbItem[]) => {
      const cacheKey = `${library.id}:${parentId}`;
      const cached = entryCacheRef.current.get(cacheKey);

      if (cached) {
        setEntries(cached.entries);
        setSortMode(cached.sort_mode);
        setBreadcrumbs(breadcrumb);
        restoreScrollPosition(library.id, parentId);
        return;
      }

      setLoading(true);
      try {
        const res = await invoke<EntriesResponse>("get_entries", {
          libraryId: library.id,
          parentId,
        });
        await preloadCovers(res.entries);
        entryCacheRef.current.set(cacheKey, { entries: res.entries, sort_mode: res.sort_mode });
        setEntries(res.entries);
        setSortMode(res.sort_mode);
        setBreadcrumbs(breadcrumb);
      } catch (e) {
        console.error("Failed to load entries:", e);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const selectLibrary = useCallback(
    (library: Library) => {
      saveScrollPosition();
      setSelectedLibrary(library);
      setSelectedEntry(null);
      setSearch("");
      loadEntries(library, null, [{ id: null, title: library.name }]);
    },
    [loadEntries, saveScrollPosition]
  );

  const navigateTo = useCallback(
    (entry: MediaEntry) => {
      if (!selectedLibrary) return;
      saveScrollPosition();
      setForwardStack([]);
      const newBreadcrumbs = [...breadcrumbs, { id: entry.id, title: entry.title }];
      if (entry.entry_type === "movie" || entry.entry_type === "show") {
        setSelectedEntry(entry);
        setBreadcrumbs(newBreadcrumbs);
      } else if (entry.entry_type === "collection") {
        setSelectedEntry(null);
        loadEntries(selectedLibrary, entry.id, newBreadcrumbs);
      }
    },
    [selectedLibrary, breadcrumbs, loadEntries, saveScrollPosition]
  );

  const navigateBreadcrumb = useCallback(
    (index: number) => {
      if (!selectedLibrary) return;
      saveScrollPosition();
      setSelectedEntry(null);
      setForwardStack([]);
      const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
      const parentId = newBreadcrumbs[newBreadcrumbs.length - 1].id;
      loadEntries(selectedLibrary, parentId, newBreadcrumbs);
    },
    [selectedLibrary, breadcrumbs, loadEntries, saveScrollPosition]
  );

  const goBack = useCallback(() => {
    if (!selectedLibrary || breadcrumbs.length <= 1) return;
    saveScrollPosition();
    const removed = breadcrumbs[breadcrumbs.length - 1];
    setForwardStack((prev) => [...prev, removed]);
    const newBreadcrumbs = breadcrumbs.slice(0, -1);
    const parentId = newBreadcrumbs[newBreadcrumbs.length - 1].id;
    if (selectedEntry) {
      setSelectedEntry(null);
      setBreadcrumbs(newBreadcrumbs);
    } else {
      loadEntries(selectedLibrary, parentId, newBreadcrumbs);
    }
  }, [selectedLibrary, breadcrumbs, selectedEntry, loadEntries, saveScrollPosition]);

  const goForward = useCallback(() => {
    if (!selectedLibrary || forwardStack.length === 0) return;
    saveScrollPosition();
    const next = forwardStack[forwardStack.length - 1];
    setForwardStack((prev) => prev.slice(0, -1));
    const newBreadcrumbs = [...breadcrumbs, next];
    // Check if the forward entry is a non-collection (movie/show detail page)
    const forwardEntry = entries.find((e) => e.id === next.id);
    if (forwardEntry && forwardEntry.entry_type !== "collection") {
      setSelectedEntry(forwardEntry);
      setBreadcrumbs(newBreadcrumbs);
    } else {
      setSelectedEntry(null);
      loadEntries(selectedLibrary, next.id, newBreadcrumbs);
    }
  }, [selectedLibrary, forwardStack, breadcrumbs, entries, loadEntries, saveScrollPosition]);

  const invalidateCache = useCallback((libraryId?: string, parentId?: number | null) => {
    if (libraryId != null && parentId !== undefined) {
      entryCacheRef.current.delete(`${libraryId}:${parentId}`);
    } else if (libraryId != null) {
      // Invalidate all entries for this library
      for (const key of entryCacheRef.current.keys()) {
        if (key.startsWith(`${libraryId}:`)) entryCacheRef.current.delete(key);
      }
    } else {
      entryCacheRef.current.clear();
    }
  }, []);

  const updateCache = useCallback((libraryId: string, parentId: number | null, entries: MediaEntry[], sort_mode: string) => {
    entryCacheRef.current.set(`${libraryId}:${parentId}`, { entries, sort_mode });
  }, []);

  const changeSortMode = useCallback(
    async (mode: string) => {
      if (!selectedLibrary) return;
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
    [selectedLibrary, breadcrumbs, loadEntries, invalidateCache]
  );

  const updateSortOrder = useCallback(
    async (reordered: MediaEntry[]) => {
      if (!selectedLibrary) return;
      setEntries(reordered);
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
    [selectedLibrary, breadcrumbs, sortMode, loadEntries, invalidateCache, updateCache]
  );

  const renameEntry = useCallback(
    async (entryId: number, newTitle: string): Promise<string | null> => {
      if (!selectedLibrary) return "No library selected";
      try {
        await invoke("rename_entry", {
          libraryId: selectedLibrary.id,
          entryId,
          newTitle,
        });
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        invalidateCache(selectedLibrary.id, parentId);
        await loadEntries(selectedLibrary, parentId, breadcrumbs);
        return null;
      } catch (e) {
        return String(e);
      }
    },
    [selectedLibrary, breadcrumbs, loadEntries, invalidateCache]
  );

  const setCover = useCallback(
    async (entryId: number, coverPath: string | null) => {
      if (!selectedLibrary) return;
      const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
      setEntries((prev) => {
        const updated = prev.map((e) => (e.id === entryId ? { ...e, selected_cover: coverPath } : e));
        updateCache(selectedLibrary.id, parentId, updated, sortMode);
        return updated;
      });
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
    [selectedLibrary, breadcrumbs, sortMode, loadEntries, invalidateCache, updateCache]
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

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Titlebar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          libraries={libraries}
          selectedLibrary={selectedLibrary}
          onSelectLibrary={selectLibrary}
          onLibraryCreated={loadLibraries}
          onLibraryDeleted={() => {
            loadLibraries();
            invalidateCache();
            setSelectedLibrary(null);
            setEntries([]);
            setBreadcrumbs([]);
          }}
          onLibraryRescanned={() => {
            if (selectedLibrary) {
              invalidateCache(selectedLibrary.id);
              const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
              loadEntries(selectedLibrary, parentId, breadcrumbs);
            }
          }}
        />
        <MainContent
          entries={entries}
          searchResults={searchResults}
          selectedEntry={selectedEntry}
          loading={loading}
          breadcrumbs={breadcrumbs}
          coverSize={coverSize}
          onCoverSizeChange={setCoverSize}
          search={search}
          onSearchChange={setSearch}
          onNavigate={navigateTo}
          onBreadcrumbClick={navigateBreadcrumb}
          selectedLibrary={selectedLibrary}
          sortMode={sortMode}
          onSortModeChange={changeSortMode}
          onSortOrderChange={updateSortOrder}
          onRenameEntry={renameEntry}
          onSetCover={setCover}
          getCoverUrl={getCoverUrl}
          getFullCoverUrl={getFullCoverUrl}
          scrollContainerRef={scrollContainerRef}
        />
      </div>
      <Toaster position="top-center" />
    </div>
  );
}

export default App;
