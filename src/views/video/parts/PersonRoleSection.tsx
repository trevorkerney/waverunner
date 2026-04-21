import { useMemo, useState } from "react";
import { SortableCoverCard } from "@/components/cards/SortableCoverCard";
import { SortDropdown, type SortOption } from "@/views/video/parts/SortDropdown";
import { sortEntriesClientSide } from "@/lib/utils";
import type { MediaEntry } from "@/types";

type SectionSortMode = "alpha" | "date";

/** One role section on the person-detail page (Actor / Director / Composer). Owns its
 *  own local sort mode (alpha or date), renders a header row with the section label +
 *  sort dropdown, then a plain CSS grid of read-only cards. Empty sections are hidden
 *  by the parent — this component assumes `entries` is non-empty. */
export function PersonRoleSection({
  label,
  entries,
  coverSize,
  onNavigate,
  onEditCharacterName,
}: {
  /** Section header text — `actor`, `director`, `composer`. */
  label: string;
  entries: MediaEntry[];
  coverSize: number;
  onNavigate: (entry: MediaEntry) => void;
  /** Optional — only the Actor section passes this, which makes the per-card
   *  "Edit character name" item appear. */
  onEditCharacterName?: (entry: MediaEntry) => void;
}) {
  const [sortMode, setSortMode] = useState<SectionSortMode>("alpha");

  const sorted = useMemo(() => sortEntriesClientSide(entries, sortMode), [entries, sortMode]);

  const sortOptions: SortOption[] = [
    { id: "alpha", label: "Alphabetical", onClick: () => setSortMode("alpha") },
    { id: "date", label: "Date", onClick: () => setSortMode("date") },
  ];
  const triggerLabel = sortMode === "date" ? "Date" : "A\u2013Z";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <h2 className="text-sm font-semibold lowercase tracking-wide text-muted-foreground">
          {label}
        </h2>
        <SortDropdown triggerLabel={triggerLabel} options={sortOptions} />
      </div>
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))`,
          alignItems: "center",
          justifyItems: "center",
        }}
      >
        {sorted.map((entry) => (
          <SortableCoverCard
            key={`${entry.entry_type}-${entry.id}`}
            sortableId={`${entry.entry_type}-${entry.id}`}
            entry={entry}
            size={coverSize}
            onNavigate={onNavigate}
            onRename={async () => null}
            onChangeCover={() => {}}
            onAddCover={() => {}}
            onAddCoverFromTmdb={() => {}}
            onDeleteCover={() => {}}
            onDelete={async () => {}}
            deletingId={null}
            isDragActive={false}
            sortMode="alpha"
            readOnly
            hideYear
            onEditCharacterName={onEditCharacterName}
          />
        ))}
      </div>
    </section>
  );
}
