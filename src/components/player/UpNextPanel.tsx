import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Music2, X, ListX, GripVertical } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MusicPlayerState, MusicPlayerActions, currentMusicItem } from "../../hooks/useMusicPlayer";
import { MusicQueueItem, RecentPlay, TrackQueueInfo } from "../../types";
import { PlayingIndicator } from "../music/PlayingIndicator";
import { trackDisplayTitle, fmtRelative } from "../music/musicQueue";

/** How much of a long context tail to render (the Tracks page can queue
 *  thousands); the cut is labeled so it never reads as "that's everything". */
const CONTEXT_TAIL_LIMIT = 50;

function Thumb({ item }: { item: MusicQueueItem }) {
  return item.cover ? (
    <img
      src={convertFileSrc(item.cover)}
      alt=""
      className="size-8 shrink-0 rounded-[2px] object-cover"
      draggable={false}
    />
  ) : (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-[2px] bg-muted text-muted-foreground">
      <Music2 size={14} />
    </div>
  );
}

function RowText({ item, highlight }: { item: MusicQueueItem; highlight?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className={`truncate text-sm ${highlight ? "font-medium text-primary" : ""}`}>
          {item.title}
        </span>
      </span>
      {item.artistName && (
        <span className="block truncate text-xs text-muted-foreground">{item.artistName}</span>
      )}
    </span>
  );
}

/** One draggable explicit-queue row: grip handle drags (immediate, 4px
 *  threshold), the rest of the row keeps its double-click-play and remove. */
function QueueRow({
  id,
  item,
  onPlay,
  onRemove,
}: {
  id: number;
  item: MusicQueueItem;
  onPlay: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group/qrow flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1.5 hover:bg-accent/50 ${
        isDragging ? "relative z-10 bg-accent shadow-md" : ""
      }`}
      onDoubleClick={onPlay}
    >
      <span
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
        title="Drag to reorder"
      >
        <GripVertical size={14} />
      </span>
      <Thumb item={item} />
      <RowText item={item} />
      <button
        onClick={onRemove}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover/qrow:opacity-100"
        title="Remove from queue"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** The queue popover: what's playing, what the user queued, and what follows
 *  from the current context — in the exact order it will play. */
export function UpNextPanel({
  state,
  actions,
  onClose,
}: {
  state: MusicPlayerState;
  actions: MusicPlayerActions;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<"next" | "recent">("next");

  // History tab data — refetched when the tab shows and when the playing
  // track changes (each start logs a new row).
  const [recent, setRecent] = useState<RecentPlay[] | null>(null);
  const currentTrackId = currentMusicItem(state)?.trackId ?? null;
  useEffect(() => {
    if (tab !== "recent") return;
    let cancelled = false;
    // The panel's tab is the RAW history — dismissed tracks stay visible here.
    invoke<RecentPlay[]>("get_recent_music_plays", { libraryId: null, limit: 50, includeDismissed: true })
      .then((rows) => {
        if (!cancelled) setRecent(rows);
      })
      .catch((e) => console.error("Failed to load recent plays:", e));
    return () => {
      cancelled = true;
    };
  }, [tab, currentTrackId]);

  // Double-click a history row → play it now, as its own one-track context.
  const playRecent = async (p: RecentPlay) => {
    try {
      const infos = await invoke<TrackQueueInfo[]>("get_track_queue_items", {
        trackIds: [p.track_id],
      });
      const info = infos[0];
      if (!info) return;
      await actions.playQueue(
        [
          {
            trackId: info.track_id,
            title: trackDisplayTitle(info.title, info.file_path),
            artistName: info.artist_name,
            artistId: info.artist_id,
            artists: info.artists.map((c) => ({ name: c.name, artistId: c.artist_id })),
            albumId: info.album_id,
            albumTitle: info.album_title,
            cover: info.cover,
            path: info.file_path,
            durationSecs: info.duration_secs,
          },
        ],
        0
      );
    } catch (e) {
      console.error("Failed to play from history:", e);
    }
  };

  // Stable drag ids by item IDENTITY (trackId repeats when a track is queued
  // twice; array indices shift mid-drag). Objects keep their reference across
  // reorders, so a WeakMap-issued uid stays stable for the row's lifetime.
  const uidMapRef = useRef(new WeakMap<MusicQueueItem, number>());
  const uidCounterRef = useRef(1);
  const uidFor = (item: MusicQueueItem): number => {
    let id = uidMapRef.current.get(item);
    if (id == null) {
      id = uidCounterRef.current++;
      uidMapRef.current.set(item, id);
    }
    return id;
  };
  const queueIds = state.explicitQueue.map(uidFor);
  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const handleQueueDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = queueIds.indexOf(active.id as number);
    const to = queueIds.indexOf(over.id as number);
    if (from >= 0 && to >= 0) actions.moveQueued(from, to);
  };

  // Light-dismiss: a click outside the panel closes it — but clicks on the
  // playback bar itself (play/seek/volume) don't count as leaving; the panel
  // stays up while the user works the controls. (The bar's queue button stops
  // propagation so it toggles instead of insta-reopening.)
  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      if (!(ev.target instanceof Node) || !panelRef.current) return;
      const inBar =
        ev.target instanceof Element && ev.target.closest("[data-now-playing-bar]") !== null;
      if (!panelRef.current.contains(ev.target) && !inBar) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const current = currentMusicItem(state);
  // Context resume point: the track after the context index — correct whether
  // the current track is the context one or an explicit-queue detour.
  const tail = state.queue.slice(state.index + 1);
  const shownTail = tail.slice(0, CONTEXT_TAIL_LIMIT);

  return (
    <div
      ref={panelRef}
      className="absolute bottom-full right-3 z-20 mb-2 flex max-h-[26rem] w-80 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-xl"
    >
      <div className="flex border-b">
        {(
          [
            ["next", "Up next"],
            ["recent", "Recently listened to"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 border-b-2 px-3 py-2 text-xs font-medium ${
              tab === key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "recent" ? (
        <div className="overflow-y-auto p-2">
          {recent == null ? (
            <p className="px-1.5 py-3 text-center text-xs text-muted-foreground">Loading…</p>
          ) : recent.length === 0 ? (
            <p className="px-1.5 py-3 text-center text-xs text-muted-foreground">
              Nothing played yet.
            </p>
          ) : (
            recent.map((p, i) => (
              <div
                key={`${p.started_at}-${i}`}
                className="flex cursor-default items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-accent/50"
                onDoubleClick={() => void playRecent(p)}
                title="Double-click to play"
              >
                {p.cover ? (
                  <img
                    src={convertFileSrc(p.cover)}
                    alt=""
                    className="size-8 shrink-0 rounded-[2px] object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-[2px] bg-muted text-muted-foreground">
                    <Music2 size={14} />
                  </div>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {trackDisplayTitle(p.track_title, p.file_path)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[p.artist_name, p.album_title].filter(Boolean).join(" — ")}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {fmtRelative(p.started_at)}
                </span>
              </div>
            ))
          )}
        </div>
      ) : (
      <div className="overflow-y-auto p-2">
        {current && (
          <>
            <p className="px-1 pb-1 pt-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Now playing
            </p>
            <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5">
              <Thumb item={current} />
              <RowText item={current} highlight />
              <PlayingIndicator paused={!state.isPlaying} className="shrink-0" />
            </div>
          </>
        )}

        {state.explicitQueue.length > 0 && (
          <>
            <div className="flex items-center justify-between px-1 pb-1 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                In queue
              </p>
              <button
                onClick={() => actions.clearExplicitQueue()}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                title="Clear queue"
              >
                <ListX size={13} />
                Clear
              </button>
            </div>
            <DndContext sensors={dragSensors} onDragEnd={handleQueueDragEnd}>
              <SortableContext items={queueIds} strategy={verticalListSortingStrategy}>
                {state.explicitQueue.map((item, i) => (
                  <QueueRow
                    key={queueIds[i]}
                    id={queueIds[i]}
                    item={item}
                    onPlay={() => actions.playQueuedAt(i)}
                    onRemove={() => actions.removeQueuedAt(i)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </>
        )}

        {shownTail.length > 0 && (
          <>
            <p className="px-1 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {state.contextLabel ? `Up next · ${state.contextLabel}` : "Up next"}
            </p>
            {shownTail.map((item, i) => (
              <div
                key={`ctx-${state.index + 1 + i}-${item.trackId}`}
                className="flex cursor-default items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-accent/50"
                onDoubleClick={() => actions.jumpTo(state.index + 1 + i)}
              >
                <Thumb item={item} />
                <RowText item={item} />
              </div>
            ))}
            {tail.length > shownTail.length && (
              <p className="px-1.5 pb-1 pt-1.5 text-xs text-muted-foreground">
                …and {tail.length - shownTail.length} more
              </p>
            )}
          </>
        )}

        {state.explicitQueue.length === 0 && shownTail.length === 0 && (
          <p className="px-1.5 py-3 text-center text-xs text-muted-foreground">
            Nothing up next{state.loop === "all" ? " — the queue will loop" : ""}.
          </p>
        )}
      </div>
      )}
    </div>
  );
}
