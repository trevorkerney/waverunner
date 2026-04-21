import { forwardRef, type Ref } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { User } from "lucide-react";
import { VirtuosoGrid } from "react-virtuoso";
import type { PersonSummary } from "@/types";

/** Formats a person's credit count: "1 movie", "4 shows", "2 movies, 4 shows". Splits
 *  by format so users see what they're looking at instead of an ambiguous "6 works".
 *  Inlined here and in PeopleList — copy is cheaper than a one-line shared file. */
function formatPersonWorks(person: Pick<PersonSummary, "movie_count" | "show_count">): string {
  const parts: string[] = [];
  if (person.movie_count > 0) parts.push(`${person.movie_count} ${person.movie_count === 1 ? "movie" : "movies"}`);
  if (person.show_count > 0) parts.push(`${person.show_count} ${person.show_count === 1 ? "show" : "shows"}`);
  return parts.join(", ");
}

interface PeopleGridProps {
  people: PersonSummary[];
  onSelectPerson: (person: PersonSummary) => void;
  /** When provided, Virtuoso assigns its internal scroller element here so App's
   *  saveScrollPosition / restoreScrollPosition continue to work unchanged. */
  scrollerRef?: Ref<HTMLElement | null>;
}

/** Virtualized people grid. Only renders cards in the viewport (+ a small buffer), so
 *  libraries with thousands of people scroll smoothly. The grid is responsive — column
 *  count follows container width via CSS grid auto-fill. */
export function PeopleGrid({ people, onSelectPerson, scrollerRef }: PeopleGridProps) {
  return (
    <VirtuosoGrid
      style={{ height: "100%" }}
      totalCount={people.length}
      scrollerRef={(el) => {
        if (!scrollerRef) return;
        if (typeof scrollerRef === "function") {
          scrollerRef(el as HTMLElement | null);
        } else {
          (scrollerRef as { current: HTMLElement | null }).current =
            el instanceof HTMLElement ? el : null;
        }
      }}
      components={{
        List: GridList,
      }}
      itemContent={(i) => {
        const p = people[i];
        return <PersonCard person={p} onClick={() => onSelectPerson(p)} />;
      }}
    />
  );
}

const GridList = forwardRef<HTMLDivElement, { style?: React.CSSProperties; children?: React.ReactNode }>(
  ({ style, children, ...props }, ref) => (
    <div
      ref={ref}
      {...props}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        gap: "1rem",
        padding: "1rem",
        ...style,
      }}
    >
      {children}
    </div>
  ),
);
GridList.displayName = "PeopleGridList";

function PersonCard({ person, onClick }: { person: PersonSummary; onClick: () => void }) {
  const imageSrc = person.image_path ? convertFileSrc(person.image_path) : null;
  return (
    <button
      onClick={onClick}
      // Fixed card height keeps VirtuosoGrid's layout estimates stable (variance in item
      // size causes scroll jitter). 1-line names now let the work count hug the name;
      // any leftover space sits at the bottom of the card instead of between name and
      // work count.
      className="flex h-[13rem] flex-col items-center gap-2 rounded-md p-2 text-center transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
    >
      <div className="flex h-32 w-32 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={person.name}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <User className="h-12 w-12 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-col items-center">
        <span className="line-clamp-2 text-sm font-medium leading-5">{person.name}</span>
        <span className="text-xs text-muted-foreground">{formatPersonWorks(person)}</span>
      </div>
    </button>
  );
}
