import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton, useHandoff } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Download } from "lucide-react";
import type { TmdbImage, TmdbImageDownload } from "@/types";

/** Everything that differs between the two pickers. One component, one
 *  hand-off, one download path — only the shape of the art changes. */
type ImageKind = "posters" | "backdrops";
const KIND = {
  posters: {
    title: "TMDB Posters",
    noun: "poster",
    field: "posters" as const,
    imageType: "cover",
    sizes: ["w342", "w500", "w780", "original"],
    defaultSize: "w780",
    thumbSize: "w185",
    cols: "grid-cols-4",
    colSpan: "col-span-4",
    skeletonCount: 8,
    skeletonAspect: "aspect-[2/3]",
  },
  backdrops: {
    title: "TMDB Backdrops",
    noun: "backdrop",
    field: "backdrops" as const,
    imageType: "backdrop",
    sizes: ["w780", "w1280", "original"],
    defaultSize: "w1280",
    thumbSize: "w300",
    cols: "grid-cols-2",
    colSpan: "col-span-2",
    skeletonCount: 4,
    skeletonAspect: "aspect-video",
  },
} as const;
/** Fixed frame (the Settings dialog's height): header + filter bar + a
 *  body of a row of posters and the top of the next — enough to show it
 *  scrolls — + footer. The count of images can't be known before the
 *  fetch, so the box never sizes to it. */
const TMDB_IMAGES_HEIGHT = "36rem";
/** How long a closed dialog keeps its content before resetting — longer
 *  than the shell's fade-out (200ms) plus its exit (150ms). */
const CLOSE_RESET_MS = 400;

/** A thumbnail that holds its exact spot (TMDB reports every image's
 *  dimensions) with a skeleton until its own file has loaded, then fades
 *  in — tiles fill as TMDB delivers them, and nothing shifts. */
function TmdbThumb({ src, img }: { src: string; img: TmdbImage }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span
      className="relative block w-full overflow-hidden rounded"
      style={{ aspectRatio: img.width && img.height ? `${img.width} / ${img.height}` : undefined }}
    >
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      <img
        src={src}
        alt=""
        loading="lazy"
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
      />
    </span>
  );
}

interface TmdbImageBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string;
  entryId: number;
  tmdbId: string;
  /** Which TMDB endpoint the id belongs to — movie and TV ids overlap. */
  mediaType: "movie" | "tv";
  /** Posters (2:3, saved as covers) or backdrops (16:9). */
  kind: ImageKind;
  onDownloaded: () => void;
}

interface ImageSelection {
  checked: boolean;
  size: string;
}

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
  kind,
  onDownloaded,
}: TmdbImageBrowserDialogProps) {
  const K = KIND[kind];
  const [loading, setLoading] = useState(false);
  // Covers' hand-off: the grid mounts invisible once the listing is in, its
  // first-screen thumbs are waited on, the skeleton (if it ever showed —
  // 500ms) fades out, the grid fades in. The ref is the whole body.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { stage, skeletonSeen, shown, contentVisible } = useHandoff(!loading, bodyRef);
  const [downloading, setDownloading] = useState(false);
  const [posters, setPosters] = useState<TmdbImage[]>([]);
  const [posterSelections, setPosterSelections] = useState<Record<number, ImageSelection>>({});
  // Language filter: "all" | "textless" | an iso_639_1 code. Filters the grid
  // only — already-checked images stay selected (and download) even when hidden.
  const [language, setLanguage] = useState<string>("all");

  useEffect(() => {
    if (!open) {
      // Reset once the shell's fade-out is over (the content must still be
      // there to fade), so a reopen never shows the previous title's grid
      // for a frame before the load takes over.
      const t = window.setTimeout(() => {
        setLoading(true);
        setPosters([]);
        setPosterSelections({});
      }, CLOSE_RESET_MS);
      return () => window.clearTimeout(t);
    }
    setLoading(true);
    setLanguage("all");
    setPosterSelections({});

    invoke<{ images: { posters: TmdbImage[]; backdrops: TmdbImage[] } | null }>(
      mediaType === "tv" ? "get_tmdb_show_detail" : "get_tmdb_movie_detail",
      { tmdbId: Number(tmdbId) },
    )
      .then((detail) => {
        const p = detail.images?.[K.field] ?? [];
        setPosters(p);
        // Init selections — unchecked, default size
        const ps: Record<number, ImageSelection> = {};
        p.forEach((_, i) => {
          ps[i] = { checked: false, size: K.defaultSize };
        });
        setPosterSelections(ps);
      })
      .catch((e) => toast.error(String(e)))
      .finally(() => setLoading(false));
  }, [open, tmdbId, mediaType, K]);

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

  const selectedCount = Object.values(posterSelections).filter((s) => s.checked).length;

  // Filter options come from the languages actually present in this title's art.
  const languages = useMemo(() => {
    const codes = new Set<string>();
    let hasTextless = false;
    for (const img of posters) {
      const code = imageLang(img.iso_639_1);
      if (code) codes.add(code);
      else hasTextless = true;
    }
    return { codes: [...codes].sort(), hasTextless };
  }, [posters]);

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

  const doDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const images: TmdbImageDownload[] = [];

      for (const [idx, sel] of Object.entries(posterSelections)) {
        if (sel.checked) {
          images.push({
            file_path: posters[Number(idx)].file_path,
            size: sel.size,
            image_type: K.imageType,
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
  }, [posterSelections, posters, libraryId, entryId, onDownloaded, onOpenChange, K]);

  // Hidden until the hand-off reveals it.
  const gridFade = `transition-opacity duration-200 will-change-[opacity] ${
    contentVisible ? "opacity-100" : "opacity-0"
  }`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" height={TMDB_IMAGES_HEIGHT} className="gap-0 p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>{K.title}</DialogTitle>
        </DialogHeader>

        {/* Count + language filter */}
        <div className="flex shrink-0 items-center gap-1 border-b px-6 py-2">
          <span className="py-1.5 text-sm text-muted-foreground">
            {loading
              ? `${K.noun.charAt(0).toUpperCase()}${K.noun.slice(1)}s`
              : `${visiblePosters} ${K.noun}${visiblePosters === 1 ? "" : "s"}`}
          </span>
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

        {/* FIXED size: the body holds a little over a row of posters; the
            rest scrolls. The skeleton overlays the (invisible) grid in the
            same layout until the grid is shown, and stays MOUNTED through
            its own fade-out — an unmount/remount would skip it. */}
        <DialogBody
          ref={bodyRef}
          className={`relative isolate p-4 [scrollbar-gutter:stable] ${shown ? "" : "overflow-hidden"}`}
        >
          {!shown && skeletonSeen && (
            <div
              className={`absolute inset-x-4 top-4 z-10 grid ${K.cols} gap-3 transition-opacity duration-200 ${
                stage === "hidden" ? "" : "opacity-0"
              }`}
            >
              {Array.from({ length: K.skeletonCount }, (_, i) => (
                <div key={i} className="flex flex-col gap-1.5 p-2">
                  <Skeleton className={`${K.skeletonAspect} w-full rounded`} />
                  <Skeleton className="h-7 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          )}

          <div className={`grid ${K.cols} gap-3 ${gridFade}`}>
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
                      <TmdbThumb src={`https://image.tmdb.org/t/p/${K.thumbSize}${img.file_path}`} img={img} />
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
                          {K.sizes.map((s) => (
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
                <p className={`${K.colSpan} py-8 text-center text-sm text-muted-foreground`}>
                  {posters.length === 0 ? `No ${K.noun}s available` : `No ${K.noun}s in this language`}
                </p>
              )}
          </div>
        </DialogBody>

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
