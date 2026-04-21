import { convertFileSrc } from "@tauri-apps/api/core";
import { User as UserIcon } from "lucide-react";

/** Header bar for the person-detail page. Now that the page shows all role sections at
 *  once, the role label is gone — counts ("X movies, X shows") are the new secondary
 *  line. Counts are de-duplicated across roles by the caller (Eastwood's directorial
 *  features that he also acts in count as 1 movie, not 2). */
export function PersonDetailHeader({
  name,
  imagePath,
  movieCount,
  showCount,
}: {
  name: string;
  imagePath: string | null;
  movieCount: number;
  showCount: number;
}) {
  const imageSrc = imagePath ? convertFileSrc(imagePath) : null;
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
        <p className="text-sm text-muted-foreground">{formatCounts(movieCount, showCount)}</p>
      </div>
    </div>
  );
}

/** Same shape as PeopleGrid/PeopleList — short copy is cheaper than a shared module. */
function formatCounts(movies: number, shows: number): string {
  const parts: string[] = [];
  if (movies > 0) parts.push(`${movies} ${movies === 1 ? "movie" : "movies"}`);
  if (shows > 0) parts.push(`${shows} ${shows === 1 ? "show" : "shows"}`);
  if (parts.length === 0) return "no works";
  return parts.join(", ");
}
