import { useState, type ReactNode, type RefObject } from "react";
import { LayoutGrid, List as ListIcon } from "lucide-react";
import { PeopleGrid } from "@/components/PeopleGrid";
import { PeopleList } from "@/components/PeopleList";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { GridToolbar } from "@/views/video/parts/GridToolbar";
import { GridSearchInput } from "@/views/video/parts/GridSearchInput";
import type { PersonRole, PersonSummary, ViewSpec } from "@/types";

type ViewMode = "grid" | "list";

export function PeopleListView({
  view,
  people,
  loading,
  breadcrumbBar,
  scrollContainerRef,
  onNavigateToPerson,
}: {
  view: Extract<ViewSpec, { kind: "people-all" | "people-list" }>;
  people: PersonSummary[] | null;
  loading: boolean;
  breadcrumbBar: ReactNode;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onNavigateToPerson: (person: PersonSummary, role: PersonRole) => void;
}) {
  const role: PersonRole = view.kind === "people-all" ? "all" : view.role;

  // Local search state — people lists aren't tied to the library-entry search effect in
  // App.tsx (that one hits search_entries, which has no concept of people). Keeping it
  // local means no cross-view leakage and no App-level state for what's a view-scoped
  // filter.
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<ViewMode>("grid");

  const q = search.trim().toLowerCase();
  const filtered = q && people ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {breadcrumbBar}
      <GridToolbar>
        <GridSearchInput value={search} onChange={setSearch} />
        <ToggleGroup
          value={[mode]}
          onValueChange={(v) => {
            if (v.length) setMode((v[v.length - 1] as ViewMode) ?? "grid");
          }}
          spacing={1}
          className="gap-1"
        >
          <ToggleGroupItem
            value="grid"
            aria-label="Grid view"
            className="h-8 rounded-md border border-input px-2 data-[state=on]:bg-accent"
          >
            <LayoutGrid size={14} />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="list"
            aria-label="List view"
            className="h-8 rounded-md border border-input px-2 data-[state=on]:bg-accent"
          >
            <ListIcon size={14} />
          </ToggleGroupItem>
        </ToggleGroup>
      </GridToolbar>
      <div className="flex-1 min-h-0">
        {loading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {!loading && filtered && filtered.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            {q ? "No results" : "No people found."}
          </p>
        )}
        {!loading && filtered && filtered.length > 0 && (
          mode === "grid" ? (
            <PeopleGrid
              people={filtered}
              onSelectPerson={(p) => onNavigateToPerson(p, role)}
              scrollerRef={scrollContainerRef as unknown as RefObject<HTMLElement | null>}
            />
          ) : (
            <PeopleList
              people={filtered}
              onSelectPerson={(p) => onNavigateToPerson(p, role)}
              scrollerRef={scrollContainerRef as unknown as RefObject<HTMLElement | null>}
            />
          )
        )}
      </div>
    </main>
  );
}
