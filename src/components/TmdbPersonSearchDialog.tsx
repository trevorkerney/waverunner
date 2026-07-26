import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Search, User } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { TmdbPersonSearchResult } from "@/types";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w185";

/** Search TMDB for a person and pick one result. Generic on purpose — the
 *  person-detail header uses it to apply a match (onPick invokes the match
 *  command) and the cast editor uses it to fill a row from TMDB. Single-step:
 *  no field-review, since per-person data (name, bio, image) is small and
 *  universal. The dialog closes itself after onPick resolves. */
export function TmdbPersonSearchDialog({
  open,
  onOpenChange,
  title,
  initialQuery,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Pre-fills the search input (usually the current name) so the dialog
   *  lands on the right result immediately. */
  initialQuery: string;
  onPick: (hit: TmdbPersonSearchResult) => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TmdbPersonSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [pickingId, setPickingId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setResults([]);
  }, [open, initialQuery]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await invoke<TmdbPersonSearchResult[]>("search_tmdb_person", { query: q });
        setResults(res);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, open]);

  const handlePick = async (r: TmdbPersonSearchResult) => {
    setPickingId(r.id);
    try {
      await onPick(r);
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setPickingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
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
              placeholder="Search TMDB for a person"
              className="h-8 pl-8 text-sm"
              autoFocus
            />
          </div>
          <div className="max-h-80 overflow-y-auto">
            {searching && (
              <div className="flex items-center justify-center py-4">
                <Spinner className="size-4" />
              </div>
            )}
            {!searching && results.length === 0 && query.trim() && (
              <p className="py-4 text-center text-sm text-muted-foreground">No results.</p>
            )}
            <div className="flex flex-col gap-1">
              {results.map((r) => {
                const src = r.profile_path ? `${TMDB_IMAGE_BASE}${r.profile_path}` : null;
                return (
                  <button
                    key={r.id}
                    onClick={() => handlePick(r)}
                    disabled={pickingId !== null}
                    className="flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-50"
                  >
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                      {src ? (
                        <img
                          src={src}
                          alt={r.name}
                          className="h-full w-full object-cover"
                          draggable={false}
                        />
                      ) : (
                        <User className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="text-xs leading-snug text-muted-foreground">
                        {[r.known_for_department, r.known_for_summary]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    {pickingId === r.id && <Spinner className="size-4" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
