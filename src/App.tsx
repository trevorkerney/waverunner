import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const [loading, setLoading] = useState(false);

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

  const loadEntries = useCallback(
    async (library: Library, parentId: number | null, breadcrumb: BreadcrumbItem[]) => {
      setLoading(true);
      try {
        const res = await invoke<EntriesResponse>("get_entries", {
          libraryId: library.id,
          parentId,
        });
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
      setSelectedLibrary(library);
      setSearch("");
      loadEntries(library, null, [{ id: null, title: library.name }]);
    },
    [loadEntries]
  );

  const navigateTo = useCallback(
    (entry: MediaEntry) => {
      if (!selectedLibrary || entry.entry_type !== "collection") return;
      setForwardStack([]);
      const newBreadcrumbs = [...breadcrumbs, { id: entry.id, title: entry.title }];
      loadEntries(selectedLibrary, entry.id, newBreadcrumbs);
    },
    [selectedLibrary, breadcrumbs, loadEntries]
  );

  const navigateBreadcrumb = useCallback(
    (index: number) => {
      if (!selectedLibrary) return;
      setForwardStack([]);
      const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
      const parentId = newBreadcrumbs[newBreadcrumbs.length - 1].id;
      loadEntries(selectedLibrary, parentId, newBreadcrumbs);
    },
    [selectedLibrary, breadcrumbs, loadEntries]
  );

  const goBack = useCallback(() => {
    if (!selectedLibrary || breadcrumbs.length <= 1) return;
    const removed = breadcrumbs[breadcrumbs.length - 1];
    setForwardStack((prev) => [...prev, removed]);
    const newBreadcrumbs = breadcrumbs.slice(0, -1);
    const parentId = newBreadcrumbs[newBreadcrumbs.length - 1].id;
    loadEntries(selectedLibrary, parentId, newBreadcrumbs);
  }, [selectedLibrary, breadcrumbs, loadEntries]);

  const goForward = useCallback(() => {
    if (!selectedLibrary || forwardStack.length === 0) return;
    const next = forwardStack[forwardStack.length - 1];
    setForwardStack((prev) => prev.slice(0, -1));
    const newBreadcrumbs = [...breadcrumbs, next];
    loadEntries(selectedLibrary, next.id, newBreadcrumbs);
  }, [selectedLibrary, forwardStack, breadcrumbs, loadEntries]);

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
        loadEntries(selectedLibrary, parentId, breadcrumbs);
      } catch (e) {
        console.error("Failed to set sort mode:", e);
      }
    },
    [selectedLibrary, breadcrumbs, loadEntries]
  );

  const updateSortOrder = useCallback(
    async (reordered: MediaEntry[]) => {
      if (!selectedLibrary) return;
      setEntries(reordered);
      try {
        await invoke("update_sort_order", {
          libraryId: selectedLibrary.id,
          entryIds: reordered.map((e) => e.id),
        });
      } catch (e) {
        console.error("Failed to update sort order:", e);
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        loadEntries(selectedLibrary, parentId, breadcrumbs);
      }
    },
    [selectedLibrary, breadcrumbs, loadEntries]
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
        await loadEntries(selectedLibrary, parentId, breadcrumbs);
        return null;
      } catch (e) {
        return String(e);
      }
    },
    [selectedLibrary, breadcrumbs, loadEntries]
  );

  const setCover = useCallback(
    async (entryId: number, coverPath: string | null) => {
      if (!selectedLibrary) return;
      setEntries((prev) =>
        prev.map((e) => (e.id === entryId ? { ...e, selected_cover: coverPath } : e))
      );
      try {
        await invoke("set_cover", {
          libraryId: selectedLibrary.id,
          entryId,
          coverPath,
        });
      } catch (e) {
        console.error("Failed to set cover:", e);
        const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        loadEntries(selectedLibrary, parentId, breadcrumbs);
      }
    },
    [selectedLibrary, breadcrumbs, loadEntries]
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
            setSelectedLibrary(null);
            setEntries([]);
            setBreadcrumbs([]);
          }}
          onLibraryRescanned={() => {
            if (selectedLibrary) {
              const parentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
              loadEntries(selectedLibrary, parentId, breadcrumbs);
            }
          }}
        />
        <MainContent
          entries={entries}
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
        />
      </div>
      <Toaster position="top-center" />
    </div>
  );
}

export default App;
