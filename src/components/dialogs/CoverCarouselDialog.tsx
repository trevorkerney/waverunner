import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
  type CarouselApi,
} from "@/components/ui/carousel";
import { useCoverUrl } from "@/context/CoverUrlContext";
import { getDisplayCover } from "@/components/cards/SortableCoverCard";
import type { MediaEntry } from "@/types";

export function CoverCarouselDialog({
  entry,
  mode,
  open,
  onOpenChange,
  onSelect,
  onDelete,
}: {
  entry: MediaEntry;
  mode: "select" | "delete";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (coverPath: string) => void;
  onDelete: (coverPath: string) => Promise<void>;
}) {
  const { getFullCoverUrl } = useCoverUrl();
  const currentCover = getDisplayCover(entry);
  const startIndex = currentCover
    ? Math.max(0, entry.covers.indexOf(currentCover))
    : 0;
  const [selectedIndex, setSelectedIndex] = useState(startIndex);
  const [api, setApi] = useState<CarouselApi>();
  const [dims, setDims] = useState<Map<number, { w: number; h: number }>>(new Map());
  const [sizes, setSizes] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    if (!api) return;
    const onSelectSlide = () => setSelectedIndex(api.selectedScrollSnap());
    api.on("select", onSelectSlide);
    return () => {
      api.off("select", onSelectSlide);
    };
  }, [api]);

  useEffect(() => {
    entry.covers.forEach((cover, i) => {
      if (sizes.has(i)) return;
      invoke<number>("get_file_size", { path: cover })
        .then((n) => setSizes((prev) => new Map(prev).set(i, n)))
        .catch(() => {});
    });
  }, [entry.covers, sizes]);

  const fmtSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const selDim = dims.get(selectedIndex);
  const selSize = sizes.get(selectedIndex);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose Cover</DialogTitle>
        </DialogHeader>
        <div className="px-12">
          <Carousel setApi={setApi} opts={{ startIndex }}>
            <CarouselContent>
              {entry.covers.map((cover, i) => (
                <CarouselItem key={i}>
                  <div className="flex items-center justify-center">
                    <img
                      src={getFullCoverUrl(cover)}
                      alt={`Cover ${i + 1}`}
                      className="max-h-[400px] rounded-md object-contain"
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        setDims((prev) => {
                          if (prev.has(i)) return prev;
                          return new Map(prev).set(i, { w: img.naturalWidth, h: img.naturalHeight });
                        });
                      }}
                    />
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
          </Carousel>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {selectedIndex + 1} / {entry.covers.length}
            {selDim && ` · ${selDim.w}×${selDim.h}`}
            {selSize != null && ` · ${fmtSize(selSize)}`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {mode === "delete" ? "Close" : "Cancel"}
          </Button>
          {mode === "delete" ? (
            <Button
              variant="destructive"
              onClick={async () => {
                const cover = entry.covers[selectedIndex];
                if (!cover) return;
                await onDelete(cover);
                setSelectedIndex((prev) => Math.max(0, Math.min(prev, entry.covers.length - 2)));
              }}
            >
              Delete
            </Button>
          ) : (
            <Button onClick={() => onSelect(entry.covers[selectedIndex])}>
              Select
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
