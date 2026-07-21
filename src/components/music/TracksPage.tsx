import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Music, Pencil } from "lucide-react";
import { Spinner } from "../ui/spinner";
import { Input } from "../ui/input";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";
import { TrackEditDialog } from "./EditDialogs";
import { LibraryTrackRow, MusicQueueItem } from "../../types";
import { fmtTrackTime, trackDisplayTitle } from "./musicQueue";

interface TracksPageProps {
  libraryId: string;
  onPlayQueue: (items: MusicQueueItem[], startIndex: number) => void;
  /** Track currently loaded in the music player, for row highlighting. */
  currentTrackId: number | null;
}

/** Library-wide flat track list. Loose tracks (no album, possibly no artist)
 *  appear like any other row with those columns simply empty — the home for
 *  files that would previously have been excluded. Double-click plays from
 *  that row through the (filtered) list. */
export function TracksPage({ libraryId, onPlayQueue, currentTrackId }: TracksPageProps) {
  const [rows, setRows] = useState<LibraryTrackRow[] | null>(null);
  const [filter, setFilter] = useState("");
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (reloadKey === 0) setRows(null); // silent refetch after edits
    invoke<LibraryTrackRow[]>("get_music_tracks", { libraryId })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => console.error("Failed to load tracks:", e));
    return () => {
      cancelled = true;
    };
  }, [libraryId, reloadKey]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.title, r.file_name, r.artist_name, r.album_title, ...r.credits.map((c) => c.name)]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q)),
    );
  }, [rows, filter]);

  const queue = useMemo<MusicQueueItem[]>(
    () =>
      filtered.map((r) => ({
        trackId: r.id,
        title: trackDisplayTitle(r.title, r.file_path),
        artistName:
          r.credits.length > 0 ? r.credits.map((c) => c.name).join(", ") : r.artist_name,
        albumId: r.album_id,
        albumTitle: r.album_title,
        cover: null,
        path: r.file_path,
        durationSecs: r.runtime_secs,
      })),
    [filtered],
  );

  if (rows === null) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  return (
    <div className="px-6 pb-8">
      <div className="flex items-center justify-between gap-4 py-4">
        <h1 className="flex items-center gap-2 font-heading text-2xl font-bold">
          <Music size={22} />
          Tracks
          <span className="text-base font-normal text-muted-foreground">({rows.length})</span>
        </h1>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tracks…"
          className="h-8 max-w-xs text-sm"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? "No tracks in this library." : "No tracks match the filter."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border">
          {filtered.map((t, i) => {
            const isCurrent = currentTrackId === t.id;
            return (
              <ContextMenu key={t.id}>
                <ContextMenuTrigger
                  render={
                    <div
                      className={`group/track flex cursor-default items-center gap-3 px-3 py-1.5 text-sm hover:bg-accent/50 ${i > 0 ? "border-t" : ""} ${isCurrent ? "bg-accent/40" : ""}`}
                      onDoubleClick={() => onPlayQueue(queue, i)}
                    />
                  }
                >
                <button
                  onClick={() => onPlayQueue(queue, i)}
                  className={`flex w-5 shrink-0 items-center justify-center text-muted-foreground transition-opacity ${isCurrent ? "opacity-100" : "opacity-0 group-hover/track:opacity-100"}`}
                  title="Play"
                >
                  <Play size={13} className="translate-x-px" />
                </button>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${t.title.trim() === "" ? "text-muted-foreground" : ""}`}>
                    {trackDisplayTitle(t.title, t.file_path)}
                  </span>
                  {(t.credits.length > 0 || t.artist_name) && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.credits.length > 0 ? t.credits.map((c) => c.name).join(", ") : t.artist_name}
                    </span>
                  )}
                </span>
                <span className="hidden min-w-0 max-w-[35%] shrink-0 truncate text-xs text-muted-foreground sm:block">
                  {t.album_title ?? ""}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {fmtTrackTime(t.runtime_secs)}
                </span>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => setEditTrackId(t.id)}>
                    <Pencil size={14} />
                    Edit metadata
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      )}
      <TrackEditDialog
        trackId={editTrackId}
        open={editTrackId !== null}
        onOpenChange={(o) => {
          if (!o) setEditTrackId(null);
        }}
        onSaved={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}
