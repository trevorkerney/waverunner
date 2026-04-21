import { useMemo, type Ref } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { User } from "lucide-react";
import { GroupedVirtuoso } from "react-virtuoso";
import type { PersonSummary } from "@/types";

/** Formats a person's credit count: "1 movie", "4 shows", "2 movies, 4 shows". Splits
 *  by format so users see what they're looking at instead of an ambiguous "6 works".
 *  Inlined here and in PeopleGrid — copy is cheaper than a one-line shared file. */
function formatPersonWorks(person: Pick<PersonSummary, "movie_count" | "show_count">): string {
  const parts: string[] = [];
  if (person.movie_count > 0) parts.push(`${person.movie_count} ${person.movie_count === 1 ? "movie" : "movies"}`);
  if (person.show_count > 0) parts.push(`${person.show_count} ${person.show_count === 1 ? "show" : "shows"}`);
  return parts.join(", ");
}

interface PeopleListProps {
  people: PersonSummary[];
  onSelectPerson: (person: PersonSummary) => void;
  /** When provided, Virtuoso assigns its internal scroller element here so App's
   *  saveScrollPosition / restoreScrollPosition continue to work unchanged. */
  scrollerRef?: Ref<HTMLElement | null>;
}

/** Virtualized compact list of people, grouped under sticky A-Z letter headers. Lower
 *  density than the grid (smaller avatars, one per row) but ~10x more visible per screen.
 *  Grouping makes wayfinding cheap — the sticky header tells you where you are, and
 *  scrolling past letters feels like flipping through a phonebook. */
export function PeopleList({ people, onSelectPerson, scrollerRef }: PeopleListProps) {
  const { letters, counts, flat } = useMemo(() => groupByLetter(people), [people]);

  return (
    <GroupedVirtuoso
      style={{ height: "100%" }}
      groupCounts={counts}
      scrollerRef={(el) => {
        if (!scrollerRef) return;
        if (typeof scrollerRef === "function") {
          scrollerRef(el as HTMLElement | null);
        } else {
          (scrollerRef as { current: HTMLElement | null }).current =
            el instanceof HTMLElement ? el : null;
        }
      }}
      groupContent={(index) => (
        <div className="border-b border-border bg-background/95 px-4 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
          {letters[index]}
        </div>
      )}
      itemContent={(flatIndex) => {
        const p = flat[flatIndex];
        return <PersonRow person={p} onClick={() => onSelectPerson(p)} />;
      }}
    />
  );
}

/** Group by the uppercased first letter of the name. Non-alpha leads (digits, punctuation)
 *  fall under "#" so they stay visually separate from real letters. Each group preserves
 *  the incoming order — the caller controls whether that's alpha, date, or a future sort. */
function groupByLetter(people: PersonSummary[]): {
  letters: string[];
  counts: number[];
  flat: PersonSummary[];
} {
  const buckets = new Map<string, PersonSummary[]>();
  const order: string[] = [];
  for (const p of people) {
    const firstChar = p.name.trim().charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(firstChar) ? firstChar : "#";
    let bucket = buckets.get(letter);
    if (!bucket) {
      bucket = [];
      buckets.set(letter, bucket);
      order.push(letter);
    }
    bucket.push(p);
  }
  // Alpha order: A-Z first, # last.
  order.sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
  const letters = order;
  const counts = order.map((l) => buckets.get(l)!.length);
  const flat = order.flatMap((l) => buckets.get(l)!);
  return { letters, counts, flat };
}

function PersonRow({ person, onClick }: { person: PersonSummary; onClick: () => void }) {
  const imageSrc = person.image_path ? convertFileSrc(person.image_path) : null;
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={person.name}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <User className="h-5 w-5 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{person.name}</span>
        <span className="text-xs text-muted-foreground">{formatPersonWorks(person)}</span>
      </div>
    </button>
  );
}
