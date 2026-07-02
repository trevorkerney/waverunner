import { useState, useCallback, useEffect, useMemo } from "react";
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
import type { TmdbImage, TmdbImageDownload } from "@/types";

const POSTER_SIZES = ["w342", "w500", "w780", "original"];
const BACKDROP_SIZES = ["w780", "w1280", "original"];

interface TmdbImageBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string;
  entryId: number;
  tmdbId: string;
  /** Which TMDB endpoint the id belongs to — movie and TV ids overlap. */
  mediaType: "movie" | "tv";
  onDownloaded: () => void;
  /** Tab the dialog opens on — "Add cover" entry points want posters,
   *  "Add backdrop" wants backdrops. Defaults to posters. */
  initialTab?: "posters" | "backdrops";
}

interface ImageSelection {
  checked: boolean;
  size: string;
}

type Tab = "posters" | "backdrops";

/** TMDB marks textless art with a null language (occasionally "xx" = "No Language"). */
function imageLang(iso: string | null | undefined): string | null {
  return iso && iso !== "xx" ? iso : null;
}

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });
function languageLabel(code: string): string {
  try {
    return LANGUAGE_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

export function TmdbImageBrowserDialog({
  open,
  onOpenChange,
  libraryId,
  entryId,
  tmdbId,
  mediaType,
  onDownloaded,
  initialTab = "posters",
}: TmdbImageBrowserDialogProps) {
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [posters, setPosters] = useState<TmdbImage[]>([]);
  const [backdrops, setBackdrops] = useState<TmdbImage[]>([]);
  const [posterSelections, setPosterSelections] = useState<Record<number, ImageSelection>>({});
  const [backdropSelections, setBackdropSelections] = useState<Record<number, ImageSelection>>({});
  const [tab, setTab] = useState<Tab>("posters");
  // Language filter: "all" | "textless" | an iso_639_1 code. Filters the grid
  // only — already-checked images stay selected (and download) even when hidden.
  const [language, setLanguage] = useState<string>("all");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setTab(initialTab);
    setLanguage("all");
    setPosterSelections({});
    setBackdropSelections({});

    invoke<{ images: { posters: TmdbImage[]; backdrops: TmdbImage[] } | null }>(
      mediaType === "tv" ? "get_tmdb_show_detail" : "get_tmdb_movie_detail",
      { tmdbId: Number(tmdbId) },
    )
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
  }, [open, tmdbId, mediaType, initialTab]);

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

  // Filter options come from the languages actually present in this title's art.
  const languages = useMemo(() => {
    const codes = new Set<string>();
    let hasTextless = false;
    for (const img of [...posters, ...backdrops]) {
      const code = imageLang(img.iso_639_1);
      if (code) codes.add(code);
      else hasTextless = true;
    }
    return { codes: [...codes].sort(), hasTextless };
  }, [posters, backdrops]);

  const matchesLanguage = useCallback(
    (img: TmdbImage) =>
      language === "all"
        ? true
        : language === "textless"
          ? imageLang(img.iso_639_1) === null
          : imageLang(img.iso_639_1) === language,
    [language],
  );
  const visiblePosters = posters.filter(matchesLanguage).length;
  const visibleBackdrops = backdrops.filter(matchesLanguage).length;

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
            image_type: "backdrop",
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

        {/* Tabs + language filter */}
        <div className="flex shrink-0 items-center gap-1 border-b px-6 py-2">
          <button
            onClick={() => setTab("posters")}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === "posters"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
          >
            Posters ({visiblePosters})
          </button>
          <button
            onClick={() => setTab("backdrops")}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === "backdrops"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
          >
            Backdrops ({visibleBackdrops})
          </button>
          <div className="ml-auto">
            <Select value={language} onValueChange={(v) => v && setLanguage(v)}>
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All languages</SelectItem>
                {languages.hasTextless && <SelectItem value="textless">Textless</SelectItem>}
                {languages.codes.map((c) => (
                  <SelectItem key={c} value={c}>
                    {languageLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
                if (!sel || !matchesLanguage(img)) return null;
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
              {visiblePosters === 0 && (
                <p className="col-span-4 py-8 text-center text-sm text-muted-foreground">
                  {posters.length === 0 ? "No posters available" : "No posters in this language"}
                </p>
              )}
            </div>
          )}

          {!loading && tab === "backdrops" && (
            <div className="grid grid-cols-2 gap-3">
              {backdrops.map((img, idx) => {
                const sel = backdropSelections[idx];
                if (!sel || !matchesLanguage(img)) return null;
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
              {visibleBackdrops === 0 && (
                <p className="col-span-2 py-8 text-center text-sm text-muted-foreground">
                  {backdrops.length === 0 ? "No backdrops available" : "No backdrops in this language"}
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
