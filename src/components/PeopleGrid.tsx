import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ListFilter, Search, Star, User } from "lucide-react";
import { Input } from "@/components/ui/input";
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
import type { CharacterMatch, PersonRole, PersonSummary } from "@/types";

// People pages hold thousands of entries, so the grid is virtualized: rows are
// fixed-height and only the visible window (plus overscan) is mounted. The
// default view is the Top 100 by credit count; "All" is alphabetical with
// letter headers and an A–Z scrubber rail. Search always searches everyone.

const TOP_N = 100;
// Fixed cell geometry — virtualization needs constant row heights.
const CELL_MIN_W = 148;
// Tall enough for a 2-line name plus a 2-line wrapped subtitle ("as X · Title").
const CARD_H = 224;
const ROW_GAP = 8;
const ROW_H = CARD_H + ROW_GAP;
const HEADER_H = 48;
const PAD_X = 16;
const PAD_Y = 16;
const GAP_X = 8;
const OVERSCAN_PX = 400;
// Width reserved on the right for the floating scrubber rail in "All" mode.
const RAIL_W = 32;

type Row =
  | { kind: "header"; letter: string }
  | { kind: "people"; items: PersonSummary[] };

function letterFor(name: string): string {
  const c = name.trim().charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
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

  const searching = search.trim().length > 0;
  // Small lists skip the Top-100 concept entirely — everything, alphabetical.
  const hasTop = people.length > TOP_N;
  const effectiveMode: "top" | "all" | "search" = searching ? "search" : hasTop ? mode : "all";

  const resetScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [scrollContainerRef]);

  // ── Row model ─────────────────────────────────────────────────────────────
  const { rows, letters, cols, padRight } = useMemo(() => {
    const padRight = PAD_X + (effectiveMode === "all" ? RAIL_W : 0);
    const cols = Math.max(1, Math.floor((viewport.width - PAD_X - padRight + GAP_X) / (CELL_MIN_W + GAP_X)));
    const chunk = (list: PersonSummary[]): Row[] => {
      const out: Row[] = [];
      for (let i = 0; i < list.length; i += cols) out.push({ kind: "people", items: list.slice(i, i + cols) });
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

    if (effectiveMode === "top") {
      const top = [...people].sort(byCount).slice(0, TOP_N);
      return { rows: chunk(top), letters: [] as string[], cols, padRight };
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
  }, [people, search, effectiveMode, viewport.width, charMatches]);

  // Character-matched cards explain themselves: "as Walter White · Breaking Bad".
  const charSubtitles = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of charMatches) {
      let s = `as ${m.matched_role} · ${m.matched_title}`;
      if (m.extra_matches > 0) s += ` (+${m.extra_matches} more)`;
      if (!map.has(m.person.id)) map.set(m.person.id, s);
    }
    return map;
  }, [charMatches]);

  // Row offsets + per-letter jump targets.
  const { offsets, total, headerOffsets } = useMemo(() => {
    const offsets: number[] = new Array(rows.length);
    const headerOffsets: Record<string, number> = {};
    let y = PAD_Y;
    rows.forEach((r, i) => {
      offsets[i] = y;
      if (r.kind === "header") headerOffsets[r.letter] = y;
      y += r.kind === "header" ? HEADER_H : ROW_H;
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
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetScroll();
            }}
            placeholder="Search people..."
            className="h-8 pl-8 text-sm"
          />
        </div>
        {hasTop && !searching && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground">
              <ListFilter size={12} />
              {mode === "top" ? `Top ${TOP_N}` : "All"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(["top", "all"] as const).map((m) => (
                <DropdownMenuItem
                  key={m}
                  onClick={() => {
                    setMode(m);
                    onModeChange(m);
                    resetScroll();
                  }}
                >
                  {m === "top" ? `Top ${TOP_N}` : "All"}
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
                const h = row.kind === "header" ? HEADER_H : ROW_H;
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
                      height: CARD_H,
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
                        subtitle={effectiveMode === "search" ? charSubtitles.get(p.id) : undefined}
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
  onClick,
  onToggleFavorite,
  subtitle,
}: {
  person: PersonSummary;
  onClick: () => void;
  onToggleFavorite: () => void;
  /** Replaces the work-count line (character-search context, "as X · Title"). */
  subtitle?: string;
}) {
  const imageSrc = person.image_path ? convertFileSrc(person.image_path) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            onClick={onClick}
            style={{ height: CARD_H }}
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
          <span className="w-full break-words text-xs leading-tight text-muted-foreground line-clamp-2" title={subtitle}>
            {subtitle ?? (person.work_count === 1 ? "1 work" : `${person.work_count} works`)}
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
