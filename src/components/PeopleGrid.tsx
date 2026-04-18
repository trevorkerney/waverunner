import { convertFileSrc } from "@tauri-apps/api/core";
import { User } from "lucide-react";
import type { PersonSummary } from "@/types";

interface PeopleGridProps {
  people: PersonSummary[];
  onSelectPerson: (person: PersonSummary) => void;
}

export function PeopleGrid({ people, onSelectPerson }: PeopleGridProps) {
  return (
    <div className="grid gap-4 p-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
      {people.map((p) => (
        <PersonCard key={p.id} person={p} onClick={() => onSelectPerson(p)} />
      ))}
    </div>
  );
}

function PersonCard({ person, onClick }: { person: PersonSummary; onClick: () => void }) {
  const imageSrc = person.image_path ? convertFileSrc(person.image_path) : null;
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-2 rounded-md p-2 text-center transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
    >
      <div className="flex h-32 w-32 items-center justify-center overflow-hidden rounded-full bg-muted">
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
        <span className="line-clamp-2 text-sm font-medium">{person.name}</span>
        <span className="text-xs text-muted-foreground">
          {person.work_count === 1 ? "1 work" : `${person.work_count} works`}
        </span>
      </div>
    </button>
  );
}
