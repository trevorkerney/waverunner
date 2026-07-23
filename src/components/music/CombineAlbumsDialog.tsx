import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import type { EntriesResponse, MediaEntry, MusicAlbumDetail } from "../../types";
import { Check, Disc3, Layers } from "lucide-react";

/** Combine two albums into one entry. The choice is stored as a scan-time
 *  directive (album_combine) and applied by a rescan, so it survives every
 *  future rescan instead of being re-split by tag grouping.
 *  - merge: tracks fold into one release, keeping disc numbers (inline
 *    Disc N sections). Blocked when both albums claim the same
 *    (disc, track) slot — that shape is alternate cuts, i.e. versions.
 *  - versions: the source becomes a version in the release picker. */
export function CombineAlbumsDialog({
  libraryId,
  source,
  open,
  onOpenChange,
  onDone,
}: {
  libraryId: string;
  /** The album the user right-clicked — it gets folded INTO the target. */
  source: { id: number; title: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Combine + rescan finished — the host refreshes its views. */
  onDone: () => void;
}) {
  const [albums, setAlbums] = useState<MediaEntry[] | null>(null);
  const [filter, setFilter] = useState("");
  const [targetId, setTargetId] = useState<number | null>(null);
  const [mode, setMode] = useState<"merge" | "versions">("merge");
  const [collisions, setCollisions] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open || !source) return;
    setAlbums(null);
    setFilter("");
    setTargetId(null);
    setMode("merge");
    setCollisions(null);
    invoke<EntriesResponse>("get_entries", {
      libraryId,
      parentId: null,
      entryTypeFilter: "album",
    })
      .then((res) => setAlbums(res.entries.filter((e) => e.id !== source.id)))
      .catch((e) => toast.error(String(e)));
  }, [open, libraryId, source]);

  // Picking a target checks for (disc, track) collisions across ALL releases
  // of both albums — colliding albums can only combine as versions.
  useEffect(() => {
    if (targetId == null || !source) {
      setCollisions(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    (async () => {
      try {
        const [a, b] = await Promise.all([
          invoke<MusicAlbumDetail>("get_album_detail", { entryId: source.id }),
          invoke<MusicAlbumDetail>("get_album_detail", { entryId: targetId }),
        ]);
        if (cancelled) return;
        const slots = (d: MusicAlbumDetail) =>
          new Set(
            d.releases
              .flatMap((r) => r.tracks)
              .filter((t) => t.track_number != null)
              .map((t) => `${t.disc_number ?? 1}:${t.track_number}`),
          );
        const sa = slots(a);
        const overlap = [...slots(b)].filter((s) => sa.has(s));
        if (overlap.length > 0) {
          const [d, n] = overlap[0].split(":");
          setCollisions(`Both albums have a Disc ${d}, Track ${n}${overlap.length > 1 ? ` (+${overlap.length - 1} more)` : ""}`);
          setMode("versions");
        } else {
          setCollisions(null);
          setMode("merge");
        }
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetId, source]);

  const filtered = useMemo(() => {
    if (!albums) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return albums;
    return albums.filter((a) => a.title.toLowerCase().includes(q));
  }, [albums, filter]);

  async function combine() {
    if (!source || targetId == null) return;
    setWorking(true);
    try {
      await invoke("combine_albums", { libraryId, sourceId: source.id, targetId, mode });
      // The directive applies on rescan — run one now to make it real.
      const toastId = toast.loading("Combining — rescanning library…");
      const unlisten = await listen<string>("scan-progress", (e) => {
        toast.loading(e.payload, { id: toastId });
      });
      try {
        await invoke("rescan_library", { libraryId });
        toast.success("Albums combined", { id: toastId });
      } finally {
        unlisten();
      }
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setWorking(false);
    }
  }

  const modeRow = (
    value: "merge" | "versions",
    icon: React.ReactNode,
    label: string,
    note: string,
    disabled?: boolean,
  ) => (
    <button
      onClick={() => !disabled && setMode(value)}
      disabled={disabled}
      className={`flex items-start gap-3 rounded-md border px-3 py-2.5 text-left ${
        disabled
          ? "cursor-not-allowed opacity-50"
          : mode === value
            ? "border-primary bg-accent"
            : "border-border hover:bg-accent/40"
      }`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{note}</span>
      </span>
      {mode === value && !disabled && <Check size={14} className="mt-1 shrink-0 text-primary" />}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !working && onOpenChange(o)}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Combine album</DialogTitle>
          <DialogDescription>
            Fold "{source?.title}" into another album. The combine is remembered and
            survives rescans; your files are never touched.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {albums == null ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Loading albums…
            </div>
          ) : targetId == null ? (
            <>
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search albums…"
                className="h-8 text-sm"
              />
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {filtered.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setTargetId(a.id)}
                    className="flex items-baseline justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-left hover:bg-accent/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {[a.collection_display, a.year].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">No albums match.</p>
                )}
              </div>
            </>
          ) : checking ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Checking track lists…
            </div>
          ) : (
            <>
              <p className="text-sm">
                "{source?.title}" →{" "}
                <span className="font-medium">
                  {albums.find((a) => a.id === targetId)?.title}
                </span>{" "}
                <button
                  onClick={() => setTargetId(null)}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  change
                </button>
              </p>
              <div className="grid gap-2">
                {modeRow(
                  "merge",
                  <Disc3 size={16} />,
                  "Merge as one release",
                  collisions
                    ? `${collisions} — merging would double-book track slots.`
                    : "One track list; disc numbers are kept, so discs show inline.",
                  collisions != null,
                )}
                {modeRow(
                  "versions",
                  <Layers size={16} />,
                  "Combine as versions",
                  "Both track lists stay intact as separate versions in the release picker.",
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={working}>
            Cancel
          </Button>
          <Button onClick={() => void combine()} disabled={targetId == null || checking || working}>
            {working ? <Spinner className="size-4" /> : "Combine"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
