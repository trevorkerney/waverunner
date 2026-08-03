import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Music, Music2, Pencil, ListPlus, ListStart, ListEnd, Disc3 } from "lucide-react";
import { Spinner } from "../ui/spinner";
import { ClearableInput } from "../ui/clearable-input";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";
import { TrackEditDialog } from "./EditDialogs";
import { MatchDialog } from "./MatchDialog";
import { AddToPlaylistDialog } from "../AddToPlaylistDialog";
import { useDeselectOnBackgroundClick } from "./useTrackSelection";
import { PlayingIndicator } from "./PlayingIndicator";
import { LoveButton, LoveMenuItem } from "./LoveButton";
import { LibraryTrackRow, MusicQueueItem } from "../../types";
import { fmtTrackTime, trackDisplayTitle } from "./musicQueue";

interface TracksPageProps {
  libraryId: string;
  onPlayQueue: (items: MusicQueueItem[], startIndex: number) => void;
  /** Track currently loaded in the music player, for row highlighting. */
  currentTrackId: number | null;
  /** Whether that track is actively playing — freezes the equalizer when false. */
  playing?: boolean;
  /** A track was added to a playlist — the host refreshes playlist counts. */
  onPlaylistsChanged?: () => void;
  /** "Play next" / "Add to queue" context items. */
  onEnqueue?: (items: MusicQueueItem[], mode: "next" | "last") => void;
  /** Grid thumbnail resolver (covers → covers_thumb), for the row art. */
  getCoverUrl: (filePath: string) => string;
  /** Credit-name links → artist pages. */
  onNavigateToArtist?: (artistId: number, artistTitle: string) => void;
  /** Album-name links → album pages. */
  onNavigateToAlbum?: (albumId: number, albumTitle: string) => void;
  /** One-shot request to scroll a track's row into view and select it (Home's
   *  album-less tiles). A fresh nonce re-fires on repeat clicks. */
  focusRequest?: { trackId: number; nonce: number } | null;
}

/** Memoized row: with thousands of tracks, a selection/current-track change
 *  must re-render only the two affected rows — re-rendering the whole list
 *  visibly delays the context menu (it waits on the commit that the
 *  right-click's select triggered). Handlers take the index so they stay
 *  referentially stable. */
export const TrackRow = memo(function TrackRow({
  t,
  index,
  isCurrent,
  isSelected,
  playing,
  onPlayAt,
  onSelect,
  onMenuTarget,
  getCoverUrl,
  onOpenArtist,
  onOpenAlbum,
  numWidthCh,
}: {
  t: LibraryTrackRow;
  index: number;
  isCurrent: boolean;
  isSelected: boolean;
  /** Only ever true for the current row — stable false elsewhere keeps memo hits. */
  playing: boolean;
  onPlayAt: (index: number) => void;
  onSelect: (trackId: number) => void;
  onMenuTarget: (trackId: number) => void;
  getCoverUrl: (filePath: string) => string;
  onOpenArtist: (artistId: number, artistTitle: string) => void;
  onOpenAlbum: (albumId: number, albumTitle: string) => void;
  /** Digit count of the largest list position — sizes the number column. */
  numWidthCh: number;
}) {
  return (
    <div
      data-track-row
      data-music-track-id={t.id}
      className={`group/track flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 text-sm ${isSelected ? "bg-accent" : "hover:bg-accent/50"}`}
      // Offscreen rows skip layout/paint; ~44px estimates a row (32px thumb +
      // padding) so the scrollbar stays honest until real heights replace it.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px" }}
      onClick={() => onSelect(t.id)}
      onDoubleClick={() => onPlayAt(index)}
      onContextMenu={() => onMenuTarget(t.id)}
    >
      {/* Album-page pattern: the list position, swapping to a play button on
          hover. Width tracks the largest number (ch = digit width in mono). */}
      <span
        className="relative shrink-0 text-right font-mono text-xs text-muted-foreground"
        style={{ width: `${numWidthCh}ch` }}
      >
        <span className="group-hover/track:invisible">{index + 1}</span>
        <Play
          size={13}
          onClick={(e) => {
            e.stopPropagation();
            onPlayAt(index);
          }}
          className="invisible absolute right-0 top-1/2 -translate-y-1/2 cursor-pointer group-hover/track:visible"
        />
      </span>
      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-muted">
        {t.cover ? (
          <img
            src={getCoverUrl(t.cover)}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
            draggable={false}
          />
        ) : (
          <Music2 size={15} className="text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={`truncate ${isCurrent ? "font-medium text-primary" : ""}`}>
            {trackDisplayTitle(t.title, t.file_path)}
          </span>
          {isCurrent && <PlayingIndicator paused={!playing} className="shrink-0" />}
        </span>
        {(t.credits.length > 0 || t.artist_name) && (
          <span className="block truncate text-xs text-muted-foreground">
            {/* Names the library knows as artists link to their pages. */}
            {t.credits.length > 0 ? (
              t.credits.map((c, ci) => (
                <span key={`${c.name}-${ci}`}>
                  {ci > 0 && ", "}
                  {c.artist_id != null ? (
                    <span
                      role="link"
                      className="cursor-pointer hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenArtist(c.artist_id!, c.name);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      {c.name}
                    </span>
                  ) : (
                    c.name
                  )}
                </span>
              ))
            ) : t.artist_id != null && t.artist_name ? (
              <span
                role="link"
                className="cursor-pointer hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenArtist(t.artist_id!, t.artist_name!);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {t.artist_name}
              </span>
            ) : (
              t.artist_name
            )}
          </span>
        )}
      </span>
      <span className="hidden min-w-0 max-w-[35%] shrink-0 truncate text-xs text-muted-foreground sm:block">
        {t.album_id != null && t.album_title ? (
          <span
            role="link"
            className="cursor-pointer hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onOpenAlbum(t.album_id!, t.album_title!);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {t.album_title}
          </span>
        ) : (
          t.album_title ?? ""
        )}
      </span>
      <LoveButton trackId={t.id} loved={t.loved} reveal="group-hover/track:opacity-100" />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {fmtTrackTime(t.runtime_secs)}
      </span>
    </div>
  );
});

/** Library-wide flat track list. Loose tracks (no album, possibly no artist)
 *  appear like any other row with those columns simply empty — the home for
 *  files that would previously have been excluded. Double-click plays from
 *  that row through the (filtered) list. */
export function TracksPage({ libraryId, onPlayQueue, currentTrackId, playing, onPlaylistsChanged, onEnqueue, getCoverUrl, onNavigateToArtist, onNavigateToAlbum, focusRequest }: TracksPageProps) {
  const [rows, setRows] = useState<LibraryTrackRow[] | null>(null);
  const [filter, setFilter] = useState("");
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  // Track being matched to MusicBrainz (its own dialog).
  const [matchTrack, setMatchTrack] = useState<number | null>(null);
  const [playlistFor, setPlaylistFor] = useState<{ id: number; title: string } | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  useDeselectOnBackgroundClick(useCallback(() => setSelectedTrackId(null), []));
  const [reloadKey, setReloadKey] = useState(0);
  // One context menu serves the whole list (a per-row ContextMenu means
  // thousands of mounted menu components — the enter/leave freeze). The row
  // under the pointer records itself here as the native contextmenu event
  // bubbles up to the shared trigger; a ref so no row re-renders.
  const menuTrackRef = useRef<number | null>(null);

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

  // Rescans change the track list out from under this page — refetch silently
  // (rows stay visible; only reloadKey 0 shows the loading state). Scrobbles
  // tick the play-count column, same silent treatment.
  useEffect(() => {
    const onRescanned = () => setReloadKey((k) => k + 1);
    window.addEventListener("waverunner:library-rescanned", onRescanned);
    window.addEventListener("waverunner:track-scrobbled", onRescanned);
    return () => {
      window.removeEventListener("waverunner:library-rescanned", onRescanned);
      window.removeEventListener("waverunner:track-scrobbled", onRescanned);
    };
  }, []);

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
        artistId: r.credits.find((c) => c.artist_id != null)?.artist_id ?? r.artist_id,
        artists:
          r.credits.length > 0
            ? r.credits.map((c) => ({ name: c.name, artistId: c.artist_id }))
            : r.artist_name
              ? [{ name: r.artist_name, artistId: r.artist_id }]
              : [],
        albumId: r.album_id,
        albumTitle: r.album_title,
        cover: r.cover,
        path: r.file_path,
        durationSecs: r.runtime_secs,
      })),
    [filtered],
  );

  const handlePlayAt = useCallback((index: number) => onPlayQueue(queue, index), [onPlayQueue, queue]);
  const handleSelect = useCallback((trackId: number) => setSelectedTrackId(trackId), []);
  const handleMenuTarget = useCallback((trackId: number) => {
    menuTrackRef.current = trackId;
    setSelectedTrackId(trackId);
  }, []);
  const handleOpenArtist = useCallback(
    (artistId: number, artistTitle: string) => onNavigateToArtist?.(artistId, artistTitle),
    [onNavigateToArtist]
  );
  const handleOpenAlbum = useCallback(
    (albumId: number, albumTitle: string) => onNavigateToAlbum?.(albumId, albumTitle),
    [onNavigateToAlbum]
  );

  // Scroll-to-track request (album-page pattern): consumed once per nonce,
  // waits for the rows to be in the DOM.
  const focusConsumedRef = useRef(0);
  useEffect(() => {
    if (!focusRequest || rows == null) return;
    if (focusConsumedRef.current === focusRequest.nonce) return;
    const el = document.querySelector(`[data-music-track-id="${focusRequest.trackId}"]`);
    if (!el) return;
    focusConsumedRef.current = focusRequest.nonce;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setSelectedTrackId(focusRequest.trackId);
  }, [focusRequest, rows]);

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
        <div className="w-full max-w-xs">
          <ClearableInput
            value={filter}
            onValueChange={setFilter}
            placeholder="Filter tracks…"
            className="h-8 text-sm"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? "No tracks in this library." : "No tracks match the filter."}
        </p>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger render={<div />}>
            {filtered.map((t, i) => {
              const isCurrent = currentTrackId === t.id;
              return (
                <TrackRow
                  key={t.id}
                  t={t}
                  index={i}
                  isCurrent={isCurrent}
                  isSelected={selectedTrackId === t.id}
                  playing={isCurrent ? (playing ?? false) : false}
                  onPlayAt={handlePlayAt}
                  onSelect={handleSelect}
                  onMenuTarget={handleMenuTarget}
                  getCoverUrl={getCoverUrl}
                  onOpenArtist={handleOpenArtist}
                  onOpenAlbum={handleOpenAlbum}
                  numWidthCh={Math.max(2, String(filtered.length).length)}
                />
              );
            })}
          </ContextMenuTrigger>
          <ContextMenuContent>
            {onEnqueue && (
              <>
                <ContextMenuItem
                  onClick={() => {
                    const idx = filtered.findIndex((r) => r.id === menuTrackRef.current);
                    if (idx >= 0) onEnqueue([queue[idx]], "next");
                  }}
                >
                  <ListStart size={14} />
                  Play next
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => {
                    const idx = filtered.findIndex((r) => r.id === menuTrackRef.current);
                    if (idx >= 0) onEnqueue([queue[idx]], "last");
                  }}
                >
                  <ListEnd size={14} />
                  Add to queue
                </ContextMenuItem>
              </>
            )}
            <ContextMenuItem onClick={() => setEditTrackId(menuTrackRef.current)}>
              <Pencil size={14} />
              Edit metadata
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setMatchTrack(menuTrackRef.current)}>
              <Disc3 size={14} />
              Match to MusicBrainz…
            </ContextMenuItem>
            <LoveMenuItem
              resolve={() => {
                const t = rows?.find((r) => r.id === menuTrackRef.current);
                return t ? { id: t.id, loved: t.loved } : null;
              }}
            />
            <ContextMenuItem
              onClick={() => {
                const t = rows?.find((r) => r.id === menuTrackRef.current);
                if (t) setPlaylistFor({ id: t.id, title: trackDisplayTitle(t.title, t.file_path) });
              }}
            >
              <ListPlus size={14} />
              Add to playlist
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      <AddToPlaylistDialog
        open={playlistFor != null}
        onOpenChange={(o) => {
          if (!o) setPlaylistFor(null);
        }}
        libraryId={libraryId}
        entryId={playlistFor?.id ?? null}
        entryTitle={playlistFor?.title ?? null}
        onAdded={() => onPlaylistsChanged?.()}
      />
      <TrackEditDialog
        trackId={editTrackId}
        open={editTrackId !== null}
        onOpenChange={(o) => {
          if (!o) setEditTrackId(null);
        }}
        onSaved={() => setReloadKey((k) => k + 1)}
      />
      {matchTrack != null && (
        <MatchDialog
          kind="track"
          entityId={matchTrack}
          open={matchTrack != null}
          onOpenChange={(o) => !o && setMatchTrack(null)}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}
