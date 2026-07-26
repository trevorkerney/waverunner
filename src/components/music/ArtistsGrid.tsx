import { type RefObject } from "react";
import { Music2 } from "lucide-react";
import { MediaEntry } from "../../types";

interface ArtistsGridProps {
  entries: MediaEntry[];
  getCoverUrl: (filePath: string) => string;
  onNavigate: (entry: MediaEntry) => void;
  /** MainContent's grid anchor — the A–Z scrubber jumps by querying
   *  [data-flip-id] inside it, so this grid must carry both. */
  gridRef: RefObject<HTMLDivElement | null>;
  /** "alpha" renders letter sections (People-page style); anything else is a
   *  flat ranked grid. */
  sortMode: string;
  /** Section/scrubber letter for a title — MainContent's letterForTitle, so
   *  sections and scrubber jumps can never disagree. */
  letterFor: (title: string) => string;
}

function displayCover(entry: MediaEntry): string | null {
  if (entry.selected_cover && entry.covers.includes(entry.selected_cover)) {
    return entry.selected_cover;
  }
  return entry.covers[0] ?? null;
}

/** Artists page — mirrors the video libraries' People pages: circular image,
 *  centered name, works-count subtitle, letter sections in A–Z mode. */
export function ArtistsGrid({ entries, getCoverUrl, onNavigate, gridRef, sortMode, letterFor }: ArtistsGridProps) {
  if (entries.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No artists found.</p>;
  }

  // Subtitle matches the ACTIVE SORT — the backend bakes all three variants
  // into otherwise-unused display slots so local sort switches need no refetch:
  //   collection_display — credits mode (per-type breakdown)
  //   role_display       — alphabetical ("2 releases · 4 appearances · 7 loved")
  //   season_display     — loved mode ("N loved")
  const subtitleFor = (artist: MediaEntry) =>
    sortMode === "credits" ? artist.collection_display
    : sortMode === "loved" ? artist.season_display
    : artist.role_display;

  const grid = (items: MediaEntry[]) => (
    <div
      className="grid gap-x-3 gap-y-1"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
    >
      {items.map((artist) => {
        const cover = displayCover(artist);
        const subtitle = subtitleFor(artist);
        return (
          <button
            key={artist.id}
            data-flip-id={String(artist.id)}
            onClick={() => onNavigate(artist)}
            className="group flex flex-col items-center gap-2 overflow-hidden rounded-md p-2 text-center transition-colors hover:bg-accent/40 focus:bg-accent/60 focus:outline-none"
          >
            {/* content-visibility on the (fixed-size, overflow-hidden) cover box —
                not the card root, where paint containment would clip the hover
                shadow — skips layout/paint/decode for every offscreen circle.
                Same discipline as the video grid's cover cards. */}
            <div
              className="flex h-32 w-32 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted shadow-md ring-1 ring-foreground/10 transition-all duration-200 group-hover:shadow-lg group-hover:ring-primary/50"
              style={{ contentVisibility: "auto", containIntrinsicSize: "128px 128px" }}
            >
              {cover ? (
                <img
                  src={getCoverUrl(cover)}
                  alt={artist.title}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <Music2 className="h-12 w-12 text-muted-foreground" />
              )}
            </div>
            <div className="flex min-w-0 flex-col items-center">
              <span className="line-clamp-2 text-sm font-medium leading-tight">{artist.title}</span>
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
      })}
    </div>
  );

  if (sortMode !== "alpha") {
    return <div ref={gridRef}>{grid(entries)}</div>;
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
        <section key={l} className="pt-4 first:pt-0">
          <div className="flex items-end px-2 pb-2">
            <span className="text-lg font-semibold">{l}</span>
          </div>
          {grid(groups.get(l)!)}
        </section>
      ))}
    </div>
  );
}
