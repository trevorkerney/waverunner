import { Film, Tv, Folder } from "lucide-react";
import { useCoverUrl } from "@/context/CoverUrlContext";
import { getDisplayCover } from "@/components/cards/SortableCoverCard";
import type { MediaEntry } from "@/types";

export function DragOverlayCard({
  entry,
  size,
}: {
  entry: MediaEntry;
  size: number;
}) {
  const { getCoverUrl } = useCoverUrl();
  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getCoverUrl(coverPath) : null;

  return (
    <div className="flex cursor-grabbing flex-col items-center gap-2 rounded-md bg-accent p-2 text-left shadow-lg">
      <div className="relative overflow-hidden rounded-sm bg-muted">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={entry.title}
            className="pointer-events-none w-full"
            style={{ maxHeight: size * 2, width: size }}
            draggable={false}
          />
        ) : (
          <div
            className="flex items-center justify-center"
            style={{ height: size * 1.5, width: size }}
          >
            {entry.entry_type === "movie" ? (
              <Film size={size * 0.3} className="text-muted-foreground" />
            ) : entry.entry_type === "show" ? (
              <Tv size={size * 0.3} className="text-muted-foreground" />
            ) : (
              <Folder size={size * 0.3} className="text-muted-foreground" />
            )}
          </div>
        )}
      </div>
      <div className="w-full" style={{ maxWidth: size }}>
        <p className="text-sm font-medium">{entry.title}</p>
        {(entry.season_display || entry.collection_display || entry.year) && (
          <p className="text-xs text-muted-foreground">{[entry.season_display || entry.collection_display, entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`].filter(Boolean).join(", ")}</p>
        )}
      </div>
    </div>
  );
}
