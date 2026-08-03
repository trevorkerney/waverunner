import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ListFilter, Search, Star, User } from "lucide-react";
import { ClearableInput } from "@/components/ui/clearable-input";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ScrubberRail } from "@/components/ScrubberRail";
import { playDropIn } from "@/lib/dropIn";
import type { CharacterMatch, DirectorCreatorCounts, PersonRole, PersonSummary, TitleCounts } from "@/types";

// People pages hold thousands of entries, so the grid is virtualized: row
// heights are computed up front (each row sized to its tallest subtitle) and
// only the visible window (plus overscan) is mounted. The default view ranks
// everyone by credit count ("Most credited"); "A–Z" is alphabetical with
// letter headers and a scrubber rail. Search always searches everyone.

// Display labels for the two modes. The persisted values stay "top" | "all"
// (settings table, people_mode:*) — only the labels changed.
const MODE_LABELS = { top: "Most credited", all: "Alphabetical" } as const;
// Cell geometry — virtualization needs row heights known up front. Cards are a
// fixed base (padding + face + 2-line name reserve) plus a measured number of
// subtitle lines; each row is sized to its tallest subtitle so credit
// breakdowns are never ellipsized.
const CELL_MIN_W = 148;
const CARD_BASE_H = 194;
// One subtitle line: text-xs (12px) at leading-tight.
const SUB_LINE_H = 15;
const ROW_GAP = 8;
const HEADER_H = 48;
const PAD_X = 16;
const PAD_Y = 16;
const GAP_X = 8;
const OVERSCAN_PX = 400;
// Width reserved on the right for the floating scrubber rail in "All" mode.
const RAIL_W = 32;

type Row =
  | { kind: "header"; letter: string }
  | { kind: "people"; items: PersonSummary[]; cardH: number };

function letterFor(name: string): string {
  const c = name.trim().charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "3 movies, 1 show & 9 episodes across 8 shows" — commas between units, "&" before the last.
function joinUnits(units: string[]): string {
  if (units.length <= 1) return units[0] ?? "";
  return `${units.slice(0, -1).join(", ")} & ${units[units.length - 1]}`;
}

// D&C cards spell the credits out instead of "N works":
// "directed 3 movies, 1 show & 9 episodes across 8 shows · created 2 shows".
// Empty buckets are omitted; every real D&C person has at least one non-empty.
function dcSubtitle(dc: DirectorCreatorCounts): string | null {
  const directed: string[] = [];
  if (dc.films > 0) directed.push(plural(dc.films, "movie", "movies"));
  if (dc.shows > 0) directed.push(plural(dc.shows, "show", "shows"));
  if (dc.episodes > 0) {
    // "of 1 show", but "across N shows" — "across" implies spread.
    const prep = dc.episode_shows === 1 ? "of" : "across";
    directed.push(
      `${plural(dc.episodes, "episode", "episodes")} ${prep} ${plural(dc.episode_shows, "show", "shows")}`,
    );
  }
  const parts: string[] = [];
  if (directed.length > 0) parts.push(`directed ${joinUnits(directed)}`);
  if (dc.created > 0) parts.push(`created ${plural(dc.created, "show", "shows")}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Actor cards: "in 23 movies & 4 shows"; composer cards: "scored 12 movies & 3 shows".
function titleCountsSubtitle(tc: TitleCounts, verb: string): string | null {
  const units: string[] = [];
  if (tc.films > 0) units.push(plural(tc.films, "movie", "movies"));
  if (tc.shows > 0) units.push(plural(tc.shows, "show", "shows"));
  return units.length > 0 ? `${verb} ${joinUnits(units)}` : null;
}

// ── Subtitle measurement ────────────────────────────────────────────────────
// Row heights must be known before render (the grid is virtualized), but
// subtitles must never be ellipsized — so each subtitle's wrapped line count
// is computed up front: word widths are measured once per string on a canvas
// and greedy-wrapped arithmetically against the current cell width.
let measureCtx: CanvasRenderingContext2D | null = null;
let measureFont = "";
let spaceW = 4;
const wordWidthCache = new Map<string, number[]>();

function ensureMeasureCtx(fontFamily: string) {
  const font = `12px ${fontFamily}`; // subtitle is text-xs
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (measureCtx && measureFont !== font) {
    measureFont = font;
    measureCtx.font = font;
    wordWidthCache.clear();
    spaceW = measureCtx.measureText(" ").width;
  }
}

function subtitleLines(text: string, maxW: number): number {
  if (maxW <= 0) return 1;
  if (!measureCtx) return 2;
  let widths = wordWidthCache.get(text);
  if (!widths) {
    widths = text.split(" ").map((w) => measureCtx!.measureText(w).width);
    wordWidthCache.set(text, widths);
  }
  const max = maxW - 1; // wrap a hair early rather than ever clipping
  let lines = 1;
  let line = 0;
  for (const w of widths) {
    const cand = line === 0 ? w : line + spaceW + w;
    if (cand <= max) {
      line = cand;
    } else if (w <= max) {
      lines += 1;
      line = w;
    } else {
      // A word wider than the cell hard-breaks mid-word (break-words).
      if (line > 0) lines += 1;
      lines += Math.ceil(w / max) - 1;
      line = w % max || max;
    }
  }
  return lines;
}

interface PeoplePageProps {
  people: PersonSummary[];
  /** For the character-name search (it's a backend query). */
  libraryId: string;
  role: PersonRole;
  /** Mode to land on — the parent remembers it per view (persisted to settings),
   *  so it survives navigation and restarts. The component is keyed per view. */
  initialMode: "top" | "all";
  onModeChange: (mode: "top" | "all") => void;
  onSelectPerson: (person: PersonSummary) => void;
  onToggleFavorite: (person: PersonSummary) => void;
  /** App-owned ref so the existing scroll save/restore keeps working. */
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}

const CHARACTER_SECTION = "Played a matching character";

export function PeoplePage({ people, libraryId, role, initialMode, onModeChange, onSelectPerson, onToggleFavorite, scrollContainerRef }: PeoplePageProps) {
  const [mode, setMode] = useState<"top" | "all">(initialMode);
  const [search, setSearch] = useState("");
  const [charMatches, setCharMatches] = useState<CharacterMatch[]>([]);
  // Guards against an older, slower query response landing after a newer one.
  const charReqSeq = useRef(0);

  // Character-name search runs against the backend (roles aren't shipped with
  // the people list), debounced like the entries search.
  useEffect(() => {
    const q = search.trim();
    const seq = ++charReqSeq.current;
    if (q.length < 2) {
      setCharMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await invoke<CharacterMatch[]>("search_people_by_character", {
          libraryId,
          role,
          query: q,
        });
        if (charReqSeq.current === seq) setCharMatches(res);
      } catch {
        if (charReqSeq.current === seq) setCharMatches([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [search, libraryId, role]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  // Re-measure subtitles once webfonts finish loading (metrics can shift).
  const [fontsLoaded, setFontsLoaded] = useState(false);
  useEffect(() => {
    let mounted = true;
    document.fonts?.ready.then(() => {
      if (!mounted) return;
      measureFont = ""; // drop widths measured against fallback fonts
      setFontsLoaded(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const searching = search.trim().length > 0;
  const effectiveMode: "top" | "all" | "search" = searching ? "search" : mode;

  const resetScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [scrollContainerRef]);

  // Character-matched cards explain themselves: "as Walter White · Breaking Bad".
  // (Computed before the row model — row heights depend on the text shown.)
  const charSubtitles = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of charMatches) {
      let s = `as ${m.matched_role} · ${m.matched_title}`;
      if (m.extra_matches > 0) s += ` (+${m.extra_matches} more)`;
      if (!map.has(m.person.id)) map.set(m.person.id, s);
    }
    return map;
  }, [charMatches]);

  // Single source for a card's subtitle text — measurement (row heights) and
  // render both go through this, so they can never disagree. Segments follow
  // the sidebar's role order: acting · directing/creating · composing. On role
  // pages only that role's segment is populated; the all-people page combines
  // whichever a person has.
  const subtitleTextFor = useCallback(
    (p: PersonSummary): string => {
      const charSub = effectiveMode === "search" ? charSubtitles.get(p.id) : undefined;
      if (charSub) return charSub;
      const parts = [
        p.acting ? titleCountsSubtitle(p.acting, "in") : null,
        p.dc ? dcSubtitle(p.dc) : null,
        p.composing ? titleCountsSubtitle(p.composing, "scored") : null,
      ].filter((s): s is string => s !== null);
      if (parts.length > 0) return parts.join(" · ");
      return p.work_count === 1 ? "1 work" : `${p.work_count} works`;
    },
    [effectiveMode, charSubtitles],
  );

  // ── Row model ─────────────────────────────────────────────────────────────
  const { rows, letters, cols, padRight } = useMemo(() => {
    const padRight = PAD_X + (effectiveMode === "all" ? RAIL_W : 0);
    const cols = Math.max(1, Math.floor((viewport.width - PAD_X - padRight + GAP_X) / (CELL_MIN_W + GAP_X)));
    // Subtitle width inside a card: the even column width minus the card's p-2.
    const cellW = (viewport.width - PAD_X - padRight - (cols - 1) * GAP_X) / cols;
    const subtitleW = cellW - 16;
    ensureMeasureCtx(
      scrollContainerRef.current ? getComputedStyle(scrollContainerRef.current).fontFamily : "sans-serif",
    );
    const chunk = (list: PersonSummary[]): Row[] => {
      const out: Row[] = [];
      for (let i = 0; i < list.length; i += cols) {
        const items = list.slice(i, i + cols);
        let lines = 1;
        for (const p of items) lines = Math.max(lines, subtitleLines(subtitleTextFor(p), subtitleW));
        out.push({ kind: "people", items, cardH: CARD_BASE_H + lines * SUB_LINE_H });
      }
      return out;
    };
    const byCount = (a: PersonSummary, b: PersonSummary) =>
      b.work_count - a.work_count || a.name.localeCompare(b.name);

    if (effectiveMode === "search") {
      // Prefix matches outrank substring matches; each tier sorts by credits.
      const q = search.trim().toLowerCase();
      const prefix: PersonSummary[] = [];
      const substr: PersonSummary[] = [];
      for (const p of people) {
        const n = p.name.toLowerCase();
        if (n.startsWith(q)) prefix.push(p);
        else if (n.includes(q)) substr.push(p);
      }
      prefix.sort(byCount);
      substr.sort(byCount);
      const nameMatches = [...prefix, ...substr];
      // Character matches follow under their own header; people already
      // matched by name stay in the name group (the stronger signal).
      const nameIds = new Set(nameMatches.map((p) => p.id));
      const charPeople = charMatches.filter((m) => !nameIds.has(m.person.id)).map((m) => m.person);
      const rows = chunk(nameMatches);
      if (charPeople.length > 0) {
        rows.push({ kind: "header", letter: CHARACTER_SECTION });
        rows.push(...chunk(charPeople));
      }
      return { rows, letters: [] as string[], cols, padRight };
    }

    // "top": everyone, ranked by credit count — no truncation. Favorites get a
    // pinned ★ section first, ranked the same way (they still appear at their
    // natural spot below, like A–Z keeps them under their letters); the main
    // list then opens under its own header so the sections read as two.
    if (effectiveMode === "top") {
      const ranked = [...people].sort(byCount);
      const favorites = ranked.filter((p) => p.favorite);
      const rows: Row[] = [];
      if (favorites.length > 0) {
        rows.push({ kind: "header", letter: "★" });
        rows.push(...chunk(favorites));
        rows.push({ kind: "header", letter: MODE_LABELS.top });
      }
      rows.push(...chunk(ranked));
      return { rows, letters: [] as string[], cols, padRight };
    }

    // "All": alphabetical with letter sections. Grouped via map (not encounter
    // order) so digits and accented names merge into one "#" bucket. Favorites
    // get a pinned "★" section up top (and still appear under their letters).
    const groups = new Map<string, PersonSummary[]>();
    for (const p of people) {
      const l = letterFor(p.name);
      const g = groups.get(l);
      if (g) g.push(p);
      else groups.set(l, [p]);
    }
    const groupLetters = [...groups.keys()].sort((a, b) =>
      a === "#" ? -1 : b === "#" ? 1 : a.localeCompare(b),
    );
    const favorites = people.filter((p) => p.favorite);
    const letters = favorites.length > 0 ? ["★", ...groupLetters] : groupLetters;
    const rows: Row[] = [];
    if (favorites.length > 0) {
      rows.push({ kind: "header", letter: "★" });
      rows.push(...chunk(favorites));
    }
    for (const l of groupLetters) {
      rows.push({ kind: "header", letter: l });
      rows.push(...chunk(groups.get(l)!));
    }
    return { rows, letters, cols, padRight };
  }, [people, search, effectiveMode, viewport.width, charMatches, subtitleTextFor, fontsLoaded, scrollContainerRef]);

  // Row offsets + per-letter jump targets.
  const { offsets, total, headerOffsets } = useMemo(() => {
    const offsets: number[] = new Array(rows.length);
    const headerOffsets: Record<string, number> = {};
    let y = PAD_Y;
    rows.forEach((r, i) => {
      offsets[i] = y;
      if (r.kind === "header") headerOffsets[r.letter] = y;
      y += r.kind === "header" ? HEADER_H : r.cardH + ROW_GAP;
    });
    return { offsets, total: y + PAD_Y, headerOffsets };
  }, [rows]);

  // ── Scroll + viewport tracking ────────────────────────────────────────────
  const rafRef = useRef(0);
  const onScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => setScrollTop(el.scrollTop));
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    update();
    setScrollTop(el.scrollTop); // pick up an externally-restored position
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollContainerRef]);

  // Page load-in: drop the initial on-screen face cards in, once, when the page first lays
  // out (the component is keyed per people view, so this re-arms on each navigation here).
  const didLoadInRef = useRef(false);
  useLayoutEffect(() => {
    if (didLoadInRef.current || viewport.width === 0) return;
    const cards = scrollContainerRef.current?.querySelectorAll<HTMLElement>("[data-person-card]");
    if (!cards || cards.length === 0) return;
    didLoadInRef.current = true;
    playDropIn(cards);
  });

  // ── Scrubber ──────────────────────────────────────────────────────────────
  const showScrubber = effectiveMode === "all" && letters.length > 1;

  const jumpTo = useCallback(
    (letter: string) => {
      const el = scrollContainerRef.current;
      const y = headerOffsets[letter];
      if (!el || y == null) return;
      el.scrollTop = Math.max(0, y - 4);
    },
    [scrollContainerRef, headerOffsets],
  );

  return (
    <>
      {/* Toolbar: search (always searches ALL people) + Top/All selector */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <div className="relative flex flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-muted-foreground" />
          <ClearableInput
            value={search}
            onValueChange={(v) => {
              setSearch(v);
              resetScroll();
            }}
            placeholder="Search people..."
            className="h-8 pl-8 text-sm"
          />
        </div>
        {!searching && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
              <ListFilter size={12} />
              {MODE_LABELS[mode]}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(["all", "top"] as const).map((m) => (
                <DropdownMenuItem
                  key={m}
                  onClick={() => {
                    setMode(m);
                    onModeChange(m);
                    resetScroll();
                  }}
                >
                  {MODE_LABELS[m]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          onScroll={onScroll}
          className="min-w-0 flex-1 overflow-y-auto"
        >
          {rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No people found.</p>
          ) : (
            <div className="relative" style={{ height: total }}>
              {rows.map((row, i) => {
                const h = row.kind === "header" ? HEADER_H : row.cardH + ROW_GAP;
                const y = offsets[i];
                if (y + h < scrollTop - OVERSCAN_PX || y > scrollTop + viewport.height + OVERSCAN_PX) {
                  return null;
                }
                if (row.kind === "header") {
                  return (
                    <div
                      key={`h-${row.letter}`}
                      className="absolute inset-x-0 flex items-end pb-2"
                      style={{ top: y, height: HEADER_H, paddingLeft: PAD_X, paddingRight: padRight }}
                    >
                      {row.letter === "★" ? (
                        <span className="flex items-center gap-1.5 text-lg font-semibold">
                          <Star size={16} className="fill-primary text-primary" />
                          Favorites
                        </span>
                      ) : row.letter === CHARACTER_SECTION ? (
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {row.letter}
                        </span>
                      ) : (
                        <span className="text-lg font-semibold">{row.letter}</span>
                      )}
                    </div>
                  );
                }
                return (
                  <div
                    key={`r-${i}-${row.items[0].id}`}
                    className="absolute inset-x-0 grid"
                    style={{
                      top: y,
                      height: row.cardH,
                      paddingLeft: PAD_X,
                      paddingRight: padRight,
                      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                      columnGap: GAP_X,
                    }}
                  >
                    {row.items.map((p) => (
                      <PersonCard
                        key={p.id}
                        person={p}
                        height={row.cardH}
                        subtitle={subtitleTextFor(p)}
                        onClick={() => onSelectPerson(p)}
                        onToggleFavorite={() => onToggleFavorite(p)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {showScrubber && <ScrubberRail labels={letters} onJump={jumpTo} />}
      </div>
    </>
  );
}

function PersonCard({
  person,
  height,
  onClick,
  onToggleFavorite,
  subtitle,
}: {
  person: PersonSummary;
  /** Row-uniform card height, sized upstream to fit the tallest subtitle. */
  height: number;
  onClick: () => void;
  onToggleFavorite: () => void;
  /** Computed by PeoplePage's subtitleTextFor — the same text row heights were measured against. */
  subtitle: string;
}) {
  const imageSrc = person.image_path ? convertFileSrc(person.image_path) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            onClick={onClick}
            data-person-card=""
            style={{ height }}
            className="group flex flex-col items-center gap-2 overflow-hidden rounded-md p-2 text-center transition-colors hover:bg-accent/40 focus:bg-accent/60 focus:outline-none"
          />
        }
      >
        <div className="flex h-32 w-32 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted shadow-md ring-1 ring-foreground/10 transition-all duration-200 group-hover:shadow-lg group-hover:ring-primary/50">
          {imageSrc ? (
            <img
              src={imageSrc}
              alt={person.name}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <User className="h-12 w-12 text-muted-foreground" />
          )}
        </div>
        <div className="flex min-w-0 flex-col items-center">
          <span className="line-clamp-2 text-sm font-medium leading-tight">
            {person.favorite && <Star size={11} className="mb-0.5 mr-1 inline fill-primary text-primary" />}
            {person.name}
          </span>
          <span className="w-full break-words text-xs leading-tight text-muted-foreground" title={subtitle}>
            {subtitle}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onToggleFavorite}>
          <Star size={14} />
          {person.favorite ? "Remove from favorites" : "Add to favorites"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
