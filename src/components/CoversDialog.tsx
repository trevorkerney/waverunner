import { useCallback, useEffect, useState } from "react";
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

  const tileGrid = (images: CaaImage[]) => (
    <div
      className="grid items-start gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
    >
      {images.map((img) => {
        const isPicked = picked.has(img.url);
        return (
          <div key={img.url}>
            <button
              disabled={progress != null}
              onClick={() => toggle(img.url)}
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
            {img.types.length > 0 && (
              <p className="mt-1 truncate text-center text-[11px] text-muted-foreground">
                {img.types.join(", ")}
              </p>
            )}
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
                                <p className="truncate text-xs text-muted-foreground">
                                  {[
                                    r.label,
                                    r.disambiguation,
                                    r.status && r.status !== "Official" ? r.status : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
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
                              <div className="mt-2">{tileGrid(expanded)}</div>
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
      onChanged();
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
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addLocal = async () => {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
    });
    if (!picked || typeof picked !== "string") return;
    setBusy(true);
    try {
      const added = await invoke<string>("add_cover", {
        libraryId: target.libraryId,
        entryId,
        sourcePath: picked,
        releaseId: target.kind === "release" ? releaseId : null,
      });
      await refetch();
      // An added cover is almost always meant to be used — set it directly.
      await setCover(added);
    } catch (e) {
      toast.error(String(e));
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
                        className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white/80 opacity-0 transition-all duration-200 group-hover:-translate-y-1.5 group-hover:scale-110 group-hover:opacity-100"
                        title={
                          c.origin === "fetched"
                            ? "Auto-fetched image — replaced by re-fetching, never deleted here"
                            : "A file in your library folder — waverunner doesn't modify library folders"
                        }
                      >
                        <Lock size={11} />
                      </span>
                    ) : confirmDelete === c.path ? (
                      <span className="absolute inset-x-1.5 top-1.5 flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-6 px-2 text-[11px]"
                          disabled={busy}
                          onClick={() => deleteCover(c.path)}
                        >
                          Delete
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Keep
                        </Button>
                      </span>
                    ) : (
                      <button
                        title="Delete this cover"
                        onClick={() => setConfirmDelete(c.path)}
                        className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white opacity-0 transition-all duration-200 hover:bg-black/80 group-hover:-translate-y-1.5 group-hover:scale-110 group-hover:opacity-100"
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
            onChanged();
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
            onChanged();
          }}
        />
      )}
    </Dialog>
  );
}
