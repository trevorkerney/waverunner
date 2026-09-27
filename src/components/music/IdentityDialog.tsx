import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { FadeIn, SkeletonRows, useSkeletonDelay } from "../ui/skeleton";
import { Search, Music2, Equal, VenetianMask, Scissors, Sparkles } from "lucide-react";
import { MATCH_LOCK_TITLE, useMatchLock } from "@/hooks/libraryRuns";

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

export type IdentityMode = "same" | "persona" | "split";

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
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-amber-300">
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

/** The one "this name is really…" dialog: every way a credit name or artist
 *  page can turn out to be someone else, side by side, so the concept choice
 *  happens in one place —
 *   - the SAME artist (a merge: the name becomes an alias, credits move,
 *     undoable) — "God" on Yeezus → Ye;
 *   - a PERSONA of another artist (independent identity, both pages live on)
 *     — kiLL edward → J. Cole;
 *   - SEVERAL artists (a joint credit to split; hands off to the split
 *     editor, applied on the next rescan).
 *  Persona and split need a page of their own; a bare credit name (no page
 *  yet) can only be the same artist as someone. */
export function IdentityDialog({
  libraryId,
  sourceName,
  sourceArtistId,
  initialMode = "same",
  suggested = null,
  onOpenChange,
  onDone,
  onSplit,
  queue,
}: {
  libraryId: string;
  sourceName: string;
  /** The name's own page, when it has one — excluded from the search so it
   *  can't be merged into itself; required for persona and split. */
  sourceArtistId: number | null;
  initialMode?: IdentityMode;
  /** A lookalike page the scanner spotted — leads the "same artist" list. */
  suggested?: { id: number; name: string } | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  /** Opens the split editor for the page (the host owns that dialog). */
  onSplit?: () => void;
  /** Given (the metadata page), a pick hands the write to the host's apply
   *  queue and the dialog closes at once — the row leaves at the click and
   *  the link lands in the background; the host refreshes when the queue
   *  drains, so onDone isn't called. Absent, the write runs here. */
  queue?: (job: { label: string; run: () => Promise<void> }) => void;
}) {
  const [mode, setMode] = useState<IdentityMode>(initialMode);
  const [applying, setApplying] = useState<number | null>(null);
  // A pass on this library holds every identity write (backend refuses).
  const locked = useMatchLock(libraryId);
  const [links, setLinks] = useState<PersonaLinks | null>(null);
  const hasPage = sourceArtistId != null;

  // What this page is already part of — so a persona re-link reads as a
  // change and an existing link can be removed here.
  useEffect(() => {
    if (sourceArtistId == null) return;
    let alive = true;
    invoke<PersonaLinks>("get_artist_personas", { artistId: sourceArtistId })
      .then((r) => alive && setLinks(r))
      .catch(() => alive && setLinks(null));
    return () => {
      alive = false;
    };
  }, [sourceArtistId]);

  const finish = (message: string) => {
    toast.success(message);
    onOpenChange(false);
    onDone();
  };

  // Queued (metadata page): hand the write over and close now — the queue
  // banner is the feedback, the drain refresh brings the result.
  const handOff = (label: string, run: () => Promise<void>) => {
    queue!({ label, run });
    onOpenChange(false);
  };

  const linkSame = async (target: ArtistChoice) => {
    const run = () =>
      invoke<void>("link_credit_name", { libraryId, name: sourceName, targetArtistId: target.id });
    if (queue) {
      handOff(`\u{201c}${sourceName}\u{201d} \u{2192} ${target.name}`, run);
      return;
    }
    setApplying(target.id);
    try {
      await run();
      finish(`“${sourceName}” is now ${target.name}.`);
    } catch (e) {
      toast.error(String(e));
      setApplying(null);
    }
  };

  const linkPersona = async (target: ArtistChoice) => {
    const run = () =>
      invoke<void>("set_artist_persona", { personaId: sourceArtistId, parentId: target.id });
    if (queue) {
      handOff(`\u{201c}${sourceName}\u{201d} \u{2192} persona of ${target.name}`, run);
      return;
    }
    setApplying(target.id);
    try {
      await run();
      finish(`“${sourceName}” is a persona of ${target.name}.`);
    } catch (e) {
      toast.error(String(e));
      setApplying(null);
    }
  };

  const unlinkPersona = async () => {
    const run = () => invoke<void>("unset_artist_persona", { personaId: sourceArtistId });
    if (queue) {
      handOff(`\u{201c}${sourceName}\u{201d} \u{2192} its own artist`, run);
      return;
    }
    setApplying(-1);
    try {
      await run();
      finish(`“${sourceName}” is its own artist again.`);
    } catch (e) {
      toast.error(String(e));
      setApplying(null);
    }
  };

  const parent = links?.parent ?? null;
  const owns = links?.personas ?? [];

  const tabs: { id: IdentityMode; label: string; icon: React.ReactNode; enabled: boolean }[] = [
    { id: "same", label: "The same artist as…", icon: <Equal size={13} />, enabled: true },
    { id: "persona", label: "A persona of…", icon: <VenetianMask size={13} />, enabled: hasPage },
    { id: "split", label: "Several artists", icon: <Scissors size={13} />, enabled: hasPage && !!onSplit },
  ];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/* STATIC height across all three modes (modal rule): the tab strip
          swaps the body's content, the frame stays put; the pickers'
          result lists scroll inside. */}
      <DialogContent size="md" height="28rem">
        <DialogHeader>
          <DialogTitle>“{sourceName}” is really…</DialogTitle>
        </DialogHeader>
        <div className="flex shrink-0 gap-1 rounded-md border p-0.5 text-xs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={!t.enabled || applying !== null}
              onClick={() => setMode(t.id)}
              title={
                t.enabled
                  ? undefined
                  : "Needs a page of its own — this name has none yet (it gets one after a rescan)"
              }
              className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 transition-colors disabled:opacity-40 ${
                mode === t.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        <DialogBody className="-mx-1 flex flex-col gap-3 overflow-x-hidden px-1 pb-1">
        {mode === "same" && (
          <>
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
          </>
        )}

        {mode === "persona" && (
          <>
            <p className="text-xs text-muted-foreground">
              Same person, independent identity — both pages keep their own credits and matching,
              the parent’s discography includes the persona’s, and each page links to the other.
              Undoable from History.
            </p>
            {parent && (
              <div className="flex items-center gap-3 rounded-md border px-3 py-2">
                <p className="min-w-0 flex-1 text-xs">
                  Currently a persona of{" "}
                  <span className="font-medium text-foreground">{parent.title}</span>. Picking
                  someone else moves the link.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 gap-1.5"
                  disabled={applying !== null || locked}
                  title={locked ? MATCH_LOCK_TITLE : undefined}
                  onClick={unlinkPersona}
                >
                  {applying === -1 && <Spinner className="size-3" />}
                  Remove link
                </Button>
              </div>
            )}
            {/* One level deep: an artist with personas of their own can't
                also be someone else's mask — the backend refuses it. */}
            {owns.length > 0 && (
              <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{sourceName}</span> already performs
                as {owns.map((p) => p.title).join(", ")} — unlink those first to make them a
                persona of someone else.
              </p>
            )}
            <ArtistPicker
              libraryId={libraryId}
              excludeArtistId={sourceArtistId}
              suggested={null}
              applying={applying}
              onPick={linkPersona}
            />
          </>
        )}

        {mode === "split" && (
          <>
            <p className="text-xs text-muted-foreground">
              A joint credit that is really several people (“A & B”). The split is staged and
              applied by the next rescan: each member gets their own page, and joint albums show in
              every member’s discography.
            </p>
            <Button
              variant="outline"
              className="gap-1.5 self-start"
              onClick={() => {
                onOpenChange(false);
                onSplit?.();
              }}
            >
              <Scissors size={14} />
              Choose the members…
            </Button>
          </>
        )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
