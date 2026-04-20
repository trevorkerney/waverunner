import type { ReactNode, RefObject } from "react";
import { PeopleGrid } from "@/components/PeopleGrid";
import type { PersonRole, PersonSummary, ViewSpec } from "@/types";

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
  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {breadcrumbBar}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {loading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {!loading && people && people.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No people found.</p>
        )}
        {!loading && people && people.length > 0 && (
          <PeopleGrid people={people} onSelectPerson={(p) => onNavigateToPerson(p, role)} />
        )}
      </div>
    </main>
  );
}
