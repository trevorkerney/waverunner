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
      restoreScrollPosition(selectedLibrary.id, parentId);
    } else {
      loadEntries(selectedLibrary, parentId, newBreadcrumbs);
    }
  }, [selectedLibrary, breadcrumbs, selectedEntry, loadEntries, saveScrollPosition, restoreScrollPosition]);

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
        await loadEntries(selectedLibrary, parentId, breadcrumbs);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [selectedLibrary, breadcrumbs, invalidateCache, loadEntries]
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
    async (entryId: number, coverPath: string | null) => {
      if (!selectedLibrary) return;
      const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
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
    [selectedLibrary, breadcrumbs, sortMode, loadEntries, invalidateCache, updateCache]
  );

  const addCover = useCallback(
    async (entryId: number) => {
      if (!selectedLibrary) return;
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
      });
      if (!selected || typeof selected !== "string") return;
      try {
        const newCoverPath = await invoke<string>("add_cover", {
          libraryId: selectedLibrary.id,
          entryId,
          sourcePath: selected,
        });
        const updateEntry = (e: MediaEntry) =>
          e.id === entryId
            ? { ...e, covers: [...e.covers, newCoverPath], selected_cover: newCoverPath }
            : e;
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        setEntries((prev) => {
          const updated = prev.map(updateEntry);
          updateCache(selectedLibrary.id, parentId, updated, sortMode);
          return updated;
        });
        setSelectedEntry((prev) => (prev && prev.id === entryId ? updateEntry(prev) : prev));
        await invoke("set_cover", {
          libraryId: selectedLibrary.id,
          entryId,
          coverPath: newCoverPath,
        });
      } catch (e) {
        toast.error(String(e));
      }
    },
    [selectedLibrary, breadcrumbs, sortMode, updateCache]
  );

  const deleteCover = useCallback(
    async (entryId: number, coverPath: string) => {
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
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
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
    [selectedLibrary, breadcrumbs, sortMode, updateCache]
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
      {!(playerState.isActive && playerState.isFullscreen) && <Titlebar />}
      {playerState.isActive && !playerState.isMinimized && (
        <PlayerView state={playerState} actions={playerActions} />
      )}
      <div className={`flex flex-1 overflow-hidden${playerState.isActive && !playerState.isMinimized ? " hidden" : ""}`}>
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
          playerState={playerState}
          playerActions={playerActions}
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
