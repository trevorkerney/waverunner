import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Play, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import type { ExtraInfo } from "@/types";

const KIND_LABELS: Record<string, string> = {
  extras: "Extras",
  featurettes: "Featurettes",
  "behind the scenes": "Behind the Scenes",
  "deleted scenes": "Deleted Scenes",
  interviews: "Interviews",
  scenes: "Scenes",
  shorts: "Shorts",
  clips: "Clips",
  trailers: "Trailers",
  other: "Other",
  webisodes: "Webisodes",
};

export function ExtrasDialog({
  open,
  onOpenChange,
  libraryId,
  entryId,
  entryTitle,
  isShow,
  onPlayFile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string;
  entryId: number;
  entryTitle: string;
  isShow: boolean;
  onPlayFile?: (path: string, title: string) => void;
}) {
  const [extras, setExtras] = useState<ExtraInfo[] | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [populating, setPopulating] = useState(false);
  // Kinds the user has expanded; groups default to collapsed.
  const [expandedKinds, setExpandedKinds] = useState<Set<string>>(new Set());

  const toggleKind = useCallback((kind: string) => {
    setExpandedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      setExtras(await invoke<ExtraInfo[]>("get_extras", { entryId }));
    } catch (e) {
      toast.error(String(e));
    }
  }, [entryId]);

  useEffect(() => {
    if (!open) return;
    setExtras(null);
    setExpandedId(null);
    setExpandedKinds(new Set());
    load();
  }, [open, load]);

  const groups = useMemo(() => {
    const map = new Map<string, ExtraInfo[]>();
    for (const e of extras ?? []) {
      const list = map.get(e.kind) ?? [];
      list.push(e);
      map.set(e.kind, list);
    }
    return Array.from(map.entries());
  }, [extras]);

  const play = useCallback(
    async (extra: ExtraInfo) => {
      try {
        const path = await invoke<string>("get_extra_file_path", {
          libraryId,
          extraId: extra.id,
        });
        onPlayFile?.(path, `${entryTitle} — ${extra.title}`);
        onOpenChange(false);
      } catch (e) {
        toast.error(String(e));
      }
    },
    [libraryId, entryTitle, onPlayFile, onOpenChange],
  );

  const populate = useCallback(
    async (extraId: number | null) => {
      setPopulating(true);
      try {
        const matched = await invoke<number>("populate_extras_metadata", {
          ownerId: entryId,
          extraId,
        });
        if (matched > 0) {
          toast.success(`Metadata found for ${matched} ${matched === 1 ? "extra" : "extras"}`);
          load();
        } else {
          toast.info("No TMDB matches found");
        }
      } catch (e) {
        toast.error(String(e));
      } finally {
        setPopulating(false);
      }
    },
    [entryId, load],
  );

  const fmtRuntime = (m: number) => `${m} min`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Fixed header/footer with only the body scrolling: keeps Close always
          visible and the scrollbar inside the padding (clear of the rounded
          corners). */}
      <DialogContent
        showCloseButton={false}
        className="grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Extras</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden">
        {extras == null && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading…
          </div>
        )}

        {extras != null && extras.length === 0 && (
          <p className="py-4 text-sm text-muted-foreground">No extras found for this {isShow ? "show" : "movie"}.</p>
        )}

        {extras != null && extras.length > 0 && (
          <div className="flex min-w-0 flex-col gap-3">
            {groups.map(([kind, items]) => {
              const collapsed = !expandedKinds.has(kind);
              return (
              <div key={kind} className="flex min-w-0 flex-col gap-1.5">
                <button
                  onClick={() => toggleKind(kind)}
                  className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                >
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  {KIND_LABELS[kind] ?? kind}
                  <span className="font-normal normal-case tracking-normal">({items.length})</span>
                </button>
                {!collapsed && (
                <div className="flex min-w-0 flex-col gap-1">
                  {items.map((extra) => {
                    const expanded = expandedId === extra.id;
                    const hasMeta = extra.plot || extra.release_date || extra.runtime != null;
                    return (
                      <ContextMenu key={extra.id}>
                        <ContextMenuTrigger
                          render={<div className="group min-w-0 rounded-md border border-border" />}
                        >
                          <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
                            <button
                              onClick={() => setExpandedId(expanded ? null : extra.id)}
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                              title={expanded ? "Hide details" : "Show details"}
                            >
                              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                            <span className="min-w-0 flex-1 truncate text-sm">{extra.title}</span>
                            {extra.runtime != null && (
                              <span className="shrink-0 text-xs text-muted-foreground">{fmtRuntime(extra.runtime)}</span>
                            )}
                            <button
                              onClick={() => play(extra)}
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                              title="Play"
                            >
                              <Play size={14} />
                            </button>
                          </div>
                          {expanded && (
                            <div className="border-t border-border px-3 py-2 text-sm">
                              {extra.release_date && (
                                <p className="text-xs text-muted-foreground">{extra.release_date}</p>
                              )}
                              {extra.plot ? (
                                <p className="mt-1">{extra.plot}</p>
                              ) : (
                                <p className="mt-1 text-muted-foreground">
                                  {hasMeta ? "" : "No metadata."}
                                  {extra.kind === "webisodes"
                                    ? " Right-click to populate from TMDB."
                                    : ""}
                                </p>
                              )}
                            </div>
                          )}
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onClick={() => play(extra)}>
                            <Play size={14} />
                            Play
                          </ContextMenuItem>
                          <ContextMenuItem disabled={populating} onClick={() => populate(extra.id)}>
                            <Sparkles size={14} />
                            Populate metadata from TMDB
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </div>
                )}
              </div>
              );
            })}
          </div>
        )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
