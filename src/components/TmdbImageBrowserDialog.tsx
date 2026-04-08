import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Download } from "lucide-react";
import type { TmdbImage, TmdbMovieDetail, TmdbImageDownload } from "@/types";

const POSTER_SIZES = ["w342", "w500", "w780", "original"];
const BACKDROP_SIZES = ["w780", "w1280", "original"];

interface TmdbImageBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string;
  entryId: number;
  tmdbId: string;
  onDownloaded: () => void;
}

interface ImageSelection {
  checked: boolean;
  size: string;
}

type Tab = "posters" | "backdrops";

export function TmdbImageBrowserDialog({
  open,
  onOpenChange,
  libraryId,
  entryId,
  tmdbId,
  onDownloaded,
}: TmdbImageBrowserDialogProps) {
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [posters, setPosters] = useState<TmdbImage[]>([]);
  const [backdrops, setBackdrops] = useState<TmdbImage[]>([]);
  const [posterSelections, setPosterSelections] = useState<Record<number, ImageSelection>>({});
  const [backdropSelections, setBackdropSelections] = useState<Record<number, ImageSelection>>({});
  const [tab, setTab] = useState<Tab>("posters");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setTab("posters");
    setPosterSelections({});
    setBackdropSelections({});

    invoke<TmdbMovieDetail>("get_tmdb_movie_detail", {
      tmdbId: Number(tmdbId),
    })
      .then((detail) => {
        const p = detail.images?.posters ?? [];
        const b = detail.images?.backdrops ?? [];
        setPosters(p);
        setBackdrops(b);

        // Init selections — unchecked, default sizes
        const ps: Record<number, ImageSelection> = {};
        p.forEach((_, i) => {
          ps[i] = { checked: false, size: "w780" };
        });
        setPosterSelections(ps);

        const bs: Record<number, ImageSelection> = {};
        b.forEach((_, i) => {
          bs[i] = { checked: false, size: "w1280" };
        });
        setBackdropSelections(bs);
      })
      .catch((e) => toast.error(String(e)))
      .finally(() => setLoading(false));
  }, [open, tmdbId]);

  const togglePoster = (idx: number, checked: boolean) => {
    setPosterSelections((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], checked },
    }));
  };

  const setPosterSize = (idx: number, size: string) => {
    setPosterSelections((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], size },
    }));
  };

  const toggleBackdrop = (idx: number, checked: boolean) => {
    setBackdropSelections((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], checked },
    }));
  };

  const setBackdropSize = (idx: number, size: string) => {
    setBackdropSelections((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], size },
    }));
  };

  const selectedCount =
    Object.values(posterSelections).filter((s) => s.checked).length +
    Object.values(backdropSelections).filter((s) => s.checked).length;

  const doDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const images: TmdbImageDownload[] = [];

      for (const [idx, sel] of Object.entries(posterSelections)) {
        if (sel.checked) {
          images.push({
            file_path: posters[Number(idx)].file_path,
            size: sel.size,
            image_type: "cover",
          });
        }
      }

      for (const [idx, sel] of Object.entries(backdropSelections)) {
        if (sel.checked) {
          images.push({
            file_path: backdrops[Number(idx)].file_path,
            size: sel.size,
            image_type: "background",
          });
        }
      }

      await invoke("download_tmdb_images", {
        libraryId,
        entryId,
        images,
      });

      toast.success(`Downloaded ${images.length} image${images.length !== 1 ? "s" : ""}`);
      onDownloaded();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloading(false);
    }
  }, [posterSelections, backdropSelections, posters, backdrops, libraryId, entryId, onDownloaded, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[800px] max-w-[90vw] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>TMDB Images</DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 border-b px-6 py-2">
          <button
            onClick={() => setTab("posters")}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === "posters"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
          >
            Posters ({posters.length})
          </button>
          <button
            onClick={() => setTab("backdrops")}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === "backdrops"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
          >
            Backdrops ({backdrops.length})
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Spinner className="size-6" />
            </div>
          )}

          {!loading && tab === "posters" && (
            <div className="grid grid-cols-4 gap-3">
              {posters.map((img, idx) => {
                const sel = posterSelections[idx];
                if (!sel) return null;
                return (
                  <div
                    key={img.file_path}
                    className={`flex flex-col gap-1.5 rounded-lg border p-2 transition-colors ${
                      sel.checked ? "border-primary bg-accent/30" : "border-transparent"
                    }`}
                  >
                    <label className="cursor-pointer">
                      <img
                        src={`https://image.tmdb.org/t/p/w185${img.file_path}`}
                        alt=""
                        className="w-full rounded object-cover"
                        loading="lazy"
                      />
                    </label>
                    <div className="flex items-center gap-1.5">
                      <Checkbox
                        checked={sel.checked}
                        onCheckedChange={(c) => togglePoster(idx, !!c)}
                      />
                      <Select
                        value={sel.size}
                        onValueChange={(v) => v && setPosterSize(idx, v)}
                      >
                        <SelectTrigger className="h-7 flex-1 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {POSTER_SIZES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {img.width}x{img.height}
                      {img.iso_639_1 && ` (${img.iso_639_1})`}
                    </p>
                  </div>
                );
              })}
              {posters.length === 0 && (
                <p className="col-span-4 py-8 text-center text-sm text-muted-foreground">
                  No posters available
                </p>
              )}
            </div>
          )}

          {!loading && tab === "backdrops" && (
            <div className="grid grid-cols-2 gap-3">
              {backdrops.map((img, idx) => {
                const sel = backdropSelections[idx];
                if (!sel) return null;
                return (
                  <div
                    key={img.file_path}
                    className={`flex flex-col gap-1.5 rounded-lg border p-2 transition-colors ${
                      sel.checked ? "border-primary bg-accent/30" : "border-transparent"
                    }`}
                  >
                    <label className="cursor-pointer">
                      <img
                        src={`https://image.tmdb.org/t/p/w300${img.file_path}`}
                        alt=""
                        className="w-full rounded object-cover"
                        loading="lazy"
                      />
                    </label>
                    <div className="flex items-center gap-1.5">
                      <Checkbox
                        checked={sel.checked}
                        onCheckedChange={(c) => toggleBackdrop(idx, !!c)}
                      />
                      <Select
                        value={sel.size}
                        onValueChange={(v) => v && setBackdropSize(idx, v)}
                      >
                        <SelectTrigger className="h-7 flex-1 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {BACKDROP_SIZES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {img.width}x{img.height}
                      {img.iso_639_1 && ` (${img.iso_639_1})`}
                    </p>
                  </div>
                );
              })}
              {backdrops.length === 0 && (
                <p className="col-span-2 py-8 text-center text-sm text-muted-foreground">
                  No backdrops available
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="m-0 shrink-0 border-t p-0 px-4 py-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={downloading}
          >
            Cancel
          </Button>
          <Button
            onClick={doDownload}
            disabled={downloading || selectedCount === 0}
          >
            {downloading ? (
              <>
                <Spinner className="size-3.5" />
                Downloading...
              </>
            ) : (
              <>
                <Download size={14} />
                Download{selectedCount > 0 ? ` (${selectedCount})` : ""}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
