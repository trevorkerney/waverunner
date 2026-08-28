import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Search, Music2 } from "lucide-react";

/** An existing artist page, as a link target. */
interface ArtistChoice {
  id: number;
  name: string;
  image: string | null;
  release_count: number;
}

interface PersonaLinks {
  parent: { artist_id: number; title: string } | null;
  personas: { artist_id: number; title: string }[];
}

/** Link an artist as a PERSONA of another — same human, independent identity
 *  (kiLL edward → J. Cole). Not a merge: both pages keep their own credits and
 *  matching, and the relationship shows on both artist pages. Shared by the
 *  metadata center's artist rows and the artist detail page. */
export function PersonaDialog({
  libraryId,
  personaId,
  personaName,
  onOpenChange,
  onDone,
}: {
  libraryId: string;
  personaId: number;
  personaName: string;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ArtistChoice[] | null>(null);
  const [applying, setApplying] = useState<number | null>(null);
  const [links, setLinks] = useState<PersonaLinks | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  // What this artist is already part of — so re-linking reads as a change and
  // an existing link can be removed without digging through History.
  useEffect(() => {
    let alive = true;
    invoke<PersonaLinks>("get_artist_personas", { artistId: personaId })
      .then((r) => alive && setLinks(r))
      .catch(() => alive && setLinks(null));
    return () => {
      alive = false;
    };
  }, [personaId]);

  const search = (q: string) => {
    window.clearTimeout(timer.current);
    const trimmed = q.trim();
    if (trimmed.length < 1) {
      setResults(null);
      return;
    }
    const mine = ++seq.current;
    timer.current = window.setTimeout(async () => {
      try {
        const rows = await invoke<ArtistChoice[]>("search_credit_link_choices", {
          libraryId,
          query: trimmed,
          limit: 8,
          excludeArtistId: personaId,
        });
        if (seq.current === mine) setResults(rows);
      } catch {
        if (seq.current === mine) setResults([]);
      }
    }, 150);
  };

  const apply = async (target: ArtistChoice) => {
    setApplying(target.id);
    try {
      await invoke("set_artist_persona", { personaId, parentId: target.id });
      toast.success(`“${personaName}” is a persona of ${target.name}.`);
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(String(e));
      setApplying(null);
    }
  };

  const unlink = async () => {
    setApplying(-1);
    try {
      await invoke("unset_artist_persona", { personaId });
      toast.success(`“${personaName}” is its own artist again.`);
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(String(e));
      setApplying(null);
    }
  };

  const parent = links?.parent ?? null;
  const owns = links?.personas ?? [];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>“{personaName}” is a persona of…</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Same person, independent identity — both pages keep their own credits and matching, and
          each links to the other. Undoable from History. (For a misspelling of the same identity,
          use Alias instead.)
        </p>

        {/* Already linked: say so, and offer the way out. */}
        {parent && (
          <div className="flex items-center gap-3 rounded-md border px-3 py-2">
            <p className="min-w-0 flex-1 text-xs">
              Currently a persona of{" "}
              <span className="font-medium text-foreground">{parent.title}</span>. Picking someone
              else moves the link.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={applying !== null}
              onClick={unlink}
            >
              {applying === -1 && <Spinner className="size-3" />}
              Remove link
            </Button>
          </div>
        )}
        {/* One level deep: an artist with personas of their own can't also be
            someone else's mask, and the backend refuses it — say so up front
            instead of failing on apply. */}
        {owns.length > 0 && (
          <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{personaName}</span> already performs as{" "}
            {owns.map((p) => p.title).join(", ")} — unlink those first to make them a persona of
            someone else.
          </p>
        )}

        <Input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            search(e.target.value);
          }}
          placeholder="Search artists…"
          className="h-8 text-sm"
        />
        <div className="overflow-hidden rounded-md border">
          {(results ?? []).map((o, i) => (
            <button
              key={o.id}
              type="button"
              disabled={applying !== null}
              onClick={() => apply(o)}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent disabled:opacity-60 ${
                i === 0 ? "" : "border-t"
              }`}
            >
              {o.image ? (
                <img
                  src={convertFileSrc(o.image)}
                  alt=""
                  draggable={false}
                  className="size-7 shrink-0 rounded-full object-cover"
                />
              ) : (
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Music2 size={14} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{o.name}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {o.release_count} {o.release_count === 1 ? "release" : "releases"}
                </span>
              </span>
              {applying === o.id && <Spinner className="size-3.5 shrink-0" />}
            </button>
          ))}
          {(results ?? []).length === 0 && (
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
              <Search size={12} />
              {query.trim().length < 1
                ? "Type to search existing artists"
                : results === null
                  ? "Searching…"
                  : "No matching artists"}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
