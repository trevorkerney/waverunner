import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import { Search, Link2Off, CircleCheck, CircleSlash, TriangleAlert } from "lucide-react";

/** Match one album, artist, or track to MusicBrainz — the same dialog for all
 *  three, since the shape of the job is identical: see what it's matched to
 *  now, search or paste an id, apply, or forget the match entirely. */

export type MbEntityKind = "album" | "artist" | "track";

export interface MbStatus {
  kind: MbEntityKind;
  entity_id: number;
  title: string;
  /** Owning artist (album) or album (track) — narrows the search. */
  context: string | null;
  mbid: string | null;
  /** "user" = you picked it, "mb" = the automatic pass did. */
  tier: string | null;
  release_group_id: string | null;
  gap_count: number;
  /** Your tracks with no counterpart on the release. */
  gap_ours: number;
  /** The release's tracks with no counterpart here. */
  gap_mb: number;
  searched_not_found: boolean;
}

interface MbCandidateRow {
  /** "release-group" | "release" | "artist" | "recording" — a release-group
   *  names the album, a release names one pressing and carries track credits. */
  kind: string;
  mbid: string;
  title: string;
  subtitle: string;
  detail: string | null;
  score: number;
}

const ENTITY_URL: Record<MbEntityKind, string> = {
  album: "release",
  artist: "artist",
  track: "recording",
};

const NOUN: Record<MbEntityKind, string> = {
  album: "album",
  artist: "artist",
  track: "recording",
};

const CONTEXT_LABEL: Record<MbEntityKind, string> = {
  album: "Artist",
  artist: "",
  track: "Album",
};

/** One-line summary of where this entity stands with MusicBrainz. Shared with
 *  the inline status chips so both read the same. */
export function mbStateOf(s: MbStatus | null): {
  state: "matched" | "partial" | "mismatch" | "notfound" | "none";
  label: string;
} {
  if (!s) return { state: "none", label: "Not matched" };
  if (s.mbid && s.gap_count > 0) {
    // Never sum the two sides: one song absent from both directions is a
    // single problem, and adding them reported "24 tracks" for a 12-track
    // album. Each side is counted and named separately.
    const parts = [
      s.gap_ours > 0 && `${s.gap_ours} ${s.gap_ours === 1 ? "track" : "tracks"} unmatched`,
      s.gap_mb > 0 && `${s.gap_mb} not in your files`,
    ].filter(Boolean);
    return { state: "mismatch", label: parts.join(" · ") || `${s.gap_count} don’t line up` };
  }
  if (s.mbid) return { state: "matched", label: s.tier === "user" ? "Matched by you" : "Matched" };
  // Pre-12.5 matches knew the album but never recorded which pressing.
  if (s.release_group_id) return { state: "partial", label: "Matched, pressing unknown" };
  if (s.searched_not_found) return { state: "notfound", label: "Searched, not found" };
  return { state: "none", label: "Not matched" };
}

export function MatchDialog({
  kind,
  entityId,
  open,
  onOpenChange,
  onChanged,
}: {
  kind: MbEntityKind;
  entityId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A match was applied or cleared — the host should refetch. */
  onChanged?: () => void;
}) {
  const [status, setStatus] = useState<MbStatus | null>(null);
  const [query, setQuery] = useState("");
  const [context, setContext] = useState("");
  const [results, setResults] = useState<MbCandidateRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await invoke<MbStatus>("mb_status", { kind, entityId });
    setStatus(s);
    setQuery(s.title);
    setContext(s.context ?? "");
    return s;
  }, [kind, entityId]);

  useEffect(() => {
    if (!open) return;
    setResults(null);
    load().catch((e) => toast.error(String(e)));
  }, [open, load]);

  const search = async () => {
    setSearching(true);
    setResults(null);
    try {
      setResults(
        await invoke<MbCandidateRow[]>("mb_search_entity", { kind, query, context: context || null }),
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSearching(false);
    }
  };

  const apply = async (mbid: string, mbidKind?: string) => {
    setBusy(`apply:${mbid}`);
    try {
      await invoke("mb_apply_entity_match", { kind, entityId, mbid, mbidKind });
      const s = await load();
      setResults(null);
      onChanged?.();
      toast.success(
        s.gap_count > 0 ? `Matched — but ${mbStateOf(s).label.toLowerCase()}.` : "Matched to MusicBrainz.",
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const unmatch = async () => {
    setBusy("unmatch");
    try {
      await invoke("mb_unmatch_entity", { kind, entityId });
      await load();
      onChanged?.();
      toast.success("Match forgotten and its changes reverted.");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const artistSettled = kind === "artist" && !!status?.mbid;
  const st = mbStateOf(status);
  const StateIcon =
    st.state === "matched" ? CircleCheck : st.state === "mismatch" ? TriangleAlert : CircleSlash;
  const stateColor =
    st.state === "matched"
      ? "text-emerald-400"
      : st.state === "mismatch"
        ? "text-amber-400"
        : "text-muted-foreground";

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="w-[min(38rem,calc(100vw-3rem))] max-w-none">
        <DialogHeader>
          <DialogTitle>Match {kind} to MusicBrainz</DialogTitle>
          <DialogDescription>
            {status?.title}
            {status?.context ? ` — ${status.context}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Where it stands now */}
          <div className="flex items-start justify-between gap-3 rounded-md border p-2.5">
            <div className="min-w-0">
              {/* items-center centers on the line box, which includes room
                  for descenders — so the icon reads low against letters that
                  have none. Lifting it a pixel centers it on the letterforms. */}
              <p className={`flex items-center gap-1.5 text-sm ${stateColor}`}>
                <StateIcon size={14} className="shrink-0 -translate-y-px" />
                {st.label}
              </p>
              {status?.mbid && (
                <a
                  href={`https://musicbrainz.org/${kind === "album" ? "release" : ENTITY_URL[kind]}/${status.mbid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  {status.mbid}
                </a>
              )}
              {!status?.mbid && status?.release_group_id && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Matched to the album, but not to a specific release — so its track list can’t be
                  checked. Match it again to fix that.
                </p>
              )}
            </div>
            {/* Anything to forget at all, not just a release id: an album
                matched before 12.5 has a release GROUP and applied changes,
                and refusing to unmatch it would strand ~190 albums. */}
            {(status?.mbid || status?.release_group_id) && (
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 gap-1.5"
                disabled={busy !== null}
                onClick={unmatch}
              >
                {busy === "unmatch" ? <Spinner className="size-3" /> : <Link2Off size={13} />}
                Unmatch
              </Button>
            )}
          </div>

          {/* An identified artist has nothing left to search for — there is
              one right answer and it's already stored. Unmatch first if it's
              wrong. Albums and tracks keep the box, since a matched album can
              still want a different pressing. */}
          {!artistSettled && (
            <>
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              className="h-8 flex-1 text-sm"
              placeholder={`${NOUN[kind]} title, or paste a MusicBrainz link or ID…`}
            />
            {CONTEXT_LABEL[kind] && (
              <Input
                value={context}
                onChange={(e) => setContext(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                className="h-8 w-36 text-sm"
                placeholder={`${CONTEXT_LABEL[kind]} (optional)`}
              />
            )}
            <Button size="sm" variant="outline" disabled={searching} onClick={search}>
              {searching ? <Spinner className="size-3" /> : <Search size={13} />}
              Go
            </Button>
          </div>
          <p className="-mt-1.5 px-1 text-[11px] text-muted-foreground">
            {CONTEXT_LABEL[kind]
              ? `Clear the ${CONTEXT_LABEL[kind].toLowerCase()} to widen the search — a wrong tag there hides every real result.`
              : "Paste a MusicBrainz link for an exact match."}
          </p>
            </>
          )}

          {/* Results */}
          {searching ? (
            <div className="flex justify-center py-4">
              <Spinner className="size-4" />
            </div>
          ) : (
            results && (
              <div className="max-h-72 overflow-y-auto overflow-x-hidden rounded-md border">
                {results.length === 0 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">No results.</p>
                )}
                {results.map((c, i) => (
                  <div
                    key={c.mbid}
                    className={`flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-accent/50 ${
                      i > 0 ? "border-t" : ""
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block break-words text-sm">
                        {c.title}
                        {c.kind === "release" && (
                          <span className="ml-1.5 text-[11px] text-amber-300">one pressing</span>
                        )}
                        {c.mbid === status?.mbid && (
                          <span className="ml-1.5 text-[11px] text-emerald-400">current</span>
                        )}
                      </span>
                      <span className="block break-words text-xs text-muted-foreground">
                        {[c.subtitle, c.detail].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      className="shrink-0 gap-1.5"
                      disabled={busy !== null}
                      onClick={() => apply(c.mbid, c.kind)}
                    >
                      {busy === `apply:${c.mbid}` && <Spinner className="size-3" />}
                      Apply
                    </Button>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Compact status pill for a detail-page header. Fetches its own status so a
 *  page only has to say which entity it is. */
export function MbStatusChip({
  kind,
  entityId,
  reloadKey = 0,
  onClick,
}: {
  kind: MbEntityKind;
  entityId: number;
  reloadKey?: number;
  onClick?: () => void;
}) {
  const [status, setStatus] = useState<MbStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    invoke<MbStatus>("mb_status", { kind, entityId })
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [kind, entityId, reloadKey]);

  if (!loaded) return null;
  const st = mbStateOf(status);
  const tone =
    st.state === "matched"
      ? "border-emerald-500/40 text-emerald-300"
      : st.state === "mismatch"
        ? "border-amber-500/40 text-amber-300"
        : "border-border text-muted-foreground";

  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:text-foreground ${tone}`}
    >
      MusicBrainz · {st.label}
    </button>
  );
}
