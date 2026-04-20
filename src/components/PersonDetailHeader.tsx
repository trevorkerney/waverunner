import { convertFileSrc } from "@tauri-apps/api/core";
import { User as UserIcon } from "lucide-react";
import type { PersonRole } from "@/types";

export function PersonDetailHeader({
  name,
  imagePath,
  role,
  workCount,
}: {
  name: string;
  imagePath: string | null;
  role: PersonRole;
  workCount: number;
}) {
  const imageSrc = imagePath ? convertFileSrc(imagePath) : null;
  const roleLabel =
    role === "actor"
      ? "Actor"
      : role === "director_creator"
      ? "Director / Creator"
      : role === "composer"
      ? "Composer"
      : "Credits";
  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-4">
      <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
        {imageSrc ? (
          <img src={imageSrc} alt={name} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <UserIcon className="h-10 w-10 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-2xl font-bold">{name}</h1>
        <p className="text-sm text-muted-foreground">
          {roleLabel} · {workCount === 1 ? "1 work" : `${workCount} works`}
        </p>
      </div>
    </div>
  );
}
