import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Check, Download, FolderOpen, Globe, Image as ImageIcon, Lock, Trash2 } from "lucide-react";
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
  return (
    <span ref={ref}>
      {dims ? `${prefix}${dims[0]} × ${dims[1]}` : null}
    </span>
  );
}

/** The "Covers…" context-menu entry, everywhere one exists. The menu stays
 *  OPEN while the dialog preps (it waits for covers to fetch + decode so it
 *  can appear at final size); past 500ms the icon becomes a spinner. When the
 *  dialog signals ready, the menu is dismissed. */
export function CoversMenuItem({ onOpen }: { onOpen: () => void }) {
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const slowTimer = setTimeout(() => setSlow(true), 500);
    const done = () => {
      setPending(false);
      setSlow(false);
      // Close the still-open menu the moment the dialog takes over. The
      // dialog mounts on the NEXT render, so this can't reach it.
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    };
    window.addEventListener("waverunner:covers-dialog-ready", done);
    return () => {
      clearTimeout(slowTimer);
      window.removeEventListener("waverunner:covers-dialog-ready", done);
    };
  }, [pending]);
  return (
    <ContextMenuItem
      closeOnClick={false}
      onClick={() => {
        if (pending) return;
        setPending(true);
        onOpen();
      }}
    >
      <ImageIcon size={14} />
      Covers…
      {slow && <Spinner className="ml-auto size-3.5" />}
    </ContextMenuItem>
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
  libraryId,
  albumId,
  releaseId,
  title,
  onDownloaded,
  onReady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string;
  albumId: number;
  releaseId: number | null;
  title: string;
  onDownloaded: () => void;
  /** Fires when the modal is actually about to show (data + thumbs ready) —
   *  the launching button shows its spinner until then. */
  onReady: () => void;
}) {
  const [data, setData] = useState<CaaBrowse | null>(null);
  const [ready, setReady] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
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

  // Same no-resize rule as the covers dialog: stay unmounted until the CAA
  // listing AND its thumbnails are fully loaded, then appear at final size.
  useEffect(() => {
    if (!open) {
      setData(null);
      setReady(false);
      setPicked(new Set());
      setProgress(null);
      setOthers(null);
      setScans(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await invoke<CaaBrowse>("caa_release_images", { albumId, releaseId });
        if (cancelled) return;
        setData(d);
        await Promise.allSettled(
          [...d.group, ...d.release].map((i) => {
            const img = new Image();
            img.src = i.thumb;
            return img.decode().catch(() => {});
          }),
        );
        if (!cancelled) {
          setReady(true);
          onReady();
        }
      } catch (e) {
        toast.error(String(e));
        if (!cancelled) onOpenChange(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, albumId, releaseId]);

  const toggle = (url: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const download = async () => {
    const urls = [...picked];
    setProgress({ done: 0, total: urls.length });
    try {
      for (let i = 0; i < urls.length; i++) {
        const name = urls[i].split("/").pop() || "caa-cover.jpg";
        await invoke("add_cover_from_url", {
          libraryId,
          entryId: albumId,
          url: urls[i],
          filename: `caa-${name}`,
          releaseId,
        });
        setProgress({ done: i + 1, total: urls.length });
      }
      onDownloaded();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
      setProgress(null);
    }
  };

  // `frontKey`: a release row's own thumb is the same file as the "Front"
  // tile in its expanded scan set (the /front URL redirects to that image),
  // so both select under ONE key — picking either lights both, and the
  // download fetches it once.
  const tileGrid = (images: CaaImage[], frontKey?: string) => (
    <div
      className="grid items-start gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
    >
      {images.map((img) => {
        const key = img.front && frontKey ? frontKey : img.url;
        const isPicked = picked.has(key);
        return (
          <div key={img.url}>
            <button
              disabled={progress != null}
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
              <img src={img.thumb} alt="" loading="lazy" draggable={false} className="h-auto w-full" />
              {isPicked && (
                <span className="absolute left-1.5 top-1.5 rounded-full bg-primary p-1 text-primary-foreground shadow">
                  <Check size={11} />
                </span>
              )}
            </button>
            <p className="mt-1 truncate text-center text-[11px] text-muted-foreground">
              {img.types.join(", ")}
              <ImageSize url={img.url} prefix={img.types.length > 0 ? " · " : ""} />
            </p>
          </div>
        );
      })}
    </div>
  );

  const empty = data && data.group.length === 0 && data.release.length === 0;

  return (
    <Dialog open={open && ready} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(760px,calc(100vw-3rem))]">
        <DialogHeader>
          <DialogTitle className="truncate">MusicBrainz cover art — {title}</DialogTitle>
        </DialogHeader>
        {data && (
          <p className="-mt-2 text-xs text-muted-foreground">
            {data.release_pinned
              ? "Release group matched · this release is matched to its MusicBrainz release"
              : "Release group matched · this release isn't matched to a MusicBrainz release yet — only the release group cover is available"}
          </p>
        )}
        <div className="max-h-[60vh] overflow-y-auto px-1.5 pb-1.5 pt-3 [scrollbar-gutter:stable]">
          {!data ? null : empty ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No cover art on MusicBrainz for this release.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {data.group.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Release group cover
                  </p>
                  {tileGrid(data.group)}
                </div>
              )}
              {data.release.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    This release
                  </p>
                  {tileGrid(data.release)}
                </div>
              )}
              {data.release_pinned && data.release.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No scans for this release on Cover Art Archive.
                </p>
              )}
            </div>
          )}

          {/* Other pressings in the group — explicit opt-in, lazy row thumbs. */}
          {data && (
            <div className="mt-4 border-t pt-3">
              {others === null ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadOthers}
                  disabled={othersLoading || progress != null}
                >
                  <Globe size={14} />
                  {data.release_pinned ? "Other releases…" : "Browse this group's releases…"}
                  {othersSlow && <Spinner className="size-3.5" />}
                </Button>
              ) : (
                <div>
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
                                  disabled={progress != null}
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
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={progress != null}>
            Cancel
          </Button>
          <Button onClick={download} disabled={picked.size === 0 || progress != null}>
            {progress != null ? (
              <>
                <Spinner className="size-3.5" />
                Downloading {progress.done}/{progress.total}…
              </>
            ) : (
              <>
                <Download size={14} />
                Download {picked.size > 0 ? picked.size : ""}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
    }
  | {
      kind: "release";
      libraryId: string;
      albumId: number;
      releaseId: number | null;
      title: string;
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
  /** Concrete release id once resolved (target may say "the default"). */
  const [releaseId, setReleaseId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Remote pickers (each its own modal, TMDB-style). Both launch buttons show
  // a right-side spinner past 500ms while their modal preps.
  const [caaOpen, setCaaOpen] = useState(false);
  const [caaReady, setCaaReady] = useState(false);
  const [caaSlow, setCaaSlow] = useState(false);
  useEffect(() => {
    if (!(caaOpen && !caaReady)) {
      setCaaSlow(false);
      return;
    }
    const t = setTimeout(() => setCaaSlow(true), 500);
    return () => clearTimeout(t);
  }, [caaOpen, caaReady]);
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
    setLoading(true);
    try {
      if (target.kind === "release") {
        const r = await invoke<{ release_id: number; covers: CoverInfo[]; selected: string | null }>(
          "get_release_covers",
          { albumId: target.albumId, releaseId: target.releaseId },
        );
        setCovers(r.covers);
        setSelected(r.selected);
        setReleaseId(r.release_id);
        return r.covers;
      } else {
        const r = await invoke<{ covers: CoverInfo[]; selected: string | null }>(
          "get_entry_covers",
          { libraryId: target.libraryId, entryId: target.entryId },
        );
        setCovers(r.covers);
        setSelected(r.selected);
        setReleaseId(null);
        return r.covers;
      }
    } catch (e) {
      toast.error(String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, [target]);

  // The dialog stays INVISIBLE until the covers are fetched AND decoded, so
  // it appears at its final size in one shot — no reserved-height guessing,
  // no resize as images pop in. Local files decode in a few ms; a cap keeps
  // one slow/broken image from holding the dialog hostage.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!open) {
      setReady(false);
      setCovers([]);
      setSelected(null);
      setCaaOpen(false);
      setConfirmDelete(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const list = await refetch();
      await Promise.allSettled(
        list.map((c) => {
          const img = new Image();
          img.src = getCoverUrl(c.path);
          return img.decode().catch(() => {});
        }),
      );
      if (!cancelled) {
        // Tell the launching CoversMenuItem to stand down (it holds its
        // context menu open, with a spinner past 500ms, until this moment).
        window.dispatchEvent(new Event("waverunner:covers-dialog-ready"));
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refetch, getCoverUrl]);

  if (!target) return null;
  const entryId = target.kind === "release" ? target.albumId : target.entryId;

  // What's ACTUALLY shown elsewhere: the explicit pick when valid, else the
  // first cover (the app-wide display fallback) — so the dialog never opens
  // with nothing marked while a cover is clearly in use.
  const effectiveSelected =
    (selected && covers.some((c) => c.path === selected) ? selected : null) ??
    covers[0]?.path ??
    null;

  const setCover = async (path: string) => {
    setBusy(true);
    try {
      if (target.kind === "release") {
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

  return (
    <Dialog open={open && ready} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(760px,calc(100vw-3rem))]">
        <DialogHeader>
          <DialogTitle className="truncate">Covers — {target.title}</DialogTitle>
        </DialogHeader>
        {/* scrollbar-gutter reserves the bar's lane up front — hover-scale can
            momentarily extend the scrollable area, and without the gutter the
            appearing scrollbar reflowed the whole grid. */}
        <div className="max-h-[60vh] overflow-y-auto px-1.5 pb-1.5 pt-4 [scrollbar-gutter:stable]">
          {/* Pre-open loading never renders (the dialog waits for it); this
              spinner only covers a post-mutation refetch that emptied out. */}
          {loading && covers.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-muted-foreground">
              <Spinner className="size-5" />
            </div>
          ) : covers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No covers yet — add one below.
            </p>
          ) : (
            <div
              className="grid items-start gap-3"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
            >
              {covers.map((c) => {
                const isSelected = c.path === effectiveSelected;
                return (
                  <div key={c.path} className="group relative">
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
                      <img
                        src={getCoverUrl(c.path)}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        className="h-auto w-full"
                      />
                    </button>
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
              })}
            </div>
          )}

        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-start">
          <Button variant="outline" size="sm" onClick={addLocal} disabled={busy}>
            <FolderOpen size={14} />
            Add local…
          </Button>
          {target.kind === "release" && (
            <Button variant="outline" size="sm" onClick={() => setCaaOpen(true)} disabled={busy || caaOpen}>
              <Globe size={14} />
              Add from MusicBrainz…
              {caaSlow && <Spinner className="size-3.5" />}
            </Button>
          )}
          {videoRemote && (
            <Button variant="outline" size="sm" onClick={openTmdb} disabled={busy || tmdbPending}>
              <Globe size={14} />
              Add from TMDB…
              {tmdbSlow && <Spinner className="size-3.5" />}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {target.kind === "release" && caaOpen && (
        <CaaImageBrowserDialog
          open={caaOpen}
          onOpenChange={(o) => {
            setCaaOpen(o);
            if (!o) setCaaReady(false);
          }}
          onReady={() => setCaaReady(true)}
          libraryId={target.libraryId}
          albumId={target.albumId}
          releaseId={releaseId}
          title={target.title}
          onDownloaded={() => {
            refetch();
            notifyChanged();
          }}
        />
      )}

      {tmdb && target.kind === "entry" && (
        <TmdbImageBrowserDialog
          open={!!tmdb}
          onOpenChange={(o) => {
            if (!o) setTmdb(null);
          }}
          libraryId={target.libraryId}
          entryId={target.entryId}
          tmdbId={tmdb.tmdbId}
          mediaType={tmdb.mediaType}
          initialTab="posters"
          onDownloaded={() => {
            refetch();
            notifyChanged();
          }}
        />
      )}
    </Dialog>
  );
}
