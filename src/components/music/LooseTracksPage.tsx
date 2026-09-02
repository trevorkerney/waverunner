import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Music2, Pencil, ListPlus, ListStart, ListEnd, Disc3 } from "lucide-react";
import { Spinner } from "../ui/spinner";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../ui/context-menu";
import { TrackEditDialog } from "./EditDialogs";
import { MatchDialog } from "./MatchDialog";
import { AddToPlaylistDialog } from "../AddToPlaylistDialog";
import { MoveToCollectionDialog } from "./MoveToCollectionDialog";
import { PlayingIndicator } from "./PlayingIndicator";
import { LoveButton, LoveMenuItem } from "./LoveButton";
import { RevealMenuItem } from "./RevealMenuItem";
import { CodecBadge } from "./CodecBadge";
import { LibraryTrackRow, MusicQueueItem } from "../../types";
import { fmtTrackTime, fmtAlbumRuntime, trackDisplayTitle } from "./musicQueue";
import { useMbHidden } from "@/lib/mbVisibility";

interface LooseTracksPageProps {
  libraryId: string;
  /** Sounds side (base-root + misc files) instead of the music loose pool. */
  sounds: boolean;
  onPlayQueue: (items: MusicQueueItem[], startIndex: number) => void;
  currentTrackId: number | null;
  playing?: boolean;
  onPlaylistsChanged?: () => void;
  onEnqueue?: (items: MusicQueueItem[], mode: "next" | "last") => void;
  onNavigateToArtist?: (artistId: number, artistTitle: string) => void;
  /** Sounds: a move created/changed collections — the host refreshes grids. */
  onCollectionsChanged?: () => void;
  /** One-shot request to scroll a track's row into view and select it
   *  (Home's album-less tiles). A fresh nonce re-fires on repeat clicks. */
  focusRequest?: { trackId: number; nonce: number } | null;
}

/** The loose pool as a page, styled like an album detail page: placeholder
 *  cover, "Loose tracks" title, album-style rows. Music variant unions every
 *  hidden loose container (per-artist + root); sounds variant is the sound
 *  loose pool. Reached from the header button on the Albums/Sounds grids. */
export function LooseTracksPage({
  libraryId,
  sounds,
  onPlayQueue,
  currentTrackId,
  playing,
  onPlaylistsChanged,
  onEnqueue,
  onNavigateToArtist,
  onCollectionsChanged,
  focusRequest,
}: LooseTracksPageProps) {
  const [rows, setRows] = useState<LibraryTrackRow[] | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  // Per-library "hide MusicBrainz outside the center" (center map toggle).
  const mbHidden = useMbHidden(libraryId);
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  // Track being matched to MusicBrainz (its own dialog).
  const [matchTrack, setMatchTrack] = useState<number | null>(null);
  const [playlistFor, setPlaylistFor] = useState<{ id: number; title: string } | null>(null);
  const [moveFor, setMoveFor] = useState<{ id: number; title: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (reloadKey === 0) setRows(null); // silent refetch after edits
    invoke<LibraryTrackRow[]>("get_music_tracks", { libraryId, looseOnly: true, sounds })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => console.error("Failed to load loose tracks:", e));
    return () => {
      cancelled = true;
    };
  }, [libraryId, sounds, reloadKey]);

  // Rescans / metadata applies can promote or demote loose tracks — refetch
  // silently off the app-wide library-changed event.
  useEffect(() => {
    const onRescanned = () => setReloadKey((k) => k + 1);
    window.addEventListener("waverunner:library-rescanned", onRescanned);
    return () => window.removeEventListener("waverunner:library-rescanned", onRescanned);
  }, []);

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

  const queue = useMemo<MusicQueueItem[]>(
    () =>
      (rows ?? []).map((r) => ({
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
    [rows],
  );

  if (rows === null) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  const totalSecs = rows.reduce((acc, t) => acc + (t.runtime_secs ?? 0), 0);
  const playFrom = (index: number) => {
    if (queue.length > 0) onPlayQueue(queue, index);
  };

  return (
    <div
      className="px-6 pb-8"
      onClick={(e) => {
        if (
          selectedTrackId !== null &&
          !(e.target as HTMLElement).closest("button, [role='link'], [role='menu'], input, textarea, select, img")
        ) {
          setSelectedTrackId(null);
        }
      }}
    >
      {/* Header — album-page shape with a placeholder cover. */}
      <div className="flex items-end gap-5 py-6">
        <div className="flex h-80 w-80 shrink-0 items-center justify-center rounded-[3px] bg-muted text-muted-foreground">
          <Music2 size={56} />
        </div>
        <div className="min-w-0 pb-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {sounds ? "sounds" : "music"}
          </p>
          <h1 className="min-w-0 truncate font-heading text-3xl font-bold">Loose tracks</h1>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {[
              `${rows.length} track${rows.length === 1 ? "" : "s"}`,
              fmtAlbumRuntime(totalSecs) || null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="mt-3 flex items-center gap-2.5">
            <button
              onClick={() => playFrom(0)}
              disabled={rows.length === 0}
              className="flex items-center gap-2 rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
            >
              <Play size={15} className="translate-x-px" />
              Play
            </button>
          </div>
        </div>
      </div>

      {/* Track list — album-style rows; the number column is list position
          (loose tracks have no meaningful track numbers). */}
      <div className="mb-4">
        {rows.length === 0 && (
          <p className="px-2 py-6 text-sm text-muted-foreground">No loose tracks.</p>
        )}
        {rows.map((t, index) => {
          const isCurrent = currentTrackId === t.id;
          const isSelected = selectedTrackId === t.id;
          return (
            <ContextMenu key={t.id}>
              <ContextMenuTrigger
                render={
                  <button
                    data-music-track-id={t.id}
                    onClick={() => setSelectedTrackId(t.id)}
                    onContextMenu={() => setSelectedTrackId(t.id)}
                    onDoubleClick={() => playFrom(index)}
                    className={`group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left ${
                      isSelected ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  />
                }
              >
                <span
                  className="relative shrink-0 text-right font-mono text-xs text-muted-foreground"
                  style={{ width: `${Math.max(2, String(rows.length).length)}ch` }}
                >
                  <span className="group-hover:invisible">{index + 1}</span>
                  <Play
                    size={13}
                    onClick={(e) => {
                      e.stopPropagation();
                      playFrom(index);
                    }}
                    className="invisible absolute right-0 top-1/2 -translate-y-1/2 group-hover:visible"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
                    <span className={`truncate ${isCurrent ? "font-semibold text-primary" : ""}`}>
                      {trackDisplayTitle(t.title, t.file_path)}
                    </span>
                    {isCurrent && <PlayingIndicator paused={!playing} className="shrink-0" />}
                    <LoveButton
                      trackId={t.id}
                      loved={t.loved}
                      reveal="group-hover:opacity-100"
                      className="ml-1.5"
                    />
                  </span>
                  {(t.credits.length > 0 || t.artist_name) && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.credits.length > 0 ? (
                        t.credits.map((c, ci) => (
                          <span key={`${c.name}-${ci}`}>
                            {ci > 0 && ", "}
                            {c.artist_id != null && onNavigateToArtist ? (
                              <span
                                role="link"
                                className="cursor-pointer hover:underline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onNavigateToArtist(c.artist_id!, c.name);
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
                      ) : t.artist_id != null && t.artist_name && onNavigateToArtist ? (
                        <span
                          role="link"
                          className="cursor-pointer hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigateToArtist(t.artist_id!, t.artist_name!);
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
                {t.play_count > 0 && (
                  <span className="shrink-0 text-[10px] text-muted-foreground" title="Play count">
                    {t.play_count}×
                  </span>
                )}
                <CodecBadge codec={t.codec} bitrate={t.bitrate_kbps} mode={t.bitrate_mode} />
                <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">
                  {fmtTrackTime(t.runtime_secs)}
                </span>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {onEnqueue && (
                  <>
                    <ContextMenuItem onClick={() => onEnqueue([queue[index]], "next")}>
                      <ListStart size={14} />
                      Play next
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => onEnqueue([queue[index]], "last")}>
                      <ListEnd size={14} />
                      Add to queue
                    </ContextMenuItem>
                  </>
                )}
                {sounds && (
                  <ContextMenuItem
                    onClick={() =>
                      setMoveFor({ id: t.id, title: trackDisplayTitle(t.title, t.file_path) })
                    }
                  >
                    <ListPlus size={14} />
                    Add to collection…
                  </ContextMenuItem>
                )}
                <ContextMenuItem onClick={() => setEditTrackId(t.id)}>
                  <Pencil size={14} />
                  Edit metadata
                </ContextMenuItem>
                {!mbHidden && (
                  <ContextMenuItem onClick={() => setMatchTrack(t.id)}>
                    <Disc3 size={14} />
                    Match to MusicBrainz…
                  </ContextMenuItem>
                )}
                <LoveMenuItem resolve={() => ({ id: t.id, loved: t.loved })} />
                <ContextMenuItem
                  onClick={() =>
                    setPlaylistFor({ id: t.id, title: trackDisplayTitle(t.title, t.file_path) })
                  }
                >
                  <ListPlus size={14} />
                  Add to playlist
                </ContextMenuItem>
                <RevealMenuItem resolve={() => t.id} />
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>

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
      {sounds && (
        <MoveToCollectionDialog
          libraryId={libraryId}
          track={moveFor}
          open={moveFor != null}
          onOpenChange={(o) => {
            if (!o) setMoveFor(null);
          }}
          onMoved={() => onCollectionsChanged?.()}
        />
      )}
    </div>
  );
}
