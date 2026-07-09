import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, type RefObject } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  useDroppable,
  pointerWithin,
  type CollisionDetection,
  type DropAnimation,
  type Over,
  defaultDropAnimationSideEffects,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem as BreadcrumbUIItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Search,
  Folder,
  ArrowUpDown,
  ArrowUp,
  Pencil,
  Play,
  Image as ImageIcon,
  LibraryBig,
  FolderPlus,
  Film,
  Tv,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  User as UserIcon,
  ListMusic,
  ListPlus,
  Save,
  Clapperboard,
  GitBranch,
  RotateCcw,
  Eye,
  EyeOff,
  LayoutGrid,
} from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Library, MediaEntry, BreadcrumbItem, MovieDetail, MovieDetailUpdate, SeasonInfo, EpisodeInfo, ShowDetail, SeasonDetailLocal, EpisodeDetailLocal, TmdbSeasonDetail, TmdbEpisodeDetail, TmdbShowFieldSelection, TmdbSeasonFieldSelection, TmdbEpisodeFieldSelection, CastUpdateInfo, CastInfo, RatingInfo, ViewSpec, PersonInfo, PersonSummary, PersonRole, PlaylistSummary, GenreSummary, SortPreset, WatchState, EpisodeWatchInfo, ContinueTarget, ShowEpisodeFlat } from "@/types";
import { scopeKeyFor, viewCacheKey } from "@/lib/complications";
import { ExtrasDialog } from "@/components/ExtrasDialog";
import { SortPresetSaveDialog } from "@/components/SortPresetSaveDialog";
import { playDropIn } from "@/lib/dropIn";
import { TmdbMatchDialog } from "@/components/TmdbMatchDialog";
import { TmdbShowMatchDialog } from "@/components/TmdbShowMatchDialog";
import { TmdbImageBrowserDialog } from "@/components/TmdbImageBrowserDialog";
import { TmdbEpisodeSourceDialog } from "@/components/TmdbEpisodeSourceDialog";
import { BackdropSelectDialog } from "@/components/BackdropSelectDialog";
import rtCriticsIcon from "@/assets/ratings/rt-critics.svg";
import rtAudienceIcon from "@/assets/ratings/rt-audience.svg";
import rtCriticsRottenIcon from "@/assets/ratings/rt-critics-rotten.svg";
import rtAudienceRottenIcon from "@/assets/ratings/rt-audience-rotten.svg";
import imdbIcon from "@/assets/ratings/imdb.svg";
import metacriticIcon from "@/assets/ratings/metacritic.svg";
import { PeoplePage } from "@/components/PeopleGrid";
import { ScrubberRail } from "@/components/ScrubberRail";
import { CreatePlaylistDialog } from "@/components/CreatePlaylistDialog";
import { CreatePlaylistCollectionDialog } from "@/components/CreatePlaylistCollectionDialog";
import { AddToPlaylistDialog } from "@/components/AddToPlaylistDialog";
import { RenameDialog } from "@/components/RenameDialog";

function letterForTitle(title: string): string {
  // Mirrors the backend's generate_sort_title: grids sort with leading English
  // articles stripped ("The Office" files under O), so the scrubber letter must
  // come from the same key or T-jumps land on "The …" titles sorted elsewhere.
  let t = title.trim().toLowerCase();
  for (const article of ["the ", "a ", "an "]) {
    if (t.startsWith(article)) {
      t = t.slice(article.length).trim();
      break;
    }
  }
  const c = t.charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

// Granularity of the date jump rail. Smaller = finer markers (1 = every year,
// 5 = half-decades). Buckets a 4-digit year string to its group's start year.
const YEAR_RAIL_STEP = 5;
function yearBucket(year: string | null | undefined): string | null {
  if (!year || year.length < 4) return null;
  const y = parseInt(year.slice(0, 4), 10);
  if (Number.isNaN(y)) return null;
  return String(Math.floor(y / YEAR_RAIL_STEP) * YEAR_RAIL_STEP);
}

function getDisplayCover(entry: MediaEntry): string | null {
  if (entry.selected_cover && entry.covers.includes(entry.selected_cover)) {
    return entry.selected_cover;
  }
  return entry.covers[0] || null;
}

/** Stable, collision-free sortable id for a grid entry.
 *  - Playlist links use their `link_id` (distinct across playlists).
 *  - Nested playlist_collections use `pc-<id>` so they don't collide with real
 *    media_entry ids (both id spaces AUTOINCREMENT from 1).
 *  - Everything else (movies, shows, media_collections, artists) keeps its numeric
 *    media_entry id so existing library drag-and-drop, key-by-id, and
 *    update_sort_order flows keep working unchanged. */
function sortableIdFor(entry: MediaEntry): string | number {
  if (entry.link_id != null) return `link-${entry.link_id}`;
  if (entry.entry_type === "playlist_collection") return `pc-${entry.id}`;
  return entry.id;
}

function formatReleaseDate(date: string | null | undefined): string | null {
  if (!date) return null;
  if (/^\d{4}$/.test(date)) return date;
  if (/^\d{4}-\d{2}$/.test(date)) {
    const [y, m] = date.split("-");
    return new Date(+y, +m - 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split("-");
    return new Date(+y, +m - 1, +d).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }
  return date;
}

interface MainContentProps {
  entries: MediaEntry[];
  people: PersonSummary[] | null;
  playlists: PlaylistSummary[] | null;
  genres: GenreSummary[] | null;
  onSelectGenre: (libraryId: string, genre: string) => void;
  activeView: ViewSpec | null;
  searchResults: MediaEntry[] | null;
  selectedEntry: MediaEntry | null;
  loading: boolean;
  breadcrumbs: BreadcrumbItem[];
  coverSize: number;
  onCoverSizeChange: (size: number) => void;
  search: string;
  onSearchChange: (search: string) => void;
  onNavigate: (entry: MediaEntry) => void;
  onNavigateToPerson: (person: PersonInfo, role: PersonRole) => void;
  onTogglePersonFavorite: (person: PersonSummary) => void;
  peopleMode: "top" | "all";
  onPeopleModeChange: (mode: "top" | "all") => void;
  onNavigateToPlaylist: (playlist: PlaylistSummary) => void;
  onPlaylistChanged: (libraryId: string) => void;
  onBreadcrumbClick: (index: number) => void;
  selectedLibrary: Library | null;
  hasLibraries: boolean;
  sortMode: string;
  onSortModeChange: (mode: string) => void;
  presets: SortPreset[];
  selectedPresetId: number | null;
  onChangePreset: (presetId: number | null) => Promise<void> | void;
  onSavePreset: (name: string, overwrite: boolean) => Promise<void>;
  onDeletePreset: (presetId: number) => Promise<void> | void;
  onSortOrderChange: (reordered: MediaEntry[]) => void;
  onRenameEntry: (entryId: number, newTitle: string) => Promise<string | null>;
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
  onMoveEntry: (entryId: number, newParentId: number | null, insertBeforeId: number | null, anchor?: { id: number; viewportTop: number }) => Promise<void>;
  onCreateCollection: (name: string) => Promise<number | null>;
  onDeleteEntry: (entryId: number) => Promise<void>;
  onRescan: () => void;
  onEntryChanged: () => void;
  getCoverUrl: (filePath: string) => string;
  getCoverAspect: (filePath: string) => number | undefined;
  getFullCoverUrl: (filePath: string) => string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onPlayFile?: (path: string, title: string, opts?: { watch?: { kind: "movie" | "episode"; id: number }; startSecs?: number }) => void;
  onPlayInteractive?: (args: { libraryId: string; entryId: number; title: string; fresh?: boolean }) => void;
  onPlayEpisode?: (args: { libraryId: string; showId: number; showTitle: string; startEpisodeId: number; startSecs?: number }) => void;
}

export function MainContent({
  entries,
  people,
  playlists,
  genres,
  onSelectGenre,
  activeView,
  searchResults,
  selectedEntry,
  loading,
  breadcrumbs,
  coverSize,
  onCoverSizeChange,
  search,
  onSearchChange,
  onNavigate,
  onNavigateToPerson,
  onTogglePersonFavorite,
  peopleMode,
  onPeopleModeChange,
  onNavigateToPlaylist,
  onPlaylistChanged,
  onBreadcrumbClick,
  selectedLibrary,
  hasLibraries,
  sortMode,
  onSortModeChange,
  presets,
  selectedPresetId,
  onChangePreset,
  onSavePreset,
  onDeletePreset,
  onSortOrderChange,
  onRenameEntry,
  onTitleChanged,
  onSetCover,
  onAddCover,
  onDeleteCover,
  onMoveEntry,
  onCreateCollection,
  onDeleteEntry,
  onRescan,
  onEntryChanged,
  getCoverUrl,
  getCoverAspect,
  getFullCoverUrl,
  scrollContainerRef,
  onPlayFile,
  onPlayInteractive,
  onPlayEpisode,
}: MainContentProps) {
  const [coverDialogEntry, setCoverDialogEntry] = useState<MediaEntry | null>(
    null
  );
  const [coverDialogMode, setCoverDialogMode] = useState<"select" | "delete">("select");
  const [savePresetOpen, setSavePresetOpen] = useState(false);

  const openCoverDialog = useCallback((entry: MediaEntry, mode: "select" | "delete") => {
    setCoverDialogMode(mode);
    setCoverDialogEntry(entry);
  }, []);

  const [tmdbImagesEntry, setTmdbImagesEntry] = useState<{ entry: MediaEntry; tmdbId: string } | null>(null);

  const openTmdbImages = useCallback(async (entry: MediaEntry) => {
    if (!selectedLibrary) return;
    try {
      // The two commands take differently-named id args (showId vs entryId).
      const detail = entry.entry_type === "show"
        ? await invoke<{ tmdb_id: string | null }>("get_show_detail", { showId: entry.id })
        : await invoke<{ tmdb_id: string | null }>("get_movie_detail", { entryId: entry.id });
      if (!detail.tmdb_id) {
        toast.error("Match to TMDB first");
        return;
      }
      setTmdbImagesEntry({ entry, tmdbId: detail.tmdb_id });
    } catch (e) {
      toast.error(String(e));
    }
  }, [selectedLibrary]);

  const deletePlaylistCollection = useCallback(async (collectionId: number) => {
    try {
      await invoke("delete_playlist_collection", { collectionId });
      if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
    } catch (err) {
      toast.error(String(err));
    }
  }, [selectedLibrary, onPlaylistChanged]);

  // Keep the dialog's entry in sync with the live entries/selectedEntry so covers list updates after delete
  const liveCoverDialogEntry = useMemo(() => {
    if (!coverDialogEntry) return null;
    if (selectedEntry?.id === coverDialogEntry.id) return selectedEntry;
    const found = entries.find((e) => e.id === coverDialogEntry.id);
    return found ?? coverDialogEntry;
  }, [coverDialogEntry, entries, selectedEntry]);
  const isSearching = searchResults != null;
  const filteredEntries = isSearching ? searchResults : entries;

  // Jump rail for big grids — letters in alphabetical sort, decades in date sort.
  // Hidden while searching (ranked order) and for grids small enough to scan.
  const gridScrubber = useMemo(() => {
    if (selectedEntry || loading || isSearching) return null;
    if (sortMode === "alpha") {
      const seen = new Set<string>();
      for (const e of filteredEntries) seen.add(letterForTitle(e.title));
      if (seen.size < 2) return null;
      const labels = [...seen].sort((a, b) => (a === "#" ? -1 : b === "#" ? 1 : a.localeCompare(b)));
      return { labels, find: (l: string) => filteredEntries.find((e) => letterForTitle(e.title) === l) };
    }
    if (sortMode === "date" || sortMode === "year") {
      // Year buckets (YEAR_RAIL_STEP) in encounter order so the rail follows the sort direction.
      const labels: string[] = [];
      const seen = new Set<string>();
      for (const e of filteredEntries) {
        const b = yearBucket(e.year);
        if (b && !seen.has(b)) {
          seen.add(b);
          labels.push(b);
        }
      }
      if (labels.length < 2) return null;
      return { labels, find: (l: string) => filteredEntries.find((e) => yearBucket(e.year) === l) };
    }
    return null;
  }, [selectedEntry, loading, isSearching, filteredEntries, sortMode]);

  // Whether a jump rail applies to THIS entry set in *any* scrubbable mode (≥2
  // letters or ≥2 decades) — deliberately independent of the current sort. The
  // rail floats (absolute), so the only thing that changes the grid width is the
  // reserved right gutter; keying it off this (not `gridScrubber`) keeps the
  // gutter stable when toggling custom sort, which never shows a rail, so the
  // grid no longer reflows on the switch. Views with no grid rail at all
  // (detail/loading/search) reserve nothing.
  const scrubberApplies = useMemo(() => {
    if (selectedEntry || loading || isSearching) return false;
    const letters = new Set<string>();
    for (const e of filteredEntries) {
      letters.add(letterForTitle(e.title));
      if (letters.size >= 2) return true;
    }
    const buckets = new Set<string>();
    for (const e of filteredEntries) {
      const b = yearBucket(e.year);
      if (b) buckets.add(b);
      if (buckets.size >= 2) return true;
    }
    return false;
  }, [selectedEntry, loading, isSearching, filteredEntries]);

  const jumpToGridEntry = useCallback(
    (label: string) => {
      const target = gridScrubber?.find(label);
      const container = scrollContainerRef.current;
      if (!target || !container) return;
      // window.CSS — the bare `CSS` identifier is dnd-kit's transform helper here.
      const sel = `[data-flip-id="${window.CSS.escape(String(sortableIdFor(target)))}"]`;
      gridRef.current?.querySelector(sel)?.scrollIntoView({ block: "start" });
      // content-visibility makes offsets above the target ESTIMATES until that
      // region renders, so the first jump can land off (worse at some zoom
      // levels). Re-align over a few frames until the target stops moving —
      // each pass renders the surroundings and tightens the layout.
      let attempts = 0;
      const settle = () => {
        const el = gridRef.current?.querySelector(sel);
        if (!el) return;
        const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
        if (Math.abs(delta) > 2 && attempts < 8) {
          attempts++;
          el.scrollIntoView({ block: "start" });
          requestAnimationFrame(settle);
        }
      };
      requestAnimationFrame(settle);
    },
    [gridScrubber, scrollContainerRef],
  );

  const [dragId, setDragId] = useState<string | number | null>(null);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MediaEntry | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  // Confirm-before-delete targets (empty/cheap ones skip confirmation entirely).
  const [deletePlaylistCollectionTarget, setDeletePlaylistCollectionTarget] = useState<MediaEntry | null>(null);
  const [deletePresetTarget, setDeletePresetTarget] = useState<SortPreset | null>(null);

  // Playlist-related dialog state
  const [addToPlaylistFor, setAddToPlaylistFor] = useState<MediaEntry | null>(null);
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [renameCollectionFor, setRenameCollectionFor] = useState<MediaEntry | null>(null);

  const handleDelete = useCallback(async (entryId: number) => {
    setDeletingId(entryId);
    try {
      await onDeleteEntry(entryId);
    } finally {
      setDeletingId(null);
    }
  }, [onDeleteEntry]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 500, tolerance: 5 } })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragId(event.active.id as string | number);
  }, []);

  // ── Drop-into-container animation support ─────────────────────────
  // When a card is dropped into a collection / the move-up zone, the overlay
  // "absorbs" into the target (see dropAnimation) and the source card stays
  // hidden until the refreshed entry list arrives — without this it would pop
  // back at its old spot and then vanish.
  const absorbTargetRef = useRef<{ x: number; y: number } | null>(null);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | number | null>(null);

  const beginAbsorb = useCallback((over: Over, activeId: string | number) => {
    const r = over.rect;
    absorbTargetRef.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    setPendingRemovalId(activeId);
    // Safety net: if the move fails and the grid never changes, unhide the card.
    window.setTimeout(() => {
      setPendingRemovalId((cur) => (cur === activeId ? null : cur));
    }, 2000);
  }, []);

  // Clear the hide as soon as the entry has actually left the list.
  useEffect(() => {
    if (pendingRemovalId == null) return;
    if (!filteredEntries.some((e) => sortableIdFor(e) === pendingRemovalId)) {
      setPendingRemovalId(null);
    }
  }, [filteredEntries, pendingRemovalId]);

  // ── FLIP layout animation for the grid ────────────────────────────
  // When cards change layout position between renders (entry moved into a
  // collection, deleted, reordered), slide them from their previous spot
  // instead of teleporting. Positions use offsetLeft/Top, which ignore both
  // scrolling and dnd-kit's live drag transforms. The render that ends a drag
  // is skipped so optimistic reorders don't double-animate.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const flipPositionsRef = useRef<Map<string, { x: number; y: number; w: number; h: number }>>(new Map());
  const flipKeysRef = useRef<string[]>([]);
  const wasDraggingRef = useRef(false);
  // Tracks the view whose cards last played the page load-in, so it fires once per
  // navigation rather than on every in-view re-render.
  const loadedInViewRef = useRef<string | null>(null);
  // Cover resizes are animated by CSS width transitions on the cards themselves;
  // FLIP sits those renders out (it would fight the transition).
  const prevCoverSizeRef = useRef(coverSize);
  // Navigation (switching All/Movies/TV, entering/leaving collections, toggling
  // search) shows the same entries at unrelated positions — FLIP would send them
  // flying across the grid. Rebaseline without animating on those renders.
  const navKey = `${activeView ? viewCacheKey(activeView) : "none"}|${breadcrumbs[breadcrumbs.length - 1]?.id ?? "root"}|${isSearching ? "s" : ""}`;
  const prevNavKeyRef = useRef(navKey);
  // Page load-in key: changes when the view or parent collection changes (but NOT on search
  // toggle or in-place refreshes), so the "drop in" plays once per page you navigate to.
  const loadInKey = `${activeView ? viewCacheKey(activeView) : "none"}|${breadcrumbs[breadcrumbs.length - 1]?.id ?? "root"}`;

  useLayoutEffect(() => {
    const grid = gridRef.current;
    const dragging = dragId != null;
    const justDropped = wasDraggingRef.current && !dragging;
    wasDraggingRef.current = dragging;
    const resized = prevCoverSizeRef.current !== coverSize;
    prevCoverSizeRef.current = coverSize;
    const navigated = prevNavKeyRef.current !== navKey;
    prevNavKeyRef.current = navKey;
    if (!grid) {
      flipPositionsRef.current = new Map();
      // The grid isn't mounted. On a non-grid VIEW (people / genres list / playlists
      // list) — not a detail page — forget the last loaded-in grid so returning to
      // ANY grid, including the one we left, replays the drop-in. A detail page keeps
      // a grid-kind activeView + selectedEntry, so we leave the marker intact and
      // back-from-detail stays still, as before.
      if (!selectedEntry) loadedInViewRef.current = null;
      return;
    }
    const children = Array.from(grid.children) as HTMLElement[];

    // ── List-change FLIP (drops, deletes, reorders): layout positions ──
    const prev = flipPositionsRef.current;
    const next = new Map<string, { x: number; y: number; w: number; h: number }>();
    const keys: string[] = [];
    for (const child of children) {
      const key = child.dataset.flipId;
      if (!key) continue;
      keys.push(key);
      next.set(key, { x: child.offsetLeft, y: child.offsetTop, w: child.offsetWidth, h: child.offsetHeight });
    }

    // ── Page load-in ──────────────────────────────────────────────────
    // The first time a view shows its cards (you navigated here, cache hit or miss),
    // every card drops in — slide-down + scale + fade. This is the look the first
    // spinner→grid reveal has; here it's made to fire consistently on every navigation
    // instead of only when the FLIP timing happened to line up. Rebaseline + bail so the
    // list-change FLIP below doesn't also run on this render.
    if (
      keys.length > 0 &&
      loadedInViewRef.current !== loadInKey &&
      !dragging && !justDropped && !resized
    ) {
      loadedInViewRef.current = loadInKey;
      flipKeysRef.current = keys;
      flipPositionsRef.current = next;
      playDropIn(children.filter((c) => c.dataset.flipId));
      return;
    }

    // Only animate when the list composition/order actually changed. Positions can
    // also drift between renders without any list change (cover images finish
    // loading and grow their cards, window resizes) — the baseline is stale then,
    // and animating against it makes cards jump on otherwise-benign re-renders.
    const prevKeys = flipKeysRef.current;
    flipKeysRef.current = keys;
    const listChanged =
      prevKeys.length !== keys.length || keys.some((k, i) => prevKeys[i] !== k);
    if (!dragging && !justDropped && !resized && !navigated && listChanged) {
      // Counts only cards that actually move, so the stagger cascades across
      // the movers rather than indexing the whole grid.
      let animated = 0;
      for (const child of children) {
        const key = child.dataset.flipId;
        if (!key) continue;
        const old = prev.get(key);
        if (!old) continue;
        const now = next.get(key)!;
        const dx = old.x - now.x;
        const dy = old.y - now.y;
        if (dx !== 0 || dy !== 0) {
          child.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: "translate(0px, 0px)" },
            ],
            {
              duration: 280,
              easing: "cubic-bezier(0.2, 0, 0, 1)",
              // Stagger for a choreographed cascade; fill backwards holds the
              // starting keyframe while a card waits its turn.
              delay: Math.min(animated * 8, 160),
              fill: "backwards",
            },
          );
          animated++;
        }
      }
      // Brand-new cards (no prior position) fall into place: a brief slide-down
      // + fade so an added collection reads as "dropping in" while the existing
      // cards shift past it. Gated on a non-empty prior list so the initial
      // populate of a view doesn't animate every card.
      if (prevKeys.length > 0) {
        for (const child of children) {
          const key = child.dataset.flipId;
          if (!key || prev.has(key)) continue; // movers handled above; only new cards here
          child.animate(
            [
              { transform: "translateY(-12px) scale(0.96)", opacity: 0 },
              { transform: "translateY(0px) scale(1)", opacity: 1 },
            ],
            { duration: 280, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "backwards" },
          );
        }
      }
    }
    flipPositionsRef.current = next;
  });

  // Creating a collection scrolls it into view if it sorted below the fold, so
  // there's feedback (and the fall-in animation is seen) instead of it silently
  // appearing off-screen. We stash the new id, then scroll once the refreshed
  // grid actually contains the card.
  const [pendingNewCollectionId, setPendingNewCollectionId] = useState<number | null>(null);
  const handleCreateCollection = useCallback(async (name: string) => {
    const id = await onCreateCollection(name);
    if (id != null) setPendingNewCollectionId(id);
  }, [onCreateCollection]);
  useEffect(() => {
    if (pendingNewCollectionId == null) return;
    if (!filteredEntries.some((e) => e.id === pendingNewCollectionId)) return;
    setPendingNewCollectionId(null);
    const container = scrollContainerRef.current;
    const el = gridRef.current?.querySelector<HTMLElement>(
      `[data-flip-id="${window.CSS.escape(String(pendingNewCollectionId))}"]`,
    );
    if (!container || !el) return;
    // Only scroll when it's not already fully in view — no jolt when the new
    // collection sorts into the visible region.
    const elRect = el.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    if (elRect.top < cRect.top || elRect.bottom > cRect.bottom) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [pendingNewCollectionId, filteredEntries, scrollContainerRef]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const overId = String(over.id);

      // Resolve the active card back to the underlying entry so we know whether
      // it's a library media_entry, a playlist link, or a nested playlist_collection.
      const activeEntry = filteredEntries.find((e) => sortableIdFor(e) === active.id);
      if (!activeEntry) return;

      const inPlaylist = activeView?.kind === "playlist-detail";

      // ── Playlist moves ────────────────────────────────────────────
      if (inPlaylist && activeView.kind === "playlist-detail") {
        // Dropping onto a nested playlist_collection card.
        if (overId.startsWith("pc-drop-")) {
          const targetPcId = Number(overId.slice("pc-drop-".length));
          if (activeEntry.entry_type === "playlist_collection" && activeEntry.id === targetPcId) return;
          beginAbsorb(over, active.id);
          try {
            if (activeEntry.link_id != null) {
              await invoke("move_media_link", {
                linkId: activeEntry.link_id,
                parentPlaylistId: null,
                parentCollectionId: targetPcId,
              });
            } else if (activeEntry.entry_type === "playlist_collection") {
              await invoke("move_playlist_collection", {
                collectionId: activeEntry.id,
                parentPlaylistId: null,
                parentCollectionId: targetPcId,
              });
            } else {
              return;
            }
            if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
          } catch (e) {
            toast.error(String(e));
          }
          return;
        }

        // Dropping onto the move-up zone — re-parent to whatever is one level above us.
        if (overId === "move-up-zone" && activeView.collectionId !== null) {
          // The parent of the current nested collection: find its row in the DB via
          // the second-to-last view-carrying breadcrumb. That breadcrumb's view is
          // either the root playlist (collectionId === null) or another collection.
          const parentCrumb = breadcrumbs[breadcrumbs.length - 2];
          const parentView = parentCrumb?.view;
          let parentPlaylistId: number | null = null;
          let parentCollectionId: number | null = null;
          if (parentView && parentView.kind === "playlist-detail") {
            if (parentView.collectionId === null) {
              parentPlaylistId = parentView.playlistId;
            } else {
              parentCollectionId = parentView.collectionId;
            }
          } else {
            // No clean parent breadcrumb — fall back to the root of the current playlist.
            parentPlaylistId = activeView.playlistId;
          }
          beginAbsorb(over, active.id);
          try {
            if (activeEntry.link_id != null) {
              await invoke("move_media_link", {
                linkId: activeEntry.link_id,
                parentPlaylistId,
                parentCollectionId,
              });
            } else if (activeEntry.entry_type === "playlist_collection") {
              await invoke("move_playlist_collection", {
                collectionId: activeEntry.id,
                parentPlaylistId,
                parentCollectionId,
              });
            } else {
              return;
            }
            if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
          } catch (e) {
            toast.error(String(e));
          }
          return;
        }

        // In-level sortable reorder inside a playlist. over.id is another item's
        // sortable id ("link-N" or "pc-N"); onSortOrderChange routes to
        // update_playlist_sort_order in App.tsx because activeView is playlist-detail.
        if (sortMode !== "custom") return;
        const oldIndex = filteredEntries.findIndex((e) => sortableIdFor(e) === active.id);
        const newIndex = filteredEntries.findIndex((e) => sortableIdFor(e) === over.id);
        if (oldIndex === -1 || newIndex === -1) return;
        const reordered = [...filteredEntries];
        const [moved] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, moved);
        onSortOrderChange(reordered);
        return;
      }

      // ── Library moves (unchanged) ─────────────────────────────────
      const entryId = Number(active.id);
      if (overId === "move-up-zone") {
        const currentParentId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
        const grandparentId = breadcrumbs.length >= 3 ? breadcrumbs[breadcrumbs.length - 2].id : null;
        beginAbsorb(over, active.id);
        await onMoveEntry(entryId, grandparentId, currentParentId);
      } else if (overId.startsWith("collection-")) {
        const targetId = Number(overId.replace("collection-", ""));
        if (targetId !== entryId) {
          beginAbsorb(over, active.id);
          // Pin the scroll to the collection we just dropped onto: record where its
          // card sits in the viewport now, so the post-move reload can keep it there
          // instead of snapping back to the (possibly far-away) source row.
          const container = scrollContainerRef.current;
          const targetEl = gridRef.current?.querySelector<HTMLElement>(`[data-flip-id="${window.CSS.escape(String(targetId))}"]`);
          const anchor = container && targetEl
            ? { id: targetId, viewportTop: targetEl.getBoundingClientRect().top - container.getBoundingClientRect().top }
            : undefined;
          await onMoveEntry(entryId, targetId, null, anchor);
        }
      } else {
        // Sortable reorder (over.id is the numeric entry id from useSortable)
        if (sortMode !== "custom") return;
        const targetId = over.id as number;
        const oldIndex = filteredEntries.findIndex((e) => e.id === entryId);
        const newIndex = filteredEntries.findIndex((e) => e.id === targetId);
        if (oldIndex === -1 || newIndex === -1) return;
        const reordered = [...filteredEntries];
        const [moved] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, moved);
        onSortOrderChange(reordered);
      }
    },
    [breadcrumbs, onMoveEntry, sortMode, filteredEntries, onSortOrderChange, activeView, selectedLibrary, onPlaylistChanged, beginAbsorb]
  );

  const dragEntry = dragId != null
    ? filteredEntries.find((e) => sortableIdFor(e) === dragId) ?? null
    : null;

  // Default drops animate the overlay back to the source card. When the drop
  // went into a container (collection / move-up zone), fly into the target and
  // shrink away instead.
  const dropAnimation: DropAnimation = useMemo(
    () => ({
      duration: 280,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      keyframes({ dragOverlay, transform }) {
        const absorb = absorbTargetRef.current;
        absorbTargetRef.current = null;
        if (absorb && dragOverlay.rect) {
          const r = dragOverlay.rect;
          const dx = absorb.x - (r.left + r.width / 2);
          const dy = absorb.y - (r.top + r.height / 2);
          return [
            {
              transform: `translate3d(${transform.initial.x}px, ${transform.initial.y}px, 0) scale(1)`,
              opacity: "1",
            },
            {
              transform: `translate3d(${transform.initial.x + dx}px, ${transform.initial.y + dy}px, 0) scale(0.15)`,
              opacity: "0",
            },
          ];
        }
        return [
          { transform: CSS.Transform.toString(transform.initial) ?? "translate3d(0, 0, 0)" },
          { transform: CSS.Transform.toString(transform.final) ?? "translate3d(0, 0, 0)" },
        ];
      },
      sideEffects: defaultDropAnimationSideEffects({
        styles: { active: { opacity: "0" } },
      }),
    }),
    [],
  );

  // Prefer collection/move-up droppables (pointerWithin), fall back to closestCenter for sort
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointerCollisions = pointerWithin(args);
    // Filter for our special droppables (collection-* and move-up-zone)
    const specialCollisions = pointerCollisions.filter((c) => {
      const id = String(c.id);
      return (
        id === "move-up-zone" ||
        id.startsWith("collection-") ||
        id.startsWith("pc-drop-")
      );
    });
    if (specialCollisions.length > 0) return specialCollisions;
    return closestCenter(args);
  }, []);

  // Show the move-up droppable whenever dragging something up one level is meaningful.
  // Library-root nests via collection breadcrumbs (breadcrumbs.length > 1).
  // Playlist-detail is "inside" only when the active view points at a nested
  // playlist_collection — at the playlist root there's nothing above us.
  const isInsideCollection =
    activeView?.kind === "playlist-detail"
      ? activeView.collectionId !== null
      : breadcrumbs.length > 1;

  const breadcrumbBar = (
    <Breadcrumb className="border-b border-border">
      <BreadcrumbList className="!flex-nowrap overflow-x-auto px-4 py-2 pr-8 text-xs font-medium">
        {breadcrumbs.map((crumb, i) => (
          <BreadcrumbUIItem key={i} className="whitespace-nowrap">
            {i > 0 && <BreadcrumbSeparator />}
            {i === breadcrumbs.length - 1 ? (
              <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<button onClick={() => onBreadcrumbClick(i)} />}>
                {crumb.title}
              </BreadcrumbLink>
            )}
          </BreadcrumbUIItem>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );

  if (activeView?.kind === "people-list" || activeView?.kind === "people-all") {
    const role: PersonRole = activeView.kind === "people-all" ? "all" : activeView.role;
    return (
      <main className="flex flex-1 flex-col overflow-hidden bg-background">
        {breadcrumbBar}
        {loading && (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        )}
        {!loading && people && people.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No people found.</p>
        )}
        {!loading && people && people.length > 0 && (
          <PeoplePage
            // Keyed per view: the mode is per-page state and must not bleed
            // between e.g. Actors and Composers when React reuses the instance.
            key={viewCacheKey(activeView)}
            people={people}
            libraryId={activeView.libraryId}
            role={role}
            initialMode={peopleMode}
            onModeChange={onPeopleModeChange}
            onSelectPerson={(p) => onNavigateToPerson(p, role)}
            onToggleFavorite={onTogglePersonFavorite}
            scrollContainerRef={scrollContainerRef}
          />
        )}
      </main>
    );
  }

  if (activeView?.kind === "genres") {
    // Intentionally basic — placement first, we'll iterate on the look.
    return (
      <main className="flex flex-1 flex-col overflow-hidden bg-background">
        {breadcrumbBar}
        {loading && (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        )}
        {!loading && genres && genres.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No genres found.</p>
        )}
        {!loading && genres && genres.length > 0 && (
          <div ref={scrollContainerRef} className="flex flex-wrap content-start gap-2 overflow-y-auto p-4">
            {genres.map((g) => (
              <button
                key={g.name}
                onClick={() => onSelectGenre(activeView.libraryId, g.name)}
                className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span>{g.name}</span>
                <span className="text-xs text-muted-foreground">{g.count}</span>
              </button>
            ))}
          </div>
        )}
      </main>
    );
  }

  if (activeView?.kind === "playlists") {
    return (
      <PlaylistsView
        libraryId={activeView.libraryId}
        playlists={playlists}
        loading={loading}
        breadcrumbBar={breadcrumbBar}
        scrollContainerRef={scrollContainerRef}
        onNavigateToPlaylist={onNavigateToPlaylist}
        onPlaylistChanged={onPlaylistChanged}
        getFullCoverUrl={getFullCoverUrl}
        search={search}
        onSearchChange={onSearchChange}
        coverSize={coverSize}
        onCoverSizeChange={onCoverSizeChange}
        sortMode={sortMode}
        onSortModeChange={onSortModeChange}
        presets={presets}
        selectedPresetId={selectedPresetId}
        onChangePreset={onChangePreset}
        onSavePreset={onSavePreset}
        onDeletePreset={onDeletePreset}
      />
    );
  }

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {selectedLibrary && (
        <>
          {breadcrumbBar}

          {/* Person-detail header */}
          {activeView?.kind === "person-detail" && !selectedEntry && (
            <PersonDetailHeader
              name={activeView.personName}
              imagePath={activeView.personImage}
              role={activeView.role}
              workCount={entries.length}
            />
          )}

          {/* Search + Sort + Size Slider. Hidden on person pages — the filmography
              is a small curated list, always alphabetical. */}
          {!selectedEntry && activeView?.kind !== "person-detail" && <div className="flex items-center gap-3 border-b border-border px-4 py-2">
            <div className="relative flex-1">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search..."
                className="h-8 pl-8 text-sm"
              />
            </div>
            <div className="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                <ArrowUpDown size={12} />
                {(() => {
                  // When a preset is active the dropdown label shows the preset name — the
                  // underlying sort_mode is still 'custom' but the user's mental model is
                  // "I'm on the Chronological preset".
                  if (selectedPresetId != null) {
                    const p = presets.find((p) => p.id === selectedPresetId);
                    if (p) return p.name;
                  }
                  return sortMode === "alpha"
                    ? "A\u2013Z"
                    : sortMode === "date" || sortMode === "year"
                      ? "Date"
                      : "Custom";
                })()}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onSortModeChange("alpha")}>
                  Alphabetical
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSortModeChange("date")}>
                  Date
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { onSortModeChange("custom"); onChangePreset(null); }}>
                  Custom
                </DropdownMenuItem>
                {presets.length > 0 && <DropdownMenuSeparator />}
                {presets.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => onChangePreset(p.id)}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{p.name}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeletePresetTarget(p);
                      }}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete preset ${p.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* Save-preset button: visible only in pristine custom sort at a sortable scope
                with items to save. Clicking opens the name dialog. */}
            {sortMode === "custom"
              && selectedPresetId === null
              && activeView
              && scopeKeyFor(activeView, breadcrumbs[breadcrumbs.length - 1]?.id ?? null) != null
              && filteredEntries.length > 0
              && (
                <button
                  onClick={() => setSavePresetOpen(true)}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  title="Save current order as a preset"
                >
                  <Save size={14} />
                </button>
              )
            }
            </div>
            <div className="flex w-32 items-center gap-2">
              <Slider
                value={[coverSize]}
                onValueChange={(v) =>
                  onCoverSizeChange(Array.isArray(v) ? v[0] : v)
                }
                min={100}
                max={400}
                step={10}
                className="w-full"
              />
            </div>
          </div>}
        </>
      )}

      {/* Content. The jump rail floats inside the right edge (the scrollbar keeps
          the page edge); content gets extra right padding so it never sits under it. */}
      <div className="relative flex min-h-0 flex-1">
      <div ref={scrollContainerRef} className={`min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4 ${scrubberApplies ? "pr-10" : ""}`}>
      {selectedEntry ? (
        selectedEntry.entry_type === "show"
          ? <ShowDetailPage entry={selectedEntry} selectedLibrary={selectedLibrary!} getCoverUrl={getCoverUrl} getFullCoverUrl={getFullCoverUrl} onEntryChanged={onEntryChanged} onTitleChanged={onTitleChanged} onChangeCover={() => openCoverDialog(selectedEntry, "select")} onAddCover={() => onAddCover(selectedEntry.id)} onDeleteCover={() => openCoverDialog(selectedEntry, "delete")} onPlayEpisode={onPlayEpisode} onPlayFile={onPlayFile} onNavigateToPerson={onNavigateToPerson} onSelectGenre={onSelectGenre} />
          : <EntryDetailPage entry={selectedEntry} selectedLibrary={selectedLibrary!} getCoverUrl={getCoverUrl} getFullCoverUrl={getFullCoverUrl} onEntryChanged={onEntryChanged} onTitleChanged={onTitleChanged} onChangeCover={() => openCoverDialog(selectedEntry, "select")} onAddCover={() => onAddCover(selectedEntry.id)} onDeleteCover={() => openCoverDialog(selectedEntry, "delete")} onPlayFile={onPlayFile} onPlayInteractive={onPlayInteractive} onNavigateToPerson={onNavigateToPerson} onSelectGenre={onSelectGenre} />
      ) : (
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-h-full flex-col" />}>
        {!selectedLibrary ? (
          <Empty className="border-none min-h-full">
            <EmptyHeader>
              <EmptyMedia>
                <LibraryBig size={48} className="text-muted-foreground" />
              </EmptyMedia>
              {hasLibraries ? (
                <>
                  <EmptyTitle>No library selected</EmptyTitle>
                  <EmptyDescription>Select a library from the sidebar to get started.</EmptyDescription>
                </>
              ) : (
                <>
                  <EmptyTitle>No libraries yet</EmptyTitle>
                  <EmptyDescription>Create a library from the sidebar to start organizing your media.</EmptyDescription>
                </>
              )}
            </EmptyHeader>
          </Empty>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : filteredEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {search ? "No results" : "Empty"}
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDragId(null)}
          >
            {isInsideCollection && <MoveUpDropZone isActive={dragId != null} />}
            <SortableContext
              items={filteredEntries.map(sortableIdFor)}
              strategy={rectSortingStrategy}
            >
              <div
                ref={gridRef}
                // gap-2.5: cards carry 8px of their own padding per side, so the
                // visible cover-to-cover distance is gap + 16px. Cards span two
                // implicit rows and subgrid onto them, so every cover in a row
                // shares one (bottom-aligned) track and every title the next —
                // covers keep their natural heights but their bottoms line up.
                className="grid gap-2.5"
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))`,
                  justifyItems: "center",
                }}
              >
                {filteredEntries.map((entry) => (
                  <SortableCoverCard
                    key={sortableIdFor(entry)}
                    sortableId={sortableIdFor(entry)}
                    entry={entry}
                    size={coverSize}
                    onNavigate={onNavigate}
                    onRename={onRenameEntry}
                    onChangeCover={() => openCoverDialog(entry, "select")}
                    onAddCover={() => onAddCover(entry.id, {
                      playlistCollection: entry.entry_type === "playlist_collection",
                    })}
                    onAddCoverFromTmdb={() => openTmdbImages(entry)}
                    onDeleteCover={() => openCoverDialog(entry, "delete")}
                    onDelete={async (entry) => {
                      // Empty collections delete immediately; non-empty ones confirm
                      // (their items move back to the parent, nothing touches disk).
                      if (entry.child_count === 0) {
                        handleDelete(entry.id);
                      } else {
                        setDeleteTarget(entry);
                      }
                    }}
                    deletingId={deletingId}
                    getCoverUrl={getCoverUrl}
                    getCoverAspect={getCoverAspect}
                    isDragActive={dragId != null}
                    pendingRemoval={pendingRemovalId != null && pendingRemovalId === sortableIdFor(entry)}
                    sortMode={sortMode}
                    onAddToPlaylist={selectedLibrary ? (e) => setAddToPlaylistFor(e) : undefined}
                    onRemoveLink={activeView?.kind === "playlist-detail" ? async (linkId) => {
                      try {
                        await invoke("remove_media_link", { linkId });
                        if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
                      } catch (err) {
                        toast.error(String(err));
                      }
                    } : undefined}
                    onRenamePlaylistCollection={activeView?.kind === "playlist-detail" ? (e) => setRenameCollectionFor(e) : undefined}
                    onDeletePlaylistCollection={activeView?.kind === "playlist-detail" ? (e) => {
                      // Empty groups delete straight away; ones with content confirm first.
                      if (e.child_count === 0) {
                        void deletePlaylistCollection(e.id);
                      } else {
                        setDeletePlaylistCollectionTarget(e);
                      }
                    } : undefined}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={dropAnimation}>
              {dragEntry && (
                <DragOverlayCard entry={dragEntry} size={coverSize} getCoverUrl={getCoverUrl} />
              )}
            </DragOverlay>
          </DndContext>
        )}
        </ContextMenuTrigger>
          <ContextMenuContent>
            {activeView?.kind === "playlist-detail" && (
              <ContextMenuItem onClick={() => setCreateCollectionOpen(true)}>
                <FolderPlus size={14} />
                Create collection here
              </ContextMenuItem>
            )}
            {activeView?.kind === "library-root" && selectedLibrary?.format === "video" && (
              <ContextMenuItem onClick={() => { setNewCollectionName(""); setNewCollectionOpen(true); }}>
                <FolderPlus size={14} />
                New Collection
              </ContextMenuItem>
            )}
            {activeView?.kind !== "playlist-detail" && (
              <ContextMenuItem onClick={async () => {
                if (!selectedLibrary) return;
                const toastId = toast.loading("Rescanning...");
                const unlisten = await listen<string>("scan-progress", (event) => {
                  toast.loading(event.payload, { id: toastId });
                });
                try {
                  const warnings = await invoke<string[]>("rescan_library", { libraryId: selectedLibrary.id });
                  if (warnings.length > 0) {
                    toast.warning(`Rescan complete — ${warnings.length} item${warnings.length === 1 ? "" : "s"} skipped`, {
                      id: toastId,
                      description: warnings.slice(0, 5).join("  •  ") + (warnings.length > 5 ? `  •  +${warnings.length - 5} more` : ""),
                      duration: 8000,
                    });
                  } else {
                    toast.success("Rescan complete", { id: toastId });
                  }
                  onRescan();
                } catch (err) {
                  toast.error(String(err), { id: toastId });
                } finally {
                  unlisten();
                }
              }}>
                <RefreshCw size={14} />
                Rescan
              </ContextMenuItem>
            )}
          </ContextMenuContent>
      </ContextMenu>
      )}
      </div>
      {gridScrubber && <ScrubberRail labels={gridScrubber.labels} onJump={jumpToGridEntry} />}
      </div>

      {/* New Collection Dialog */}
      <Dialog open={newCollectionOpen} onOpenChange={setNewCollectionOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New Collection</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Input
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              placeholder="Collection name"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newCollectionName.trim()) {
                  handleCreateCollection(newCollectionName.trim());
                  setNewCollectionOpen(false);
                }
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewCollectionOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newCollectionName.trim()}
              onClick={() => {
                handleCreateCollection(newCollectionName.trim());
                setNewCollectionOpen(false);
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Collection Confirmation Dialog (collections are virtual — nothing
          on disk is touched; the items inside move back to the parent) */}
      <Dialog open={deleteTarget != null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Collection</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete &ldquo;{deleteTarget?.title}&rdquo;? The {deleteTarget?.child_count === 1 ? "item" : "items"} inside will move out of the collection. Nothing is deleted from disk.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) handleDelete(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deletePlaylistCollectionTarget != null}
        onOpenChange={(open) => { if (!open) setDeletePlaylistCollectionTarget(null); }}
        title="Delete Collection"
        message={<>Delete &ldquo;{deletePlaylistCollectionTarget?.title}&rdquo;? Its links and nested collections will be removed from the playlist.</>}
        onConfirm={() => { if (deletePlaylistCollectionTarget) void deletePlaylistCollection(deletePlaylistCollectionTarget.id); }}
      />
      <ConfirmDialog
        open={deletePresetTarget != null}
        onOpenChange={(open) => { if (!open) setDeletePresetTarget(null); }}
        title="Delete Preset"
        message={<>Delete preset &ldquo;{deletePresetTarget?.name}&rdquo;?</>}
        onConfirm={() => { if (deletePresetTarget) onDeletePreset(deletePresetTarget.id); }}
      />

      <SortPresetSaveDialog
        open={savePresetOpen}
        onOpenChange={setSavePresetOpen}
        onSave={onSavePreset}
      />

      {/* Cover Carousel Dialog */}
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
          getCoverUrl={getFullCoverUrl}
        />
      )}

      {tmdbImagesEntry && selectedLibrary && (
        <TmdbImageBrowserDialog
          open={!!tmdbImagesEntry}
          onOpenChange={(open) => { if (!open) setTmdbImagesEntry(null); }}
          libraryId={selectedLibrary.id}
          entryId={tmdbImagesEntry.entry.id}
          tmdbId={tmdbImagesEntry.tmdbId}
          mediaType={tmdbImagesEntry.entry.entry_type === "show" ? "tv" : "movie"}
          onDownloaded={() => { onEntryChanged(); }}
        />
      )}

      {/* Add-to-playlist dialog (applies anywhere a media entry is right-clicked) */}
      <AddToPlaylistDialog
        open={addToPlaylistFor !== null}
        onOpenChange={(o) => { if (!o) setAddToPlaylistFor(null); }}
        libraryId={selectedLibrary?.id ?? null}
        entryId={addToPlaylistFor?.id ?? null}
        entryTitle={addToPlaylistFor?.title ?? null}
        onAdded={() => {
          if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
        }}
      />

      {/* Create-collection-here dialog for right-click inside a playlist-detail view.
          Parented to the playlist root when collectionId is null, else to the nested collection. */}
      <CreatePlaylistCollectionDialog
        open={createCollectionOpen}
        onOpenChange={setCreateCollectionOpen}
        parentPlaylistId={
          activeView?.kind === "playlist-detail" && activeView.collectionId === null
            ? activeView.playlistId : null
        }
        parentCollectionId={
          activeView?.kind === "playlist-detail" ? activeView.collectionId : null
        }
        onCreated={() => {
          if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
        }}
      />

      {/* Rename-nested-playlist-collection dialog */}
      <RenameDialog
        open={renameCollectionFor !== null}
        onOpenChange={(o) => { if (!o) setRenameCollectionFor(null); }}
        title="Rename collection"
        initialValue={renameCollectionFor?.title ?? ""}
        onSubmit={async (newName) => {
          if (!renameCollectionFor) return;
          try {
            await invoke("rename_playlist_collection", {
              collectionId: renameCollectionFor.id,
              newTitle: newName,
            });
            if (selectedLibrary) onPlaylistChanged(selectedLibrary.id);
          } catch (e) {
            toast.error(String(e));
          }
        }}
      />
    </main>
  );
}

function SortableCoverCard({
  entry,
  size,
  onNavigate,
  onRename,
  onChangeCover,
  onAddCover,
  onAddCoverFromTmdb,
  onDeleteCover,
  onDelete,
  onAddToPlaylist,
  onRemoveLink,
  onRenamePlaylistCollection,
  onDeletePlaylistCollection,
  sortableId,
  getCoverUrl,
  getCoverAspect,
  isDragActive,
  sortMode,
  deletingId,
  pendingRemoval,
}: {
  entry: MediaEntry;
  size: number;
  onNavigate: (entry: MediaEntry) => void;
  onRename: (entryId: number, newTitle: string) => Promise<string | null>;
  onChangeCover: () => void;
  onAddCover: () => void;
  onAddCoverFromTmdb: () => void;
  onDeleteCover: () => void;
  onDelete: (entry: MediaEntry) => Promise<void>;
  onAddToPlaylist?: (entry: MediaEntry) => void;
  onRemoveLink?: (linkId: number) => void;
  onRenamePlaylistCollection?: (entry: MediaEntry) => void;
  onDeletePlaylistCollection?: (entry: MediaEntry) => void;
  /** Overrides the useSortable id. Playlist views need string ids so links and
   *  nested playlist_collections don't collide with each other or with real
   *  media_entry ids. Library views can omit this and the card falls back to entry.id. */
  sortableId?: string | number;
  getCoverUrl: (filePath: string) => string;
  getCoverAspect: (filePath: string) => number | undefined;
  isDragActive: boolean;
  sortMode: string;
  deletingId: number | null;
  /** True while this card's drop-into-container move is settling — keeps it
   *  hidden so it doesn't pop back at its old spot before the grid refreshes. */
  pendingRemoval?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setSortRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId ?? entry.id });

  const isCollection = entry.entry_type === "collection";
  const isPlaylistCollection = entry.entry_type === "playlist_collection";
  const isDropTarget = isCollection || isPlaylistCollection;

  // Optimistic watch state: entry lists are cached upstream, so after
  // mark-watched/unwatched from this card's menu the card corrects itself
  // locally and the caches catch up on their next reload.
  const [watchOverride, setWatchOverride] = useState<"watched" | "unwatched" | null>(null);
  useEffect(() => setWatchOverride(null), [entry.id, entry.watched, entry.unwatched]);
  const isWatched = watchOverride ? watchOverride === "watched" : entry.watched;
  const isUnwatched = watchOverride ? watchOverride === "unwatched" : entry.unwatched;
  // Different prefixes so the drag-end handler knows which backend to call.
  const dropId = isPlaylistCollection
    ? `pc-drop-${entry.id}`
    : `collection-${entry.id}`;
  const { setNodeRef: setCollectionDropRef, isOver } = useDroppable({
    id: dropId,
    disabled: !isDropTarget || isDragging,
  });

  const setRef = useCallback(
    (node: HTMLElement | null) => {
      setSortRef(node);
      if (isDropTarget) setCollectionDropRef(node);
    },
    [setSortRef, setCollectionDropRef, isDropTarget]
  );

  // Only show sort shift animation in custom sort mode
  const style = {
    transform: sortMode === "custom" ? CSS.Transform.toString(transform) : undefined,
    transition: sortMode === "custom" ? transition : undefined,
  };

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const isDeleting = deletingId === entry.id;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (isRenaming) {
      submittedRef.current = false;
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const startRename = () => {
    setRenameValue(entry.title);
    setIsRenaming(true);
  };

  const submitRename = async () => {
    if (submittedRef.current) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === entry.title) {
      setIsRenaming(false);
      return;
    }
    submittedRef.current = true;
    setRenameLoading(true);
    const error = await onRename(entry.id, trimmed);
    setRenameLoading(false);
    setIsRenaming(false);
    if (error) {
      toast.error(error);
    }
  };

  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getCoverUrl(coverPath) : null;
  // If the cover's real aspect was captured during preload, reserve the exact box height
  // up front so the card doesn't resize when the image paints (no row shift).
  const coverAspect = coverPath ? getCoverAspect(coverPath) : undefined;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={setRef}
            {...attributes}
            {...listeners}
            data-flip-id={String(sortableId ?? entry.id)}
            onClick={() => !isRenaming && !isDragging && onNavigate(entry)}
          />
        }
        className={`group grid justify-items-center rounded-md p-2 text-left ${
          isDragging || pendingRemoval ? "pointer-events-none opacity-0" : ""
        } ${isOver && isDragActive ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}
        style={{ ...style, maxWidth: size, gridRow: "span 2", gridTemplateRows: "subgrid" }}
      >
        {/* content-visibility lives on the cover box, NOT the card root: it brings
            paint containment, and on the root it would clip the hover lift (the
            cover translates above the card's padding). Here the clip box is the
            already-overflow-hidden cover and transforms along with the hover. */}
        <div
          className="relative self-end overflow-hidden rounded-[3px] bg-muted shadow-md ring-1 ring-foreground/10 transition-[translate,scale] duration-200 group-hover:-translate-y-1 group-hover:scale-[1.04] group-hover:shadow-xl group-hover:ring-foreground/25"
          style={
            coverAspect
              ? {
                  // Known aspect → reserve the exact box so the image can't shift the row on load.
                  width: size - 16,
                  aspectRatio: String(coverAspect),
                  contentVisibility: "auto",
                  containIntrinsicSize: `${size - 16}px ${Math.round((size - 16) / coverAspect)}px`,
                }
              : {
                  width: size - 16,
                  // Skips layout/paint/decode for offscreen covers; estimates a 2:3 poster.
                  contentVisibility: "auto",
                  containIntrinsicSize: `${size - 16}px ${Math.round((size - 16) * 1.5)}px`,
                }
          }
        >
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={entry.title}
              loading="lazy"
              decoding="async"
              // Covers cached before thumbnails existed for app-added images
              // 404 on the thumb path — fall back to the full-res original.
              onError={(e) => {
                const img = e.currentTarget;
                if (!img.dataset.fullFallback && coverPath) {
                  img.dataset.fullFallback = "1";
                  img.src = convertFileSrc(coverPath);
                }
              }}
              // With a reserved box the image fills it exactly (real aspect → no crop);
              // otherwise it keeps its natural height.
              className={coverAspect ? "pointer-events-none h-full w-full object-cover" : "pointer-events-none w-full"}
              style={coverAspect ? undefined : { maxHeight: size * 2 }}
              draggable={false}
            />
          ) : (
            <div className="flex aspect-[2/3] w-full items-center justify-center">
              {entry.entry_type === "movie" ? (
                <Film size={size * 0.3} className="text-muted-foreground" />
              ) : entry.entry_type === "show" ? (
                <Tv size={size * 0.3} className="text-muted-foreground" />
              ) : (
                <Folder size={size * 0.3} className="text-muted-foreground" />
              )}
            </div>
          )}
          {/* Top-right badge stack. Watched is the library default and goes
              unbadged; the notable state is DELIBERATELY unwatched. */}
          <div className="absolute right-1 top-1 flex flex-col items-end gap-1">
            {isCollection && (
              <div className="rounded-sm bg-black/70 p-1 text-white backdrop-blur-sm" title="Collection">
                <LayoutGrid size={12} />
              </div>
            )}
            {entry.interactive && (
              <div
                className="rounded-sm bg-black/70 p-1 text-white backdrop-blur-sm"
                title="Interactive — you make choices while it plays"
              >
                <GitBranch size={12} />
              </div>
            )}
            {isUnwatched && (
              <div className="rounded-sm bg-black/70 p-1 text-white backdrop-blur-sm" title="Marked unwatched">
                <EyeOff size={12} />
              </div>
            )}
          </div>
          {!isWatched && entry.watch_progress != null && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.round(Math.min(1, Math.max(0, entry.watch_progress)) * 100)}%` }}
              />
            </div>
          )}
        </div>
        <div className="w-full">
          {isDeleting ? (
            <div className="flex items-center gap-1.5 px-1">
              <Spinner className="size-3" />
              <span className="truncate text-sm text-muted-foreground">{entry.title}</span>
            </div>
          ) : renameLoading ? (
            <div className="flex items-center gap-1.5 px-1">
              <Spinner className="size-3" />
              <span className="truncate text-sm text-muted-foreground">{renameValue}</span>
            </div>
          ) : isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") {
                  submittedRef.current = true;
                  setIsRenaming(false);
                }
              }}
              onBlur={submitRename}
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded bg-transparent px-1 text-sm font-medium outline-none ring-1 ring-primary"
              style={{ userSelect: "text" }}
            />
          ) : (
            <>
              <p className="text-sm font-medium">{entry.title}</p>
              {/* Person-page filmography shows the character ("as …") instead of the usual subtitle */}
              {entry.role_display ? (
                <p className="text-xs text-muted-foreground">{entry.role_display}</p>
              ) : (entry.season_display || entry.collection_display || entry.year) && (
                <p className="text-xs text-muted-foreground">{[entry.season_display || entry.collection_display, entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`].filter(Boolean).join(", ")}</p>
              )}
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {entry.entry_type === "playlist_collection" ? (
          <>
            {onRenamePlaylistCollection && (
              <ContextMenuItem onClick={() => onRenamePlaylistCollection(entry)}>
                <Pencil size={14} />
                Rename
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={onAddCover}>
              <ImageIcon size={14} />
              Add local cover
            </ContextMenuItem>
            <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
              <ImageIcon size={14} />
              Change cover
            </ContextMenuItem>
            <ContextMenuItem onClick={onDeleteCover} disabled={entry.covers.length < 1}>
              <Trash2 size={14} />
              Delete cover
            </ContextMenuItem>
            {onDeletePlaylistCollection && (
              <ContextMenuItem
                onClick={() => onDeletePlaylistCollection(entry)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={14} />
                Delete collection
              </ContextMenuItem>
            )}
          </>
        ) : (
          <>
            {entry.link_id == null && (
              <ContextMenuItem onClick={startRename}>
                <Pencil size={14} />
                Rename
              </ContextMenuItem>
            )}
            {/* Add/Delete cover mutate the target media_entry (shared with the library),
                which we don't want from inside a playlist — only the per-link cover
                override (Change cover) is offered there. */}
            {entry.link_id == null && (
              <>
                <ContextMenuItem onClick={onAddCover}>
                  <ImageIcon size={14} />
                  Add local cover
                </ContextMenuItem>
                <ContextMenuItem onClick={onAddCoverFromTmdb} disabled={entry.entry_type === "collection" || !entry.tmdb_id}>
                  <ImageIcon size={14} />
                  Add cover from TMDB
                </ContextMenuItem>
              </>
            )}
            <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
              <ImageIcon size={14} />
              Change cover
            </ContextMenuItem>
            {entry.link_id == null && (
              <ContextMenuItem onClick={onDeleteCover} disabled={entry.covers.length < 1}>
                <Trash2 size={14} />
                Delete cover
              </ContextMenuItem>
            )}
            {onAddToPlaylist && entry.link_id == null && (entry.entry_type === "movie" || entry.entry_type === "show") && (
              <ContextMenuItem onClick={() => onAddToPlaylist(entry)}>
                <ListPlus size={14} />
                Add to playlist
              </ContextMenuItem>
            )}
            {(entry.entry_type === "movie" || entry.entry_type === "show") && (
              // Watched is the default, so the offered action pivots on the
              // explicit-unwatched flag: untouched titles offer Mark unwatched.
              // Shows flip every episode at once.
              <ContextMenuItem
                onClick={async () => {
                  try {
                    if (entry.entry_type === "show") {
                      await invoke("mark_show_watched", { showId: entry.id, watched: isUnwatched });
                    } else {
                      await invoke("mark_watched", { kind: "movie", id: entry.id, watched: isUnwatched });
                    }
                    setWatchOverride(isUnwatched ? "watched" : "unwatched");
                  } catch (e) {
                    toast.error(String(e));
                  }
                }}
              >
                {isUnwatched ? <Eye size={14} /> : <EyeOff size={14} />}
                {isUnwatched ? "Mark watched" : "Mark unwatched"}
              </ContextMenuItem>
            )}
            {onRemoveLink && entry.link_id != null && (
              <ContextMenuItem
                onClick={() => onRemoveLink(entry.link_id!)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={14} />
                Remove from playlist
              </ContextMenuItem>
            )}
            {/* Only collections are deletable — movies/shows mirror the filesystem
                and leave the library via rescan. */}
            {entry.link_id == null && entry.entry_type === "collection" && (
              <ContextMenuItem onClick={() => onDelete(entry)} className="text-destructive focus:text-destructive">
                <Trash2 size={14} />
                Delete collection
              </ContextMenuItem>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MoveUpDropZone({ isActive }: { isActive: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "move-up-zone",
    disabled: !isActive,
  });

  // Stays mounted so it can expand/collapse smoothly when a drag starts/ends
  // instead of popping in. grid-template-rows 0fr→1fr animates height-to-auto;
  // the overflow-hidden child is what lets the row actually collapse to zero.
  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: isActive ? "1fr" : "0fr" }}
      aria-hidden={!isActive}
    >
      <div className={`overflow-hidden transition-opacity duration-200 ${isActive ? "opacity-100" : "opacity-0"}`}>
        <div
          ref={setNodeRef}
          className={`mb-4 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm transition-colors ${
            isOver
              ? "border-primary bg-primary/10 text-primary"
              : "border-muted-foreground/30 text-muted-foreground"
          }`}
        >
          <ArrowUp size={16} />
          Move up a level
        </div>
      </div>
    </div>
  );
}

function DragOverlayCard({
  entry,
  size,
  getCoverUrl,
}: {
  entry: MediaEntry;
  size: number;
  getCoverUrl: (filePath: string) => string;
}) {
  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getCoverUrl(coverPath) : null;

  return (
    <div className="flex rotate-1 scale-105 cursor-grabbing flex-col items-center gap-2 rounded-md bg-accent p-2 text-left shadow-2xl">
      <div className="relative overflow-hidden rounded-[3px] bg-muted shadow-md ring-1 ring-foreground/10 transition-[translate,scale] duration-200 group-hover:-translate-y-1 group-hover:scale-[1.04] group-hover:shadow-xl group-hover:ring-foreground/25" style={{ width: size - 16 }}>
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={entry.title}
            className="pointer-events-none w-full"
            style={{ maxHeight: size * 2 }}
            draggable={false}
          />
        ) : (
          <div className="flex aspect-[2/3] w-full items-center justify-center">
            {entry.entry_type === "movie" ? (
              <Film size={size * 0.3} className="text-muted-foreground" />
            ) : entry.entry_type === "show" ? (
              <Tv size={size * 0.3} className="text-muted-foreground" />
            ) : (
              <Folder size={size * 0.3} className="text-muted-foreground" />
            )}
          </div>
        )}
      </div>
      <div className="w-full" style={{ maxWidth: size }}>
        <p className="text-sm font-medium">{entry.title}</p>
        {(entry.season_display || entry.collection_display || entry.year) && (
          <p className="text-xs text-muted-foreground">{[entry.season_display || entry.collection_display, entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`].filter(Boolean).join(", ")}</p>
        )}
      </div>
    </div>
  );
}

function CoverCarouselDialog({
  entry,
  mode,
  open,
  onOpenChange,
  onSelect,
  onDelete,
  getCoverUrl,
}: {
  entry: MediaEntry;
  mode: "select" | "delete";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (coverPath: string) => void;
  onDelete: (coverPath: string) => Promise<void>;
  getCoverUrl: (filePath: string) => string;
}) {
  const currentCover = getDisplayCover(entry);
  const startIndex = currentCover
    ? Math.max(0, entry.covers.indexOf(currentCover))
    : 0;
  const [selectedIndex, setSelectedIndex] = useState(startIndex);
  const [api, setApi] = useState<CarouselApi>();
  const [dims, setDims] = useState<Map<number, { w: number; h: number }>>(new Map());
  const [sizes, setSizes] = useState<Map<number, number>>(new Map());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!api) return;
    const onSelectSlide = () => setSelectedIndex(api.selectedScrollSnap());
    api.on("select", onSelectSlide);
    return () => {
      api.off("select", onSelectSlide);
    };
  }, [api]);

  useEffect(() => {
    entry.covers.forEach((cover, i) => {
      if (sizes.has(i)) return;
      invoke<number>("get_file_size", { path: cover })
        .then((n) => setSizes((prev) => new Map(prev).set(i, n)))
        .catch(() => {});
    });
  }, [entry.covers, sizes]);

  const fmtSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const selDim = dims.get(selectedIndex);
  const selSize = sizes.get(selectedIndex);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose Cover</DialogTitle>
        </DialogHeader>
        <div className="px-12">
          <Carousel setApi={setApi} opts={{ startIndex }}>
            <CarouselContent>
              {entry.covers.map((cover, i) => (
                <CarouselItem key={i}>
                  <div className="flex items-center justify-center">
                    <img
                      src={getCoverUrl(cover)}
                      alt={`Cover ${i + 1}`}
                      className="max-h-[400px] rounded-md object-contain"
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        setDims((prev) => {
                          if (prev.has(i)) return prev;
                          return new Map(prev).set(i, { w: img.naturalWidth, h: img.naturalHeight });
                        });
                      }}
                    />
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
          </Carousel>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {selectedIndex + 1} / {entry.covers.length}
            {selDim && ` · ${selDim.w}×${selDim.h}`}
            {selSize != null && ` · ${fmtSize(selSize)}`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {mode === "delete" ? "Close" : "Cancel"}
          </Button>
          {mode === "delete" ? (
            <Button variant="destructive" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
          ) : (
            <Button onClick={() => onSelect(entry.covers[selectedIndex])}>
              Select
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Confirmation for the destructive path */}
      <Dialog open={confirmingDelete} onOpenChange={(o) => { if (!o) setConfirmingDelete(false); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Cover</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Permanently delete this cover image? This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={async () => {
                const cover = entry.covers[selectedIndex];
                if (!cover) return;
                setDeleting(true);
                try {
                  await onDelete(cover);
                  setSelectedIndex((prev) => Math.max(0, Math.min(prev, entry.covers.length - 2)));
                } finally {
                  setDeleting(false);
                  setConfirmingDelete(false);
                }
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function fmtRuntime(minutes: number): string {
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** Clock-style position for resume labels: 1:12:03 / 12:03. */
function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    : `${m}:${sec.toString().padStart(2, "0")}`;
}

const RATING_ORDER = ["rotten_tomatoes", "rotten_tomatoes_audience", "imdb", "metacritic"];
const RATING_LABELS: Record<string, string> = {
  rotten_tomatoes_audience: "RT Audience",
  rotten_tomatoes: "RT Critics",
  imdb: "IMDb",
  metacritic: "Metacritic",
};
// Source icons replace the text labels as they're added to src/assets/ratings
// (svg and png both load as plain <img>); sources without one keep the label.
const RATING_ICONS: Record<string, string> = {
  rotten_tomatoes_audience: rtAudienceIcon,
  rotten_tomatoes: rtCriticsIcon,
  imdb: imdbIcon,
  metacritic: metacriticIcon,
};

// RT shows a "rotten" mark below 60%: a green splat for critics, a tipped-over green
// popcorn for the audience. Above that it's the regular fresh tomato/popcorn. Other
// sources never swap. parseInt copes with values like "85%" or "85".
const RT_ROTTEN_ICONS: Record<string, string> = {
  rotten_tomatoes: rtCriticsRottenIcon,
  rotten_tomatoes_audience: rtAudienceRottenIcon,
};
function ratingIconFor(source: string, value: string): string | undefined {
  const rotten = RT_ROTTEN_ICONS[source];
  if (rotten) {
    const pct = parseInt(value, 10);
    if (!Number.isNaN(pct) && pct < 60) return rotten;
  }
  return RATING_ICONS[source];
}

// Manual rating editor. Free-text values ("8.5", "85%") matching how ratings are
// fetched/stored/displayed. Order = how they read top-to-bottom in the form.
const RATING_EDIT_SOURCES = ["imdb", "rotten_tomatoes", "rotten_tomatoes_audience", "metacritic"] as const;

function ratingsToDraft(ratings: RatingInfo[]): Record<string, string> {
  const d: Record<string, string> = {};
  for (const s of RATING_EDIT_SOURCES) d[s] = ratings.find((r) => r.source === s)?.value ?? "";
  return d;
}

function draftToRatings(draft: Record<string, string>): RatingInfo[] {
  return RATING_EDIT_SOURCES.map((s) => ({ source: s, value: (draft[s] ?? "").trim() }));
}

/** Shared rating-value inputs for the movie/show edit forms. */
function RatingsEditFields({ draft, onChange }: { draft: Record<string, string>; onChange: (source: string, value: string) => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ratings</p>
      {RATING_EDIT_SOURCES.map((s) => (
        <EditField key={s} label={RATING_LABELS[s] ?? s} value={draft[s] ?? ""} onChange={(v) => onChange(s, v)} />
      ))}
    </div>
  );
}

/** The hero ratings row shared by movie and show detail pages. */
function RatingsLine({ ratings }: { ratings: RatingInfo[] }) {
  if (ratings.length === 0) return null;
  return (
    // Between the old mt-1.5 and the section gap-4 — gap-4 below LOOKS bigger
    // than it measures (the genres band is visually heavier), so true-equal
    // margins read lopsided.
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {RATING_ORDER.filter((s) => ratings.some((r) => r.source === s)).map((source) => {
        const r = ratings.find((x) => x.source === source)!;
        const icon = ratingIconFor(source, r.value);
        const label = RATING_LABELS[source] ?? source;
        return (
          <span key={source} className="flex items-center gap-1" title={label}>
            {icon ? <img src={icon} alt={label} className="h-4 w-4" draggable={false} /> : <span>{label}</span>}
            <span className="font-medium text-foreground">{r.value}</span>
          </span>
        );
      })}
    </div>
  );
}

function PersonFace({ imagePath, className, iconSize }: { imagePath: string | null; className: string; iconSize: number }) {
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ring-1 ring-foreground/10 ${className}`}>
      {imagePath ? (
        <img src={convertFileSrc(imagePath)} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <UserIcon size={iconSize} className="text-muted-foreground" />
      )}
    </span>
  );
}

/** Vertical face card for people (cast grid, crew rows). Names and roles wrap
 *  to two lines so they rarely need to truncate. */
function CastCard({
  person,
  onClick,
  className = "w-full min-w-0",
}: {
  person: CastInfo;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 rounded-md p-1.5 text-center transition-colors hover:bg-accent/50 ${className}`}
    >
      <PersonFace imagePath={person.image_path} className="h-20 w-20" iconSize={28} />
      <span className="w-full text-xs font-medium leading-tight line-clamp-2">{person.name}</span>
      {person.role && (
        <span className="-mt-0.5 w-full text-[11px] leading-tight text-muted-foreground line-clamp-2">{person.role}</span>
      )}
    </button>
  );
}

/** Full-width cast grid (movie + show detail pages). Cast is now uncapped, so
 *  it collapses to ~2 rows with a "View all" toggle. The visible-when-collapsed
 *  count is derived from the measured column count so it's always whole rows. */
function CastBand({
  cast,
  onNavigateToPerson,
}: {
  cast: CastInfo[];
  onNavigateToPerson?: (person: PersonInfo, role: PersonRole) => void;
}) {
  const CAST_MIN_W = 108; // matches the grid's minmax min
  const CAST_GAP_X = 4; // gap-x-1
  const COLLAPSED_ROWS = 2;
  const [expanded, setExpanded] = useState(false);
  const [cols, setCols] = useState(1);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const update = () =>
      setCols(Math.max(1, Math.floor((el.clientWidth + CAST_GAP_X) / (CAST_MIN_W + CAST_GAP_X))));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const collapsedCount = cols * COLLAPSED_ROWS;
  const overflow = cast.length > collapsedCount;
  const shown = expanded || !overflow ? cast : cast.slice(0, collapsedCount);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cast</p>
      <div
        ref={gridRef}
        className="grid gap-x-1 gap-y-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))" }}
      >
        {shown.map((c) => (
          <CastCard
            key={c.id}
            person={c}
            onClick={() => onNavigateToPerson?.({ id: c.id, name: c.name, image_path: c.image_path }, "actor")}
          />
        ))}
      </div>
      {overflow && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 w-fit text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {expanded ? "show less" : `...view all ${cast.length} cast members`}
        </button>
      )}
    </div>
  );
}

/** Returns the cover src to render right now: the already-cached grid thumbnail
 *  paints in the same frame as the page text, then swaps to the full-res cover
 *  once it has decoded. Thumbnails (600×900) exceed the hero's 500px height cap,
 *  so both versions render at identical size and the swap is invisible. */
function useProgressiveCover(thumbSrc: string | null, fullSrc: string | null): string | null {
  const [readySrc, setReadySrc] = useState<string | null>(null);
  useEffect(() => {
    if (!fullSrc) return;
    let cancelled = false;
    const img = new Image();
    img.src = fullSrc;
    img.decode().then(() => {
      if (!cancelled) setReadySrc(fullSrc);
    }).catch(() => { /* keep showing the thumbnail */ });
    return () => {
      cancelled = true;
    };
  }, [fullSrc]);
  // Compare instead of resetting on src change — a stale readySrc from the
  // previous entry must not flash the old cover on the new page.
  return readySrc === fullSrc ? fullSrc : thumbSrc;
}

function EntryDetailPage({
  entry,
  selectedLibrary,
  getCoverUrl,
  getFullCoverUrl,
  onEntryChanged,
  onTitleChanged,
  onChangeCover,
  onAddCover,
  onDeleteCover,
  onPlayFile,
  onPlayInteractive,
  onNavigateToPerson,
  onSelectGenre,
}: {
  entry: MediaEntry;
  selectedLibrary: Library;
  getCoverUrl: (filePath: string) => string;
  getFullCoverUrl: (filePath: string) => string;
  onEntryChanged: () => void;
  onTitleChanged: (entryId: number, newTitle: string) => void;
  onChangeCover: () => void;
  onAddCover: () => void;
  onDeleteCover: () => void;
  onPlayFile?: (path: string, title: string, opts?: { watch?: { kind: "movie" | "episode"; id: number }; startSecs?: number }) => void;
  onPlayInteractive?: (args: { libraryId: string; entryId: number; title: string; fresh?: boolean }) => void;
  onNavigateToPerson?: (person: PersonInfo, role: PersonRole) => void;
  onSelectGenre?: (libraryId: string, genre: string) => void;
}) {
  const [detail, setDetail] = useState<MovieDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MovieDetailUpdate>({});
  const [saving, setSaving] = useState(false);
  const [tmdbDialogOpen, setTmdbDialogOpen] = useState(false);
  // Which tab the TMDB image browser opens on, or null when closed — the cover
  // menu opens posters, the backdrop menu opens backdrops.
  const [tmdbImagesTab, setTmdbImagesTab] = useState<"posters" | "backdrops" | null>(null);
  const [backdropDialogOpen, setBackdropDialogOpen] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [extrasCount, setExtrasCount] = useState(0);
  const [ratings, setRatings] = useState<RatingInfo[]>([]);
  const [omdbEnabled, setOmdbEnabled] = useState(false);
  const [watch, setWatch] = useState<WatchState | null>(null);
  // Entry id everything below has finished loading for. Render is gated on it so
  // the page appears in one piece instead of sections popping in one by one.
  const [loadedId, setLoadedId] = useState<number | null>(null);

  // Watch indicators refresh when the player closes — that's when the
  // session's progress recording has settled.
  useEffect(() => {
    const refresh = () => {
      invoke<WatchState>("get_watch_state", { entryId: entry.id })
        .then(setWatch)
        .catch(() => {});
    };
    window.addEventListener("waverunner:player-closed", refresh);
    return () => window.removeEventListener("waverunner:player-closed", refresh);
  }, [entry.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [extras, cachedRatings, settings, d, w] = await Promise.all([
        invoke<unknown[]>("get_extras", { entryId: entry.id }).catch(() => [] as unknown[]),
        // Cached ratings only — fetching is always explicit (context menu / bulk match).
        invoke<RatingInfo[]>("get_ratings", { entryId: entry.id }).catch(() => [] as RatingInfo[]),
        invoke<Record<string, string>>("get_settings").catch(() => ({} as Record<string, string>)),
        invoke<MovieDetail | null>("get_movie_detail", { entryId: entry.id }).catch((e) => {
          console.error("Failed to load movie detail:", e);
          return null;
        }),
        invoke<WatchState>("get_watch_state", { entryId: entry.id }).catch(() => null),
      ]);
      // Decode the hero backdrop before the gate opens so it paints with the page.
      if (d?.backdrop) {
        try {
          const img = new Image();
          img.src = convertFileSrc(d.backdrop);
          await img.decode();
        } catch { /* paint will decode it instead */ }
      }
      if (cancelled) return;
      setExtrasCount(extras.length);
      setRatings(cachedRatings);
      setOmdbEnabled(settings["omdb_enabled"] === "true");
      setDetail(d);
      setWatch(w);
      setLoadedId(entry.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  const fetchRatings = useCallback(async () => {
    try {
      const fetched = await invoke<RatingInfo[]>("fetch_ratings", { entryId: entry.id });
      setRatings(fetched);
      if (fetched.length > 0) toast.success("Ratings updated");
      else toast.info("No ratings found");
    } catch (e) {
      toast.error(String(e));
    }
  }, [entry.id]);

  // Re-fetch after saves / TMDB applies — initial load happens in the combined effect above.
  const loadDetail = useCallback(async () => {
    try {
      const d = await invoke<MovieDetail>("get_movie_detail", {
        entryId: entry.id,
      });
      setDetail(d);
    } catch (e) {
      console.error("Failed to load movie detail:", e);
    }
  }, [entry.id]);

  const [ratingsDraft, setRatingsDraft] = useState<Record<string, string>>({});
  const startEditing = () => {
    setRatingsDraft(ratingsToDraft(ratings));
    setDraft({
      title: entry.title,
      release_date: detail?.release_date ?? entry.year ?? "",
      tmdb_id: detail?.tmdb_id ?? null,
      imdb_id: detail?.imdb_id ?? null,
      rotten_tomatoes_id: detail?.rotten_tomatoes_id ?? null,
      plot: detail?.plot ?? null,
      tagline: detail?.tagline ?? null,
      runtime: detail?.runtime ?? null,
      maturity_rating: detail?.maturity_rating ?? null,
      genres: detail?.genres ?? [],
      directors: detail?.directors.map((d: { name: string }) => d.name) ?? [],
      cast: detail?.cast.map((c: { name: string; role: string | null }) => ({ name: c.name, role: c.role, tmdb_id: null, profile_path: null })) ?? [],
      composers: detail?.composers.map((p: { name: string }) => p.name) ?? [],
      studios: detail?.studios ?? [],
      keywords: detail?.keywords ?? [],
    });
    setEditing(true);
  };

  const saveDetail = async () => {
    setSaving(true);
    try {
      await invoke("update_movie_detail", {
        entryId: entry.id,
        detail: draft,
      });
      await invoke("set_manual_ratings", { entryId: entry.id, ratings: draftToRatings(ratingsDraft) });
      await loadDetail();
      setRatings(await invoke<RatingInfo[]>("get_ratings", { entryId: entry.id }).catch(() => [] as RatingInfo[]));
      if (draft.title && draft.title !== entry.title) {
        onTitleChanged(entry.id, draft.title);
      }
      onEntryChanged();
      setEditing(false);
    } catch (e) {
      console.error("Failed to save movie detail:", e);
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const coverPath = getDisplayCover(entry);
  const coverSrc = useProgressiveCover(
    coverPath ? getCoverUrl(coverPath) : null,
    coverPath ? getFullCoverUrl(coverPath) : null,
  );

  const updateDraft = (field: keyof MovieDetailUpdate, value: unknown) => {
    setDraft((prev: MovieDetailUpdate) => ({ ...prev, [field]: value }));
  };

  const updateListField = (field: keyof MovieDetailUpdate, value: string) => {
    updateDraft(field, value.split(",").map((s) => s.trim()).filter(Boolean));
  };

  // One menu shared by the cover image and the hero/content area — identical
  // items; only the tab the TMDB image browser lands on differs by surface.
  // Grouped: watch → artwork → metadata → destructive.
  const detailMenuItems = (tmdbTab: "posters" | "backdrops") => (
    <>
      {extrasCount > 0 && (
        <>
          <ContextMenuItem onClick={() => setExtrasOpen(true)}>
            <Clapperboard size={14} />
            View extras
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
        <ImageIcon size={14} />
        Change cover
      </ContextMenuItem>
      <ContextMenuItem onClick={() => setBackdropDialogOpen(true)}>
        <ImageIcon size={14} />
        Change backdrop
      </ContextMenuItem>
      <ContextMenuItem onClick={() => setTmdbImagesTab(tmdbTab)} disabled={!detail?.tmdb_id}>
        <ImageIcon size={14} />
        Add cover/backdrop from TMDB
      </ContextMenuItem>
      <ContextMenuItem onClick={onAddCover}>
        <ImageIcon size={14} />
        Add local cover
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={startEditing}>
        <Pencil size={14} />
        Edit
      </ContextMenuItem>
      <ContextMenuItem onClick={() => setTmdbDialogOpen(true)}>
        <Film size={14} />
        {detail?.tmdb_id ? "Rematch TMDB" : "Match TMDB"}
      </ContextMenuItem>
      {omdbEnabled && (
        <ContextMenuItem onClick={fetchRatings}>
          <RefreshCw size={14} />
          Get ratings
        </ContextMenuItem>
      )}
      {/* Watched is the default — the offered action pivots on the
          explicit-unwatched flag, so untouched titles offer Mark unwatched. */}
      <ContextMenuItem
        onClick={async () => {
          try {
            const unwatched = watch?.unwatched ?? entry.unwatched;
            await invoke("mark_watched", { kind: "movie", id: entry.id, watched: unwatched });
            setWatch(await invoke<WatchState>("get_watch_state", { entryId: entry.id }));
            onEntryChanged();
          } catch (e) {
            toast.error(String(e));
          }
        }}
      >
        {(watch?.unwatched ?? entry.unwatched) ? <Eye size={14} /> : <EyeOff size={14} />}
        {(watch?.unwatched ?? entry.unwatched) ? "Mark watched" : "Mark unwatched"}
      </ContextMenuItem>
      {entry.interactive && (
        <ContextMenuItem
          onClick={async () => {
            try {
              await invoke("reset_interactive_story", { entryId: entry.id });
              setWatch(await invoke<WatchState>("get_watch_state", { entryId: entry.id }));
              toast.success("Story reset — the next playthrough starts fresh");
            } catch (e) {
              toast.error(String(e));
            }
          }}
        >
          <RotateCcw size={14} />
          Reset story
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={onDeleteCover}
        disabled={entry.covers.length < 1}
        className="text-destructive focus:text-destructive"
      >
        <Trash2 size={14} />
        Delete cover
      </ContextMenuItem>
    </>
  );

  // Everything or nothing: a blank frame beats sections trickling in.
  if (loadedId !== entry.id) return null;

  return (
    <div className="relative isolate flex flex-wrap gap-8 p-6">
      {/* Hero backdrop: real backdrop art when one is downloaded; otherwise the
          cover blurred and washed out. Both fade into the page background. */}
      {(detail?.backdrop || coverSrc) && (
        // -inset-x-4/-top-4 cancel the scroll container's p-4 so the wash reaches the section borders.
        <div aria-hidden className="pointer-events-none absolute -inset-x-4 -top-4 -z-10 h-[490px] overflow-hidden">
          {detail?.backdrop ? (
            // Anchored 25% from the top: center-crop beheads top-composed art,
            // a hard top-anchor surfaces letterbox bars — upper-quarter splits it.
            <img src={convertFileSrc(detail.backdrop)} alt="" className="absolute inset-0 h-full w-full object-cover object-[50%_25%] opacity-15" />
          ) : (
            // Oversized by the blur radius (64px) on every side so the blur's
            // transparent falloff lands outside the visible box.
            <img src={coverSrc!} alt="" className="absolute -left-16 -top-16 h-[calc(100%+8rem)] w-[calc(100%+8rem)] max-w-none object-cover opacity-25 blur-3xl" />
          )}
          {/* via-35%: pulling the midpoint up stretches the fade-to-solid over
              the lower two-thirds of the band for a longer, cleaner falloff */}
          <div className="absolute inset-0 bg-linear-to-b from-transparent via-background/60 via-35% to-background" />
        </div>
      )}
      {coverSrc && (
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <img
                src={coverSrc}
                alt={entry.title}
                className="h-auto max-h-[500px] w-auto shrink-0 rounded-lg object-contain shadow-2xl ring-1 ring-foreground/10"
              />
            }
          />
          <ContextMenuContent>{detailMenuItems("posters")}</ContextMenuContent>
        </ContextMenu>
      )}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="@container flex min-w-0 flex-1 flex-col gap-4" />}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {editing ? (
              <div className="flex flex-col gap-2">
                <input
                  value={draft.title ?? ""}
                  onChange={(e) => updateDraft("title", e.target.value)}
                  className="rounded border border-input bg-transparent px-2 py-1 text-2xl font-bold outline-none"
                />
                <input
                  value={draft.release_date ?? ""}
                  onChange={(e) => updateDraft("release_date", e.target.value)}
                  placeholder="YYYY, YYYY-MM, or YYYY-MM-DD"
                  className="w-36 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
                />
              </div>
            ) : (
              <>
                <h1 className="text-3xl font-bold">{entry.title}</h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  {(() => {
                    const dateDisplay = formatReleaseDate(detail?.release_date) ?? (entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`);
                    return dateDisplay && <span>{dateDisplay}</span>;
                  })()}
                  {detail?.runtime != null && (
                    <>
                      <span className="text-muted-foreground/50">·</span>
                      <span>{fmtRuntime(detail.runtime)}</span>
                    </>
                  )}
                  {detail?.maturity_rating && (
                    <span className="rounded border border-border px-1.5 py-px text-xs">
                      {detail.maturity_rating}
                    </span>
                  )}
                  {entry.interactive && (
                    <span
                      className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 py-px text-xs font-medium text-primary"
                      title="Branching title — you make choices while it plays"
                    >
                      <GitBranch size={11} />
                      Interactive
                    </span>
                  )}
                </div>
                {detail?.tagline && (
                  <p className="mt-2 italic text-muted-foreground">{detail.tagline}</p>
                )}
                <RatingsLine ratings={ratings} />
              </>
            )}
          </div>
          {/* Stacks vertically when the info column runs tight (narrow window /
              wide cover) so the title isn't smushed by a long button row. */}
          <div className="flex shrink-0 gap-2 @max-xl:flex-col @max-xl:items-stretch">
            {(() => {
              const playMovie = async (startSecs?: number) => {
                try {
                  const path = await invoke<string>("get_movie_file_path", { libraryId: selectedLibrary.id, entryId: entry.id });
                  onPlayFile?.(path, entry.title, { watch: { kind: "movie", id: entry.id }, startSecs });
                } catch (e) {
                  toast.error(String(e));
                }
              };
              if (entry.interactive) {
                const canResume = watch?.interactive_resume ?? false;
                return (
                  <>
                    <Button
                      size="sm"
                      onClick={() => onPlayInteractive?.({ libraryId: selectedLibrary.id, entryId: entry.id, title: entry.title, fresh: false })}
                    >
                      <Play size={14} />
                      {canResume ? "Resume" : "Play"}
                    </Button>
                    {canResume && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onPlayInteractive?.({ libraryId: selectedLibrary.id, entryId: entry.id, title: entry.title, fresh: true })}
                      >
                        Play from beginning
                      </Button>
                    )}
                  </>
                );
              }
              const resumePos = watch?.position_secs ?? null;
              return (
                <>
                  <Button size="sm" onClick={() => playMovie(resumePos ?? undefined)}>
                    <Play size={14} />
                    {resumePos != null ? `Resume from ${fmtClock(resumePos)}` : "Play"}
                  </Button>
                  {resumePos != null && (
                    <Button size="sm" variant="outline" onClick={() => playMovie(undefined)}>
                      Play from beginning
                    </Button>
                  )}
                </>
              );
            })()}
            {extrasCount > 0 && (
              <Button size="sm" variant="outline" onClick={() => setExtrasOpen(true)}>
                <Clapperboard size={14} />
                Extras ({extrasCount})
              </Button>
            )}
            {editing && (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveDetail} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </Button>
              </>
            )}
          </div>
        </div>

        {detail && !editing && (
          <div className="flex min-w-0 flex-col gap-5">
            {detail.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {detail.genres.map((g) => (
                  <button
                    key={g}
                    onClick={() => onSelectGenre?.(selectedLibrary.id, g)}
                    className="cursor-pointer rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground ring-1 ring-transparent transition-all hover:bg-primary/15 hover:text-foreground hover:ring-primary/50"
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}

            {detail.plot && <p className="text-sm leading-relaxed">{detail.plot}</p>}

            {(detail.directors.length > 0 || detail.composers.length > 0) && (
              <div className="flex flex-wrap gap-x-12 gap-y-4">
                {detail.directors.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {detail.directors.length === 1 ? "Director" : "Directors"}
                    </p>
                    <div className="-mx-1.5 flex flex-wrap gap-1">
                      {detail.directors.map((d) => (
                        <CastCard
                          key={d.id}
                          person={{ ...d, role: null }}
                          className="w-28"
                          onClick={() => onNavigateToPerson?.(d, "director_creator")}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {detail.composers.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {detail.composers.length === 1 ? "Composer" : "Composers"}
                    </p>
                    <div className="-mx-1.5 flex flex-wrap gap-1">
                      {detail.composers.map((c) => (
                        <CastCard
                          key={c.id}
                          person={{ ...c, role: null }}
                          className="w-28"
                          onClick={() => onNavigateToPerson?.(c, "composer")}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
        )}

        {editing && (
          <div className="flex flex-col gap-3 text-sm">
            <EditField label="Tagline" value={draft.tagline ?? ""} onChange={(v) => updateDraft("tagline", v || null)} />
            <EditField label="Plot" value={draft.plot ?? ""} onChange={(v) => updateDraft("plot", v || null)} multiline />
            <EditField label="Runtime (min)" value={draft.runtime != null ? String(draft.runtime) : ""} onChange={(v) => updateDraft("runtime", v ? Number(v) : null)} />
            <EditField label="Maturity Rating" value={draft.maturity_rating ?? ""} onChange={(v) => updateDraft("maturity_rating", v || null)} />
            <EditField label="Genres (comma-separated)" value={(draft.genres ?? []).join(", ")} onChange={(v) => updateListField("genres", v)} />
            <EditField label="Directors (comma-separated)" value={(draft.directors ?? []).join(", ")} onChange={(v) => updateListField("directors", v)} />
            <EditField label="Composers (comma-separated)" value={(draft.composers ?? []).join(", ")} onChange={(v) => updateListField("composers", v)} />
            <EditField label="Studios (comma-separated)" value={(draft.studios ?? []).join(", ")} onChange={(v) => updateListField("studios", v)} />
            <EditField label="Keywords (comma-separated)" value={(draft.keywords ?? []).join(", ")} onChange={(v) => updateListField("keywords", v)} />
            <EditField label="TMDB ID" value={draft.tmdb_id ?? ""} onChange={(v) => updateDraft("tmdb_id", v || null)} />
            <EditField label="IMDB ID" value={draft.imdb_id ?? ""} onChange={(v) => updateDraft("imdb_id", v || null)} />
            <EditField label="Rotten Tomatoes ID" value={draft.rotten_tomatoes_id ?? ""} onChange={(v) => updateDraft("rotten_tomatoes_id", v || null)} />
            <RatingsEditFields draft={ratingsDraft} onChange={(s, v) => setRatingsDraft((p) => ({ ...p, [s]: v }))} />
            <PeopleListEdit label="Cast" items={draft.cast ?? []} onChange={(items) => updateDraft("cast", items)} secondaryField="role" secondaryLabel="Role" />
          </div>
        )}
        </ContextMenuTrigger>
        <ContextMenuContent>{detailMenuItems("backdrops")}</ContextMenuContent>
      </ContextMenu>
      {/* Full-width band below the hero row (w-full forces the wrap) */}
      {detail && !editing && (detail.cast.length > 0 || detail.studios.length > 0 || detail.tmdb_id || detail.imdb_id || detail.rotten_tomatoes_id) && (
        <div className="flex w-full min-w-0 flex-col gap-5">
          {detail.cast.length > 0 && (
            <CastBand cast={detail.cast} onNavigateToPerson={onNavigateToPerson} />
          )}

          {(detail.studios.length > 0 || detail.tmdb_id || detail.imdb_id || detail.rotten_tomatoes_id) && (
            <p className="text-xs text-muted-foreground/70">
              {[
                detail.studios.length > 0 ? detail.studios.join(", ") : null,
                detail.tmdb_id ? `TMDB ${detail.tmdb_id}` : null,
                detail.imdb_id ? `IMDB ${detail.imdb_id}` : null,
                detail.rotten_tomatoes_id ? `Rotten Tomatoes ${detail.rotten_tomatoes_id}` : null,
              ]
                .filter(Boolean)
                .join("  ·  ")}
            </p>
          )}
        </div>
      )}
      <ExtrasDialog
        open={extrasOpen}
        onOpenChange={setExtrasOpen}
        libraryId={selectedLibrary.id}
        entryId={entry.id}
        entryTitle={entry.title}
        isShow={false}
        onPlayFile={onPlayFile}
      />
      <TmdbMatchDialog
        open={tmdbDialogOpen}
        onOpenChange={setTmdbDialogOpen}
        entryId={entry.id}
        entryTitle={entry.title}
        entryYear={entry.year}
        currentDetail={detail}
        onApplied={() => { loadDetail(); onEntryChanged(); }}
      />
      {detail?.tmdb_id && (
        <TmdbImageBrowserDialog
          open={tmdbImagesTab !== null}
          onOpenChange={(open) => { if (!open) setTmdbImagesTab(null); }}
          initialTab={tmdbImagesTab ?? "posters"}
          libraryId={selectedLibrary.id}
          entryId={entry.id}
          tmdbId={detail.tmdb_id}
          mediaType="movie"
          onDownloaded={() => { loadDetail(); onEntryChanged(); }}
        />
      )}
      <BackdropSelectDialog
        open={backdropDialogOpen}
        onOpenChange={setBackdropDialogOpen}
        entryId={entry.id}
        current={detail?.backdrop ?? null}
        onChanged={loadDetail}
      />
    </div>
  );
}

function ShowDetailPage({
  entry,
  selectedLibrary,
  getCoverUrl,
  getFullCoverUrl,
  onEntryChanged,
  onTitleChanged: _onTitleChanged,
  onChangeCover,
  onAddCover,
  onDeleteCover,
  onPlayEpisode,
  onPlayFile,
  onNavigateToPerson,
  onSelectGenre,
}: {
  entry: MediaEntry;
  selectedLibrary: Library;
  getCoverUrl: (filePath: string) => string;
  getFullCoverUrl: (filePath: string) => string;
  onEntryChanged: () => void;
  onTitleChanged: (entryId: number, newTitle: string) => void;
  onChangeCover: () => void;
  onAddCover: () => void;
  onDeleteCover: () => void;
  onPlayEpisode?: (args: { libraryId: string; showId: number; showTitle: string; startEpisodeId: number; startSecs?: number }) => void;
  /** Plays a standalone file (used for extras — episodes go through onPlayEpisode). */
  onPlayFile?: (path: string, title: string) => void;
  onNavigateToPerson?: (person: PersonInfo, role: PersonRole) => void;
  onSelectGenre?: (libraryId: string, genre: string) => void;
}) {
  const [detail, setDetail] = useState<ShowDetail | null>(null);
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [selectedSeasonId, setSelectedSeasonId] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [tmdbDialogOpen, setTmdbDialogOpen] = useState(false);
  // Which tab the TMDB image browser opens on, or null when closed — the cover
  // menu opens posters, the backdrop menu opens backdrops.
  const [tmdbImagesTab, setTmdbImagesTab] = useState<"posters" | "backdrops" | null>(null);
  const [backdropDialogOpen, setBackdropDialogOpen] = useState(false);
  const [ratings, setRatings] = useState<RatingInfo[]>([]);
  const [omdbEnabled, setOmdbEnabled] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [extrasCount, setExtrasCount] = useState(0);
  const [seasonDetail, setSeasonDetail] = useState<SeasonDetailLocal | null>(null);
  const [episodeDetails, setEpisodeDetails] = useState<Map<number, EpisodeDetailLocal>>(new Map());
  const [expandedEpisodeId, setExpandedEpisodeId] = useState<number | null>(null);
  const [seasonTmdbLoading, setSeasonTmdbLoading] = useState(false);
  const [bulkEpisodesLoading, setBulkEpisodesLoading] = useState(false);
  const [episodeTmdbLoading, setEpisodeTmdbLoading] = useState<number | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [showEditing, setShowEditing] = useState(false);
  const [showDraft, setShowDraft] = useState<TmdbShowFieldSelection>({});
  const [showSaving, setShowSaving] = useState(false);
  const [seasonEditing, setSeasonEditing] = useState(false);
  const [seasonDraft, setSeasonDraft] = useState<TmdbSeasonFieldSelection>({});
  const [seasonSaving, setSeasonSaving] = useState(false);
  const [editingEpisodeId, setEditingEpisodeId] = useState<number | null>(null);
  const [episodeDraft, setEpisodeDraft] = useState<TmdbEpisodeFieldSelection>({});
  const [episodeSaving, setEpisodeSaving] = useState(false);
  // Entry id everything below has finished loading for. Render is gated on it so
  // the page appears in one piece instead of sections popping in one by one.
  const [loadedId, setLoadedId] = useState<number | null>(null);
  // Watch history: per-episode rows, the continue-watching target for the
  // header Play button, and the show's first episode (plain Play fallback).
  const [epWatch, setEpWatch] = useState<Map<number, EpisodeWatchInfo>>(new Map());
  const [continueTarget, setContinueTarget] = useState<ContinueTarget | null>(null);
  const [firstEpisodeId, setFirstEpisodeId] = useState<number | null>(null);
  const selectedSeason = seasons.find((s) => s.id === selectedSeasonId);

  const [episodeIds, setEpisodeIds] = useState<number[]>([]);
  const loadWatch = useCallback(async () => {
    try {
      const [rows, cont, flat] = await Promise.all([
        invoke<EpisodeWatchInfo[]>("get_show_watch", { showId: entry.id }),
        invoke<ContinueTarget | null>("get_show_continue", { showId: entry.id }),
        invoke<ShowEpisodeFlat[]>("get_show_episodes", { showId: entry.id }),
      ]);
      setEpWatch(new Map(rows.map((r) => [r.episode_id, r])));
      setContinueTarget(cont);
      setFirstEpisodeId(flat[0]?.episode_id ?? null);
      setEpisodeIds(flat.map((f) => f.episode_id));
    } catch {
      // Indicators degrade to absent.
    }
  }, [entry.id]);

  // Refresh indicators when the player closes (progress has settled by then).
  useEffect(() => {
    const refresh = () => {
      loadWatch();
    };
    window.addEventListener("waverunner:player-closed", refresh);
    return () => window.removeEventListener("waverunner:player-closed", refresh);
  }, [loadWatch]);

  const loadDetail = useCallback(async () => {
    try {
      const d = await invoke<ShowDetail>("get_show_detail", {
        showId: entry.id,
      });
      setDetail(d);
    } catch (e) {
      console.error("Failed to load show detail:", e);
    }
  }, [entry.id]);

  const fetchRatings = useCallback(async () => {
    try {
      const fetched = await invoke<RatingInfo[]>("fetch_ratings", { entryId: entry.id });
      setRatings(fetched);
      if (fetched.length > 0) toast.success("Ratings updated");
      else toast.info("No ratings found");
    } catch (e) {
      toast.error(String(e));
    }
  }, [entry.id]);

  const loadSeasonDetail = useCallback(async (seasonId: number) => {
    try {
      const d = await invoke<SeasonDetailLocal>("get_season_detail_local", {
        seasonId,
      });
      setSeasonDetail(d);
    } catch (e) {
      console.error("Failed to load season detail:", e);
    }
  }, []);

  const loadEpisodeDetail = useCallback(async (episodeId: number) => {
    try {
      const d = await invoke<EpisodeDetailLocal>("get_episode_detail_local", {
        episodeId,
      });
      setEpisodeDetails((prev) => new Map(prev).set(episodeId, d));
    } catch (e) {
      console.error("Failed to load episode detail:", e);
    }
  }, []);

  useEffect(() => {
    // One combined load — detail, seasons, extras, and the first season's
    // episodes — applied in a single render. The page render is gated on
    // loadedId so nothing trickles in section by section.
    let cancelled = false;
    (async () => {
      const [d, s, extras, cachedRatings, settings] = await Promise.all([
        invoke<ShowDetail | null>("get_show_detail", { showId: entry.id }).catch((e) => {
          console.error("Failed to load show detail:", e);
          return null;
        }),
        invoke<SeasonInfo[]>("get_show_seasons", { showId: entry.id }).catch((e) => {
          console.error("Failed to load seasons:", e);
          return [] as SeasonInfo[];
        }),
        invoke<unknown[]>("get_extras", { entryId: entry.id }).catch(() => [] as unknown[]),
        // Cached ratings only — fetching is always explicit (context menu / bulk match).
        invoke<RatingInfo[]>("get_ratings", { entryId: entry.id }).catch(() => [] as RatingInfo[]),
        invoke<Record<string, string>>("get_settings").catch(() => ({} as Record<string, string>)),
      ]);
      let sd: SeasonDetailLocal | null = null;
      let eps: EpisodeInfo[] = [];
      if (s.length > 0) {
        try {
          [sd, eps] = await Promise.all([
            invoke<SeasonDetailLocal>("get_season_detail_local", { seasonId: s[0].id }),
            invoke<EpisodeInfo[]>("get_season_episodes", { seasonId: s[0].id }),
          ]);
        } catch (e) {
          console.error("Failed to load season:", e);
        }
      }
      // Decode the hero backdrop before the gate opens so it paints with the page.
      if (d?.backdrop) {
        try {
          const img = new Image();
          img.src = convertFileSrc(d.backdrop);
          await img.decode();
        } catch { /* paint will decode it instead */ }
      }
      if (cancelled) return;
      setDetail(d);
      setSeasons(s);
      setExtrasCount(extras.length);
      setRatings(cachedRatings);
      setOmdbEnabled(settings["omdb_enabled"] === "true");
      setSelectedSeasonId(s[0]?.id ?? null);
      setSeasonDetail(sd);
      setEpisodes(eps);
      setEpisodeDetails(new Map());
      setExpandedEpisodeId(null);
      setLoadedId(entry.id);
      loadWatch();
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.id, loadWatch]);

  // Pill click: keep the old season on screen and swap everything in one render
  // once both queries land — clearing eagerly (or setting the two results
  // separately) causes a visible two-phase jump when switching seasons. The
  // request counter keeps a slow response from clobbering a faster later click.
  const seasonReqRef = useRef(0);
  const selectSeason = useCallback(async (seasonId: number) => {
    setSelectedSeasonId(seasonId);
    const req = ++seasonReqRef.current;
    try {
      const [d, eps] = await Promise.all([
        invoke<SeasonDetailLocal>("get_season_detail_local", { seasonId }),
        invoke<EpisodeInfo[]>("get_season_episodes", { seasonId }),
      ]);
      if (seasonReqRef.current !== req) return;
      setSeasonDetail(d);
      setEpisodes(eps);
      setEpisodeDetails(new Map());
      setExpandedEpisodeId(null);
    } catch (e) {
      console.error("Failed to load season:", e);
    }
  }, []);

  const handleSeasonTmdb = useCallback(async () => {
    if (!detail?.tmdb_id || !selectedSeason || selectedSeason.season_number == null) return;
    setSeasonTmdbLoading(true);
    try {
      const tmdbSeason = await invoke<TmdbSeasonDetail>("get_tmdb_season_detail", {
        tmdbId: Number(detail.tmdb_id),
        seasonNumber: selectedSeason.season_number,
      });
      const fields: TmdbSeasonFieldSelection = {};
      if (tmdbSeason.overview) fields.plot = tmdbSeason.overview;
      if (tmdbSeason.credits?.cast && tmdbSeason.credits.cast.length > 0) {
        fields.cast = tmdbSeason.credits.cast.map((c) => ({
          name: c.name,
          role: c.character ?? null,
          tmdb_id: c.id,
          profile_path: c.profile_path,
        }));
      }
      // Any season-level director gets fanned out to every episode in the season by the backend.
      if (tmdbSeason.credits?.crew) {
        const directors = tmdbSeason.credits.crew
          .filter((c) => c.job === "Director")
          .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
        if (directors.length > 0) fields.season_director = directors;
      }
      await invoke("apply_tmdb_season_metadata", {
        seasonId: selectedSeason.id,
        fields,
      });
      toast.success("Season metadata populated from TMDB");
      loadSeasonDetail(selectedSeason.id);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSeasonTmdbLoading(false);
    }
  }, [detail, selectedSeason, loadSeasonDetail]);

  // The episode list itself carries plot/runtime now, so anything that writes
  // episode metadata must reload it (not just the per-episode detail cache).
  const reloadEpisodes = useCallback(async () => {
    if (selectedSeasonId == null) return;
    try {
      setEpisodes(await invoke<EpisodeInfo[]>("get_season_episodes", { seasonId: selectedSeasonId }));
    } catch {
      // keep showing the stale list
    }
  }, [selectedSeasonId]);

  const handleBulkEpisodes = useCallback(async () => {
    if (!detail?.tmdb_id || !selectedSeason || selectedSeason.season_number == null) return;
    setBulkConfirmOpen(false);
    setBulkEpisodesLoading(true);
    try {
      const count = await invoke<number>("apply_tmdb_season_episodes", {
        seasonId: selectedSeason.id,
        tmdbId: Number(detail.tmdb_id),
        seasonNumber: selectedSeason.season_number,
      });
      toast.success(`Populated ${count} episode(s) from TMDB`);
      // Reload episode details
      setEpisodeDetails(new Map());
      setExpandedEpisodeId(null);
      reloadEpisodes();
      onEntryChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBulkEpisodesLoading(false);
    }
  }, [detail, selectedSeason, selectedLibrary.id, onEntryChanged, reloadEpisodes]);

  // `source` overrides which TMDB season/episode the metadata is pulled FROM,
  // for the case where TMDB files content differently than the local layout
  // (e.g. a special the user keeps in Specials but TMDB lists inline). The local
  // episode is untouched structurally — only its metadata fields get written.
  const handleEpisodeTmdb = useCallback(async (ep: EpisodeInfo, source?: { season: number; episode: number }) => {
    const srcSeason = source?.season ?? selectedSeason?.season_number ?? null;
    const srcEpisode = source?.episode ?? ep.episode_number ?? null;
    if (!detail?.tmdb_id || srcSeason == null || srcEpisode == null) return;
    setEpisodeTmdbLoading(ep.id);
    try {
      const tmdbEp = await invoke<TmdbEpisodeDetail>("get_tmdb_episode_detail", {
        tmdbId: Number(detail.tmdb_id),
        seasonNumber: srcSeason,
        episodeNumber: srcEpisode,
      });
      const fields: TmdbEpisodeFieldSelection = {};
      if (tmdbEp.name) fields.title = tmdbEp.name;
      if (tmdbEp.overview) fields.plot = tmdbEp.overview;
      if (tmdbEp.runtime) fields.runtime = tmdbEp.runtime;
      if (tmdbEp.air_date) fields.release_date = tmdbEp.air_date;
      if (tmdbEp.guest_stars && tmdbEp.guest_stars.length > 0) {
        fields.cast = tmdbEp.guest_stars.map((c) => ({
          name: c.name,
          role: c.character ?? null,
          tmdb_id: c.id,
          profile_path: c.profile_path,
        }));
      }
      if (tmdbEp.crew && tmdbEp.crew.length > 0) {
        const directors = tmdbEp.crew
          .filter((c) => c.job === "Director")
          .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
        const composers = tmdbEp.crew
          .filter((c) => c.job === "Composer" || c.job === "Original Music Composer")
          .map((c) => ({ name: c.name, tmdb_id: c.id, profile_path: c.profile_path }));
        if (directors.length > 0) fields.director = directors;
        if (composers.length > 0) fields.composer = composers;
      }
      await invoke("apply_tmdb_episode_metadata", {
        episodeId: ep.id,
        fields,
      });
      toast.success(source
        ? `Populated from TMDB S${srcSeason} E${srcEpisode}`
        : `Episode ${ep.episode_number} metadata populated`);
      loadEpisodeDetail(ep.id);
      reloadEpisodes();
      onEntryChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setEpisodeTmdbLoading(null);
    }
  }, [detail, selectedSeason, loadEpisodeDetail, onEntryChanged, reloadEpisodes]);

  // "Fetch from a specific TMDB episode" — pick which TMDB episode to pull from.
  const [tmdbSourceFor, setTmdbSourceFor] = useState<EpisodeInfo | null>(null);
  const openTmdbSource = useCallback((ep: EpisodeInfo) => setTmdbSourceFor(ep), []);

  const [showRaterDraft, setShowRaterDraft] = useState<{ imdb_id: string; rt_id: string }>({ imdb_id: "", rt_id: "" });
  const [ratingsDraft, setRatingsDraft] = useState<Record<string, string>>({});
  const startEditShow = useCallback(() => {
    if (!detail) return;
    setSeasonEditing(false);
    setEditingEpisodeId(null);
    setShowRaterDraft({ imdb_id: detail.imdb_id ?? "", rt_id: detail.rotten_tomatoes_id ?? "" });
    setRatingsDraft(ratingsToDraft(ratings));
    setShowDraft({
      plot: detail.plot ?? "",
      tagline: detail.tagline ?? "",
      maturity_rating: detail.maturity_rating ?? "",
      genres: [...detail.genres],
      creators: detail.creators.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })),
      cast: detail.cast.map((c) => ({ name: c.name, role: c.role, tmdb_id: null, profile_path: null })),
      composers: detail.composers.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })),
      studios: [...detail.studios],
      keywords: [...detail.keywords],
    });
    setShowEditing(true);
  }, [detail, ratings]);

  const saveShow = useCallback(async () => {
    setShowSaving(true);
    try {
      await invoke("apply_tmdb_show_metadata", {
        showId: entry.id,
        fields: showDraft,
      });
      await invoke("set_rater_ids", {
        entryId: entry.id,
        imdbId: showRaterDraft.imdb_id.trim() || null,
        rtId: showRaterDraft.rt_id.trim() || null,
      });
      await invoke("set_manual_ratings", { entryId: entry.id, ratings: draftToRatings(ratingsDraft) });
      await loadDetail();
      setRatings(await invoke<RatingInfo[]>("get_ratings", { entryId: entry.id }).catch(() => [] as RatingInfo[]));
      onEntryChanged();
      setShowEditing(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setShowSaving(false);
    }
  }, [selectedLibrary.id, entry.id, showDraft, showRaterDraft, ratingsDraft, loadDetail, onEntryChanged]);

  const startEditSeason = useCallback(() => {
    if (!seasonDetail) return;
    setShowEditing(false);
    setEditingEpisodeId(null);
    setSeasonDraft({
      plot: seasonDetail.plot ?? "",
      cast: seasonDetail.cast.map((c) => ({ name: c.name, role: c.role, tmdb_id: null, profile_path: null })),
    });
    setSeasonEditing(true);
  }, [seasonDetail]);

  const saveSeason = useCallback(async () => {
    if (!selectedSeason) return;
    setSeasonSaving(true);
    try {
      await invoke("apply_tmdb_season_metadata", {
        seasonId: selectedSeason.id,
        fields: seasonDraft,
      });
      loadSeasonDetail(selectedSeason.id);
      setSeasonEditing(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSeasonSaving(false);
    }
  }, [selectedLibrary.id, selectedSeason, seasonDraft, loadSeasonDetail]);

  const startEditEpisode = useCallback((ep: EpisodeInfo) => {
    setShowEditing(false);
    setSeasonEditing(false);
    const d = episodeDetails.get(ep.id);
    setEpisodeDraft({
      title: ep.title,
      plot: d?.plot ?? "",
      runtime: d?.runtime ?? undefined,
      release_date: d?.release_date ?? "",
      cast: d?.cast.map((c) => ({ name: c.name, role: c.role, tmdb_id: null, profile_path: null })) ?? [],
      director: d?.directors.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })) ?? [],
      composer: d?.composers.map((p) => ({ name: p.name, tmdb_id: null, profile_path: null })) ?? [],
    });
    setEditingEpisodeId(ep.id);
  }, [episodeDetails]);

  const saveEpisode = useCallback(async () => {
    if (editingEpisodeId == null) return;
    setEpisodeSaving(true);
    try {
      await invoke("apply_tmdb_episode_metadata", {
        episodeId: editingEpisodeId,
        fields: episodeDraft,
      });
      loadEpisodeDetail(editingEpisodeId);
      reloadEpisodes();
      onEntryChanged();
      setEditingEpisodeId(null);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setEpisodeSaving(false);
    }
  }, [selectedLibrary.id, editingEpisodeId, episodeDraft, loadEpisodeDetail, onEntryChanged, reloadEpisodes]);

  const toggleEpisode = useCallback((epId: number) => {
    if (expandedEpisodeId === epId) {
      setExpandedEpisodeId(null);
    } else {
      setExpandedEpisodeId(epId);
      if (!episodeDetails.has(epId)) {
        loadEpisodeDetail(epId);
      }
    }
  }, [expandedEpisodeId, episodeDetails, loadEpisodeDetail]);

  const coverPath = getDisplayCover(entry);
  const coverSrc = useProgressiveCover(
    coverPath ? getCoverUrl(coverPath) : null,
    coverPath ? getFullCoverUrl(coverPath) : null,
  );
  const hasTmdb = !!detail?.tmdb_id;
  const canSeasonTmdb = hasTmdb && selectedSeason?.season_number != null;

  // One menu shared by the cover image and the hero/content area — identical
  // items; only the tab the TMDB image browser lands on differs by surface.
  // Grouped: watch → artwork → metadata → destructive.
  const detailMenuItems = (tmdbTab: "posters" | "backdrops") => (
    <>
      {extrasCount > 0 && (
        <>
          <ContextMenuItem onClick={() => setExtrasOpen(true)}>
            <Clapperboard size={14} />
            View extras
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
        <ImageIcon size={14} />
        Change cover
      </ContextMenuItem>
      <ContextMenuItem onClick={() => setBackdropDialogOpen(true)}>
        <ImageIcon size={14} />
        Change backdrop
      </ContextMenuItem>
      <ContextMenuItem onClick={() => setTmdbImagesTab(tmdbTab)} disabled={!detail?.tmdb_id}>
        <ImageIcon size={14} />
        Add cover/backdrop from TMDB
      </ContextMenuItem>
      <ContextMenuItem onClick={onAddCover}>
        <ImageIcon size={14} />
        Add local cover
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={startEditShow} disabled={!detail}>
        <Pencil size={14} />
        Edit
      </ContextMenuItem>
      <ContextMenuItem onClick={() => setTmdbDialogOpen(true)}>
        <Film size={14} />
        {detail?.tmdb_id ? "Rematch TMDB" : "Match TMDB"}
      </ContextMenuItem>
      {omdbEnabled && (
        <ContextMenuItem onClick={fetchRatings}>
          <RefreshCw size={14} />
          Get ratings
        </ContextMenuItem>
      )}
      {(() => {
        // Show-wide toggle, pivoting like everywhere else: watched is the
        // default, so the offered action is Mark unwatched unless every
        // episode is already explicitly flagged.
        const allUnwatched =
          episodeIds.length > 0 &&
          episodeIds.every((id) => {
            const w = epWatch.get(id);
            return !!w && !w.watched && w.position_secs == null;
          });
        return (
          <ContextMenuItem
            disabled={episodeIds.length === 0}
            onClick={async () => {
              try {
                await invoke("mark_show_watched", { showId: entry.id, watched: allUnwatched });
                loadWatch();
                onEntryChanged();
              } catch (e) {
                toast.error(String(e));
              }
            }}
          >
            {allUnwatched ? <Eye size={14} /> : <EyeOff size={14} />}
            {allUnwatched ? "Mark show watched" : "Mark show unwatched"}
          </ContextMenuItem>
        );
      })()}
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={onDeleteCover}
        disabled={entry.covers.length < 1}
        className="text-destructive focus:text-destructive"
      >
        <Trash2 size={14} />
        Delete cover
      </ContextMenuItem>
    </>
  );

  // Everything or nothing: a blank frame beats sections trickling in.
  if (loadedId !== entry.id) return null;

  return (
    <div className="relative isolate flex flex-wrap gap-8 p-6">
      {/* Hero backdrop: real backdrop art when one is downloaded; otherwise the
          cover blurred and washed out. Both fade into the page background. */}
      {(detail?.backdrop || coverSrc) && (
        // -inset-x-4/-top-4 cancel the scroll container's p-4 so the wash reaches the section borders.
        <div aria-hidden className="pointer-events-none absolute -inset-x-4 -top-4 -z-10 h-[490px] overflow-hidden">
          {detail?.backdrop ? (
            // Anchored 25% from the top: center-crop beheads top-composed art,
            // a hard top-anchor surfaces letterbox bars — upper-quarter splits it.
            <img src={convertFileSrc(detail.backdrop)} alt="" className="absolute inset-0 h-full w-full object-cover object-[50%_25%] opacity-15" />
          ) : (
            // Oversized by the blur radius (64px) on every side so the blur's
            // transparent falloff lands outside the visible box.
            <img src={coverSrc!} alt="" className="absolute -left-16 -top-16 h-[calc(100%+8rem)] w-[calc(100%+8rem)] max-w-none object-cover opacity-25 blur-3xl" />
          )}
          {/* via-35%: pulling the midpoint up stretches the fade-to-solid over
              the lower two-thirds of the band for a longer, cleaner falloff */}
          <div className="absolute inset-0 bg-linear-to-b from-transparent via-background/60 via-35% to-background" />
        </div>
      )}
      {coverSrc && (
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <img
                src={coverSrc}
                alt={entry.title}
                className="h-auto max-h-[500px] w-auto shrink-0 rounded-lg object-contain shadow-2xl ring-1 ring-foreground/10"
              />
            }
          />
          <ContextMenuContent>{detailMenuItems("posters")}</ContextMenuContent>
        </ContextMenu>
      )}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="@container flex min-w-0 flex-1 flex-col gap-4" />}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold">{entry.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {entry.year && (
                <span>{entry.year}{entry.end_year ? `–${entry.end_year}` : ""}</span>
              )}
              {/* Whole-show runtime — backend sends it only when every episode has one */}
              {detail?.total_runtime != null && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{fmtRuntime(detail.total_runtime)}</span>
                </>
              )}
              {detail?.maturity_rating && (
                <span className="rounded border border-border px-1.5 py-px text-xs">
                  {detail.maturity_rating}
                </span>
              )}
              {seasons.length > 0 && (() => {
                // Match the grid subtitle: count real seasons only (Specials = 0 is
                // never folded into the headline). A specials-only show reads "Specials".
                const real = seasons.filter((s) => s.season_number != null && s.season_number > 0).length;
                const label = real > 0
                  ? `${real} ${real === 1 ? "season" : "seasons"}`
                  : seasons.some((s) => s.season_number === 0)
                    ? "Specials"
                    : `${seasons.length} ${seasons.length === 1 ? "season" : "seasons"}`;
                return (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span>{label}</span>
                  </>
                );
              })()}
            </div>
            {detail?.tagline && (
              <p className="mt-2 italic text-muted-foreground">{detail.tagline}</p>
            )}
            <RatingsLine ratings={ratings} />
          </div>
          {/* Stacks vertically when the info column runs tight (narrow window /
              wide cover) so the title isn't smushed by a long button row. */}
          <div className="flex shrink-0 gap-2 @max-xl:flex-col @max-xl:items-stretch">
            {(continueTarget != null || firstEpisodeId != null) && !showEditing && (
              <Button
                size="sm"
                onClick={() => {
                  const targetId = continueTarget?.episode_id ?? firstEpisodeId;
                  if (targetId == null) return;
                  try {
                    onPlayEpisode?.({
                      libraryId: selectedLibrary.id,
                      showId: entry.id,
                      showTitle: entry.title,
                      startEpisodeId: targetId,
                      startSecs: continueTarget?.position_secs ?? undefined,
                    });
                  } catch (err) {
                    toast.error(String(err));
                  }
                }}
              >
                <Play size={14} />
                {(() => {
                  if (!continueTarget) return "Play";
                  const label =
                    continueTarget.season_number != null && continueTarget.episode_number != null
                      ? `Continue · S${continueTarget.season_number}E${continueTarget.episode_number}`
                      : "Continue";
                  // Mid-episode resume shows its timestamp, like the movie button.
                  return continueTarget.position_secs != null
                    ? `${label} from ${fmtClock(continueTarget.position_secs)}`
                    : label;
                })()}
              </Button>
            )}
            {extrasCount > 0 && (
              <Button size="sm" variant="outline" onClick={() => setExtrasOpen(true)}>
                <Clapperboard size={14} />
                Extras ({extrasCount})
              </Button>
            )}
            {showEditing && (
              <>
                <Button size="sm" variant="outline" onClick={() => setShowEditing(false)} disabled={showSaving}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveShow} disabled={showSaving}>
                  {showSaving ? "Saving..." : "Save"}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Show metadata */}
        {detail && !showEditing && (
          <div className="flex min-w-0 flex-col gap-5">
            {detail.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {detail.genres.map((g) => (
                  <button
                    key={g}
                    onClick={() => onSelectGenre?.(selectedLibrary.id, g)}
                    className="cursor-pointer rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground ring-1 ring-transparent transition-all hover:bg-primary/15 hover:text-foreground hover:ring-primary/50"
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}

            {detail.plot && <p className="text-sm leading-relaxed">{detail.plot}</p>}

            {(detail.creators.length > 0 || detail.composers.length > 0) && (
              <div className="flex flex-wrap gap-x-12 gap-y-4">
                {detail.creators.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Created by
                    </p>
                    <div className="-mx-1.5 flex flex-wrap gap-1">
                      {detail.creators.map((c) => (
                        <CastCard
                          key={c.id}
                          person={{ ...c, role: null }}
                          className="w-28"
                          onClick={() => onNavigateToPerson?.(c, "director_creator")}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {detail.composers.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {detail.composers.length === 1 ? "Composer" : "Composers"}
                    </p>
                    <div className="-mx-1.5 flex flex-wrap gap-1">
                      {detail.composers.map((c) => (
                        <CastCard
                          key={c.id}
                          person={{ ...c, role: null }}
                          className="w-28"
                          onClick={() => onNavigateToPerson?.(c, "composer")}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {showEditing && (
          <div className="flex flex-col gap-3 text-sm">
            <EditField label="Tagline" value={showDraft.tagline ?? ""} onChange={(v) => setShowDraft((p) => ({ ...p, tagline: v }))} />
            <EditField label="Plot" value={showDraft.plot ?? ""} onChange={(v) => setShowDraft((p) => ({ ...p, plot: v }))} multiline />
            <EditField label="Maturity Rating" value={showDraft.maturity_rating ?? ""} onChange={(v) => setShowDraft((p) => ({ ...p, maturity_rating: v }))} />
            <EditField label="Genres (comma-separated)" value={(showDraft.genres ?? []).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, genres: v.split(",").map((s) => s.trim()).filter(Boolean) }))} />
            <EditField label="Creators (comma-separated)" value={(showDraft.creators ?? []).map((c) => c.name).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, creators: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
            <EditField label="Composers (comma-separated)" value={(showDraft.composers ?? []).map((c) => c.name).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, composers: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
            <PeopleListEdit label="Cast" items={showDraft.cast ?? []} onChange={(items) => setShowDraft((p) => ({ ...p, cast: items }))} secondaryField="role" secondaryLabel="Role" />
            <EditField label="Studios (comma-separated)" value={(showDraft.studios ?? []).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, studios: v.split(",").map((s) => s.trim()).filter(Boolean) }))} />
            <EditField label="Keywords (comma-separated)" value={(showDraft.keywords ?? []).join(", ")} onChange={(v) => setShowDraft((p) => ({ ...p, keywords: v.split(",").map((s) => s.trim()).filter(Boolean) }))} />
            <EditField label="IMDB ID" value={showRaterDraft.imdb_id} onChange={(v) => setShowRaterDraft((p) => ({ ...p, imdb_id: v }))} />
            <EditField label="Rotten Tomatoes ID" value={showRaterDraft.rt_id} onChange={(v) => setShowRaterDraft((p) => ({ ...p, rt_id: v }))} />
            <RatingsEditFields draft={ratingsDraft} onChange={(s, v) => setRatingsDraft((p) => ({ ...p, [s]: v }))} />
          </div>
        )}

        </ContextMenuTrigger>
        <ContextMenuContent>{detailMenuItems("backdrops")}</ContextMenuContent>
      </ContextMenu>

      {/* Seasons + episodes — full-width band below the hero (w-full forces the wrap) */}
      <div className="flex w-full min-w-0 flex-col gap-4">
        {seasons.length > 0 && (
          <div className="flex flex-col gap-3">
            {/* Season pills: the show's shape at a glance, one click to switch */}
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {seasons.map((s) => {
                const active = s.id === selectedSeasonId;
                return (
                  <button
                    key={s.id}
                    onClick={() => selectSeason(s.id)}
                    className={`shrink-0 rounded-full px-3 py-1 text-sm transition-colors ${
                      active
                        ? "bg-primary font-medium text-primary-foreground"
                        : "bg-secondary text-secondary-foreground hover:bg-accent"
                    }`}
                  >
                    {s.season_number === 0 ? "Specials" : s.season_number != null ? `Season ${s.season_number}` : s.title}
                  </button>
                );
              })}
            </div>

            {/* Season metadata — borderless header band; the meta line always renders
                so there's a right-click target even when the season has no metadata */}
            {selectedSeason && !seasonEditing && (() => {
              const episodesNumbered = episodes.length > 0 && episodes.every((e) => e.episode_number != null);
              // Watched is the default — the season action pivots on every
              // episode being explicitly flagged unwatched.
              const seasonAllUnwatched =
                episodes.length > 0 &&
                episodes.every((e) => {
                  const w = epWatch.get(e.id);
                  return !!w && !w.watched && w.position_secs == null;
                });
              const totalRuntime = episodes.reduce((sum, e) => sum + (e.runtime ?? 0), 0);
              const years = [...new Set(episodes.map((e) => e.release_date?.slice(0, 4)).filter((y): y is string => !!y))].sort();
              const seasonMeta = [
                `${episodes.length} episode${episodes.length === 1 ? "" : "s"}`,
                totalRuntime > 0 ? fmtRuntime(totalRuntime) : null,
                years.length > 0 ? (years.length === 1 ? years[0] : `${years[0]}–${years[years.length - 1]}`) : null,
              ].filter(Boolean).join("  ·  ");
              return (
                <ContextMenu>
                  <ContextMenuTrigger render={<div className="flex flex-col gap-2" />}>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>{seasonMeta}</span>
                      {!seasonDetail && <Spinner className="h-3.5 w-3.5" />}
                    </div>
                    {/* Season cast intentionally not shown — per-season billing spoils
                        character exits. It's merged into the show-wide Cast band instead. */}
                    {seasonDetail?.plot && <p className="text-sm">{seasonDetail.plot}</p>}
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={startEditSeason} disabled={!seasonDetail}>
                      <Pencil size={14} />
                      Edit
                    </ContextMenuItem>
                    <ContextMenuItem onClick={handleSeasonTmdb} disabled={!canSeasonTmdb || seasonTmdbLoading}>
                      <Tv size={14} />
                      {seasonTmdbLoading ? "Loading..." : "Populate season from TMDB"}
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => setBulkConfirmOpen(true)} disabled={!canSeasonTmdb || bulkEpisodesLoading || !episodesNumbered}>
                      <Film size={14} />
                      {bulkEpisodesLoading ? "Loading..." : "Fetch all episodes' details"}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      disabled={episodes.length === 0}
                      onClick={async () => {
                        try {
                          await invoke("mark_season_watched", { seasonId: selectedSeason.id, watched: seasonAllUnwatched });
                          loadWatch();
                        } catch (e) {
                          toast.error(String(e));
                        }
                      }}
                    >
                      {seasonAllUnwatched ? <Eye size={14} /> : <EyeOff size={14} />}
                      {seasonAllUnwatched ? "Mark season watched" : "Mark season unwatched"}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })()}

            {selectedSeason && seasonEditing && (
              <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
                <EditField label="Plot" value={seasonDraft.plot ?? ""} onChange={(v) => setSeasonDraft((p) => ({ ...p, plot: v }))} multiline />
                <EditField label="Season-wide Director (comma-separated — applied to every episode)" value={(seasonDraft.season_director ?? []).map((c) => c.name).join(", ")} onChange={(v) => setSeasonDraft((p) => ({ ...p, season_director: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
                <PeopleListEdit label="Cast" items={seasonDraft.cast ?? []} onChange={(items) => setSeasonDraft((p) => ({ ...p, cast: items }))} secondaryField="role" secondaryLabel="Role" />
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setSeasonEditing(false)} disabled={seasonSaving}>Cancel</Button>
                  <Button size="sm" onClick={saveSeason} disabled={seasonSaving}>{seasonSaving ? "Saving..." : "Save"}</Button>
                </div>
              </div>
            )}

            {/* Episodes */}
            <div className="flex flex-col gap-1">
              {episodes.map((ep) => {
                const isExpanded = expandedEpisodeId === ep.id;
                const epDetail = episodeDetails.get(ep.id);
                const hasDetail = epDetail && (epDetail.release_date || epDetail.plot || epDetail.runtime || epDetail.cast.length > 0 || epDetail.directors.length > 0 || epDetail.composers.length > 0);
                const w = epWatch.get(ep.id);
                const epProgress =
                  w && !w.watched && w.position_secs != null && w.duration_secs && w.duration_secs > 0
                    ? Math.min(1, Math.max(0, w.position_secs / w.duration_secs))
                    : null;
                // Explicitly flagged unwatched — the state worth surfacing.
                const epUnwatched = !!w && !w.watched && w.position_secs == null;
                return (
                  <div key={ep.id} className="flex flex-col">
                    <ContextMenu>
                      <ContextMenuTrigger
                        render={
                          <div
                            className="flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 hover:bg-accent"
                            onClick={() => toggleEpisode(ep.id)}
                          />
                        }
                      >
                      {isExpanded ? <ChevronDown size={14} className="mt-1 shrink-0 text-muted-foreground" /> : <ChevronRight size={14} className="mt-1 shrink-0 text-muted-foreground" />}
                      <span className="mt-0.5 w-10 shrink-0 whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
                        {ep.episode_number != null
                          ? (ep.episode_number_end != null && ep.episode_number_end > ep.episode_number
                              ? `${ep.episode_number}-${ep.episode_number_end}`
                              : ep.episode_number)
                          : "–"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-medium">{ep.title}</span>
                          {ep.runtime != null && (
                            <span className="shrink-0 text-xs text-muted-foreground">{fmtRuntime(ep.runtime)}</span>
                          )}
                        </div>
                        {/* Snippet hides while expanded — the panel below shows the full plot */}
                        {!isExpanded && ep.plot && (
                          <p className="mt-0.5 text-xs leading-snug text-muted-foreground line-clamp-2">{ep.plot}</p>
                        )}
                      </div>
                      {/* Watch indicator: eye-off = flagged unwatched, mini
                          bar = partial. Watched is the default — unbadged. */}
                      {epUnwatched && (
                        <EyeOff size={14} className="self-center text-muted-foreground" aria-label="Marked unwatched" />
                      )}
                      {epProgress != null && (
                        <div className="h-1 w-12 self-center overflow-hidden rounded-full bg-muted" title={`${Math.round(epProgress * 100)}% watched`}>
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(epProgress * 100)}%` }} />
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="self-center"
                        title={
                          !w?.watched && w?.position_secs != null
                            ? `Resume from ${fmtClock(w.position_secs)}`
                            : undefined
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          try {
                            onPlayEpisode?.({
                              libraryId: selectedLibrary.id,
                              showId: entry.id,
                              showTitle: entry.title,
                              startEpisodeId: ep.id,
                              startSecs: w?.watched ? undefined : w?.position_secs ?? undefined,
                            });
                          } catch (err) {
                            toast.error(String(err));
                          }
                        }}
                      >
                        <Play size={14} />
                      </Button>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          onClick={async () => {
                            try {
                              await invoke("mark_watched", { kind: "episode", id: ep.id, watched: epUnwatched });
                              loadWatch();
                            } catch (e) {
                              toast.error(String(e));
                            }
                          }}
                        >
                          {epUnwatched ? <Eye size={14} /> : <EyeOff size={14} />}
                          {epUnwatched ? "Mark watched" : "Mark unwatched"}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          onClick={() => handleEpisodeTmdb(ep)}
                          disabled={!canSeasonTmdb || ep.episode_number == null || episodeTmdbLoading === ep.id}
                        >
                          <Film size={14} />
                          {episodeTmdbLoading === ep.id ? "Loading..." : "Fetch from TMDB"}
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() => openTmdbSource(ep)}
                          disabled={!hasTmdb || episodeTmdbLoading === ep.id}
                        >
                          <Film size={14} />
                          Fetch from a specific TMDB episode…
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    {/* Expanded panel slides open via the 0fr→1fr grid-rows trick; loaded
                        panels stay mounted (height 0) so collapse animates instead of snapping */}
                    <div
                      className="grid transition-[grid-template-rows] duration-200 ease-out"
                      style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
                    >
                    <div className="overflow-hidden">
                    {(isExpanded || epDetail) && editingEpisodeId !== ep.id && (
                      <ContextMenu>
                        <ContextMenuTrigger render={<div className="mb-2 ml-14 mt-1 flex flex-col gap-2 border-l-2 border-primary/40 bg-muted/30 py-2.5 pl-4 pr-3 text-sm" />}>
                          {!epDetail && <Spinner className="h-4 w-4" />}
                          {epDetail && !hasDetail && (
                            <p className="text-muted-foreground">No metadata</p>
                          )}
                          {epDetail && hasDetail && (
                            <>
                              {(epDetail.release_date || epDetail.runtime) && (
                                <p className="text-xs text-muted-foreground">
                                  {[
                                    formatReleaseDate(epDetail.release_date),
                                    epDetail.runtime ? fmtRuntime(epDetail.runtime) : null,
                                  ].filter(Boolean).join("  ·  ")}
                                </p>
                              )}
                              {epDetail.plot && (
                                <p>{epDetail.plot}</p>
                              )}
                              {(epDetail.directors.length > 0 || epDetail.composers.length > 0) && (
                                <div className="flex flex-wrap gap-x-10 gap-y-3">
                                  {epDetail.directors.length > 0 && (
                                    <div className="flex flex-col gap-1">
                                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {epDetail.directors.length === 1 ? "Director" : "Directors"}
                                      </p>
                                      <div className="-mx-1.5 flex flex-wrap gap-1">
                                        {epDetail.directors.map((d) => (
                                          <CastCard
                                            key={d.id}
                                            person={{ ...d, role: null }}
                                            className="w-24"
                                            onClick={() => onNavigateToPerson?.(d, "director_creator")}
                                          />
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {epDetail.composers.length > 0 && (
                                    <div className="flex flex-col gap-1">
                                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {epDetail.composers.length === 1 ? "Composer" : "Composers"}
                                      </p>
                                      <div className="-mx-1.5 flex flex-wrap gap-1">
                                        {epDetail.composers.map((c) => (
                                          <CastCard
                                            key={c.id}
                                            person={{ ...c, role: null }}
                                            className="w-24"
                                            onClick={() => onNavigateToPerson?.(c, "composer")}
                                          />
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                              {epDetail.cast.length > 0 && (
                                <div className="flex min-w-0 flex-col gap-1">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Guest Stars</p>
                                  <div className="-mx-1.5 flex flex-wrap gap-1">
                                    {epDetail.cast.map((c) => (
                                      <CastCard
                                        key={c.id}
                                        person={c}
                                        className="w-24"
                                        onClick={() =>
                                          onNavigateToPerson?.(
                                            { id: c.id, name: c.name, image_path: c.image_path },
                                            "actor",
                                          )
                                        }
                                      />
                                    ))}
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onClick={() => startEditEpisode(ep)} disabled={!epDetail}>
                            <Pencil size={14} />
                            Edit
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => handleEpisodeTmdb(ep)}
                            disabled={!canSeasonTmdb || ep.episode_number == null || episodeTmdbLoading === ep.id}
                          >
                            <Film size={14} />
                            {episodeTmdbLoading === ep.id ? "Loading..." : "Fetch from TMDB"}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => openTmdbSource(ep)}
                            disabled={!hasTmdb || episodeTmdbLoading === ep.id}
                          >
                            <Film size={14} />
                            Fetch from a specific TMDB episode…
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    )}
                    {isExpanded && editingEpisodeId === ep.id && (
                      <div className="mb-2 ml-14 mt-1 flex flex-col gap-3 rounded-md border p-3 text-sm">
                        <EditField label="Title" value={episodeDraft.title ?? ""} onChange={(v) => setEpisodeDraft((p) => ({ ...p, title: v }))} />
                        <EditField label="Air Date" value={episodeDraft.release_date ?? ""} onChange={(v) => setEpisodeDraft((p) => ({ ...p, release_date: v }))} />
                        <EditField label="Runtime (min)" value={episodeDraft.runtime != null ? String(episodeDraft.runtime) : ""} onChange={(v) => setEpisodeDraft((p) => ({ ...p, runtime: v ? Number(v) : undefined }))} />
                        <EditField label="Plot" value={episodeDraft.plot ?? ""} onChange={(v) => setEpisodeDraft((p) => ({ ...p, plot: v }))} multiline />
                        <PeopleListEdit label="Guest Stars" items={episodeDraft.cast ?? []} onChange={(items) => setEpisodeDraft((p) => ({ ...p, cast: items }))} secondaryField="role" secondaryLabel="Role" />
                        <EditField label="Director (comma-separated)" value={(episodeDraft.director ?? []).map((d) => d.name).join(", ")} onChange={(v) => setEpisodeDraft((p) => ({ ...p, director: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
                        <EditField label="Composer (comma-separated)" value={(episodeDraft.composer ?? []).map((c) => c.name).join(", ")} onChange={(v) => setEpisodeDraft((p) => ({ ...p, composer: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, tmdb_id: null, profile_path: null })) }))} />
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => setEditingEpisodeId(null)} disabled={episodeSaving}>Cancel</Button>
                          <Button size="sm" onClick={saveEpisode} disabled={episodeSaving}>{episodeSaving ? "Saving..." : "Save"}</Button>
                        </div>
                      </div>
                    )}
                    </div>
                    </div>
                  </div>
                );
              })}
              {episodes.length === 0 && (
                <p className="text-sm text-muted-foreground">No episodes</p>
              )}
            </div>
          </div>
        )}

        {seasons.length === 0 && (
          <p className="text-sm text-muted-foreground">No seasons</p>
        )}
      </div>

      {/* Cast + reference footer — full-width band below the episodes */}
      {detail && !showEditing && (detail.cast.length > 0 || detail.studios.length > 0 || detail.tmdb_id || detail.imdb_id) && (
        <div className="flex w-full min-w-0 flex-col gap-5">
          {detail.cast.length > 0 && (
            <CastBand cast={detail.cast} onNavigateToPerson={onNavigateToPerson} />
          )}
          {(detail.studios.length > 0 || detail.tmdb_id || detail.imdb_id) && (
            <p className="text-xs text-muted-foreground/70">
              {[
                detail.studios.length > 0 ? detail.studios.join(", ") : null,
                detail.tmdb_id ? `TMDB ${detail.tmdb_id}` : null,
                detail.imdb_id ? `IMDB ${detail.imdb_id}` : null,
              ]
                .filter(Boolean)
                .join("  ·  ")}
            </p>
          )}
        </div>
      )}

      <ExtrasDialog
        open={extrasOpen}
        onOpenChange={setExtrasOpen}
        libraryId={selectedLibrary.id}
        entryId={entry.id}
        entryTitle={entry.title}
        isShow
        onPlayFile={onPlayFile}
      />
      <TmdbShowMatchDialog
        open={tmdbDialogOpen}
        onOpenChange={setTmdbDialogOpen}
        entryId={entry.id}
        entryTitle={entry.title}
        entryYear={entry.year}
        currentDetail={detail}
        onApplied={() => { loadDetail(); onEntryChanged(); }}
      />

      {detail?.tmdb_id && (
        <TmdbImageBrowserDialog
          open={tmdbImagesTab !== null}
          onOpenChange={(open) => { if (!open) setTmdbImagesTab(null); }}
          initialTab={tmdbImagesTab ?? "posters"}
          libraryId={selectedLibrary.id}
          entryId={entry.id}
          tmdbId={detail.tmdb_id}
          mediaType="tv"
          onDownloaded={() => { loadDetail(); onEntryChanged(); }}
        />
      )}
      <BackdropSelectDialog
        open={backdropDialogOpen}
        onOpenChange={setBackdropDialogOpen}
        entryId={entry.id}
        current={detail?.backdrop ?? null}
        onChanged={loadDetail}
      />

      {/* Bulk episode fetch confirmation */}
      <Dialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fetch Episode Details</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            This will fetch metadata (plot, runtime, guest stars, crew) for all episodes in this season from TMDB.
            Only empty fields will be populated. Doing this multiple times in quick succession may cause you to hit TMDB's rate limit.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConfirmOpen(false)}>Cancel</Button>
            <Button onClick={handleBulkEpisodes}>Fetch All Episodes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TmdbEpisodeSourceDialog
        open={tmdbSourceFor != null}
        onOpenChange={(o) => { if (!o) setTmdbSourceFor(null); }}
        tmdbId={detail?.tmdb_id != null ? Number(detail.tmdb_id) : null}
        defaultSeason={selectedSeason?.season_number ?? null}
        defaultEpisode={tmdbSourceFor?.episode_number ?? null}
        onFetch={(season, episode) => { if (tmdbSourceFor) handleEpisodeTmdb(tmdbSourceFor, { season, episode }); }}
      />
    </div>
  );
}

function PeopleListEdit<T extends CastUpdateInfo>({
  label,
  items,
  onChange,
  secondaryField,
  secondaryLabel,
}: {
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  secondaryField: "role";
  secondaryLabel: string;
}) {
  // Name autocomplete: suggest existing people from the DB as you type, so
  // additions reuse the canonical person row instead of typo-spawning a twin.
  const [suggest, setSuggest] = useState<{ row: number; options: PersonInfo[] } | null>(null);
  const suggestSeq = useRef(0);
  const suggestTimer = useRef<number | undefined>(undefined);

  const queryNames = (row: number, q: string) => {
    window.clearTimeout(suggestTimer.current);
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setSuggest(null);
      return;
    }
    const seq = ++suggestSeq.current;
    suggestTimer.current = window.setTimeout(async () => {
      try {
        const options = await invoke<PersonInfo[]>("search_persons", { query: trimmed });
        if (suggestSeq.current === seq) setSuggest(options.length > 0 ? { row, options } : null);
      } catch {
        /* suggestions are best-effort */
      }
    }, 150);
  };

  // Hide names already in the list (including this row's exact current value)
  // and collapse duplicate person rows that share a name.
  const visibleOptions = (row: number): PersonInfo[] => {
    if (!suggest || suggest.row !== row) return [];
    const taken = new Set(items.map((it) => it.name.trim().toLowerCase()).filter(Boolean));
    const seen = new Set<string>();
    return suggest.options.filter((p) => {
      const key = p.name.toLowerCase();
      if (taken.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const update = (i: number, patch: Partial<T>) => {
    const next = items.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, { name: "", [secondaryField]: null, tmdb_id: null } as unknown as T]);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex flex-col gap-1">
        {items.map((item, i) => {
          const options = visibleOptions(i);
          return (
          <div key={i} className="flex gap-1">
            <div className="relative flex-1">
              <input
                value={item.name}
                onChange={(e) => {
                  update(i, { name: e.target.value } as Partial<T>);
                  queryNames(i, e.target.value);
                }}
                // Delayed so a click on a suggestion (onMouseDown) wins the race.
                onBlur={() => setTimeout(() => setSuggest((s) => (s?.row === i ? null : s)), 100)}
                placeholder="Name"
                className="w-full rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
              />
              {options.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
                  {options.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        update(i, { name: p.name } as Partial<T>);
                        setSuggest(null);
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                    >
                      <PersonFace imagePath={p.image_path} className="h-6 w-6" iconSize={12} />
                      <span className="truncate">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              value={(item as unknown as Record<string, string | null>)[secondaryField] ?? ""}
              onChange={(e) => update(i, { [secondaryField]: e.target.value || null } as unknown as Partial<T>)}
              placeholder={secondaryLabel}
              className="flex-1 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
            />
            <Button size="sm" variant="ghost" onClick={() => remove(i)}>
              <Trash2 size={14} />
            </Button>
          </div>
          );
        })}
        <Button size="sm" variant="outline" onClick={add} className="w-fit">
          + Add
        </Button>
      </div>
    </div>
  );
}

function EditField({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
        />
      )}
    </div>
  );
}

function PersonDetailHeader({
  name,
  imagePath,
  role,
  workCount,
}: {
  name: string;
  imagePath: string | null;
  role: PersonRole;
  workCount: number;
}) {
  const imageSrc = imagePath ? convertFileSrc(imagePath) : null;
  const roleLabel =
    role === "actor" ? "Actor"
    : role === "director_creator" ? "Director / Creator"
    : role === "composer" ? "Composer"
    : "Credits";
  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-4">
      <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
        {imageSrc ? (
          <img src={imageSrc} alt={name} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <UserIcon className="h-10 w-10 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-2xl font-bold">{name}</h1>
        <p className="text-sm text-muted-foreground">
          {roleLabel} · {workCount === 1 ? "1 work" : `${workCount} works`}
        </p>
      </div>
    </div>
  );
}

// ── Playlists grid view ─────────────────────────────────────────────
// Shows the user's playlists as clickable cards. Right-click on a card offers
// Rename / Delete / Create playlist (peer); right-click on the grid background
// offers Create playlist. Uses the shared RenameDialog for name edits.

function PlaylistsView({
  libraryId,
  playlists,
  loading,
  breadcrumbBar,
  scrollContainerRef,
  onNavigateToPlaylist,
  onPlaylistChanged,
  getFullCoverUrl,
  search,
  onSearchChange,
  coverSize,
  onCoverSizeChange,
  sortMode,
  onSortModeChange,
  presets,
  selectedPresetId,
  onChangePreset,
  onSavePreset,
  onDeletePreset,
}: {
  libraryId: string;
  playlists: PlaylistSummary[] | null;
  loading: boolean;
  breadcrumbBar: React.ReactNode;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onNavigateToPlaylist: (p: PlaylistSummary) => void;
  onPlaylistChanged: (libraryId: string) => void;
  getFullCoverUrl: (filePath: string) => string;
  search: string;
  onSearchChange: (search: string) => void;
  coverSize: number;
  onCoverSizeChange: (size: number) => void;
  sortMode: string;
  onSortModeChange: (mode: string) => void;
  presets: SortPreset[];
  selectedPresetId: number | null;
  onChangePreset: (presetId: number | null) => Promise<void> | void;
  onSavePreset: (name: string, overwrite: boolean) => Promise<void>;
  onDeletePreset: (presetId: number) => Promise<void> | void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<PlaylistSummary | null>(null);
  const [coverDialog, setCoverDialog] = useState<{ playlist: PlaylistSummary; mode: "select" | "delete" } | null>(null);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  // Confirm-before-delete targets (empty playlists skip confirmation entirely).
  const [deletePlaylistTarget, setDeletePlaylistTarget] = useState<PlaylistSummary | null>(null);
  const [deletePresetTarget, setDeletePresetTarget] = useState<SortPreset | null>(null);
  // Play the page load-in (drop-in) on the cards the first time they appear, matching the
  // library grid. Fires once per mount (i.e. per navigation to the playlists list).
  const gridRef = useRef<HTMLDivElement | null>(null);
  const didLoadInRef = useRef(false);
  useLayoutEffect(() => {
    if (didLoadInRef.current) return;
    const grid = gridRef.current;
    if (!grid || grid.children.length === 0) return;
    didLoadInRef.current = true;
    playDropIn(grid.children);
  });

  async function deletePlaylist(p: PlaylistSummary) {
    try {
      await invoke("delete_playlist", { playlistId: p.id });
      onPlaylistChanged(libraryId);
    } catch (e) {
      toast.error(String(e));
    }
  }

  // Empty playlists delete straight away; ones holding anything (links, or
  // nested collections even when those are empty) confirm first.
  function handleDelete(p: PlaylistSummary) {
    if (p.movie_count + p.show_count + p.collection_count === 0) {
      void deletePlaylist(p);
    } else {
      setDeletePlaylistTarget(p);
    }
  }

  async function handleAddCover(p: PlaylistSummary) {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("add_playlist_cover", { playlistId: p.id, sourcePath: selected });
      onPlaylistChanged(libraryId);
    } catch (e) {
      toast.error(String(e));
    }
  }

  // Synthesized MediaEntry passed to CoverCarouselDialog — only the fields it reads
  // (title, covers, selected_cover) need to be set.
  const dialogEntry: MediaEntry | null = coverDialog
    ? {
        id: coverDialog.playlist.id,
        title: coverDialog.playlist.title,
        year: null,
        end_year: null,
        folder_path: "",
        parent_id: null,
        entry_type: "playlist",
        covers: coverDialog.playlist.covers,
        selected_cover: coverDialog.playlist.selected_cover,
        child_count: 0,
        season_display: null,
        collection_display: null,
        tmdb_id: null,
        link_id: null,
        interactive: false,
        watched: false,
        watch_progress: null,
        unwatched: false,
      }
    : null;

  // Optimistic local order during a drag-reorder; reset whenever a fresh list
  // arrives from the backend (which will already reflect the persisted order).
  const [localOrder, setLocalOrder] = useState<PlaylistSummary[] | null>(null);
  useEffect(() => { setLocalOrder(null); }, [playlists]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const ordered = localOrder ?? playlists;
  const q = search.trim().toLowerCase();
  const visible = ordered ? (q ? ordered.filter((p) => p.title.toLowerCase().includes(q)) : ordered) : null;
  // Reorder only makes sense in custom sort with no active search filter.
  const dragEnabled = sortMode === "custom" && !q;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !ordered) return;
    const oldIndex = ordered.findIndex((p) => p.id === active.id);
    const newIndex = ordered.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = [...ordered];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    setLocalOrder(reordered);
    invoke("reorder_playlists", { libraryId, ids: reordered.map((p) => p.id) })
      .then(() => onPlaylistChanged(libraryId))
      .catch((e) => toast.error(String(e)));
  };

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {breadcrumbBar}
      {/* Search + Sort + Size — parity with the library grid's toolbar. */}
      {!loading && (
        <div className="flex items-center gap-3 border-b border-border px-4 py-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search..." className="h-8 pl-8 text-sm" />
          </div>
          <div className="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                <ArrowUpDown size={12} />
                {(() => {
                  // A selected preset shows its name; the underlying sort_mode is still "custom".
                  if (selectedPresetId != null) {
                    const p = presets.find((p) => p.id === selectedPresetId);
                    if (p) return p.name;
                  }
                  return sortMode === "alpha" ? "A–Z" : "Custom";
                })()}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onSortModeChange("alpha")}>Alphabetical</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { onSortModeChange("custom"); onChangePreset(null); }}>Custom</DropdownMenuItem>
                {presets.length > 0 && <DropdownMenuSeparator />}
                {presets.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => onChangePreset(p.id)}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{p.name}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeletePresetTarget(p);
                      }}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete preset ${p.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* Save-preset: pristine custom sort with playlists to save. */}
            {sortMode === "custom" && selectedPresetId === null && (playlists?.length ?? 0) > 0 && (
              <button
                onClick={() => setSavePresetOpen(true)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title="Save current order as a preset"
              >
                <Save size={14} />
              </button>
            )}
          </div>
          <div className="flex w-32 items-center gap-2">
            <Slider value={[coverSize]} onValueChange={(v) => onCoverSizeChange(Array.isArray(v) ? v[0] : v)} min={100} max={400} step={10} className="w-full" />
          </div>
        </div>
      )}
      <ContextMenu>
        <ContextMenuTrigger render={<div ref={scrollContainerRef} className="flex-1 overflow-y-auto" />}>
          {loading && (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-6" />
            </div>
          )}
          {!loading && playlists && playlists.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No playlists yet. Right-click here to create one.</p>
          )}
          {!loading && visible && visible.length === 0 && playlists && playlists.length > 0 && (
            <p className="p-4 text-sm text-muted-foreground">No results</p>
          )}
          {!loading && visible && visible.length > 0 && (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={visible.map((p) => p.id)} strategy={rectSortingStrategy}>
                <div
                  ref={gridRef}
                  className="grid gap-4 p-4"
                  style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))`, justifyItems: "center" }}
                >
                  {visible.map((pl) => (
                    <PlaylistCard
                      key={pl.id}
                      playlist={pl}
                      coverSize={coverSize}
                      sortable={dragEnabled}
                      onClick={() => onNavigateToPlaylist(pl)}
                  onRename={() => setRenameTarget(pl)}
                  onDelete={() => handleDelete(pl)}
                  onCreatePeer={() => setCreateOpen(true)}
                  onAddCover={() => handleAddCover(pl)}
                      onChangeCover={() => setCoverDialog({ playlist: pl, mode: "select" })}
                      onDeleteCover={() => setCoverDialog({ playlist: pl, mode: "delete" })}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setCreateOpen(true)}>
            <FolderPlus size={14} />
            Create playlist
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <CreatePlaylistDialog
        libraryId={libraryId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => onPlaylistChanged(libraryId)}
      />
      <RenameDialog
        open={renameTarget !== null}
        onOpenChange={(o) => { if (!o) setRenameTarget(null); }}
        title="Rename playlist"
        initialValue={renameTarget?.title ?? ""}
        onSubmit={async (newName) => {
          if (!renameTarget) return;
          try {
            await invoke("rename_playlist", { playlistId: renameTarget.id, newTitle: newName });
            onPlaylistChanged(libraryId);
          } catch (e) {
            toast.error(String(e));
          }
        }}
      />
      <ConfirmDialog
        open={deletePlaylistTarget != null}
        onOpenChange={(o) => { if (!o) setDeletePlaylistTarget(null); }}
        title="Delete Playlist"
        message={<>Delete &ldquo;{deletePlaylistTarget?.title}&rdquo;? The linked media will not be deleted.</>}
        onConfirm={() => { if (deletePlaylistTarget) void deletePlaylist(deletePlaylistTarget); }}
      />
      <ConfirmDialog
        open={deletePresetTarget != null}
        onOpenChange={(o) => { if (!o) setDeletePresetTarget(null); }}
        title="Delete Preset"
        message={<>Delete preset &ldquo;{deletePresetTarget?.name}&rdquo;?</>}
        onConfirm={() => { if (deletePresetTarget) onDeletePreset(deletePresetTarget.id); }}
      />
      {dialogEntry && coverDialog && (
        <CoverCarouselDialog
          entry={dialogEntry}
          mode={coverDialog.mode}
          open={coverDialog !== null}
          onOpenChange={(open) => { if (!open) setCoverDialog(null); }}
          onSelect={async (coverPath) => {
            try {
              await invoke("set_playlist_cover", { playlistId: coverDialog.playlist.id, coverPath });
              onPlaylistChanged(libraryId);
            } catch (e) {
              toast.error(String(e));
            }
            setCoverDialog(null);
          }}
          onDelete={async (coverPath) => {
            const wasLast = coverDialog.playlist.covers.length <= 1;
            try {
              await invoke("delete_playlist_cover", { playlistId: coverDialog.playlist.id, coverPath });
              onPlaylistChanged(libraryId);
            } catch (e) {
              toast.error(String(e));
            }
            if (wasLast) setCoverDialog(null);
          }}
          getCoverUrl={getFullCoverUrl}
        />
      )}
      <SortPresetSaveDialog
        open={savePresetOpen}
        onOpenChange={setSavePresetOpen}
        onSave={onSavePreset}
      />
    </main>
  );
}

function PlaylistCard({
  playlist,
  coverSize,
  sortable,
  onClick,
  onRename,
  onDelete,
  onCreatePeer,
  onAddCover,
  onChangeCover,
  onDeleteCover,
}: {
  playlist: PlaylistSummary;
  coverSize: number;
  sortable: boolean;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCreatePeer: () => void;
  onAddCover: () => void;
  onChangeCover: () => void;
  onDeleteCover: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: playlist.id, disabled: !sortable });
  const coverSrc = playlist.selected_cover ? convertFileSrc(playlist.selected_cover) : null;
  // Subtitle mirrors the library grid: "N movies and M shows · 2008–2014".
  const countPart = [
    playlist.movie_count > 0 ? (playlist.movie_count === 1 ? "1 movie" : `${playlist.movie_count} movies`) : null,
    playlist.show_count > 0 ? (playlist.show_count === 1 ? "1 show" : `${playlist.show_count} shows`) : null,
  ].filter(Boolean).join(" and ");
  const yearPart = playlist.year ? `${playlist.year}${playlist.end_year ? `–${playlist.end_year}` : ""}` : null;
  const subtitle = [countPart || null, yearPart].filter(Boolean).join(", ");
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            style={{ width: coverSize, maxWidth: "100%", ...(sortable ? { transform: CSS.Transform.toString(transform), transition } : {}) }}
            onClick={() => { if (!isDragging) onClick(); }}
            onContextMenu={(e) => e.stopPropagation()}
            className={`group flex flex-col gap-2 rounded-md p-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isDragging ? "opacity-50" : ""}`}
          />
        }
      >
        <div className="relative aspect-[2/3] overflow-hidden rounded-[3px] bg-muted shadow-md ring-1 ring-foreground/10 transition-[translate,scale] duration-200 group-hover:-translate-y-1 group-hover:scale-[1.04] group-hover:shadow-xl group-hover:ring-foreground/25">
          {coverSrc ? (
            <img src={coverSrc} alt={playlist.title} className="h-full w-full object-cover" draggable={false} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <ListMusic size={36} />
            </div>
          )}
        </div>
        <div className="px-1">
          <p className="line-clamp-2 text-sm font-medium">{playlist.title}</p>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRename}>
          <Pencil size={14} />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={onAddCover}>
          <ImageIcon size={14} />
          Add local cover
        </ContextMenuItem>
        <ContextMenuItem onClick={onChangeCover} disabled={playlist.covers.length <= 1}>
          <ImageIcon size={14} />
          Change cover
        </ContextMenuItem>
        <ContextMenuItem onClick={onDeleteCover} disabled={playlist.covers.length < 1}>
          <Trash2 size={14} />
          Delete cover
        </ContextMenuItem>
        <ContextMenuItem onClick={onCreatePeer}>
          <FolderPlus size={14} />
          Create playlist
        </ContextMenuItem>
        <ContextMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
          <Trash2 size={14} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
