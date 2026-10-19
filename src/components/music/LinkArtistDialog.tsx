import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "@/lib/toast";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { FadeIn, SkeletonRows, useSkeletonDelay } from "../ui/skeleton";
import { Search, Music2, Sparkles } from "lucide-react";
import { MATCH_LOCK_TITLE, useMatchLock } from "@/hooks/libraryRuns";

/** An existing artist page, as a link target. */
interface ArtistChoice {
  id: number;
  name: string;
  image: string | null;
  release_count: number;
}

/** Search-and-pick over the library's artists. `suggested` (a lookalike the
 *  scanner spotted) leads the empty-query list so the likely answer is one
 *  click. */
function ArtistPicker({
  libraryId,
  excludeArtistId,
  suggested,
  applying,
  onPick,
}: {
  libraryId: string;
  excludeArtistId: number | null;
  suggested: { id: number; name: string } | null;
  applying: number | null;
  onPick: (target: ArtistChoice) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ArtistChoice[] | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  // A pass on this library holds the pick (the backend refuses the write).
  const locked = useMatchLock(libraryId);

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
          excludeArtistId,
        });
        if (seq.current === mine) setResults(rows);
      } catch {
        if (seq.current === mine) setResults([]);
      }
    }, 150);
  };

  const row = (o: ArtistChoice, i: number, badge?: string) => (
    <button
      key={o.id}
      type="button"
      disabled={applying !== null || locked}
      title={locked ? MATCH_LOCK_TITLE : undefined}
      onClick={() => onPick(o)}
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
      {badge && (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-primary">
          <Sparkles size={11} />
          {badge}
        </span>
      )}
      {applying === o.id && <Spinner className="size-3.5 shrink-0" />}
    </button>
  );

  const list = results ?? [];
  const pending = query.trim().length >= 1 && results === null;
  // Skeleton rows after 500ms of a search in flight; results fade in.
  const showSkeleton = useSkeletonDelay(pending);
  const listKey = results ? `${results.length}:${results[0]?.id ?? ""}` : "none";
  return (
    <>
      <Input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          search(e.target.value);
        }}
        placeholder="Search artists…"
        className="h-8 shrink-0 text-sm"
      />
      <div className="overflow-hidden rounded-md border">
        {query.trim().length < 1 && suggested && (
          <SuggestedRow libraryId={libraryId} suggested={suggested} render={row} />
        )}
        {pending ? (
          showSkeleton ? <SkeletonRows rows={5} avatar /> : null
        ) : (
          <FadeIn key={listKey}>{list.map((o, i) => row(o, i))}</FadeIn>
        )}
        {list.length === 0 && !pending && (
          <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
            <Search size={12} />
            {query.trim().length < 1
              ? suggested
                ? "Or type to search other artists"
                : "Type to search existing artists"
              : "No matching artists"}
          </p>
        )}
      </div>
    </>
  );
}

/** The lookalike suggestion as a full picker row (fetched by name so it
 *  carries the same image/count the search rows do). */
function SuggestedRow({
  libraryId,
  suggested,
  render,
}: {
  libraryId: string;
  suggested: { id: number; name: string };
  render: (o: ArtistChoice, i: number, badge?: string) => React.ReactNode;
}) {
  const [choice, setChoice] = useState<ArtistChoice>({
    id: suggested.id,
    name: suggested.name,
    image: null,
    release_count: 0,
  });
  useEffect(() => {
    let alive = true;
    invoke<ArtistChoice[]>("search_credit_link_choices", {
      libraryId,
      query: suggested.name,
      limit: 8,
      excludeArtistId: null,
    })
      .then((rows) => {
        const hit = rows.find((r) => r.id === suggested.id);
        if (alive && hit) setChoice(hit);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [libraryId, suggested.id, suggested.name]);
  return <>{render(choice, 0, "looks alike")}</>;
}

/** "This name is really the same artist as…": a merge. The name becomes an
 *  alias of the artist picked, everything credited to it moves there, and
 *  credits keep showing it as written — "God" on Yeezus → Ye. Undoable from
 *  History. One job per dialog (his call, 2026-10-04): persona has
 *  PersonaDialog, a joint credit has the split editor, each behind its own
 *  row button. */
export function LinkArtistDialog({
  libraryId,
  sourceName,
  sourceArtistId,
  suggested = null,
  onOpenChange,
  onDone,
  queue,
}: {
  libraryId: string;
  sourceName: string;
  /** The name's own page, when it has one — excluded from the search so it
   *  can't be merged into itself. */
  sourceArtistId: number | null;
  /** A lookalike page the scanner spotted — leads the list. */
  suggested?: { id: number; name: string } | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  /** Given (the metadata page), a pick hands the write to the host's apply
   *  queue and the dialog closes at once — the row leaves at the click and
   *  the link lands in the background; the host refreshes when the queue
   *  drains, so onDone isn't called. Absent, the write runs here. */
  queue?: (job: { label: string; run: () => Promise<void> }) => void;
}) {
  const [applying, setApplying] = useState<number | null>(null);

  const linkSame = async (target: ArtistChoice) => {
    const run = () =>
      invoke<void>("link_credit_name", { libraryId, name: sourceName, targetArtistId: target.id });
    if (queue) {
      // Queued (metadata page): hand the write over and close now — the
      // queue banner is the feedback, the drain refresh brings the result.
      queue({ label: `\u{201c}${sourceName}\u{201d} \u{2192} ${target.name}`, run });
      onOpenChange(false);
      return;
    }
    setApplying(target.id);
    try {
      await run();
      toast.success(`“${sourceName}” is now ${target.name}.`);
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(String(e));
      setApplying(null);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/* STATIC height (modal rule): the picker's result list scrolls
          inside the body; the frame stays put. */}
      <DialogContent size="md" height="25rem">
        <DialogHeader>
          <DialogTitle>“{sourceName}” is the same artist as…</DialogTitle>
        </DialogHeader>
        <DialogBody className="-mx-1 flex flex-col gap-3 overflow-x-hidden px-1 pb-1">
          <p className="text-xs text-muted-foreground">
            One artist, another spelling or moniker. Everything credited to “{sourceName}” moves
            to the artist you pick; the name stays as an alias so it keeps resolving there
            through rescans, and credits keep showing it as written. Undoable from History.
          </p>
          <ArtistPicker
            libraryId={libraryId}
            excludeArtistId={sourceArtistId}
            suggested={suggested}
            applying={applying}
            onPick={linkSame}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
