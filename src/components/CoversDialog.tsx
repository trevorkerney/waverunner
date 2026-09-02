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
import { Check, FolderOpen, Globe, Image as ImageIcon, Lock, Trash2 } from "lucide-react";
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
  comment: string;
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
  // Remote pickers
  const [caa, setCaa] = useState<CaaImage[] | null>(null);
  const [caaLoading, setCaaLoading] = useState(false);
  const [tmdb, setTmdb] = useState<{ tmdbId: string; mediaType: "movie" | "tv" } | null>(null);

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
      setCaa(null);
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

  const loadCaa = async () => {
    if (target.kind !== "release") return;
    setCaaLoading(true);
    try {
      const imgs = await invoke<CaaImage[]>("caa_release_images", {
        albumId: target.albumId,
        releaseId,
      });
      setCaa(imgs);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCaaLoading(false);
    }
  };

  const addFromCaa = async (img: CaaImage) => {
    setBusy(true);
    try {
      const name = img.url.split("/").pop() || "caa-cover.jpg";
      const added = await invoke<string>("add_cover_from_url", {
        libraryId: target.libraryId,
        entryId,
        url: img.url,
        filename: `caa-${name}`,
        releaseId,
      });
      await refetch();
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

          {/* Cover Art Archive picks (music, once requested). */}
          {caa != null && (
            <div className="mt-4 border-t pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Cover Art Archive
              </p>
              {caa.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No cover art on MusicBrainz for this release.
                </p>
              ) : (
                <div
                  className="grid items-start gap-3"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
                >
                  {caa.map((img) => (
                    <button
                      key={img.url}
                      disabled={busy}
                      onClick={() => addFromCaa(img)}
                      title={[img.front ? "Front" : null, img.comment || null]
                        .filter(Boolean)
                        .join(" · ") || "Add this image"}
                      className="block w-full overflow-hidden rounded-[3px] bg-muted shadow-md ring-1 ring-foreground/10 transition-[translate,scale] duration-200 hover:-translate-y-1 hover:scale-[1.04] hover:shadow-xl hover:ring-foreground/25"
                    >
                      <img
                        src={img.thumb}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        className="h-auto w-full"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-start">
          <Button variant="outline" size="sm" onClick={addLocal} disabled={busy}>
            <FolderOpen size={14} />
            Add local…
          </Button>
          {target.kind === "release" && (
            <Button variant="outline" size="sm" onClick={loadCaa} disabled={busy || caaLoading}>
              {caaLoading ? <Spinner className="size-3.5" /> : <Globe size={14} />}
              Add from MusicBrainz…
            </Button>
          )}
          {videoRemote && (
            <Button variant="outline" size="sm" onClick={openTmdb} disabled={busy}>
              <Globe size={14} />
              Add from TMDB…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

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
