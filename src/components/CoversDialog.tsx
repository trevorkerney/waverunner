import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  RevealAfterResize,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton, useHandoff } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Check, Download, FolderOpen, Globe, Image as ImageIcon, Lock, RefreshCw, Trash2 } from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { TmdbImageBrowserDialog } from "./TmdbImageBrowserDialog";

// ── CAA image pixel sizes ──────────────────────────────────────────────
// The archive's listing carries no dimensions, so each is a header-only
// fetch (caa_image_size, first 64KB). Session-cached by URL, started only
// once the caption scrolls into view, and at most 3 in flight — a group
// with 100+ releases must not fan out into 100 requests on open.
type ImageDims = [number, number] | null;
const dimsCache = new Map<string, ImageDims>();
const dimsWaiters = new Map<string, Set<(d: ImageDims) => void>>();
const dimsQueue: string[] = [];
let dimsInFlight = 0;
const DIMS_CONCURRENCY = 3;

function pumpDims() {
  while (dimsInFlight < DIMS_CONCURRENCY && dimsQueue.length > 0) {
    const url = dimsQueue.shift()!;
    dimsInFlight++;
    invoke<ImageDims>("caa_image_size", { url })
      .catch(() => null)
      .then((d) => {
        dimsCache.set(url, d);
        dimsInFlight--;
        const ws = dimsWaiters.get(url);
        dimsWaiters.delete(url);
        ws?.forEach((w) => w(d));
        pumpDims();
      });
  }
}

/** "1400 × 1400" for a LOCAL cover: read off the decoded image itself (the
 *  tile has already loaded it, so this resolves from the browser's cache). */
function LocalImageSize({ src }: { src: string }) {
  const [dims, setDims] = useState<ImageDims | null>(null);
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (live && img.naturalWidth && img.naturalHeight) setDims([img.naturalWidth, img.naturalHeight]);
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return dims ? <>{`${dims[0]} × ${dims[1]}`}</> : <Skeleton className="inline-block h-2.5 w-16 align-middle" />;
}

/** "1400 × 1400" for a CAA image URL, once known; nothing while loading or
 *  when the header couldn't be read. `prefix` (" · ") joins it onto text
 *  already in the caption without leaving a dangling separator. */
function ImageSize({ url, prefix = "" }: { url: string; prefix?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [dims, setDims] = useState<ImageDims | undefined>(() => dimsCache.get(url));
  useEffect(() => {
    const cached = dimsCache.get(url);
    if (cached !== undefined) {
      setDims(cached);
      return;
    }
    const el = ref.current;
    if (!el) return;
    let live = true;
    let ws: Set<(d: ImageDims) => void> | undefined;
    const cb = (d: ImageDims) => {
      if (live) setDims(d);
    };
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const again = dimsCache.get(url);
      if (again !== undefined) {
        cb(again);
        return;
      }
      ws = dimsWaiters.get(url);
      if (!ws) {
        ws = new Set();
        dimsWaiters.set(url, ws);
        dimsQueue.push(url);
      }
      ws.add(cb);
      pumpDims();
    });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
      ws?.delete(cb);
    };
  }, [url]);
  // undefined = still to fetch (lazily, on scroll-in): a text-sized skeleton
  // holds the spot. null = the header couldn't be read: nothing, no prefix.
  return (
    <span ref={ref}>
      {dims === undefined ? (
        <>
          {prefix}
          {/* align-middle + a box shorter than the line: sits centred on the
              text's x-height and never grows the line box, so the caption
              doesn't shift when the numbers replace it. */}
          <Skeleton className="inline-block h-2.5 w-16 align-middle" />
        </>
      ) : dims ? (
        `${prefix}${dims[0]} × ${dims[1]}`
      ) : null}
    </span>
  );
}

/** The "Covers…" context-menu entry, everywhere one exists. The dialog opens
 *  at once (skeleton tiles until the covers land), so this is a plain item. */
export function CoversMenuItem({ onOpen }: { onOpen: () => void }) {
  return (
    <ContextMenuItem onClick={onOpen}>
      <ImageIcon size={14} />
      Covers
    </ContextMenuItem>
  );
}

/** The covers grid: five fixed columns (a 2xl dialog's width), so a tile is
 *  always the same size and two rows are always the same height. */
export const COVER_GRID = "grid grid-cols-5 items-start gap-3";
/** The covers dialogs' fixed height: padding + title + gap + a body of
 *  exactly two rows of square tiles (the WIDEST tiles a 2xl dialog yields,
 *  ~135px, plus the gap and the body's padding, with a little slack so two
 *  rows never overflow by a pixel and summon a scrollbar) + gap + footer,
 *  and now a caption line (4px + ~16px) under each row.
 *  16 + 20 + 16 + (312 + 40) + 16 + 60 = 480px. */
const COVERS_HEIGHT = "30rem";
/** The same for video: two rows of 2:3 posters at the same tile width
 *  (~135 × 202) plus their captions. 16 + 20 + 16 + (405 + 12 gap + 22
 *  padding + 8 slack + 40 captions) + 16 + 60 = 615px. */
const VIDEO_COVERS_HEIGHT = "38.5rem";
/** How long a closed dialog keeps its content before resetting — longer
 *  than the shell's fade-out (200ms) plus its exit (120ms), so the content
 *  is still there to fade. */
export const CLOSE_RESET_MS = 400;

/** A lazily loaded thumbnail: a square skeleton holds the spot until its
 *  own image has loaded — each tile independently, so a scan set fills in
 *  as the archive delivers it — then the tile takes the image's natural
 *  shape (booklets and spines display whole, no letterbox background). A
 *  failed image just drops the skeleton. */
function LazyThumb({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span className={`relative block w-full ${loaded ? "" : "aspect-square"}`}>
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      <img
        src={src}
        alt=""
        loading="lazy"
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        className={`w-full transition-opacity duration-200 ${
          loaded ? "h-auto opacity-100" : "absolute inset-0 h-full object-contain opacity-0"
        }`}
      />
    </span>
  );
}

/** Grey tiles in the covers grid's own layout, filling the fixed body until
 *  the real tiles are fetched and decoded — the swap moves nothing. */
export function SkeletonTiles({
  count = 10,
  className = "",
  aspect = "square",
  grid = COVER_GRID,
  caption = false,
}: {
  count?: number;
  className?: string;
  /** Album art is square; video posters are 2:3 and backdrops 16:9 (same
   *  width, taller / shorter). */
  aspect?: "square" | "poster" | "wide";
  /** The grid the real tiles use (Covers' five columns by default). */
  grid?: string;
  /** A text-sized line under each tile, where the real tiles carry their
   *  resolution — keeps the skeleton's row pitch equal to the tiles'. */
  caption?: boolean;
}) {
  return (
    <div className={`${grid} ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <Skeleton
            className={`w-full rounded-[3px] ${
              aspect === "poster" ? "aspect-[2/3]" : aspect === "wide" ? "aspect-video" : "aspect-square"
            }`}
          />
          {caption && <Skeleton className="mx-auto mt-1.5 h-3 w-2/3" />}
        </div>
      ))}
    </div>
  );
}

/** MusicBrainz / Cover Art Archive image browser — the music counterpart of
 *  the TMDB image browser: its own modal, multi-select, one Download.
 *  A release GROUP carries exactly one CAA image (the designated front);
 *  a pinned release can carry a full scan set (front/back/booklet/…), so a
 *  pinned release shows both sections. */
function CaaImageBrowserDialog({
  open,
  onOpenChange,
  albumId,
  releaseId,
  releaseMatched,
  title,
  onDownload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  albumId: number;
  releaseId: number | null;
  /** The release is pinned to a MusicBrainz release (known before the
   *  listing loads, so the frame is declared right from the first frame). */
  releaseMatched: boolean;
  title: string;
  /** Download: the picked image URLs go UP to the Covers dialog, which
   *  fetches them behind skeleton tiles in its own grid — this browser just
   *  closes. (It used to download here, behind a spinner on the button.) */
  onDownload: (urls: string[]) => void;
}) {
  const [data, setData] = useState<CaaBrowse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by Retry: the Cover Art Archive 500s now and then, and the
  // listing effect keys on this to run again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retry = () => {
    setLoadError(null);
    setData(null);
    setLoadAttempt((n) => n + 1);
  };
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // "Other releases": explicit opt-in (a group can hold 100+ pressings).
  // Rows render with fixed-size thumb boxes and lazy front-250 images —
  // browsing them costs one gated MB call plus only what scrolls into view;
  // expanding a row's full scan set is one CAA fetch for that release.
  const [others, setOthers] = useState<GroupArtRelease[] | null>(null);
  const [othersLoading, setOthersLoading] = useState(false);
  const [othersSlow, setOthersSlow] = useState(false);
  const [scans, setScans] = useState<Map<string, CaaImage[] | "loading">>(new Map());
  useEffect(() => {
    if (!othersLoading) {
      setOthersSlow(false);
      return;
    }
    const t = setTimeout(() => setOthersSlow(true), 500);
    return () => clearTimeout(t);
  }, [othersLoading]);

  const loadOthers = async () => {
    setOthersLoading(true);
    try {
      setOthers(await invoke<GroupArtRelease[]>("mb_group_release_art", { albumId, releaseId }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setOthersLoading(false);
    }
  };

  const expandScans = async (mbid: string) => {
    setScans((prev) => new Map(prev).set(mbid, "loading"));
    try {
      const imgs = await invoke<CaaImage[]>("caa_release_scans", { releaseMbid: mbid });
      setScans((prev) => new Map(prev).set(mbid, imgs));
    } catch (e) {
      toast.error(String(e));
      setScans((prev) => {
        const next = new Map(prev);
        next.delete(mbid);
        return next;
      });
    }
  };

  // The dialog opens at once with skeleton tiles; the real tiles replace
  // them only once the listing AND its thumbnails are decoded, so the swap
  // reveals finished art instead of thumbs popping in one by one.
  useEffect(() => {
    if (!open) {
      // Reset AFTER the shell has faded this content out — clearing state
      // at once unmounts the tiles mid-fade (they vanish while the text
      // beside them is still fading). Reopening inside the window keeps it.
      const t = setTimeout(() => {
        setData(null);
        setLoadError(null);
        setPicked(new Set());
        setOthers(null);
        setScans(new Map());
      }, CLOSE_RESET_MS);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await invoke<CaaBrowse>("caa_release_images", { albumId, releaseId });
        if (cancelled) return;
        // The thumbs are on archive.org and can dawdle — cap the wait so a
        // slow one can't hold the whole listing.
        const cap = new Promise<void>((r) => setTimeout(r, 2500));
        await Promise.race([
          Promise.allSettled(
            [...d.group, ...d.release].map((i) => {
              const img = new Image();
              img.src = i.thumb;
              return img.decode().catch(() => {});
            }),
          ),
          cap,
        ]);
        if (!cancelled) setData(d);
      } catch (e) {
        // In place, not a toast + bounce: the "match first" case can't
        // reach here any more (the launch button is disabled), so what's
        // left is a genuine fetch failure the user should read here.
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, albumId, releaseId, loadAttempt]);

  const toggle = (url: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const download = () => {
    onDownload([...picked]);
    setPicked(new Set());
    onOpenChange(false);
  };

  // `frontKey`: a release row's own thumb is the same file as the "Front"
  // tile in its expanded scan set (the /front URL redirects to that image),
  // so both select under ONE key — picking either lights both, and the
  // download fetches it once.
  // Same fixed five columns as the Covers grid, so the skeleton row and the
  // real tiles land in exactly the same places.
  const tileGrid = (images: CaaImage[], frontKey?: string) => (
    <div className={COVER_GRID}>
      {images.map((img) => {
        const key = img.front && frontKey ? frontKey : img.url;
        const isPicked = picked.has(key);
        return (
          <div key={img.url}>
            <button
              onClick={() => toggle(key)}
              title={[img.types.join(", ") || null, img.comment || null]
                .filter(Boolean)
                .join(" · ") || "Select this image"}
              className={`relative block w-full overflow-hidden rounded-[3px] bg-muted shadow-md transition-[translate,scale] duration-200 hover:-translate-y-1 hover:scale-[1.04] hover:shadow-xl ${
                isPicked
                  ? "ring-2 ring-primary"
                  : "ring-1 ring-foreground/10 hover:ring-foreground/25"
              }`}
            >
              <LazyThumb src={img.thumb} />
              {isPicked && (
                <span className="absolute left-1.5 top-1.5 rounded-full bg-primary p-1 text-primary-foreground shadow">
                  <Check size={11} />
                </span>
              )}
            </button>
            {/* Types give way (ellipsis) before the resolution does — the
                numbers are the part worth reading whole. */}
            <p className="mt-1 flex justify-center gap-1 text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">{img.types.join(", ")}</span>
              <span className="shrink-0">
                {/* "· " not " · ": a flex item's leading space collapses, and
                    the gap supplies the space before the dot. */}
                <ImageSize url={img.url} prefix={img.types.length > 0 ? "· " : ""} />
              </span>
            </p>
          </div>
        );
      })}
    </div>
  );

  // Same hand-off as Covers: tiles mount invisible once the listing is in,
  // their thumbs are waited on, the skeleton fades out, the tiles fade in.
  // The ref covers the whole body so the release section's thumbs count.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { stage, skeletonSeen, shown, contentVisible } = useHandoff(!!data || !!loadError, contentRef);
  const fade = `transition-opacity duration-200 will-change-[opacity] ${contentVisible ? "opacity-100" : "opacity-0"}`;
  const skeletonFade = `transition-opacity duration-200 ${stage === "hidden" ? "" : "opacity-0"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Frame by content: Covers' two rows whether only the group is
          matched (its front, plus scans when the designated release has
          them) or the release is pinned too, and the tall frame while
          browsing the group's releases. Each change is a shell morph
          (fade → resize → fade). */}
      <DialogContent
        size="2xl"
        height={others !== null ? "xl" : COVERS_HEIGHT}
      >
        <DialogHeader>
          <DialogTitle className="truncate">MusicBrainz cover art — {title}</DialogTitle>
        </DialogHeader>
        {/* Known before the listing loads (the release's pin state came with
            the Covers fetch), so it's plain text from the first frame. */}
        <p className="-mt-3 text-xs text-muted-foreground">
          {releaseMatched
            ? "release group matched · release matched"
            : "release group matched · release unmatched"}
        </p>
        {/* -mt-0.5 / -mb-0.5 with no padding: 14px from the subtitle to the
            section label, and the same 14px from the last caption to the
            footer (the dialog's 16px gaps, each pulled up 2px). */}
        <DialogBody
          ref={contentRef}
          // No scrollbar until the content is shown — the skeleton row (and
          // the invisible content beneath it) must not summon one.
          className={`relative isolate -mb-0.5 -mt-0.5 px-1.5 pb-0 pt-0 [scrollbar-gutter:stable] ${
            shown ? "" : "overflow-hidden"
          }`}
        >
          {/* Section labels are static (the sections are known up front);
              only the tiles wait on the listing. The skeleton row overlays
              the group section's (invisible) tiles until they're ready and
              stays MOUNTED through its fade. */}
          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Release group cover
              </p>
              <div className="relative isolate">
                {!shown && skeletonSeen && (
                  <div className={`absolute inset-x-0 top-0 z-10 ${COVER_GRID} ${skeletonFade}`}>
                    {Array.from({ length: 5 }, (_, i) => (
                      <div key={i}>
                        <Skeleton className="aspect-square w-full rounded-[3px]" />
                        <Skeleton className="mx-auto mt-1.5 h-3 w-2/3" />
                      </div>
                    ))}
                  </div>
                )}
                <div className={fade}>
                  {loadError || data?.group_error ? (
                    <p className="flex items-center justify-center gap-3 py-8 text-center text-sm text-destructive">
                      <span>{loadError ?? data?.group_error}</span>
                      <Button variant="outline" size="sm" onClick={retry}>
                        <RefreshCw size={13} />
                        Retry
                      </Button>
                    </p>
                  ) : !data ? (
                    // Holds the row's height while invisible, so the
                    // sections below don't jump when the tiles land.
                    <div className={COVER_GRID}>
                      <div className="aspect-square w-full" />
                    </div>
                  ) : data.group.length > 0 ? (
                    tileGrid(data.group)
                  ) : (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      No cover art on MusicBrainz for this release group.
                    </p>
                  )}
                </div>
              </div>
            </div>
            {releaseMatched && (
              <div className={fade}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  This release
                </p>
                {!data ? null : data.release_error ? (
                  // This release's Archive item failed on its own (the
                  // group above still shows) — say so here, with the retry.
                  <p className="flex items-center gap-3 text-sm text-destructive">
                    <span>{data.release_error}</span>
                    <Button variant="outline" size="sm" onClick={retry}>
                      <RefreshCw size={13} />
                      Retry
                    </Button>
                  </p>
                ) : data.release.length > 0 ? (
                  tileGrid(data.release)
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No scans for this release on Cover Art Archive.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Other pressings in the group — explicit opt-in (the footer's
              left button), lazy row thumbs. */}
          {data && others !== null && (
            // Mounts invisible; the frame grows with the content above
            // riding along, then this fades in once the shell reports the
            // resize is done.
            <RevealAfterResize className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {data.release_pinned ? "Other releases in this group" : "Releases in this group"}
                  </p>
                  {!data.release_pinned && (
                    <p className="mb-2 text-xs text-muted-foreground">
                      Your copy isn't matched to any of these specific releases — this is every
                      release in the group with cover art.
                    </p>
                  )}
                  {others.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No other releases in this group have cover art.
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-col gap-3">
                      {others.map((r) => {
                        const frontThumb = `https://coverartarchive.org/release/${r.release_id}/front-250`;
                        const frontFull = `https://coverartarchive.org/release/${r.release_id}/front`;
                        const isPicked = picked.has(frontFull);
                        const expanded = scans.get(r.release_id);
                        return (
                          <div key={r.release_id}>
                            <div className="flex items-start gap-3">
                              {r.has_front ? (
                                <button
                                  onClick={() => toggle(frontFull)}
                                  title="Front cover — click to select"
                                  className={`relative block h-28 w-28 shrink-0 overflow-hidden rounded-[3px] bg-muted shadow-sm transition-shadow ${
                                    isPicked
                                      ? "ring-2 ring-primary"
                                      : "ring-1 ring-foreground/10 hover:ring-foreground/25"
                                  }`}
                                >
                                  <img
                                    src={frontThumb}
                                    alt=""
                                    loading="lazy"
                                    draggable={false}
                                    className="h-full w-full object-contain"
                                  />
                                  {isPicked && (
                                    <span className="absolute left-1 top-1 rounded-full bg-primary p-1 text-primary-foreground shadow">
                                      <Check size={11} />
                                    </span>
                                  )}
                                </button>
                              ) : (
                                // Back/booklet-only release — nothing at its
                                // /front URL, so no selectable thumb.
                                <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-[3px] bg-muted text-center text-xs text-muted-foreground ring-1 ring-foreground/10">
                                  No front cover
                                </div>
                              )}
                              <div className="min-w-0 flex-1 text-sm">
                                <p className="truncate">
                                  {[r.date, r.countries.join("/") || null, r.format]
                                    .filter(Boolean)
                                    .join(" · ") || "Release"}
                                </p>
                                {(() => {
                                  const meta = [
                                    r.label,
                                    r.disambiguation,
                                    r.status && r.status !== "Official" ? r.status : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ");
                                  return (
                                    <p className="truncate text-xs text-muted-foreground">
                                      {meta}
                                      {r.has_front && (
                                        <ImageSize url={frontFull} prefix={meta ? " · " : ""} />
                                      )}
                                    </p>
                                  );
                                })()}
                                {r.art_count > (r.has_front ? 1 : 0) && expanded === undefined && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="mt-1 h-6 px-2 text-xs"
                                    onClick={() => expandScans(r.release_id)}
                                  >
                                    All {r.art_count} images…
                                  </Button>
                                )}
                                {expanded === "loading" && <Spinner className="mt-2 size-4" />}
                              </div>
                            </div>
                            {Array.isArray(expanded) && (
                              <div className="mt-2">
                                {tileGrid(expanded, r.has_front ? frontFull : undefined)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
            </RevealAfterResize>
          )}
        </DialogBody>
        <DialogFooter>
          {/* Browse the group's releases: left of the footer until opened;
              disabled until the group cover is actually on screen. */}
          {others === null && (
            <Button
              variant="outline"
              className="mr-auto"
              onClick={loadOthers}
              disabled={!shown || !data || othersLoading}
            >
              <Globe size={14} />
              {data?.release_pinned ? "Other releases…" : "Browse this group's releases…"}
              {othersSlow && <Spinner className="size-3.5" />}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={download} disabled={picked.size === 0}>
            <Download size={14} />
            Download {picked.size > 0 ? picked.size : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Opened from a playlist: the pool (add / delete) is the target's own, but
 *  the PICK is the link's — a playlist's copy may show a different cover
 *  than the library page, and setting it never touches the target. */
export interface PlaylistLink {
  linkId: number;
  /** What the link shows now (its override, or the target's pick). */
  selectedCover: string | null;
}

/** What the covers dialog manages.
 *  - "entry": one media_entry's covers (movies, shows, video collections,
 *    music artists) — the entry-level add/set/delete commands.
 *  - "release": ONE release of a music album (releases don't pool covers).
 *    releaseId null = the default release (grid entry points). */
export type CoversTarget =
  | {
      kind: "entry";
      libraryId: string;
      entryId: number;
      entryType: string;
      title: string;
      link?: PlaylistLink;
    }
  | {
      kind: "release";
      libraryId: string;
      albumId: number;
      releaseId: number | null;
      title: string;
      link?: PlaylistLink;
    };

interface CoverInfo {
  path: string;
  origin: string; // 'library' | 'app' | 'fetched'
}

interface CaaImage {
  thumb: string;
  url: string;
  front: boolean;
  types: string[];
  comment: string;
}

interface CaaBrowse {
  group_matched: boolean;
  release_pinned: boolean;
  group: CaaImage[];
  release: CaaImage[];
  /** Per-section fetch failures (the other section still shows). */
  group_error: string | null;
  release_error: string | null;
}

interface GroupArtRelease {
  release_id: string;
  date: string | null;
  countries: string[];
  format: string | null;
  label: string | null;
  status: string | null;
  disambiguation: string | null;
  art_count: number;
  has_front: boolean;
}

/** The one covers menu: every cover the target owns in a grid — click to set,
 *  trash to delete (app-added only; library files are read-only by rule) —
 *  plus add-from-local and the remote source that fits the library (TMDB for
 *  video, Cover Art Archive for matched music). */
export function CoversDialog({
  open,
  onOpenChange,
  target,
  getCoverUrl,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: CoversTarget | null;
  getCoverUrl: (filePath: string) => string;
  onChanged: () => void;
}) {
  // Every cover mutation also announces itself app-wide: the music queue
  // snapshots cover paths at enqueue time, so the now-playing bar would keep
  // showing the OLD art on auto-advance until a rescan re-resolved the queue.
  const notifyChanged = () => {
    onChanged();
    window.dispatchEvent(new Event("waverunner:covers-changed"));
  };
  const [covers, setCovers] = useState<CoverInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  /** For a playlist link: its own pick, kept here across refetches (the
   *  fetch reports the TARGET's pick, which isn't the link's). */
  const linkSelectedRef = useRef<string | null>(null);
  /** Concrete release id once resolved (target may say "the default"). */
  const [releaseId, setReleaseId] = useState<number | null>(null);
  /** Album matched to a MusicBrainz release group (the CAA browser's
   *  precondition) — its launch button is disabled with a tooltip otherwise. */
  const [mbMatched, setMbMatched] = useState(false);
  const [mbReleaseMatched, setMbReleaseMatched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Remote pickers (each its own modal, TMDB-style). The CAA browser opens
  // at once; the TMDB one needs the entry's tmdb id first — that lookup is
  // the button's own work, so the button spins past 500ms.
  const [caaOpen, setCaaOpen] = useState(false);
  const [tmdb, setTmdb] = useState<{ tmdbId: string; mediaType: "movie" | "tv" } | null>(null);
  const [tmdbPending, setTmdbPending] = useState(false);
  const [tmdbSlow, setTmdbSlow] = useState(false);
  useEffect(() => {
    if (!tmdbPending) {
      setTmdbSlow(false);
      return;
    }
    const t = setTimeout(() => setTmdbSlow(true), 500);
    return () => clearTimeout(t);
  }, [tmdbPending]);

  const refetch = useCallback(async (): Promise<CoverInfo[]> => {
    if (!target) return [];
    try {
      if (target.kind === "release") {
        const r = await invoke<{
          release_id: number;
          covers: CoverInfo[];
          selected: string | null;
          mb_matched: boolean;
          mb_release_matched: boolean;
        }>("get_release_covers", { albumId: target.albumId, releaseId: target.releaseId });
        setCovers(r.covers);
        setSelected(target.link ? linkSelectedRef.current : r.selected);
        setReleaseId(r.release_id);
        setMbMatched(r.mb_matched);
        setMbReleaseMatched(r.mb_release_matched);
        return r.covers;
      } else {
        const r = await invoke<{ covers: CoverInfo[]; selected: string | null }>(
          "get_entry_covers",
          { libraryId: target.libraryId, entryId: target.entryId },
        );
        setCovers(r.covers);
        setSelected(target.link ? linkSelectedRef.current : r.selected);
        setReleaseId(null);
        return r.covers;
      }
    } catch (e) {
      toast.error(String(e));
      return [];
    }
  }, [target]);

  // The dialog opens at once with skeleton tiles; the grid swaps to the real
  // tiles only once they're fetched AND decoded, so the swap reveals
  // finished art rather than images popping in one by one. Local files
  // decode in a few ms.
  const [settling, setSettling] = useState(true);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const { stage, skeletonSeen, shown, contentVisible } = useHandoff(!settling, gridRef);

  // Remote downloads in flight: one square skeleton tile per picked image,
  // appended after the existing covers, each replaced by the real tile as
  // its file lands (and decodes). The remote browser closes the moment
  // Download is clicked — the wait happens here, in the grid, where the
  // result will appear. Slots persist until the dialog closes, so the grid
  // never re-flows under the user once a tile has landed.
  const [incoming, setIncoming] = useState<{ id: number; path: string | null }[]>([]);
  const incomingSeq = useRef(0);
  const startDownloads = (urls: string[]) => {
    if (!target || target.kind !== "release") return;
    const { libraryId, albumId } = target;
    const slots = urls.map(() => ({ id: ++incomingSeq.current, path: null as string | null }));
    setIncoming((s) => [...s, ...slots]);
    void (async () => {
      for (let i = 0; i < urls.length; i++) {
        const slot = slots[i];
        try {
          const name = urls[i].split("/").pop() || "caa-cover.jpg";
          const path = await invoke<string>("add_cover_from_url", {
            libraryId,
            entryId: albumId,
            url: urls[i],
            filename: `caa-${name}`,
            releaseId,
          });
          // Decode before the swap so the tile arrives painted, not popping
          // in a beat after the skeleton leaves.
          const img = new Image();
          img.src = getCoverUrl(path);
          await img.decode().catch(() => {});
          await refetch();
          setIncoming((s) => s.map((x) => (x.id === slot.id ? { ...x, path } : x)));
          // Each landed cover is a complete change on its own: the page
          // behind (and the bar) pick it up now, not when the batch ends —
          // the first download is often the one that becomes the cover.
          notifyChanged();
        } catch (e) {
          toast.error(String(e));
          setIncoming((s) => s.filter((x) => x.id !== slot.id));
        }
      }
    })();
  };
  useEffect(() => {
    if (!open) {
      // Same as the browser: reset once the shell's fade-out is over.
      const t = setTimeout(() => {
        setSettling(true);
        setCovers([]);
        setSelected(null);
        setCaaOpen(false);
        setConfirmDelete(null);
        setIncoming([]);
      }, CLOSE_RESET_MS);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    linkSelectedRef.current = target?.link?.selectedCover ?? null;
    (async () => {
      const list = await refetch();
      await Promise.allSettled(
        list.map((c) => {
          const img = new Image();
          img.src = getCoverUrl(c.path);
          return img.decode().catch(() => {});
        }),
      );
      if (!cancelled) setSettling(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, target, refetch, getCoverUrl]);

  if (!target) return null;
  const entryId = target.kind === "release" ? target.albumId : target.entryId;

  // What's ACTUALLY shown elsewhere: the explicit pick when valid, else the
  // first cover (the app-wide display fallback) — so the dialog never opens
  // with nothing marked while a cover is clearly in use.
  const effectiveSelected =
    (selected && covers.some((c) => c.path === selected) ? selected : null) ??
    covers[0]?.path ??
    null;

  // Download slots that have landed render their cover IN the slot's
  // position (not where the refetched list would sort it), so the grid
  // stays put; the main list skips those paths.
  const incomingPaths = new Set(incoming.flatMap((s) => (s.path ? [s.path] : [])));
  const coverByPath = new Map(covers.map((c) => [c.path, c] as const));

  const setCover = async (path: string) => {
    setBusy(true);
    try {
      if (target.link) {
        // The playlist's copy only — the target's own pick stays.
        await invoke("set_link_cover", { linkId: target.link.linkId, coverPath: path });
        linkSelectedRef.current = path;
      } else if (target.kind === "release") {
        await invoke("set_release_cover", { releaseId, cover: path });
      } else {
        await invoke("set_cover", {
          libraryId: target.libraryId,
          entryId: target.entryId,
          coverPath: path,
        });
      }
      setSelected(path);
      notifyChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteCover = async (path: string) => {
    setBusy(true);
    try {
      await invoke("delete_cover", {
        libraryId: target.libraryId,
        entryId,
        coverPath: path,
      });
      setConfirmDelete(null);
      await refetch();
      notifyChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addLocal = async () => {
    const picked = await openFileDialog({
      multiple: true,
      directory: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
    });
    // The plugin returns a string for single picks and an array for multi.
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (paths.length === 0) return;
    setBusy(true);
    try {
      // Imported one by one in the order they were picked; a bad file skips
      // itself (toast) without dropping the rest of the selection.
      let first: string | null = null;
      let failed = 0;
      for (const sourcePath of paths) {
        try {
          const added = await invoke<string>("add_cover", {
            libraryId: target.libraryId,
            entryId,
            sourcePath,
            releaseId: target.kind === "release" ? releaseId : null,
          });
          first ??= added;
        } catch (e) {
          failed++;
          toast.error(String(e));
        }
      }
      await refetch();
      // An added cover is almost always meant to be used — the first one
      // picked becomes the cover; the rest are ready in the row.
      if (first) await setCover(first);
      if (paths.length > 1 && failed === 0) toast.success(`Added ${paths.length} covers`);
    } finally {
      setBusy(false);
    }
  };

  const openTmdb = async () => {
    if (target.kind !== "entry") return;
    const mediaType = target.entryType === "show" ? ("tv" as const) : ("movie" as const);
    setTmdbPending(true);
    try {
      const detail =
        target.entryType === "show"
          ? await invoke<{ tmdb_id: string | null }>("get_show_detail", { showId: target.entryId })
          : await invoke<{ tmdb_id: string | null }>("get_movie_detail", { entryId: target.entryId });
      if (!detail.tmdb_id) {
        toast.error("Match to TMDB first");
        return;
      }
      setTmdb({ tmdbId: detail.tmdb_id, mediaType });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setTmdbPending(false);
    }
  };

  const videoRemote =
    target.kind === "entry" && (target.entryType === "movie" || target.entryType === "show");
  // Video covers are posters (2:3): taller tiles, taller frame, taller
  // skeletons — album art is square.
  const poster = target.kind === "entry";

  /** One grid tile. `extraClass` lets a landed download slot fade in. */
  const renderTile = (c: CoverInfo, extraClass = "") => {
    const isSelected = c.path === effectiveSelected;
    return (
      <div key={c.path} className={`group relative ${extraClass}`}>
        {/* Natural aspect — posters, squares, and odd scans all
            display WHOLE; rows align to the tallest tile. */}
        {/* Same hover treatment as grid-page cover cards. */}
        <button
          disabled={busy}
          onClick={() => setCover(c.path)}
          title={isSelected ? "Current cover" : "Use this cover"}
          className={`block w-full overflow-hidden rounded-[3px] bg-muted shadow-md transition-[translate,scale] duration-200 group-hover:-translate-y-1 group-hover:scale-[1.04] group-hover:shadow-xl ${
            isSelected
              ? "ring-2 ring-primary"
              : "ring-1 ring-foreground/10 group-hover:ring-foreground/25"
          }`}
        >
          {/* Not lazy: the reveal waits on these decoding, and a
              lazy image below the fold would never report. */}
          <img
            src={getCoverUrl(c.path)}
            alt=""
            draggable={false}
            className="h-auto w-full"
          />
        </button>
        {/* Resolution under the tile, like the MusicBrainz browser's. */}
        <p className="mt-1 text-center text-[11px] text-muted-foreground">
          <LocalImageSize src={getCoverUrl(c.path)} />
        </p>
        {/* Badges sit OUTSIDE the transformed button (the trash
            must stay clickable, and buttons can't nest), so they
            mimic the tile's hover lift/growth themselves. */}
        {isSelected && (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-primary p-1 text-primary-foreground shadow transition-all duration-200 group-hover:-translate-y-1.5 group-hover:scale-110">
            <Check size={11} />
          </span>
        )}
        {c.origin !== "app" ? (
          <span
            className="absolute right-1.5 top-1.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md opacity-0 transition-all duration-200 group-hover:-translate-y-1.5 group-hover:scale-110 group-hover:opacity-100"
            title={
              c.origin === "fetched"
                ? "Auto-fetched image — replaced by re-fetching, never deleted here"
                : "A file in your library folder — waverunner doesn't modify library folders"
            }
          >
            <Lock size={11} />
          </span>
        ) : confirmDelete === c.path ? (
          // Same lift/growth as the icons, anchored top-right so
          // the pair rides up and out with the tile.
          <span className="absolute right-1.5 top-1.5 flex origin-top-right gap-1 transition-all duration-200 group-hover:-translate-y-1.5 group-hover:scale-110">
            <Button
              size="sm"
              className="h-6 rounded-md bg-destructive px-2 text-[11px] font-semibold text-white shadow-md hover:bg-destructive/90"
              disabled={busy}
              onClick={() => deleteCover(c.path)}
            >
              Delete
            </Button>
            <Button
              size="sm"
              className="h-6 rounded-md border-border bg-popover px-2 text-[11px] font-semibold text-popover-foreground shadow-md hover:bg-muted"
              onClick={() => setConfirmDelete(null)}
            >
              Keep
            </Button>
          </span>
        ) : (
          <button
            title="Delete this cover"
            onClick={() => setConfirmDelete(c.path)}
            className="absolute right-1.5 top-1.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md opacity-0 transition-all duration-200 hover:bg-muted group-hover:-translate-y-1.5 group-hover:scale-110 group-hover:opacity-100"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" height={poster ? VIDEO_COVERS_HEIGHT : COVERS_HEIGHT}>
        <DialogHeader>
          <DialogTitle className="truncate">Covers — {target.title}</DialogTitle>
          {target.link && (
            <DialogDescription>
              The pick here is this playlist entry's own — the library's cover stays as it is.
            </DialogDescription>
          )}
        </DialogHeader>
        {/* FIXED size: the dialog's height gives the body exactly two rows
            of tiles (the cover count can't be known before the fetch, so
            the box never sizes to it) — more scroll, fewer leave space. The
            skeleton fills the same box, so the swap to real tiles moves
            nothing. scrollbar-gutter reserves the bar's lane up front —
            hover-scale can momentarily extend the scrollable area, and
            without the gutter the appearing scrollbar reflowed the grid. */}
        <DialogBody
          // No scrollbar until the tiles are shown — a three-row grid
          // painting invisibly must not summon one early.
          className={`relative isolate px-1.5 pb-1.5 pt-4 [scrollbar-gutter:stable] ${
            shown ? "" : "overflow-hidden"
          }`}
        >
          {settling ? null : covers.length === 0 && incoming.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No covers yet — add one below.
            </p>
          ) : (
            <div
              ref={gridRef}
              className={`${COVER_GRID} transition-opacity duration-200 will-change-[opacity] ${
                contentVisible ? "opacity-100" : "opacity-0"
              }`}
            >
              {/* Existing covers first, then the download slots in the order
                  they were picked: a landed slot renders its cover's tile
                  (fading in over the skeleton's spot), a pending one the
                  square skeleton. */}
              {covers.filter((c) => !incomingPaths.has(c.path)).map((c) => renderTile(c))}
              {incoming.map((slot) => {
                const c = slot.path ? coverByPath.get(slot.path) : undefined;
                return c ? (
                  renderTile(c, "animate-in fade-in duration-300")
                ) : (
                  <Skeleton key={`incoming-${slot.id}`} className="aspect-square w-full rounded-[3px]" />
                );
              })}
            </div>
          )}
          {/* The skeleton overlays the (invisible) grid from the moment it
              appeared until the grid is shown — it stays MOUNTED through its
              own fade-out, since an unmount/remount would skip it. */}
          {!shown && skeletonSeen && (
            <SkeletonTiles
              aspect={poster ? "poster" : "square"}
              caption
              className={`absolute inset-x-1.5 top-4 z-10 transition-opacity duration-200 ${
                stage === "hidden" ? "" : "opacity-0"
              }`}
            />
          )}
        </DialogBody>
        <DialogFooter className="flex-wrap gap-2 sm:justify-start">
          {/* All three wait for the covers to be shown — adding to a grid
              that hasn't landed yet would race the initial fetch. */}
          <Button variant="outline" size="sm" onClick={addLocal} disabled={busy || !shown}>
            <FolderOpen size={14} />
            Add local…
          </Button>
          {target.kind === "release" &&
            (mbMatched ? (
              <Button variant="outline" size="sm" onClick={() => setCaaOpen(true)} disabled={busy || caaOpen || !shown}>
                <Globe size={14} />
                Add from MusicBrainz…
              </Button>
            ) : (
              // Disabled buttons don't fire hover — the tooltip hangs off a
              // wrapping span. (Before the fetch lands, mbMatched is false
              // and the button reads disabled; harmless for the moment.)
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex" />}>
                    <Button variant="outline" size="sm" disabled>
                      <Globe size={14} />
                      Add from MusicBrainz…
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Match this album to a MusicBrainz release group first to browse its cover art.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          {videoRemote && (
            <Button variant="outline" size="sm" onClick={openTmdb} disabled={busy || tmdbPending || !shown}>
              <Globe size={14} />
              Add from TMDB…
              {tmdbSlow && <Spinner className="size-3.5" />}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Both child browsers stay MOUNTED while closed: the shell fades a
          closing dialog's content out on the way back to this one, and an
          unmounted child would leave it fading an empty frame. */}
      {target.kind === "release" && (
        <CaaImageBrowserDialog
          open={caaOpen}
          onOpenChange={setCaaOpen}
          albumId={target.albumId}
          releaseId={releaseId}
          releaseMatched={mbReleaseMatched}
          title={target.title}
          onDownload={startDownloads}
        />
      )}

      {target.kind === "entry" && (
        <TmdbImageBrowserDialog
          open={!!tmdb}
          onOpenChange={(o) => {
            if (!o) setTmdb(null);
          }}
          libraryId={target.libraryId}
          entryId={target.entryId}
          tmdbId={tmdb?.tmdbId ?? ""}
          mediaType={tmdb?.mediaType ?? "movie"}
          kind="posters"
          onDownloaded={() => {
            refetch();
            notifyChanged();
          }}
        />
      )}
    </Dialog>
  );
}

