import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useHandoff } from "@/components/ui/skeleton";
import { Check, FolderOpen, Globe, Lock, Trash2 } from "lucide-react";
import { CLOSE_RESET_MS, SkeletonTiles } from "./CoversDialog";
import { TmdbImageBrowserDialog } from "./TmdbImageBrowserDialog";

/** Three columns (a 2xl dialog's width): backdrops are wide, so fewer,
 *  bigger tiles than Covers' five — ~230 × 129 each. */
const BACKDROP_GRID = "grid grid-cols-3 items-start gap-3";
/** Two rows of those: 16 + 20 + 16 + (258 + 12 gap + 22 padding + 8 slack)
 *  + 16 + 60 = 428px. */
const BACKDROPS_HEIGHT = "27rem";

interface BackdropInfo {
  path: string;
  origin: string; // 'library' | 'app' | 'fetched'
}

interface BackdropSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string;
  entryId: number;
  /** Which TMDB endpoint the entry's id belongs to. */
  entryType: "movie" | "show";
  title: string;
  getCoverUrl: (filePath: string) => string;
  /** Fired after any change so the page can reload its hero. */
  onChanged: () => void;
}

/** The backdrops menu — the Covers dialog for a video entry's backdrops:
 *  every backdrop in a grid, click to set, trash to delete (app-added
 *  only), plus add-from-local and add-from-TMDB. */
export function BackdropSelectDialog({
  open,
  onOpenChange,
  libraryId,
  entryId,
  entryType,
  title,
  getCoverUrl,
  onChanged,
}: BackdropSelectDialogProps) {
  const [backdrops, setBackdrops] = useState<BackdropInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // The TMDB picker needs the entry's tmdb id first — that lookup is the
  // button's own work, so the button spins past 500ms.
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

  const refetch = useCallback(async (): Promise<BackdropInfo[]> => {
    try {
      const r = await invoke<{ covers: BackdropInfo[]; selected: string | null }>(
        "get_entry_backdrops",
        { libraryId, entryId },
      );
      setBackdrops(r.covers);
      setSelected(r.selected);
      return r.covers;
    } catch (e) {
      toast.error(String(e));
      return [];
    }
  }, [libraryId, entryId]);

  // Same hand-off as Covers: skeleton tiles at once, the real grid only
  // once fetched AND decoded, then skeleton out / grid in.
  const [settling, setSettling] = useState(true);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const { stage, skeletonSeen, shown, contentVisible } = useHandoff(!settling, gridRef);
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setSettling(true);
        setBackdrops([]);
        setSelected(null);
        setConfirmDelete(null);
      }, CLOSE_RESET_MS);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    (async () => {
      const list = await refetch();
      await Promise.allSettled(
        list.map((b) => {
          const img = new Image();
          img.src = getCoverUrl(b.path);
          return img.decode().catch(() => {});
        }),
      );
      if (!cancelled) setSettling(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refetch, getCoverUrl]);

  // What the hero ACTUALLY shows: the explicit pick when valid, else the
  // first backdrop (the app-wide display fallback).
  const effectiveSelected =
    (selected && backdrops.some((b) => b.path === selected) ? selected : null) ??
    backdrops[0]?.path ??
    null;

  const setBackdrop = async (path: string) => {
    setBusy(true);
    try {
      await invoke("set_selected_backdrop", { entryId, path });
      setSelected(path);
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteBackdrop = async (path: string) => {
    setBusy(true);
    try {
      await invoke("delete_backdrop", { libraryId, entryId, backdropPath: path });
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
      multiple: true,
      directory: false,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
    });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (paths.length === 0) return;
    setBusy(true);
    try {
      let first: string | null = null;
      let failed = 0;
      for (const sourcePath of paths) {
        try {
          const added = await invoke<string>("add_backdrop", { libraryId, entryId, sourcePath });
          first ??= added;
        } catch (e) {
          failed++;
          toast.error(String(e));
        }
      }
      await refetch();
      // An added backdrop is almost always meant to be used.
      if (first) await setBackdrop(first);
      if (paths.length > 1 && failed === 0) toast.success(`Added ${paths.length} backdrops`);
    } finally {
      setBusy(false);
    }
  };

  const openTmdb = async () => {
    const mediaType = entryType === "show" ? ("tv" as const) : ("movie" as const);
    setTmdbPending(true);
    try {
      const detail =
        entryType === "show"
          ? await invoke<{ tmdb_id: string | null }>("get_show_detail", { showId: entryId })
          : await invoke<{ tmdb_id: string | null }>("get_movie_detail", { entryId });
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" height={BACKDROPS_HEIGHT}>
        <DialogHeader>
          <DialogTitle className="truncate">Backdrops — {title}</DialogTitle>
        </DialogHeader>
        <DialogBody
          className={`relative isolate px-1.5 pb-1.5 pt-4 [scrollbar-gutter:stable] ${
            shown ? "" : "overflow-hidden"
          }`}
        >
          {settling ? null : backdrops.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No backdrops yet — add one below.
            </p>
          ) : (
            <div
              ref={gridRef}
              className={`${BACKDROP_GRID} transition-opacity duration-200 will-change-[opacity] ${
                contentVisible ? "opacity-100" : "opacity-0"
              }`}
            >
              {backdrops.map((b) => {
                const isSelected = b.path === effectiveSelected;
                return (
                  <div key={b.path} className="group relative">
                    <button
                      disabled={busy}
                      onClick={() => setBackdrop(b.path)}
                      title={isSelected ? "Current backdrop" : "Use this backdrop"}
                      className={`block w-full overflow-hidden rounded-[3px] bg-muted shadow-md transition-[translate,scale] duration-200 group-hover:-translate-y-1 group-hover:scale-[1.04] group-hover:shadow-xl ${
                        isSelected
                          ? "ring-2 ring-primary"
                          : "ring-1 ring-foreground/10 group-hover:ring-foreground/25"
                      }`}
                    >
                      {/* Not lazy: the reveal waits on these decoding. */}
                      <img src={getCoverUrl(b.path)} alt="" draggable={false} className="h-auto w-full" />
                    </button>
                    {isSelected && (
                      <span className="absolute left-1.5 top-1.5 rounded-full bg-primary p-1 text-primary-foreground shadow transition-all duration-200 group-hover:-translate-y-1.5 group-hover:scale-110">
                        <Check size={11} />
                      </span>
                    )}
                    {b.origin !== "app" ? (
                      <span
                        className="absolute right-1.5 top-1.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md opacity-0 transition-all duration-200 group-hover:-translate-y-1.5 group-hover:scale-110 group-hover:opacity-100"
                        title={
                          b.origin === "fetched"
                            ? "Auto-fetched image — replaced by re-fetching, never deleted here"
                            : "A file in your library folder — waverunner doesn't modify library folders"
                        }
                      >
                        <Lock size={11} />
                      </span>
                    ) : confirmDelete === b.path ? (
                      <span className="absolute right-1.5 top-1.5 flex origin-top-right gap-1 transition-all duration-200 group-hover:-translate-y-1.5 group-hover:scale-110">
                        <Button
                          size="sm"
                          className="h-6 rounded-md bg-destructive px-2 text-[11px] font-semibold text-white shadow-md hover:bg-destructive/90"
                          disabled={busy}
                          onClick={() => deleteBackdrop(b.path)}
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
                        title="Delete this backdrop"
                        onClick={() => setConfirmDelete(b.path)}
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
          {!shown && skeletonSeen && (
            <SkeletonTiles
              aspect="wide"
              grid={BACKDROP_GRID}
              count={6}
              className={`absolute inset-x-1.5 top-4 z-10 transition-opacity duration-200 ${
                stage === "hidden" ? "" : "opacity-0"
              }`}
            />
          )}
        </DialogBody>
        <DialogFooter className="flex-wrap gap-2 sm:justify-start">
          <Button variant="outline" size="sm" onClick={addLocal} disabled={busy || !shown}>
            <FolderOpen size={14} />
            Add local…
          </Button>
          <Button variant="outline" size="sm" onClick={openTmdb} disabled={busy || tmdbPending || !shown}>
            <Globe size={14} />
            Add from TMDB…
            {tmdbSlow && <Spinner className="size-3.5" />}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Stays MOUNTED while closed: the shell fades a closing child's
          content out on the way back here. */}
      <TmdbImageBrowserDialog
        open={!!tmdb}
        onOpenChange={(o) => {
          if (!o) setTmdb(null);
        }}
        libraryId={libraryId}
        entryId={entryId}
        tmdbId={tmdb?.tmdbId ?? ""}
        mediaType={tmdb?.mediaType ?? "movie"}
        kind="backdrops"
        onDownloaded={() => {
          refetch();
          onChanged();
        }}
      />
    </Dialog>
  );
}
