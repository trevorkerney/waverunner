import { useState } from "react";

export function TruncatedList({
  label,
  items,
  limit = 5,
}: {
  label: string;
  items: string[];
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const visible = expanded ? items : items.slice(0, limit);
  const hasMore = items.length > limit;
  return (
    <div className="text-sm">
      <span className="text-muted-foreground">{label}: </span>
      {visible.join(", ")}
      {hasMore && (
        <button
          className="ml-1 text-muted-foreground underline hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "show less" : `+${items.length - limit} more`}
        </button>
      )}
    </div>
  );
}
