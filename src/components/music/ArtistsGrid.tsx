import { memo, useCallback, type RefObject } from "react";
import { Music2 } from "lucide-react";
import { MediaEntry } from "../../types";
import { MbDot } from "./MbDot";
import { WindowedGrid } from "@/components/WindowedGrid";

interface ArtistsGridProps {
  entries: MediaEntry[];
  getCoverUrl: (filePath: string) => string;
  onNavigate: (entry: MediaEntry) => void;
  /** MainContent's grid anchor — the A–Z scrubber jumps by querying
   *  [data-letter] sections (and [data-flip-id] cards) inside it, so this
   *  grid must carry both. */
  gridRef: RefObject<HTMLDivElement | null>;
  /** "alpha" renders letter sections (People-page style); anything else is a
   *  flat ranked grid. */
  sortMode: string;
  /** Section/scrubber letter for a title — MainContent's letterForTitle, so
   *  sections and scrubber jumps can never disagree. */
  letterFor: (title: string) => string;
  /** MusicBrainz match-state dot after each name ("Show MusicBrainz
   *  outside this page" on). */
  showMbDots?: boolean;
}

function displayCover(entry: MediaEntry): string | null {
  if (entry.selected_cover && entry.covers.includes(entry.selected_cover)) {
    return entry.selected_cover;
  }
  return entry.covers[0] ?? null;
}

// The auto-fill column minimum and the card's height (8 padding + 128
// circle + 8 gap + two text lines + 8 padding), for the windowing's
// arithmetic; the first measured row replaces the estimate.
const COLUMN_MIN = 160;
const CARD_ESTIMATE = 190;

/** One artist card. Memoized: a window slice move re-renders only the cards
 *  entering the grid, and the page's re-renders skip the rest. */
const ArtistCard = memo(function ArtistCard({
  artist,
  subtitle,
  showMbDots,
  getCoverUrl,
  onNavigate,
}: {
  artist: MediaEntry;
  subtitle: string | null | undefined;
  showMbDots: boolean;
  getCoverUrl: (filePath: string) => string;
  onNavigate: (entry: MediaEntry) => void;
}) {
  const cover = displayCover(artist);
  return (
    <button
      data-flip-id={String(artist.id)}
      onClick={() => onNavigate(artist)}
      className="group flex flex-col items-center gap-2 overflow-hidden rounded-md p-2 text-center transition-colors hover:bg-accent/40 focus:bg-accent/60 focus:outline-none"
    >
      <div className="flex h-32 w-32 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted shadow-md ring-1 ring-foreground/10 transition-all duration-200 group-hover:shadow-lg group-hover:ring-primary/50">
        {cover ? (
          <img
            src={getCoverUrl(cover)}
            alt={artist.title}
            // Eager: the sections window themselves, so only the circles
            // near the viewport exist, and an explicit policy opts out of
            // the webview's lazy-loading intervention (same as the cover
            // grid's cards).
            loading="eager"
            decoding="async"
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <Music2 className="h-12 w-12 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-col items-center">
        <span className="line-clamp-2 text-sm font-medium leading-tight">
          {artist.title}
          {showMbDots && <MbDot state={artist.mb_state} className="ml-1.5 -translate-y-px" />}
        </span>
        {subtitle && (
          <span
            className="w-full break-words text-xs leading-tight text-muted-foreground"
            title={subtitle}
          >
            {subtitle}
          </span>
        )}
      </div>
    </button>
  );
});

/** Artists page — mirrors the video libraries' People pages: circular image,
 *  centered name, works-count subtitle, letter sections in A–Z mode. Every
 *  section is a windowed grid of its own (2026-09-26): with fifteen hundred
 *  artists, only the rows near the viewport are in the DOM, and a section
 *  scrolled past is its header and padding. */
export function ArtistsGrid({ entries, getCoverUrl, onNavigate, gridRef, sortMode, letterFor, showMbDots = false }: ArtistsGridProps) {
  // Subtitle matches the ACTIVE SORT — the backend bakes all three variants
  // into otherwise-unused display slots so local sort switches need no refetch:
  //   collection_display — credits mode (per-type breakdown)
  //   role_display       — alphabetical ("2 releases · 4 appearances · 7 loved")
  //   season_display     — loved mode ("N loved")
  // Liked mode ranks by both hearts together, so its subtitle is the one
  // combined number ("N loved/liked") — folded here from the loved-mode
  // string ("N loved · M liked") the backend already ships, so the sort
  // switch stays a local, refetch-free flip.
  const renderArtist = useCallback(
    (artist: MediaEntry) => {
      const hearts = () => {
        const m = /(\d+) loved(?: · (\d+) liked)?/.exec(artist.season_display ?? "");
        if (!m) return artist.season_display;
        return `${Number(m[1]) + Number(m[2] ?? 0)} loved/liked`;
      };
      const subtitle =
        sortMode === "credits" ? artist.collection_display
        : sortMode === "liked" ? hearts()
        : sortMode === "loved" ? artist.season_display
        : artist.role_display;
      return (
        <ArtistCard
          key={artist.id}
          artist={artist}
          subtitle={subtitle}
          showMbDots={showMbDots}
          getCoverUrl={getCoverUrl}
          onNavigate={onNavigate}
        />
      );
    },
    [sortMode, showMbDots, getCoverUrl, onNavigate],
  );

  if (entries.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No artists found.</p>;
  }

  const grid = (items: MediaEntry[], key: string) => (
    <WindowedGrid
      items={items}
      renderItem={renderArtist}
      minColumnWidth={COLUMN_MIN}
      estimateRowHeight={CARD_ESTIMATE}
      // The subtitle line changes with the sort — every row height with it.
      resetKey={`${sortMode}|${key}`}
      className="grid gap-x-3 gap-y-1"
    />
  );

  if (sortMode !== "alpha") {
    return <div ref={gridRef}>{grid(entries, "all")}</div>;
  }

  // Letter sections — grouped via map (not encounter order) so digits and
  // accented names merge into one "#" bucket, matching the scrubber labels.
  const groups = new Map<string, MediaEntry[]>();
  for (const e of entries) {
    const l = letterFor(e.title);
    const g = groups.get(l);
    if (g) g.push(e);
    else groups.set(l, [e]);
  }
  const letters = [...groups.keys()].sort((a, b) =>
    a === "#" ? -1 : b === "#" ? 1 : a.localeCompare(b),
  );

  return (
    <div ref={gridRef}>
      {letters.map((l) => (
        <section key={l} data-letter={l} className="pt-4 first:pt-0">
          <div className="flex items-end px-2 pb-2">
            <span className="text-lg font-semibold">{l}</span>
          </div>
          {grid(groups.get(l)!, l)}
        </section>
      ))}
    </div>
  );
}
