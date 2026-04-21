import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Search, User, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { LocalPersonSearchResult, TmdbPersonSearchResult } from "@/types";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w185";

export type PersonPick =
  | { kind: "existing"; personId: number; name: string; imagePath: string | null; tmdbId: number | null }
  | { kind: "tmdb"; tmdbId: number; name: string; profilePath: string | null }
  | { kind: "new"; name: string };

/** Unified person picker for cast/crew edit surfaces. Surfaces three source lists:
 *  (1) local persons matching the query, (2) TMDB search results, (3) a "Create new"
 *  fallback when the typed name has no match. One dialog, three pick modes. */
export function PersonPickerDialog({
  open,
  onOpenChange,
  initialName,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fills the input (for edit-in-place on an existing row). Blank when adding. */
  initialName?: string;
  onPick: (pick: PersonPick) => void;
}) {
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState<LocalPersonSearchResult[]>([]);
  const [tmdb, setTmdb] = useState<TmdbPersonSearchResult[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [tmdbLoading, setTmdbLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery(initialName ?? "");
    setLocal([]);
    setTmdb([]);
  }, [open, initialName]);

  // Debounced local + TMDB searches. Local is fast (DB substring scan); TMDB has
  // network latency. Run in parallel.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setLocal([]);
      setTmdb([]);
      return;
    }
    const timer = setTimeout(async () => {
      setLocalLoading(true);
      setTmdbLoading(true);
      const localPromise = invoke<LocalPersonSearchResult[]>("search_persons_local", { query: q })
        .then((res) => setLocal(res))
        .catch((e) => toast.error(`Local search failed: ${e}`))
        .finally(() => setLocalLoading(false));
      const tmdbPromise = invoke<TmdbPersonSearchResult[]>("search_tmdb_person", { query: q })
        .then((res) => setTmdb(res))
        .catch(() => {
          // Silent — no TMDB token, offline, etc. Local results + "Create new" still work.
        })
        .finally(() => setTmdbLoading(false));
      await Promise.all([localPromise, tmdbPromise]);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, open]);

  const submitPick = (pick: PersonPick) => {
    onPick(pick);
    onOpenChange(false);
  };

  const hasAnyResults = local.length > 0 || tmdb.length > 0;
  const showCreateRow = query.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initialName ? "Change person" : "Add person"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search people"
              className="h-8 pl-8 text-sm"
              autoFocus
            />
          </div>
          <div className="max-h-96 overflow-y-auto">
            {/* Local results */}
            {(localLoading || local.length > 0) && (
              <>
                <p className="sticky top-0 bg-background px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  In library
                </p>
                {localLoading && local.length === 0 && (
                  <div className="flex items-center justify-center py-2">
                    <Spinner className="size-3" />
                  </div>
                )}
                <div className="mb-2 flex flex-col gap-0.5">
                  {local.map((p) => {
                    const src = p.image_path ? convertFileSrc(p.image_path) : null;
                    return (
                      <button
                        key={`local-${p.id}`}
                        onClick={() =>
                          submitPick({
                            kind: "existing",
                            personId: p.id,
                            name: p.name,
                            imagePath: p.image_path,
                            tmdbId: p.tmdb_id,
                          })
                        }
                        className="flex items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                      >
                        <Avatar src={src} name={p.name} />
                        <span className="flex-1 truncate text-sm">{p.name}</span>
                        {p.tmdb_id != null && (
                          <span className="text-xs text-muted-foreground">matched</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {/* TMDB results */}
            {(tmdbLoading || tmdb.length > 0) && (
              <>
                <p className="sticky top-0 bg-background px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  From TMDB
                </p>
                {tmdbLoading && tmdb.length === 0 && (
                  <div className="flex items-center justify-center py-2">
                    <Spinner className="size-3" />
                  </div>
                )}
                <div className="mb-2 flex flex-col gap-0.5">
                  {tmdb.map((p) => {
                    const src = p.profile_path ? `${TMDB_IMAGE_BASE}${p.profile_path}` : null;
                    return (
                      <button
                        key={`tmdb-${p.id}`}
                        onClick={() =>
                          submitPick({
                            kind: "tmdb",
                            tmdbId: p.id,
                            name: p.name,
                            profilePath: p.profile_path,
                          })
                        }
                        className="flex items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                      >
                        <Avatar src={src} name={p.name} />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm">{p.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {[p.known_for_department, p.known_for_summary]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {/* Create new fallback — always available when query is non-empty */}
            {showCreateRow && (
              <button
                onClick={() => submitPick({ kind: "new", name: query.trim() })}
                className="flex w-full items-center gap-3 rounded-md border-t border-border px-2 py-2 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Plus className="h-4 w-4 text-muted-foreground" />
                </div>
                <span className="flex-1 truncate text-sm">
                  Create new: <span className="font-medium">{query.trim()}</span>
                </span>
              </button>
            )}

            {!hasAnyResults && !localLoading && !tmdbLoading && !showCreateRow && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Start typing to search.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
      {src ? (
        <img src={src} alt={name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <User className="h-5 w-5 text-muted-foreground" />
      )}
    </div>
  );
}
