import { useCallback, useEffect, useRef, useState } from "react";
import { useFlipList } from "@/hooks/useFlipList";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClearableInput } from "@/components/ui/clearable-input";
import { Spinner } from "@/components/ui/spinner";
import { Search, Undo2, GitMerge, Equal, CircleAlert, CircleCheck, CircleSlash, Combine, RefreshCw, FileWarning, TriangleAlert, ChevronRight, Scissors, Music2, VenetianMask } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { MatchDialog } from "./MatchDialog";
import { SplitArtistDialog } from "./EditDialogs";
import { CombineSelectedDialog, type AlbumSelection } from "./CombineSelectedDialog";
import { notifyPendingWorkChanged } from "./PendingWork";
import { PersonaDialog } from "./PersonaDialog";

/** The metadata matching/cleaning center — the permanent home for a music
 *  library's external-source state. Two entrances: the import wizard's final
 *  step embeds it, and the sidebar opens it any time after. Sections: match
 *  summary + re-run, uncertain matches, artist merges, unmatched albums
 *  (manual search), incomplete tags (informational — the files imported via
 *  fallbacks and play fine), unreadable files, and the undoable log of what
 *  the automatic pass applied. */

interface MbSuggestion {
  id: number;
  kind: string;
  payload: {
    // album_match
    album_id?: number;
    album_title?: string;
    artist_title?: string | null;
    album_date?: string | null;
    album_tracks?: number;
    /** Candidate release groups — the pass no longer guesses a pressing. */
    groups?: {
      group_id: string;
      title: string;
      artist: string;
      album_type: string | null;
      first_release_date: string | null;
      disambiguation: string | null;
      score: number;
    }[];
    // artist_merge
    keep_id?: number;
    keep_title?: string;
    other_name?: string;
    // artist_split / artist_match
    artist_id?: number;
    artist_name?: string;
    parts?: string[];
    /** artist_match: the few MusicBrainz artists answering to this name —
     *  the pass never picks between same-named strangers, the user does. */
    candidates?: {
      mbid: string;
      title: string;
      subtitle: string;
      detail: string | null;
      score: number;
    }[];
    /** artist_match: where the artist is credited in YOUR library — the
     *  memory jog for a feature-only name. album alone = credited on that
     *  album; track + album = a feature; track alone = a loose track.
     *  group_id links to the album's matched MB release group, so the user
     *  can drill to a release, find the track, and compare its credited
     *  artist against the candidate. */
    appearances?: { track?: string; album?: string | null; group_id?: string | null }[];
    appearance_count?: number;
  };
}

type MbAlbumState = "release" | "album" | "notfound" | "unchecked";

interface MbAlbumRow {
  album_id: number;
  title: string;
  artist_title: string | null;
  state: MbAlbumState;
  gap_ours: number;
  gap_mb: number;
  /** Every credited artist's id — the map hangs the album's chip under each
   *  of their rows (albums have no single owning parent). */
  artist_ids: number[];
  /** User said "stop counting this" — gray on the map, out of every count. */
  ignored: boolean;
  /** User declared the album deliberately partial — missing release tracks
   *  are expected and stop surfacing/counting. */
  partial: boolean;
}

interface MbChange {
  /** The batch — one ACTION, however many rows it wrote. Undo takes this. */
  id: number;
  kind: string;
  label: string;
  undone: boolean;
  created_at: string;
  /** Rows this action wrote; 1 for most. */
  change_count: number;
  kinds: string[];
}

interface MbGapRow {
  /** "ours" — in your library; "mb" — on the matched release. */
  side: "ours" | "mb";
  disc: number;
  position: number;
  title: string;
  /** MusicBrainz's title at the same slot, when both sides have one. */
  counterpart: string | null;
}

interface MbGapAlbum {
  album_id: number;
  title: string;
  artist_title: string | null;
  /** Which release of a multi-version card this diff belongs to. */
  release_label: string | null;
  rows: MbGapRow[];
}

type MbArtistState = "matched" | "notfound" | "unchecked";

interface MbArtistRow {
  artist_id: number;
  title: string;
  state: MbArtistState;
  album_count: number;
  /** User said "stop counting this" — gray on the map, out of every count. */
  ignored: boolean;
}

interface MbReview {
  suggestions: MbSuggestion[];
  albums: MbAlbumRow[];
  artists: MbArtistRow[];
  gaps: MbGapAlbum[];
  changes: MbChange[];
}

export interface MusicMatchState {
  running: boolean;
  unchecked: number;
  /** Artists without an MBID — the pass's artist phase workload. */
  unchecked_artists: number;
  pending_suggestions: number;
  unmatched: number;
  matched: number;
}

interface TagFallbackRow {
  track_id: number;
  file_path: string;
  missing: string[];
}

interface ScanIssueRow {
  file_path: string;
  reason: string;
}

interface MetadataCenterProps {
  libraryId: string;
  /** Re-fetch trigger — bump to reload (e.g. when the hosting dialog opens). */
  reloadKey?: number;
  /** Fired after library data changes underneath (match applied, undo,
   *  suggestion resolved, or a re-run pass landing) so the host can refresh
   *  the pages behind this panel. */
  onChanged?: () => void;
  /** A directive needing a rescan was written (artist split). Hosts that ARE
   *  a wizard run the rescan themselves; without this the request goes out as
   *  the sidebar window event, which is refused while a wizard is open. */
  onRescanNeeded?: (libraryId: string) => void;
  /** Reports the pending-decision count after every load — the wizard shows
   *  it beside Finish as a pointer (never a gate). */
  onDecisionsChange?: (pending: number) => void;
  /** "Run a matching pass" was requested. Wizard hosts jump their stepper
   *  back to the match step; without this the request opens the match-only
   *  wizard through the sidebar window event. */
  onRunPass?: () => void;
}

type PaneId = "queue" | "map" | "albums" | "artists" | "credits" | "gaps" | "files" | "history";

/** A credit name resolving to no artist — the residue the scan refused to
 *  guess about (usually a lookalike routed to a merge suggestion instead of
 *  spawning a duplicate page). */
interface UnlinkedCredit {
  name: string;
  track_count: number;
  album_count: number;
  near_miss_id: number | null;
  near_miss_title: string | null;
}

interface ArtistChoice {
  id: number;
  name: string;
  image: string | null;
  release_count: number;
}

/** Album states, in the order the rail's warning count reads them. The lists
 *  group these into identified (release, album) and not (notfound, unchecked). */
const STATE_ORDER: MbAlbumState[] = ["release", "album", "notfound", "unchecked"];

/** A titled block that stays shut until asked. For lists that are long by
 *  nature and not actionable here — file paths the user fixes elsewhere. */
function Collapsible({
  title,
  note,
  open,
  onToggle,
  children,
}: {
  title: string;
  note?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <ChevronRight size={13} className={open ? "rotate-90 transition-transform" : "transition-transform"} />
        {title}
      </button>
      {open && (
        <>
          {note && <p className="mb-2 mt-1.5 text-xs text-muted-foreground">{note}</p>}
          <div className="overflow-hidden rounded-md border text-sm">{children}</div>
        </>
      )}
    </section>
  );
}

/** "This name is really that artist" — search-and-pick over the library's
 *  existing artists, applied as a merge (name becomes a redirect, credits
 *  re-stamp, undoable from History). For wrong-name credits like "God" on
 *  Yeezus → Kanye West. */
function LinkArtistDialog({
  libraryId,
  sourceName,
  sourceArtistId,
  onOpenChange,
  onDone,
}: {
  libraryId: string;
  sourceName: string;
  /** The name's auto-created page, when acting on an artist row — excluded
   *  from the search so it can't be merged into itself. */
  sourceArtistId: number | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ArtistChoice[] | null>(null);
  const [applying, setApplying] = useState<number | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);

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
          excludeArtistId: sourceArtistId,
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
      await invoke("link_credit_name", {
        libraryId,
        name: sourceName,
        targetArtistId: target.id,
      });
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>“{sourceName}” is an alias for…</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Everything credited to “{sourceName}” moves to the artist you pick, and the name keeps
          resolving there through future rescans. Undoable from History. (For an independent
          identity of the same person — an alter ego with its own work — use Persona instead.)
        </p>
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

interface TagFixTrack {
  track_title: string;
  album_title: string | null;
  file_path: string;
  /** Which tag carries the spelling: "artist tag" | "track title" | "credits". */
  source: string;
}

interface TagFixAlbum {
  album_title: string;
  folder_path: string;
}

/** An alias spelling that still lives in the files' tags. kind 'misspelling'
 *  = user-declared debt (retag + rescan, and this card says exactly which
 *  files); kind 'variant' = neutral, waiting for the user to classify. */
interface TagFix {
  artist_id: number;
  canonical: string;
  wrong: string;
  kind: string;
  tracks: TagFixTrack[];
  track_total: number;
  albums: TagFixAlbum[];
}

/** The fix-at-source card. Declared misspellings say what to retag and where;
 *  neutral variants ask the question instead — "It's a misspelling" starts
 *  the nagging, "It's a nickname" ends it forever. Only the user ever
 *  classifies; the machine records spellings without opinions. */
function TagFixCard({
  fix,
  busy,
  busyKey,
  onSetKind,
}: {
  fix: TagFix;
  busy: boolean;
  busyKey: string | null;
  onSetKind: (fix: TagFix, kind: "misspelling" | "nickname") => void;
}) {
  const [open, setOpen] = useState(false);
  const extra = fix.track_total - fix.tracks.length;
  const declared = fix.kind === "misspelling";
  const summary = [
    fix.track_total > 0 &&
      `${fix.track_total} track tag${fix.track_total === 1 ? "" : "s"}`,
    fix.albums.length > 0 &&
      `${fix.albums.length} album tag${fix.albums.length === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const spin = busyKey?.startsWith(`aliaskind:${fix.artist_id}:${fix.wrong}`);
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm">
          {declared ? (
            <>
              “{fix.wrong}” should be “{fix.canonical}”
            </>
          ) : (
            <>
              “{fix.wrong}” — a spelling of “{fix.canonical}”
            </>
          )}
          <span className="block text-[11px] text-muted-foreground">
            {declared
              ? `${summary} still carry the old spelling — fix them at the source, then rescan`
              : `in ${summary} — a misspelling to fix, or a nickname to keep?`}
          </span>
        </p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {open ? "hide files" : "show files"}
        </button>
        {!declared && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5"
            disabled={busy}
            title="Wrong text — flags these files for retagging until the spelling is gone"
            onClick={() => onSetKind(fix, "misspelling")}
          >
            {spin && <Spinner className="size-3" />}
            It’s a misspelling
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5"
          disabled={busy}
          title="Intended moniker, not a typo — keeps resolving here, never flagged"
          onClick={() => onSetKind(fix, "nickname")}
        >
          {spin && declared && <Spinner className="size-3" />}
          It’s a nickname
        </Button>
      </div>
      {open && (
        <div className="mt-2 overflow-hidden rounded-md border">
          {fix.albums.map((al, i) => (
            <div key={`al-${al.folder_path}`} className={`px-3 py-1.5 ${i > 0 ? "border-t" : ""}`}>
              <span className="block text-xs">
                album-artist tag on <span className="font-medium">{al.album_title}</span>
              </span>
              <span className="block min-w-0 break-all font-mono text-[11px] text-muted-foreground">
                {al.folder_path}
              </span>
            </div>
          ))}
          {fix.tracks.map((t, i) => (
            <div
              key={`t-${t.file_path}`}
              className={`px-3 py-1.5 ${i > 0 || fix.albums.length > 0 ? "border-t" : ""}`}
            >
              <span className="block text-xs">
                “{t.track_title}”{t.album_title ? ` on ${t.album_title}` : ""}
                <span className="text-muted-foreground"> · in the {t.source}</span>
              </span>
              <span className="block min-w-0 break-all font-mono text-[11px] text-muted-foreground">
                {t.file_path}
              </span>
            </div>
          ))}
          {extra > 0 && (
            <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
              +{extra} more track{extra === 1 ? "" : "s"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface ClusterMember {
  /** null = a bare credit spelling with no artist page of its own. */
  artist_id: number | null;
  name: string;
  albums: number;
  unmatched_albums: number;
  tracks: number;
  mbid: string | null;
}

interface IdentityCluster {
  key: string;
  /** Most-albums-first — members[0] is the natural survivor default. */
  members: ClusterMember[];
  /** Unmatched albums across members: pass work resolving this unlocks. */
  unlocks: number;
}

interface ClusterCandidate {
  kind: string;
  mbid: string;
  title: string;
  subtitle: string;
  detail: string | null;
  score: number;
}

/** One MB search for the whole cluster: confirming a candidate merges every
 *  spelling into the survivor, matches it, and lets the ordinary artist-match
 *  path adopt MusicBrainz's canonical name — so which tag spelling "survives"
 *  stops mattering. */
function ClusterMatchDialog({
  libraryId,
  cluster,
  survivorId,
  onOpenChange,
  onDone,
}: {
  libraryId: string;
  cluster: IdentityCluster;
  survivorId: number;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const survivorName =
    cluster.members.find((m) => m.artist_id === survivorId)?.name ?? cluster.members[0]?.name ?? "";
  const [query, setQuery] = useState(survivorName);
  const [results, setResults] = useState<ClusterCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const searchedOnce = useRef(false);

  const search = async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const rows = await invoke<ClusterCandidate[]>("mb_search_entity", {
        kind: "artist",
        query: q,
      });
      setResults(rows);
    } catch (e) {
      toast.error(String(e));
      setResults([]);
    } finally {
      setSearching(false);
    }
  };
  useEffect(() => {
    if (!searchedOnce.current) {
      searchedOnce.current = true;
      search(survivorName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async (mbid: string) => {
    setApplying(mbid);
    try {
      await invoke("mb_resolve_cluster", {
        libraryId,
        survivorId,
        mergeArtistIds: cluster.members
          .filter((m) => m.artist_id != null && m.artist_id !== survivorId)
          .map((m) => m.artist_id as number),
        mergeNames: cluster.members.filter((m) => m.artist_id == null).map((m) => m.name),
      });
      await invoke("mb_apply_entity_match", { kind: "artist", entityId: survivorId, mbid });
      toast.success(
        `${cluster.members.length} spellings resolved to one matched artist.`,
      );
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(String(e));
      setApplying(null);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Who is this artist?</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Confirming merges {cluster.members.map((m) => `“${m.name}”`).join(", ")} into one page,
          matches it to MusicBrainz, and adopts the canonical name — every old spelling lives on as
          an alias. Undoable from History.
        </p>
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(query);
            }}
            placeholder="Search MusicBrainz artists, or paste an artist URL/ID…"
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={searching}
            onClick={() => search(query)}
          >
            {searching ? <Spinner className="size-3" /> : <Search size={13} />}
          </Button>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-md border">
          {(results ?? []).map((r, i) => (
            <div
              key={r.mbid}
              className={`flex items-center gap-2 px-2 py-1.5 ${i === 0 ? "" : "border-t"}`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{r.title}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {r.subtitle}
                  {r.detail ? ` · ${r.detail}` : ""}
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => openUrl(`https://musicbrainz.org/artist/${r.mbid}`)}
              >
                view
              </button>
              <Button size="sm" disabled={applying !== null} onClick={() => apply(r.mbid)}>
                {applying === r.mbid && <Spinner className="size-3" />}
                Yes, it&apos;s them
              </Button>
            </div>
          ))}
          {(results ?? []).length === 0 && (
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
              <Search size={12} />
              {searching ? "Searching…" : results === null ? "Searching…" : "No candidates found"}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One suspected identity, every spelling of it, and the whole resolution in
 *  one card — replaces the old pairwise "Merge A into B" cards, which never
 *  showed how many spellings existed or what name would come out the end. */
function ClusterCard({
  cluster,
  busy,
  busyKey,
  onMatch,
  onMergeOnly,
  onEject,
}: {
  cluster: IdentityCluster;
  busy: boolean;
  busyKey: string | null;
  onMatch: (cluster: IdentityCluster, survivorId: number) => void;
  onMergeOnly: (cluster: IdentityCluster, survivorId: number) => void;
  onEject: (name: string) => void;
}) {
  const pages = cluster.members.filter((m) => m.artist_id != null);
  const matchedPages = pages.filter((m) => m.mbid);
  const distinctIds = new Set(matchedPages.map((m) => m.mbid)).size;
  // A matched member is the only safe survivor (the absorbed page's own id
  // would be lost); otherwise the biggest page leads.
  const defaultSurvivor = (matchedPages[0] ?? pages[0])?.artist_id ?? null;
  const [survivor, setSurvivor] = useState<number | null>(defaultSurvivor);
  const effSurvivor = pages.some((m) => m.artist_id === survivor) ? survivor : defaultSurvivor;
  const survivorName = cluster.members.find((m) => m.artist_id === effSurvivor)?.name;
  // Exactly one matched member = identity already settled; merging into it is
  // a one-click quick win, no MB search needed.
  const identityKnown = distinctIds === 1 && matchedPages.length >= 1;
  // Two members holding DIFFERENT MusicBrainz ids are provably different
  // artists — merging is off the table; only ejections make sense.
  const conflicted = distinctIds >= 2;

  const counts = (m: ClusterMember) => {
    const parts = [
      m.albums > 0 && `${m.albums} album${m.albums === 1 ? "" : "s"}`,
      m.tracks > 0 && `${m.tracks} track credit${m.tracks === 1 ? "" : "s"}`,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : "credits only";
  };

  return (
    <div data-flip-id={`cluster-${cluster.key}`} className="rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="min-w-0 text-sm font-medium">
          <GitMerge size={14} className="mr-1.5 inline text-muted-foreground" />
          One artist, {cluster.members.length} spellings?
        </p>
      </div>
      <div className="mb-2 overflow-hidden rounded-md border">
        {cluster.members.map((m, i) => (
          <label
            key={m.name}
            className={`flex items-center gap-2 px-2 py-1.5 ${i === 0 ? "" : "border-t"} ${
              m.artist_id != null && !conflicted ? "cursor-pointer" : ""
            }`}
          >
            {!conflicted && (
              <input
                type="radio"
                disabled={m.artist_id == null || busy || (identityKnown && !m.mbid)}
                checked={effSurvivor === m.artist_id && m.artist_id != null}
                onChange={() => setSurvivor(m.artist_id)}
                className="accent-primary"
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">“{m.name}”</span>
              <span className="block text-[11px] text-muted-foreground">{counts(m)}</span>
            </span>
            {m.mbid && (
              <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                matched
              </span>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                onEject(m.name);
              }}
              className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {busyKey === `eject:${m.name}` ? "…" : "not the same"}
            </button>
          </label>
        ))}
      </div>
      {conflicted ? (
        <p className="text-[11px] text-muted-foreground">
          Two of these hold different MusicBrainz identities — provably separate artists. If a
          spelling doesn&apos;t belong here, mark it &ldquo;not the same&rdquo;.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {identityKnown ? (
            <Button
              size="sm"
              className="gap-1.5"
              disabled={busy || effSurvivor == null}
              onClick={() => onMergeOnly(cluster, effSurvivor as number)}
            >
              {busyKey === `cluster:${cluster.key}` && <Spinner className="size-3" />}
              Merge all into “{survivorName}”
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={busy || effSurvivor == null}
                onClick={() => onMatch(cluster, effSurvivor as number)}
              >
                Match…
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={busy || effSurvivor == null}
                onClick={() => onMergeOnly(cluster, effSurvivor as number)}
              >
                {busyKey === `cluster:${cluster.key}` && <Spinner className="size-3" />}
                Merge only
              </Button>
            </>
          )}
          <span className="text-[11px] text-muted-foreground">
            {identityKnown
              ? "already matched — one click finishes it"
              : "the radio picks the surviving page; Match adopts the MusicBrainz name either way"}
          </span>
        </div>
      )}
    </div>
  );
}

function ArtistRow({
  a,
  first,
  onMatch,
  onSplit,
  onLink,
  onIgnore,
  onPersona,
  disabled,
}: {
  a: MbArtistRow;
  first: boolean;
  onMatch: (id: number) => void;
  /** Unidentified rows only — a name MusicBrainz can't place is very often
   *  several artists in one tag, and that is the fix. */
  onSplit?: (a: MbArtistRow) => void;
  /** Unidentified rows only — the OTHER wrong-name fix: the tag is one
   *  artist under the wrong name ("God" → Kanye West), so fold it in. */
  onLink?: (a: MbArtistRow) => void;
  /** Unidentified rows only — "not on MusicBrainz, stop counting this":
   *  the artist goes gray on the map and leaves every pass and count. */
  onIgnore?: (a: MbArtistRow) => void;
  /** Any row — link this artist as a persona of another (independent
   *  identity, same human). Matched or not: personas carry their own ids. */
  onPersona?: (a: MbArtistRow) => void;
  /** A pending suggestion owns the row — answer or dismiss it first; the
   *  manual actions unlock once it's gone (hover explains). */
  disabled?: boolean;
}) {
  // Disabled buttons swallow pointer events, so the hover hint rides a
  // wrapper span around each one.
  const withHint = (btn: React.ReactNode, key: string) =>
    disabled ? (
      <TooltipProvider key={key}>
        <Tooltip>
          <TooltipTrigger render={<span className="shrink-0" />}>{btn}</TooltipTrigger>
          <TooltipContent>dismiss suggestion to unlock</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : (
      btn
    );
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 text-sm ${first ? "" : "border-t"}`}>
      <span className="min-w-0 flex-1 truncate">
        {a.title}
        <span className="ml-1.5 text-[11px] text-muted-foreground">
          {a.album_count} {a.album_count === 1 ? "release" : "releases"}
        </span>
        {/* The pass searched this name and MusicBrainz had nothing — the
            artist route is a dead end, so point at the other one. */}
        {a.state === "notfound" && a.album_count > 0 && (
          <span className="ml-1.5 text-[11px] text-amber-300/90">
            not on MusicBrainz — match their albums
          </span>
        )}
      </span>
      {onIgnore &&
        a.state !== "matched" &&
        withHint(
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 gap-1 px-2 text-xs"
            disabled={disabled}
            onClick={() => onIgnore(a)}
          >
            <CircleSlash size={12} />
            Ignore
          </Button>,
          "ignore",
        )}
      {onLink &&
        a.state !== "matched" &&
        withHint(
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 gap-1 px-2 text-xs"
            disabled={disabled}
            onClick={() => onLink(a)}
          >
            <Equal size={12} />
            Alias
          </Button>,
          "alias",
        )}
      {/* Personas apply to matched artists too (they carry their own ids),
          so this one isn't gated on state. */}
      {onPersona &&
        withHint(
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 gap-1 px-2 text-xs"
            disabled={disabled}
            onClick={() => onPersona(a)}
          >
            <VenetianMask size={12} />
            Persona
          </Button>,
          "persona",
        )}
      {onSplit &&
        a.state !== "matched" &&
        withHint(
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 gap-1 px-2 text-xs"
            disabled={disabled}
            onClick={() => onSplit(a)}
          >
            <Scissors size={12} />
            Split
          </Button>,
          "split",
        )}
      {/* An identified artist's button states the fact rather than repeating
          the invitation — it still opens the dialog, where you can look at
          the id or unmatch. */}
      {withHint(
        <Button
          size="sm"
          variant="ghost"
          className={`h-6 shrink-0 gap-1 px-2 text-xs ${
            a.state === "matched" ? "text-emerald-400 hover:text-emerald-300" : ""
          }`}
          disabled={disabled}
          onClick={() => onMatch(a.artist_id)}
        >
          {a.state === "matched" ? (
            <>
              <CircleCheck size={12} className="-translate-y-px" />
              Matched
            </>
          ) : (
            <>
              <Search size={12} />
              Match
            </>
          )}
        </Button>,
        "match",
      )}
    </div>
  );
}

function AlbumRow({
  a,
  first,
  onMatch,
  onIgnore,
  onCombine,
}: {
  a: MbAlbumRow;
  first: boolean;
  onMatch: (id: number) => void;
  /** Unidentified rows only — "not on MusicBrainz, stop counting this". */
  onIgnore?: (a: MbAlbumRow) => void;
  /** Fold this album together with another (duplicates spotted in the list). */
  onCombine?: (a: MbAlbumRow) => void;
}) {
  const identified = a.state === "release" || a.state === "album";
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 text-sm ${first ? "" : "border-t"}`}>
      <span className="min-w-0 flex-1 truncate">
        {a.title}
        {a.artist_title && <span className="text-muted-foreground"> — {a.artist_title}</span>}
        {(a.gap_ours > 0 || a.gap_mb > 0) && (
          <span className="ml-1.5 text-[11px] text-amber-300">
            {[a.gap_ours > 0 && `${a.gap_ours} unmatched`, a.gap_mb > 0 && `${a.gap_mb} missing`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </span>
      {onCombine && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 gap-1 px-2 text-xs"
          onClick={() => onCombine(a)}
        >
          <Combine size={12} />
          Combine
        </Button>
      )}
      {onIgnore && !identified && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 gap-1 px-2 text-xs"
          onClick={() => onIgnore(a)}
        >
          <CircleSlash size={12} />
          Ignore
        </Button>
      )}
      {/* The button states the row's one remaining job: a group-matched
          album needs its release picked (the dialog opens straight onto the
          picker), a full match just states the fact. */}
      <Button
        size="sm"
        variant="ghost"
        className={`h-6 shrink-0 gap-1 px-2 text-xs ${
          a.state === "release"
            ? "text-emerald-400 hover:text-emerald-300"
            : a.state === "album"
              ? "text-amber-300 hover:text-amber-200"
              : ""
        }`}
        onClick={() => onMatch(a.album_id)}
      >
        {a.state === "release" ? (
          <>
            <CircleCheck size={12} className="-translate-y-px" />
            Matched
          </>
        ) : a.state === "album" ? (
          <>
            <TriangleAlert size={12} className="-translate-y-px" />
            Pick release
          </>
        ) : (
          <>
            <Search size={12} />
            Match
          </>
        )}
      </Button>
    </div>
  );
}

/** Change kinds in the log → words. */
const KIND_WORD: Record<string, string> = {
  track_credits: "credits",
  album_artists: "album artist",
  album_type: "type",
  album_title: "title",
  artist_rename: "renamed",
  artist_persona: "persona",
  album_year: "date",
  alias_kind: "alias",
  album_partial: "partial",
  artist_merge: "artist merge",
  artist_mbid: "artist match",
  album_match: "album match",
  track_match: "track match",
  suggestion_rejected: "declined",
  mb_ignored: "ignored",
};
const KIND_LABELS = (kinds: string[]) =>
  kinds.map((k) => KIND_WORD[k] ?? k).join(", ");

export function MetadataCenter({
  libraryId,
  reloadKey = 0,
  onChanged,
  onRescanNeeded,
  onDecisionsChange,
  onRunPass,
}: MetadataCenterProps) {
  const [review, setReview] = useState<MbReview | null>(null);
  const [matchState, setMatchState] = useState<MusicMatchState | null>(null);
  const [fallbacks, setFallbacks] = useState<TagFallbackRow[]>([]);
  const [issues, setIssues] = useState<ScanIssueRow[]>([]);
  const [unlinked, setUnlinked] = useState<UnlinkedCredit[]>([]);
  // Staged directives (splits, combines, separates) a rescan will apply.
  const [pending, setPending] = useState<
    { id: number; label: string; kind: string; target: string; locked_ids: number[] }[]
  >([]);
  // Applied matches a matching pass has yet to cash in (stamp the artists
  // their credits prove). Cleared wholesale by a completed pass.
  const [pendingPass, setPendingPass] = useState<
    { id: number; target: string; label: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  // Which mutation is in flight ("apply:…", "resolve:…", "undo:…") — the
  // matching button shows a spinner; everything else just disables.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busy = busyKey !== null;
  // Pass progress is NOT rendered here — the match modal owns it. The center
  // only keeps the completion listener (silent refresh) and the running flag
  // (button states + the rail's "open the modal" pointer).
  // Per-suggestion chosen candidate; per-album manual search state.
  const [picked, setPicked] = useState<Record<number, string>>({});
  // Text filter and paging for the album list.
  const [albumFilter, setAlbumFilter] = useState("");
  const [albumLimit, setAlbumLimit] = useState(30);
  // Album / artist opened in the shared match dialog.
  const [matchAlbum, setMatchAlbum] = useState<number | null>(null);
  const [matchArtist, setMatchArtist] = useState<number | null>(null);
  const [splitArtist, setSplitArtist] = useState<MbArtistRow | null>(null);
  // "Is really…" target: a credit name (and its auto-created page, if any).
  const [linkSource, setLinkSource] = useState<{ name: string; artistId: number | null } | null>(null);
  // "Persona of…" target: an artist page being linked to its human.
  const [personaSource, setPersonaSource] = useState<{ id: number; name: string } | null>(null);
  const [clusters, setClusters] = useState<IdentityCluster[]>([]);
  const [tagFixes, setTagFixes] = useState<TagFix[]>([]);
  const [clusterMatch, setClusterMatch] = useState<{
    cluster: IdentityCluster;
    survivorId: number;
  } | null>(null);
  const [artistFilter, setArtistFilter] = useState("");
  const [artistLimit, setArtistLimit] = useState(30);
  // Which pane the right-hand side is showing. Starts on the map — the
  // landing effect only ever redirects AWAY from it (opt-out libraries), so
  // the initial selection never visibly jumps.
  const [pane, setPane] = useState<PaneId>("map");
  const [hideUndone, setHideUndone] = useState(false);
  const [changeLimit, setChangeLimit] = useState(25);
  // Per-library opt-out: false hides every MusicBrainz-backed pane, leaving
  // the local ones (unlinked credits, file problems, history).
  const [onlineEnabled, setOnlineEnabled] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [rev, ms, fb, iss, unl, pend, pass, ls, clus, tf] = await Promise.all([
        invoke<MbReview>("mb_get_review", { libraryId }),
        invoke<MusicMatchState>("music_match_state", { libraryId }),
        invoke<TagFallbackRow[]>("get_music_tag_fallbacks", { libraryId }),
        invoke<ScanIssueRow[]>("get_music_scan_issues", { libraryId }),
        invoke<UnlinkedCredit[]>("get_unlinked_credits", { libraryId }),
        invoke<
          { id: number; label: string; kind: string; target: string; locked_ids: number[] }[]
        >("get_pending_changes", { libraryId }),
        invoke<{ id: number; target: string; label: string }[]>("get_pending_pass", {
          libraryId,
        }),
        invoke<Record<string, string>>("get_library_settings", { libraryId }),
        invoke<IdentityCluster[]>("mb_identity_clusters", { libraryId }),
        invoke<TagFix[]>("get_tag_fixes", { libraryId }),
      ]);
      setReview(rev);
      setMatchState(ms);
      setFallbacks(fb);
      setIssues(iss);
      setUnlinked(unl);
      setPending(pend);
      setPendingPass(pass);
      setClusters(clus);
      setTagFixes(tf);
      setOnlineEnabled(ls["online_metadata"] !== "off");
      // Outside surfaces (sidebar badge, library-page strip) mirror both
      // queues — tell them whenever the center's view of them refreshes.
      notifyPendingWorkChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [libraryId]);

  useEffect(() => {
    setPicked({});
    refresh();
  }, [refresh, reloadKey]);

  useEffect(() => {
    setAlbumLimit(30);
  }, [albumFilter]);

  // A pass runs behind this panel (started from here, or the wizard): the
  // MODAL shows its progress; this only refreshes the lists when it lands.
  useEffect(() => {
    const unDone = listen<{ libraryId: string }>("music-enrich-done", (e) => {
      if (e.payload.libraryId === libraryId) {
        // Our own drain emits this per applied item — refreshing then would
        // both collapse the frozen list mid-aim and flood the DB with reads
        // that contend with the next item's writes. The drain does its own
        // single refresh at the end.
        if (quickDrainingRef.current) return;
        refresh();
        onChanged?.();
      }
    });
    return () => {
      unDone.then((fn) => fn());
    };
  }, [libraryId, refresh, onChanged]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await fn();
    } catch (e) {
      toast.error(String(e));
    } finally {
      // Refresh even on failure — some errors dismiss the item they were
      // about (e.g. a stale merge suggestion), and the list must show that.
      await refresh();
      setBusyKey(null);
      onChanged?.();
    }
  };

  const applyMatch = (albumId: number, groupId: string) =>
    run(`apply:${albumId}:${groupId}`, () =>
      invoke("mb_apply_entity_match", {
        kind: "album",
        entityId: albumId,
        mbid: groupId,
        mbidKind: "release-group",
      }),
    );
  const resolve = (suggestionId: number, accept: boolean) =>
    run(`resolve:${suggestionId}:${accept}`, () =>
      invoke("mb_resolve_suggestion", { libraryId, suggestionId, accept }),
    );
  const mergeCluster = (c: IdentityCluster, survivorId: number) =>
    run(`cluster:${c.key}`, async () => {
      const survivorName = c.members.find((m) => m.artist_id === survivorId)?.name ?? "";
      await invoke("mb_resolve_cluster", {
        libraryId,
        survivorId,
        mergeArtistIds: c.members
          .filter((m) => m.artist_id != null && m.artist_id !== survivorId)
          .map((m) => m.artist_id as number),
        mergeNames: c.members.filter((m) => m.artist_id == null).map((m) => m.name),
      });
      toast.success(`${c.members.length} spellings merged into “${survivorName}”.`);
    });
  const ejectMember = (name: string) =>
    run(`eject:${name}`, () => invoke("mb_keep_separate", { libraryId, name }));
  const setAliasKind = (fix: TagFix, kind: "misspelling" | "nickname") =>
    run(`aliaskind:${fix.artist_id}:${fix.wrong}`, async () => {
      await invoke("set_alias_kind", {
        libraryId,
        artistId: fix.artist_id,
        name: fix.wrong,
        kind,
      });
      toast.success(
        kind === "nickname"
          ? `“${fix.wrong}” kept as a nickname of ${fix.canonical}.`
          : `“${fix.wrong}” flagged — its files stay listed until retagged.`,
      );
    });

  // ── Quick-win staging queue ───────────────────────────────────────────
  // Each apply costs a rate-limited MusicBrainz round-trip, so clicking one
  // at a time makes the USER the rate limiter. Two-phase, like everything
  // staged in this app: clicks only MARK rows (instant, reversible, zero
  // layout shift), an explicit Apply processes them serially, and while it
  // runs every button in the band is locked — a list must never reflow
  // under a cursor that's about to click (that's how wrong rows get hit).
  // One refresh at the end instead of one per item.
  const quickQueueRef = useRef<QuickWin[]>([]);
  const quickDrainingRef = useRef(false);
  const [quickDraining, setQuickDraining] = useState(false);
  const [queuedQuickKeys, setQueuedQuickKeys] = useState<Set<string>>(new Set());
  const [doneQuickKeys, setDoneQuickKeys] = useState<Set<string>>(new Set());
  const [activeQuickKey, setActiveQuickKey] = useState<string | null>(null);
  const quickWinKey = (w: QuickWin) => (w.t === "cluster" ? `qw-c-${w.c.key}` : `qw-s-${w.s.id}`);
  const execQuickWin = async (w: QuickWin) => {
    if (w.t === "cluster") {
      const survivor = w.c.members.find((m) => m.artist_id != null && m.mbid);
      if (!survivor) return;
      await invoke("mb_resolve_cluster", {
        libraryId,
        survivorId: survivor.artist_id,
        mergeArtistIds: w.c.members
          .filter((m) => m.artist_id != null && m.artist_id !== survivor.artist_id)
          .map((m) => m.artist_id as number),
        mergeNames: w.c.members.filter((m) => m.artist_id == null).map((m) => m.name),
      });
    } else if (w.t === "artist") {
      await invoke("mb_apply_entity_match", {
        kind: "artist",
        entityId: w.s.payload.artist_id,
        mbid: w.s.payload.candidates![0].mbid,
        mbidKind: null,
      });
    } else {
      await invoke("mb_apply_entity_match", {
        kind: "album",
        entityId: w.s.payload.album_id,
        mbid: w.s.payload.groups![0].group_id,
        mbidKind: "release-group",
      });
    }
  };
  const applyQueuedQuickWins = async () => {
    if (quickDrainingRef.current || quickQueueRef.current.length === 0) return;
    quickDrainingRef.current = true;
    setQuickDraining(true);
    try {
      for (;;) {
        const w = quickQueueRef.current.shift();
        if (!w) break;
        const k = quickWinKey(w);
        setActiveQuickKey(k);
        setQueuedQuickKeys(new Set(quickQueueRef.current.map(quickWinKey)));
        try {
          await execQuickWin(w);
          // Done rows stay in place, inert, until the single end refresh —
          // no row ever vanishes while its neighbors are being aimed at.
          setDoneQuickKeys((prev) => new Set(prev).add(k));
        } catch (e) {
          // The item's card survives the end-of-drain refresh; the rest of
          // the queue keeps going.
          toast.error(String(e));
        }
      }
    } finally {
      quickDrainingRef.current = false;
      setActiveQuickKey(null);
      await refresh();
      // Collapse happens only now, while the whole band is still locked.
      setDoneQuickKeys(new Set());
      setQuickDraining(false);
      onChanged?.();
    }
  };
  // Stage/unstage — a second click before Apply takes the row back out.
  const toggleQuickWin = (w: QuickWin) => {
    if (quickDrainingRef.current) return;
    const k = quickWinKey(w);
    if (queuedQuickKeys.has(k)) {
      quickQueueRef.current = quickQueueRef.current.filter((x) => quickWinKey(x) !== k);
    } else {
      quickQueueRef.current.push(w);
    }
    setQueuedQuickKeys(new Set(quickQueueRef.current.map(quickWinKey)));
  };
  const undo = (batchId: number) =>
    run(`undo:${batchId}`, () => invoke("mb_undo_batch", { libraryId, batchId }));
  const recheck = (albumId: number) =>
    run(`recheck:${albumId}`, async () => {
      const g = await invoke<{ ours: number; mb: number }>("mb_recheck_album", { albumId });
      const parts = [
        g.ours > 0 && `${g.ours} of your tracks unmatched`,
        g.mb > 0 && `${g.mb} on the release missing here`,
      ].filter(Boolean);
      toast.success(parts.length === 0 ? "Track lists line up now." : `Still ${parts.join(" · ")}.`);
    });
  const dismissGaps = (albumId: number) =>
    run(`gaps:${albumId}`, () => invoke("mb_dismiss_gaps", { albumId }));
  const markPartial = (albumId: number) =>
    run(`partial:${albumId}`, async () => {
      await invoke("mb_set_partial", { entityId: albumId, partial: true });
      toast.success("Marked deliberately partial — missing release tracks stop counting.");
    });
  const setIgnored = (entityId: number, ignored: boolean) =>
    run(`ignore:${entityId}`, () => invoke("mb_set_ignored", { entityId, ignored }));
  // Ignoring gets a confirm (every other row action opens a dialog before
  // touching anything; ignore is the one that would otherwise fire on a bare
  // click). Un-ignoring stays instant — it only returns things to the pool.
  const [confirmIgnore, setConfirmIgnore] = useState<{ entityId: number; name: string } | null>(
    null,
  );
  // Combine from an album row: pick the partner album, then the shared
  // configure dialog (keeper, mode) — same flow the grid's multi-select uses.
  const [combinePartnerFor, setCombinePartnerFor] = useState<MbAlbumRow | null>(null);
  const [partnerFilter, setPartnerFilter] = useState("");
  const [combineSelect, setCombineSelect] = useState<AlbumSelection | null>(null);

  // The pass runs in the wizard modal (match-only mode), not in this rail:
  // embedded hosts (the wizard's review step) jump their own stepper back,
  // everyone else opens the modal through the window event App/Sidebar own.
  const rerunMatching = async () => {
    if (onRunPass) {
      onRunPass();
      return;
    }
    window.dispatchEvent(
      new CustomEvent("waverunner:open-match", { detail: { libraryId } }),
    );
  };

  const albums = review?.albums ?? [];
  // A staged split/combine has already decided these entities' fate — they
  // dissolve when the rescan applies. Their rows leave the work lists and
  // every edit locks until then (or until the staging is undone): a match or
  // ignore made now would be silently discarded with the entity.
  const stagedLockedIds = new Set(pending.flatMap((p) => p.locked_ids));
  const stagedSplitNames = new Set(
    pending.filter((p) => p.kind === "artist_split").map((p) => p.target),
  );
  // Ignored entities have left the counting: the tallies (and the unmatched
  // work lists) only see what still wants matching. The map is where gray
  // lives and gets un-ignored.
  const counts = STATE_ORDER.reduce(
    (acc, st) => ({ ...acc, [st]: albums.filter((a) => a.state === st && !a.ignored).length }),
    {} as Record<MbAlbumState, number>,
  );
  const albumMatches = (a: MbAlbumRow) =>
    albumFilter.trim() === "" ||
    `${a.title} ${a.artist_title ?? ""}`.toLowerCase().includes(albumFilter.trim().toLowerCase());
  const albumsUnmatched = albums.filter(
    (a) =>
      (a.state === "notfound" || a.state === "unchecked") &&
      !a.ignored &&
      !stagedLockedIds.has(a.album_id) &&
      albumMatches(a),
  );
  const albumsIdentified = albums.filter(
    (a) => (a.state === "release" || a.state === "album") && albumMatches(a),
  );
  // The identified list, split by how far the identification goes: a group
  // match names the album but not the pressing, so its track list can't be
  // checked yet — amber, one release-pick away from green.
  const albumsReleaseUnknown = albumsIdentified.filter((a) => a.state === "album");
  const albumsFullyIdentified = albumsIdentified.filter((a) => a.state === "release");
  const visibleChanges = (review?.changes ?? []).filter((c) => !hideUndone || !c.undone);
  const artists = review?.artists ?? [];
  const artistMatches = (a: MbArtistRow) =>
    artistFilter.trim() === "" || a.title.toLowerCase().includes(artistFilter.trim().toLowerCase());
  const artistsUnmatched = artists.filter(
    (a) => a.state !== "matched" && !a.ignored && artistMatches(a),
  );
  const notStagedSplit = (a: MbArtistRow) =>
    !stagedSplitNames.has(a.title.toLowerCase()) && !stagedLockedIds.has(a.artist_id);
  // The guide's stage-1/stage-3 boundary, made visible in the page structure:
  // owners unlock albums, features get unlocked BY albums. Split on the same
  // predicate the guide counts with, so its "N left" agrees with the header
  // its Go button lands on.
  const artistsUnmatchedOwners = artistsUnmatched.filter(
    (a) => a.album_count > 0 && notStagedSplit(a),
  );
  const artistsUnmatchedFeatures = artistsUnmatched.filter(
    (a) => a.album_count === 0 && notStagedSplit(a),
  );
  const artistsIdentified = artists.filter((a) => a.state === "matched" && artistMatches(a));
  const artistsMatched = artists.filter((a) => a.state === "matched").length;

  const albumSuggestions = review?.suggestions.filter((s) => s.kind === "album_match") ?? [];
  const artistSuggestions = review?.suggestions.filter((s) => s.kind === "artist_match") ?? [];

  // No gate: decisions lead the nav and their count nags, but every pane
  // stays open — the user decided required-answering wasn't worth the wall.
  // Pairwise merge suggestions became identity clusters (live-computed, one
  // card per suspected identity) — each cluster counts as one decision.
  const decisionsPending =
    albumSuggestions.length + clusters.length + artistSuggestions.length;
  useEffect(() => {
    // Only report once real data is in, not the initial empty state.
    if (review) onDecisionsChange?.(decisionsPending);
  }, [review, decisionsPending, onDecisionsChange]);
  // The pane exists only while there's something to decide — resolving the
  // last item lands you on Artists rather than an empty page whose nav entry
  // just vanished.
  // Bounce for the appear-only-when-nonempty panes: clearing the last item
  // must not strand the user on a pane whose nav entry vanished.
  useEffect(() => {
    if (!review) return;
    if (
      (pane === "credits" && unlinked.length === 0) ||
      (pane === "gaps" && review.gaps.length === 0)
    )
      setPane(onlineEnabled ? "map" : "files");
  }, [pane, review, unlinked, onlineEnabled]);
  // Opted out: every MusicBrainz-backed pane is hidden — a stale selection
  // (or a just-flipped setting) redirects to the local ground.
  useEffect(() => {
    if (!review || onlineEnabled) return;
    if (
      pane === "artists" ||
      pane === "albums" ||
      pane === "gaps" ||
      pane === "map" ||
      pane === "queue"
    )
      setPane("files");
  }, [review, onlineEnabled, pane]);
  // Each OPEN lands on the Library map — the guided process is the home, and
  // Suggestions is one of the stops it routes to, not the front door. Once
  // per open — after that the user's pane choice stands.
  const landedRef = useRef(false);
  useEffect(() => {
    landedRef.current = false;
  }, [reloadKey, libraryId]);
  useEffect(() => {
    if (!review || landedRef.current) return;
    landedRef.current = true;
    // The map is home — the whole-library picture; the guided queue sits one
    // click below it.
    setPane(!onlineEnabled ? "files" : "map");
  }, [review, onlineEnabled]);

  const running = matchState?.running ?? false;

  // The matching-guide stages, derived from data every render — never stored.
  // 1: artists who own albums here (each Yes arid-unlocks their discography
  // on the next pass), 2: the albums themselves (matched albums prove their
  // credited artists), 3: feature-only leftovers. Rescans and passes advance
  // the stages on their own; the guide is a lens, not a gate.
  // Staged rows are excluded everywhere the LISTS exclude them — a count
  // must agree with the list its Go button lands on (staged splits/combines
  // dissolve on the next rescan; their rows already left the work lists).
  const guideOwnerLeft = artists.filter(
    (a) => a.state !== "matched" && !a.ignored && a.album_count > 0 && notStagedSplit(a),
  ).length;
  const guideAlbumsLeft = albums.filter(
    (a) =>
      a.state !== "release" &&
      a.state !== "album" &&
      !a.ignored &&
      !stagedLockedIds.has(a.album_id),
  ).length;
  const guideFeatureLeft = artistSuggestions.filter((s) => {
    const row = artists.find((a) => a.artist_id === s.payload.artist_id);
    return !row ? true : !row.ignored && row.album_count === 0 && notStagedSplit(row);
  }).length;
  const guideStage =
    guideOwnerLeft > 0 ? 1 : guideAlbumsLeft > 0 ? 2 : guideFeatureLeft > 0 ? 3 : 0;

  // Suggestions ordered by the map's doctrine: owner-artist questions are
  // stage-1 work (each answer arid-unlocks a discography), feature-artist
  // questions are stage-3 residue that album matches usually answer for free.
  const suggestionIsOwner = (s: MbSuggestion) => {
    const row = artists.find((a) => a.artist_id === s.payload.artist_id);
    return !!row && row.album_count > 0;
  };
  const artistSuggestionsOwners = artistSuggestions.filter(suggestionIsOwner);
  const artistSuggestionsFeatures = artistSuggestions.filter((s) => !suggestionIsOwner(s));
  // Suggestion per artist row, for embedding the question in the row itself.
  const suggestionByArtist = new Map<number | undefined, MbSuggestion>(
    artistSuggestions.map((s) => [s.payload.artist_id, s]),
  );
  // Rows with a ready answer float to the top of their list — they're the
  // cheapest clicks in the stage.
  const readyFirst = (a: MbArtistRow, b: MbArtistRow) =>
    Number(suggestionByArtist.has(b.artist_id)) - Number(suggestionByArtist.has(a.artist_id));

  // One uncertain-album-match card — rendered at the top of the Albums pane,
  // where the stage-2 work lives (there is no Suggestions pane; every card
  // sits with the list it belongs to).
  // Body only (candidate radios + Apply/Dismiss) — the Albums pane wraps it
  // in a titled card; the Next-up queue expands it inline under its row.
  const renderAlbumSuggestionBody = (s: MbSuggestion) => (
    <>
      {/* More than one album on MusicBrainz answers to this name, which is
          exactly when a machine should not choose. */}
      <p className="text-xs text-muted-foreground">
        {(s.payload.groups ?? []).length} albums share this name
      </p>
      <div className="mt-2 space-y-1">
        {(s.payload.groups ?? []).map((g) => (
          <label
            key={g.group_id}
            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/50"
          >
            <input
              type="radio"
              name={`cand-${s.id}`}
              className="mt-1"
              checked={picked[s.id] === g.group_id}
              onChange={() => setPicked((p) => ({ ...p, [s.id]: g.group_id }))}
            />
            <span className="min-w-0 flex-1">
              <span className="block">{g.title}</span>
              <span className="block text-xs text-muted-foreground">
                {[g.artist, g.album_type, g.first_release_date, g.disambiguation]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            {/* Two candidates can render identically — MusicBrainz has
                genuine near-duplicate groups — so every row carries a way to
                go look at the real thing. Through the opener plugin: the
                webview ignores _blank anchors, so a bare <a> silently does
                nothing. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                void openUrl(`https://musicbrainz.org/release-group/${g.group_id}`);
              }}
              className="shrink-0 self-center text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              view
            </button>
          </label>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          className="gap-1.5"
          disabled={busy || !picked[s.id]}
          onClick={() => s.payload.album_id != null && applyMatch(s.payload.album_id, picked[s.id])}
        >
          {busyKey === `apply:${s.payload.album_id}:${picked[s.id]}` && <Spinner className="size-3" />}
          Apply
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={busy}
          onClick={() => resolve(s.id, false)}
        >
          {busyKey === `resolve:${s.id}:false` && <Spinner className="size-3" />}
          Dismiss suggestion
        </Button>
      </div>
    </>
  );

  const renderAlbumCard = (s: MbSuggestion) => (
    <div key={s.id} data-flip-id={`sug-${s.id}`} className="rounded-md border p-3">
      <p className="text-sm font-medium">
        {s.payload.album_title}
        {s.payload.artist_title && (
          <span className="text-muted-foreground"> — {s.payload.artist_title}</span>
        )}
      </p>
      {renderAlbumSuggestionBody(s)}
    </div>
  );

  // The "Which artist is this?" suggestion, rendered INSIDE the artist's own
  // row in the unidentified lists — the question lives on the artist it's
  // about, not in a pile of cards somewhere else.
  const renderArtistSuggestionBody = (s: MbSuggestion) => {
    const candidates = s.payload.candidates ?? [];
    // ONE candidate is a yes/no question, not a pick — no radio to parse,
    // and the buttons say what they mean. Uniqueness on MusicBrainz still
    // isn't identity (your artist may not be on MB at all while a same-named
    // stranger is), hence the ask.
    const single = candidates.length === 1;
    const chosen = picked[s.id] ?? (single ? candidates[0].mbid : undefined);
    return (
      <div className="px-3 pb-2.5">
        <p className="text-xs text-muted-foreground">
          <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
            Suggestion:
          </span>
          {single
            ? "Is this them? One MusicBrainz artist answers to this name"
            : `${candidates.length} MusicBrainz artists answer to this name`}
        </p>
        {(s.payload.appearances?.length ?? 0) > 0 && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            In your library:{" "}
            {s.payload.appearances!.map((a, i) => (
              <span key={i}>
                {i > 0 && " · "}
                <span className="text-foreground/80">
                  {a.track
                    ? a.album
                      ? `“${a.track}” on ${a.album}`
                      : `“${a.track}”`
                    : a.album}
                </span>
                {/* The album's matched MB group: drill to a release there,
                    find this track, and compare its credited artist against
                    the candidate below. */}
                {a.group_id && (
                  <button
                    type="button"
                    onClick={() =>
                      void openUrl(`https://musicbrainz.org/release-group/${a.group_id}`)
                    }
                    className="ml-1 text-[11px] underline-offset-2 hover:text-foreground hover:underline"
                  >
                    view
                  </button>
                )}
              </span>
            ))}
            {(s.payload.appearance_count ?? 0) > s.payload.appearances!.length &&
              ` · +${s.payload.appearance_count! - s.payload.appearances!.length} more`}
          </p>
        )}
        <div className="mt-2 space-y-1">
          {candidates.map((c) => (
            <label
              key={c.mbid}
              className={`flex items-start gap-2 rounded px-1.5 py-1 text-sm ${
                single ? "" : "cursor-pointer hover:bg-accent/50"
              }`}
            >
              {!single && (
                <input
                  type="radio"
                  name={`artist-cand-${s.id}`}
                  className="mt-1"
                  checked={chosen === c.mbid}
                  onChange={() => setPicked((p) => ({ ...p, [s.id]: c.mbid }))}
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block">{c.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {[c.subtitle, c.detail].filter(Boolean).join(" · ")}
                </span>
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  void openUrl(`https://musicbrainz.org/artist/${c.mbid}`);
                }}
                className="shrink-0 self-center text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                view
              </button>
            </label>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            className="gap-1.5"
            disabled={busy || chosen == null || s.payload.artist_id == null}
            onClick={() =>
              run(`artistmatch:${s.id}`, () =>
                invoke("mb_apply_entity_match", {
                  kind: "artist",
                  entityId: s.payload.artist_id,
                  mbid: chosen,
                  mbidKind: null,
                }),
              )
            }
          >
            {busyKey === `artistmatch:${s.id}` && <Spinner className="size-3" />}
            {single ? "Yes, it’s them" : "This one"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy}
            onClick={() => resolve(s.id, false)}
          >
            {/* One label for single and multi: what the click DOES (artist
                stays unidentified) rather than a certainty claim ("not
                them") the user may not be able to make. */}
            {busyKey === `resolve:${s.id}:false` && <Spinner className="size-3" />}
            Dismiss suggestion
          </Button>
        </div>
      </div>
    );
  };

  // The library map's tree, flattened one level: albums grouped under their
  // CREDITED artists (containment instead of edges — a joint album chips
  // under every member), feature-only artists as a dot grid below. "Done" is
  // NOTHING RED — every node matched, group-matched (albums), or gray.
  const albumsByArtist = new Map<number, MbAlbumRow[]>();
  const orphanAlbums: MbAlbumRow[] = [];
  for (const al of albums) {
    if (al.artist_ids.length === 0) {
      orphanAlbums.push(al);
      continue;
    }
    for (const aid of al.artist_ids) {
      const list = albumsByArtist.get(aid);
      if (list) list.push(al);
      else albumsByArtist.set(aid, [al]);
    }
  }
  const albumRed = (a: MbAlbumRow) => !a.ignored && a.state !== "release" && a.state !== "album";
  const artistRed = (a: MbArtistRow) => !a.ignored && a.state !== "matched";
  // Strictly alphabetical (the backend's sort_title order) — the map is a
  // stable picture of the library, not a work queue; the guide's Go buttons
  // and the Artists pane's ready-first lists carry the worklist role.
  const ownerRows = artists.filter((a) => albumsByArtist.has(a.artist_id));
  const featureArtists = artists.filter((a) => !albumsByArtist.has(a.artist_id));
  const mapReds = artists.filter(artistRed).length + albums.filter(albumRed).length;
  // Completion share over the same population the map colors (ignored
  // entities are out of both sides, per doctrine). floor() so 100 can only
  // ever mean literally nothing red — 99.9% done still reads 99%.
  const mapTotal =
    artists.filter((a) => !a.ignored).length + albums.filter((a) => !a.ignored).length;
  const mapPct = mapTotal === 0 ? 100 : Math.floor(((mapTotal - mapReds) / mapTotal) * 100);

  // FLIP for the decision cards: resolving one slides the rest up into the
  // gap instead of snapping (shared recipe — see useFlipList).
  const flipContainerRef = useRef<HTMLDivElement>(null);
  useFlipList(flipContainerRef);

  // Panes share one scroll container, so a bare setPane strands the user at
  // whatever scrollTop the last pane left. Every navigation goes through
  // here: switch, then (post-commit) land on the named section or the top.
  const [paneAnchor, setPaneAnchor] = useState<string | null>(null);
  useEffect(() => {
    if (!paneAnchor) return;
    const el = paneAnchor === "__top" ? null : document.getElementById(paneAnchor);
    if (el) el.scrollIntoView({ block: "start" });
    else flipContainerRef.current?.scrollTo({ top: 0 });
    setPaneAnchor(null);
  }, [pane, paneAnchor]);
  const goTo = (p: PaneId, anchor?: string) => {
    setPaneAnchor(anchor ?? "__top");
    setPane(p);
  };

  if (loading && !review) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <Spinner className="size-6" />
      </div>
    );
  }

  // ── The Next-up queue: every actionable decision ranked payoff ÷ effort ──
  // Quick wins are confirm-tier (one credible answer already on the card, one
  // click each); Big unlocks are search-tier but worth the typing, biggest
  // payoff first. Payoff = albums the decision unlocks for the next pass.
  // Bands are visible and labeled (the user's pick over a seamless ranked
  // feed) so the ordering is legible, never mysterious.
  const clusterTier = (c: IdentityCluster): "oneclick" | "search" | "conflicted" => {
    const ids = new Set(
      c.members.filter((m) => m.artist_id != null && m.mbid).map((m) => m.mbid),
    ).size;
    return ids >= 2 ? "conflicted" : ids === 1 ? "oneclick" : "search";
  };
  const artistRowById = new Map(artists.map((a) => [a.artist_id, a]));
  // Cluster members resolve through their cluster card — they must not also
  // appear as lone artist entries, or the queue double-counts the work.
  const clusterMemberIds = new Set(
    clusters.flatMap((c) =>
      c.members.filter((m) => m.artist_id != null).map((m) => m.artist_id as number),
    ),
  );
  const artistSugRow = (s: MbSuggestion) => {
    const row = s.payload.artist_id != null ? artistRowById.get(s.payload.artist_id) : undefined;
    return row && !row.ignored && notStagedSplit(row) ? row : undefined;
  };
  type QuickWin =
    | { t: "cluster"; c: IdentityCluster; unlocks: number }
    | { t: "artist"; s: MbSuggestion; unlocks: number }
    | { t: "album"; s: MbSuggestion; unlocks: number };
  const quickWins: QuickWin[] = [
    ...clusters
      .filter((c) => clusterTier(c) === "oneclick")
      .map((c) => ({ t: "cluster" as const, c, unlocks: c.unlocks })),
    ...artistSuggestions
      .filter((s) => (s.payload.candidates?.length ?? 0) === 1)
      .flatMap((s) => {
        const row = artistSugRow(s);
        return row ? [{ t: "artist" as const, s, unlocks: row.album_count }] : [];
      }),
    ...albumSuggestions
      .filter(
        (s) =>
          (s.payload.groups?.length ?? 0) === 1 &&
          s.payload.album_id != null &&
          !stagedLockedIds.has(s.payload.album_id),
      )
      .map((s) => ({ t: "album" as const, s, unlocks: 0 })),
  ].sort((a, b) => b.unlocks - a.unlocks);
  type BigUnlock =
    | { t: "cluster"; c: IdentityCluster; unlocks: number }
    | { t: "artist_sug"; s: MbSuggestion; unlocks: number }
    | { t: "artist"; a: MbArtistRow; unlocks: number }
    | { t: "album_sug"; s: MbSuggestion; unlocks: number };
  const bigUnlocks: BigUnlock[] = [
    ...clusters
      .filter((c) => clusterTier(c) === "search")
      .map((c) => ({ t: "cluster" as const, c, unlocks: c.unlocks })),
    ...artistSuggestions
      .filter((s) => (s.payload.candidates?.length ?? 0) > 1)
      .flatMap((s) => {
        const row = artistSugRow(s);
        return row ? [{ t: "artist_sug" as const, s, unlocks: row.album_count }] : [];
      }),
    ...artists
      .filter(
        (a) =>
          a.state !== "matched" &&
          !a.ignored &&
          a.album_count > 0 &&
          notStagedSplit(a) &&
          !suggestionByArtist.has(a.artist_id) &&
          !clusterMemberIds.has(a.artist_id),
      )
      .map((a) => ({ t: "artist" as const, a, unlocks: a.album_count })),
    ...albumSuggestions
      .filter(
        (s) =>
          (s.payload.groups?.length ?? 0) > 1 &&
          s.payload.album_id != null &&
          !stagedLockedIds.has(s.payload.album_id),
      )
      .map((s) => ({ t: "album_sug" as const, s, unlocks: 0 })),
  ].sort((a, b) => b.unlocks - a.unlocks);
  // Declared misspellings nag (Source fixes band + File problems); neutral
  // variants wait quietly under File problems for the user to classify.
  const declaredFixes = tagFixes.filter((f) => f.kind === "misspelling");
  const variantFixes = tagFixes.filter((f) => f.kind === "variant");
  const conflictedClusters = clusters.filter((c) => clusterTier(c) === "conflicted").length;
  // Cleanup tallies: low-payoff residue, shown as pointers, never lists —
  // deciding these before the pass has run is usually wasted work.
  const cleanupFeatures = artists.filter(
    (a) =>
      a.state !== "matched" &&
      !a.ignored &&
      a.album_count === 0 &&
      notStagedSplit(a) &&
      !suggestionByArtist.has(a.artist_id) &&
      !clusterMemberIds.has(a.artist_id),
  ).length;
  const cleanupAlbums = albums.filter(
    (a) => a.state === "notfound" && !a.ignored && !stagedLockedIds.has(a.album_id),
  ).length;

  // `count` is the size of the pane; `alert` (red) is the blocking work —
  // unidentified owners / unidentified albums — and `warn` (amber) the softer
  // tier: feature-only names and albums awaiting a release pick. Same colors
  // as the pane's own section headings, so the rail predicts the page.
  // "Needs a decision" leads — it's required work, not reference — and it
  // only exists while there IS something to decide.
  // Opted out of online metadata: only the LOCAL panes remain — unlinked
  // credits, file problems (and History below). Everything MusicBrainz-backed
  // disappears rather than sitting permanently "unfinished".
  // The map keeps the top slot (the whole-library picture); the guided queue
  // sits right under it, deliberately numberless — it's a PATH, not a pile,
  // and its bands already say how much of each kind is waiting.
  const NAV: { id: PaneId; label: string; count: number; warn?: number; alert?: number }[] = [
    ...(onlineEnabled
      ? [
          {
            id: "map" as const,
            label: "Library map",
            // Rendered as a status word, not numbers — "complete" is the
            // map's whole promise (nothing red), a count is just noise.
            count: 0,
          },
          {
            id: "queue" as const,
            label: "Most efficient actions",
            count: 0,
          },
          {
            id: "artists" as const,
            label: "Artists",
            count: artists.length,
            // Staged-split rows are hidden from the pane's lists — keep the
            // rail's numbers agreeing with what the click reveals.
            alert: artists.filter(
              (a) =>
                a.state !== "matched" && !a.ignored && a.album_count > 0 && notStagedSplit(a),
            ).length,
            warn: artists.filter(
              (a) =>
                a.state !== "matched" && !a.ignored && a.album_count === 0 && notStagedSplit(a),
            ).length,
          },
          {
            id: "albums" as const,
            label: "Albums",
            count: albums.length,
            alert: albums.filter(
              (a) =>
                (a.state === "notfound" || a.state === "unchecked") &&
                !a.ignored &&
                !stagedLockedIds.has(a.album_id),
            ).length,
            warn: albums.filter(
              (a) => a.state === "album" && !a.ignored && !stagedLockedIds.has(a.album_id),
            ).length,
          },
        ]
      : []),
    ...(unlinked.length > 0
      ? [
          {
            id: "credits" as const,
            label: "Unlinked credits",
            count: unlinked.length,
            warn: unlinked.length,
          },
        ]
      : []),
    ...(onlineEnabled && (review?.gaps.length ?? 0) > 0
      ? [
          {
            id: "gaps" as const,
            label: "Track lists differ",
            count: review?.gaps.length ?? 0,
          },
        ]
      : []),
    {
      id: "files",
      label: "File problems",
      count: fallbacks.length + issues.length + tagFixes.length,
      warn: issues.length + declaredFixes.length,
    },
  ];
  // History is pinned to the nav's bottom, apart from the work sections — a
  // ledger, not a queue.
  const historyCount = review?.changes.length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The recorded opt-out, visible and reversible where it bites. */}
      {review && !onlineEnabled && (
        <div className="mb-3 mr-4 flex items-center gap-3 rounded-md border px-3 py-2">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Online metadata is off for this library — nothing here talks to MusicBrainz, and
            albums and artists aren’t matched.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={busy}
            onClick={async () => {
              try {
                await invoke("set_library_setting", {
                  libraryId,
                  key: "online_metadata",
                  value: "on",
                });
                await refresh();
                toast.success("Online metadata is on — run a matching pass to start identifying.");
              } catch (e) {
                toast.error(String(e));
              }
            }}
          >
            Turn on
          </Button>
        </div>
      )}
      {/* Staged directives waiting for one rescan — splits, combines,
          separates accumulate here instead of each forcing its own rescan.
          Any rescan applies (and clears) the whole batch. */}
      {pending.length > 0 && (
        // mr-4: the host containers end at the modal edge (pr-0, so the pane
        // scrollbar can sit flush) — right spacing is each block's own job.
        <div className="mb-3 mr-4 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2">
          <div className="flex items-center gap-3">
            <TriangleAlert size={14} className="shrink-0 text-red-400" />
            <p className="min-w-0 flex-1 text-sm text-red-200/90">
              {pending.length} staged {pending.length === 1 ? "change" : "changes"} — applied by the
              next rescan
            </p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={busy || running}
              onClick={() => {
                if (onRescanNeeded) onRescanNeeded(libraryId);
                else
                  window.dispatchEvent(
                    new CustomEvent("waverunner:open-rescan", { detail: { libraryId } }),
                  );
              }}
            >
              <RefreshCw size={13} />
              Rescan now
            </Button>
          </div>
          {/* One line per staged action; each truncates on its own instead of
              the whole batch collapsing into one clipped run-on. Undo reverts
              the directive itself — nothing has applied yet, so no rescan. */}
          {/* Height-capped: a long batch scrolls inside the banner instead of
              shoving the actual work below the fold. */}
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto pl-[26px]">
            {pending.map((p) => (
              <li key={p.id} className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                <span className="shrink-0">•</span>
                <span className="min-w-0 truncate">{p.label}</span>
                <button
                  onClick={() =>
                    run(`unstage:${p.id}`, () => invoke("unstage_pending_change", { id: p.id }))
                  }
                  disabled={busy}
                  className="shrink-0 underline underline-offset-2 hover:text-foreground"
                >
                  {busyKey === `unstage:${p.id}` ? "…" : "Undo"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Matches a pass has yet to cash in — the pass stamps the artists
          their credits prove. Staged changes gate it (same rule the backend
          enforces): rescan first, then pass. "Unmatch" per line rather than
          "Undo": nothing staged here, undoing means forgetting the match. */}
      {onlineEnabled && pendingPass.length > 0 && (
        <div className="mb-3 mr-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
          <div className="flex items-center gap-3">
            <RefreshCw size={14} className="shrink-0 text-amber-300" />
            <p className="min-w-0 flex-1 text-sm text-amber-200/90">
              {pendingPass.length}{" "}
              {pendingPass.some((p) => !/^\d+$/.test(p.target))
                ? pendingPass.length === 1
                  ? "item"
                  : "items"
                : pendingPass.length === 1
                  ? "match"
                  : "matches"}{" "}
              waiting for a matching pass — it identifies the artists their credits prove
            </p>
            {/* Locked while quick wins drain: the pass would walk the very
                artists mid-merge, and a button that stays live beside a
                busy list is a misclick waiting to happen. */}
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={busy || running || pending.length > 0 || quickDraining}
              title={
                pending.length > 0
                  ? "Staged changes need a rescan first"
                  : quickDraining
                    ? "Queued quick wins are still applying"
                    : undefined
              }
              onClick={rerunMatching}
            >
              <RefreshCw size={13} />
              {pending.length > 0
                ? "Rescan first"
                : running
                  ? "Pass running…"
                  : quickDraining
                    ? "Waiting for queue…"
                    : "Run pass now"}
            </Button>
          </div>
          {/* Same height cap as the staged banner — the queue can hold every
              match of a long session. */}
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto pl-[26px]">
            {pendingPass.map((p) => (
              <li
                key={p.id}
                className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground"
              >
                <span className="shrink-0">•</span>
                <span className="min-w-0 truncate">{p.label}</span>
                {/* Only album-match rows (bare album-id targets) can offer
                    Unmatch. Re-check/search rows — merges, artist matches,
                    credit changes, renames — have no match to forget; each
                    one's undo is its own History entry, which dequeues it. */}
                {/^\d+$/.test(p.target) && (
                  <button
                    onClick={() =>
                      run(`passunmatch:${p.id}`, () =>
                        invoke("mb_unmatch_entity", {
                          kind: "album",
                          entityId: parseInt(p.target, 10),
                        }),
                      )
                    }
                    disabled={busy}
                    className="shrink-0 underline underline-offset-2 hover:text-foreground"
                  >
                    {busyKey === `passunmatch:${p.id}` ? "…" : "Unmatch"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    {/* Same border the nav/pane divider uses, closing the header (and the
        staged-changes banner, when present) off from the columns. The spacing
        under the line lives INSIDE the nav (padding, not row padding) so the
        nav's border-r runs all the way up to touch it — and the pane's pt is
        scroll-container padding, so scrolled content passes flush beneath
        the line. -ml-4/pl-4: both hosts pad 16px left; the row backs out of
        it to run the border to the modal's edge, and the nav puts it back. */}
    <div className="-ml-4 flex min-h-0 flex-1 gap-4 border-t">
      {/* Nav rail: every section at a glance with its size, so nothing hides
          below a fold and the panel stops being one long scroll. */}
      {/* px-3 matches the pt-3 rhythm: buttons sit 12px off the modal edge,
          12px off the border-r, and 12px under the top rule. */}
      {/* gap-1, not gap-0.5: at 125%/150% display scaling a 2px gap is a
          fractional device-pixel step, so alternating rows rendered on
          half-pixels — the tiny warn icons visibly smeared off-center on
          those rows. 4px stays integer at every common scale factor. */}
      <nav className="flex w-64 shrink-0 flex-col gap-1 border-r px-3 pt-3">
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => goTo(n.id)}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              pane === n.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{n.label}</span>
            {/* The two numbers sit together as one cluster — they're both
                "how much is in here", so the label is what they're apart from. */}
            <span className="flex shrink-0 items-center gap-1">
              {n.id === "map" ? (
                <span
                  className={`text-xs tabular-nums ${mapReds > 0 ? "text-amber-300" : "text-emerald-400"}`}
                >
                  {mapPct}%
                </span>
              ) : (
                <>
                  {/* Digits have no descenders, so a line-box-centered icon
                      reads a pixel low — the same lift CircleCheck gets. */}
                  {/* scale-90: a circle fills its icon box while the triangle
                      is inset, so at equal sizes the circle reads bigger. */}
                  {(n.alert ?? 0) > 0 && (
                    <span className="flex items-center gap-0.5 text-xs tabular-nums text-red-400">
                      <CircleAlert size={12} className="-translate-y-px scale-90" />
                      {n.alert}
                    </span>
                  )}
                  {(n.warn ?? 0) > 0 && (
                    <span className="flex items-center gap-0.5 text-xs tabular-nums text-amber-300">
                      <TriangleAlert size={12} className="-translate-y-px" />
                      {n.warn}
                    </span>
                  )}
                  {n.count > 0 && (
                    <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                      {n.count}
                    </span>
                  )}
                </>
              )}
            </span>
          </button>
        ))}
        {/* Progress lives in the match modal, not here — this is just the
            pointer to it (App closes this center when the modal opens). */}
        {running && (
          <div className="mt-2 border-t pt-2">
            <button
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("waverunner:open-match", { detail: { libraryId } }),
                )
              }
              className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Spinner className="size-3" />
              Matching pass running — open
            </button>
          </div>
        )}
        {/* Pinned to the bottom, apart from the work sections: History is the
            ledger of what happened, not a queue of things to do. */}
        {/* The separator runs edge to edge: -ml-4 back out through the nav's
            left padding to the modal edge, -mr-2 through its right padding to
            meet the border-r; the paddings then restore button alignment.
            pt-3/pb-3 mirror the nav's own pt-3 under the top rule, so the
            three gaps (top rule→first button, this rule→History, History→
            footer) all read as one rhythm. */}
        <div className="-mx-3 mt-auto border-t px-3 pb-3 pt-3">
          <button
            onClick={() => goTo("history")}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              pane === "history"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">History</span>
            {historyCount > 0 && (
              <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                {historyCount}
              </span>
            )}
          </button>
        </div>
      </nav>

      {/* Padding on the SCROLL CONTAINER: at rest it holds the header clear
          of the line above, and scrolled content still passes through it
          (overflow clips at the padding edge), so rows slide flush beneath
          the border instead of stopping short. The base pt-1 keeps a focused
          input's ring from clipping. */}
      {/* overflow-anchor:none — Chromium's scroll anchoring compensates
          scrollTop when content above the viewport shrinks, which pins the
          on-screen cards in place after a card above is resolved. That both
          reads as a scroll "jump" AND silences the FLIP animation (rect
          deltas become zero, so nothing slides). With anchoring off, the
          cards below visibly slide up into the freed space. */}
      <div
        ref={flipContainerRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-4 pt-3 pb-4 [overflow-anchor:none]"
      >
      {/* The library map: guide checklist up top (the grind order that
          actually converges — between stages the PASS does the multiplying),
          then the whole library as state-colored nodes. Fill carries state
          alongside color (solid / light / hollow / muted) so red-green
          colorblindness never hides the difference. */}
      {/* Next up: the guided grind, banded by payoff ÷ effort. Work
          top-down; when the quick wins run dry the pass card says to cash in
          what's queued; cleanup and features stay parked at the bottom
          because deciding them before a pass is usually wasted work. */}
      {pane === "queue" && (
        <section className="space-y-6">
          {quickWins.length === 0 && bigUnlocks.length === 0 && pendingPass.length === 0 ? (
            <div className="flex items-center gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2">
              <CircleCheck size={15} className="shrink-0 text-emerald-400" />
              <p className="text-sm text-emerald-200/90">
                Nothing queued. {cleanupFeatures + cleanupAlbums > 0
                  ? "Only low-yield cleanup remains below."
                  : "This library is fully resolved."}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Every open decision, most efficient first.
            </p>
          )}
          {quickWins.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-3">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-emerald-300">
                  <CircleCheck size={14} />
                  Quick wins ({quickWins.length}) — click to queue, then apply
                </h4>
                {(queuedQuickKeys.size > 0 || quickDraining) && (
                  // The mirror lock: no draining while a pass walks the same
                  // artists. Staging (clicking rows) stays open meanwhile.
                  <Button
                    size="sm"
                    className="ml-auto shrink-0 gap-1.5"
                    disabled={quickDraining || running}
                    title={running && !quickDraining ? "A matching pass is running" : undefined}
                    onClick={applyQueuedQuickWins}
                  >
                    {quickDraining && <Spinner className="size-3" />}
                    {quickDraining
                      ? `Applying ${Math.min(doneQuickKeys.size + 1, doneQuickKeys.size + queuedQuickKeys.size + 1)} of ${doneQuickKeys.size + queuedQuickKeys.size + 1}…`
                      : running
                        ? `Wait for pass… (${queuedQuickKeys.size} queued)`
                        : `Apply ${queuedQuickKeys.size} queued`}
                  </Button>
                )}
              </div>
              <div className="overflow-hidden rounded-md border border-emerald-500/30">
                {quickWins.map((w, i) => {
                  const qk = quickWinKey(w);
                  const isActive = activeQuickKey === qk;
                  const isQueued = queuedQuickKeys.has(qk);
                  const isDone = doneQuickKeys.has(qk);
                  return (
                  <div
                    key={
                      w.t === "cluster" ? `qc-${w.c.key}` : `qs-${w.s.id}`
                    }
                    className={`flex items-center gap-3 px-3 py-2 ${i === 0 ? "" : "border-t"}`}
                  >
                    <div className="min-w-0 flex-1 text-sm">
                      {w.t === "cluster" && (
                        <>
                          {w.c.members.map((m) => `“${m.name}”`).join(" + ")} are one artist
                          <span className="block text-[11px] text-muted-foreground">
                            merges into the matched page — every spelling becomes an alias
                          </span>
                        </>
                      )}
                      {w.t === "artist" && (
                        <>
                          “{w.s.payload.artist_name}” — one MusicBrainz artist answers
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {w.s.payload.candidates?.[0]?.title}
                            {w.s.payload.candidates?.[0]?.subtitle
                              ? ` · ${w.s.payload.candidates[0].subtitle}`
                              : ""}
                          </span>
                        </>
                      )}
                      {w.t === "album" && (
                        <>
                          “{w.s.payload.album_title}” — one release group found
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {w.s.payload.groups?.[0]?.title}
                            {w.s.payload.groups?.[0]?.first_release_date
                              ? ` · ${w.s.payload.groups[0].first_release_date}`
                              : ""}
                          </span>
                        </>
                      )}
                    </div>
                    {/* Trust, then verify: every quick win links its MB
                        candidate so "one click" never means "blind click". */}
                    {w.t === "cluster" && (
                      <>
                        {(() => {
                          const survivor = w.c.members.find(
                            (m) => m.artist_id != null && m.mbid,
                          );
                          return survivor?.mbid ? (
                            <button
                              type="button"
                              className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                              onClick={() =>
                                openUrl(`https://musicbrainz.org/artist/${survivor.mbid}`)
                              }
                            >
                              view
                            </button>
                          ) : null;
                        })()}
                        <Button
                          size="sm"
                          variant={isQueued ? "outline" : "default"}
                          className="shrink-0 gap-1.5"
                          disabled={quickDraining || isDone}
                          title={isQueued ? "Click again to remove from the queue" : undefined}
                          onClick={() => toggleQuickWin(w)}
                        >
                          {isActive && <Spinner className="size-3" />}
                          {isDone ? "Done" : isActive ? "Applying…" : isQueued ? "Queued ✓" : "Merge"}
                        </Button>
                      </>
                    )}
                    {w.t === "artist" && (
                      <>
                        <button
                          type="button"
                          className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                          onClick={() =>
                            openUrl(
                              `https://musicbrainz.org/artist/${w.s.payload.candidates![0].mbid}`,
                            )
                          }
                        >
                          view
                        </button>
                        <Button
                          size="sm"
                          variant={isQueued ? "outline" : "default"}
                          className="shrink-0 gap-1.5"
                          disabled={quickDraining || isDone}
                          title={isQueued ? "Click again to remove from the queue" : undefined}
                          onClick={() => toggleQuickWin(w)}
                        >
                          {isActive && <Spinner className="size-3" />}
                          {isDone
                            ? "Done"
                            : isActive
                              ? "Applying…"
                              : isQueued
                                ? "Queued ✓"
                                : "Yes, it’s them"}
                        </Button>
                      </>
                    )}
                    {w.t === "album" && (
                      <>
                        <button
                          type="button"
                          className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                          onClick={() =>
                            openUrl(
                              `https://musicbrainz.org/release-group/${w.s.payload.groups![0].group_id}`,
                            )
                          }
                        >
                          view
                        </button>
                        <Button
                          size="sm"
                          variant={isQueued ? "outline" : "default"}
                          className="shrink-0 gap-1.5"
                          disabled={quickDraining || isDone}
                          title={isQueued ? "Click again to remove from the queue" : undefined}
                          onClick={() => toggleQuickWin(w)}
                        >
                          {isActive && <Spinner className="size-3" />}
                          {isDone ? "Done" : isActive ? "Applying…" : isQueued ? "Queued ✓" : "Match"}
                        </Button>
                      </>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          )}
          {pendingPass.length > 0 && (
            <div className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
              <RefreshCw size={14} className="shrink-0 text-amber-300" />
              <p className="min-w-0 flex-1 text-sm text-amber-200/90">
                {pendingPass.length} decision{pendingPass.length === 1 ? "" : "s"} waiting for a
                matching pass — cash them in before grinding further.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5"
                disabled={busy || running || pending.length > 0 || quickDraining}
                title={
                  pending.length > 0
                    ? "Staged changes need a rescan first"
                    : quickDraining
                      ? "Queued quick wins are still applying"
                      : undefined
                }
                onClick={rerunMatching}
              >
                <RefreshCw size={13} />
                {pending.length > 0
                  ? "Rescan first"
                  : running
                    ? "Pass running…"
                    : quickDraining
                      ? "Waiting for queue…"
                      : "Run pass now"}
              </Button>
            </div>
          )}
          {bigUnlocks.length > 0 && (
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-amber-300">
                <TriangleAlert size={14} />
                Big unlocks ({bigUnlocks.length}) — worth a search
              </h4>
              <div className="overflow-hidden rounded-md border border-amber-500/30">
                {bigUnlocks.slice(0, 15).map((w, i) => (
                  <div
                    key={
                      w.t === "cluster"
                        ? `bc-${w.c.key}`
                        : w.t === "artist"
                          ? `ba-${w.a.artist_id}`
                          : `bs-${w.s.id}`
                    }
                    className={i === 0 ? "" : "border-t"}
                  >
                  <div className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1 truncate text-sm">
                      {w.t === "cluster" && (
                        <>
                          {w.c.members.map((m) => `“${m.name}”`).join(" + ")}
                          <span className="ml-1.5 text-[11px] text-muted-foreground">
                            same artist? — settle who they are
                          </span>
                        </>
                      )}
                      {w.t === "artist_sug" && (
                        <>
                          “{w.s.payload.artist_name}”
                          <span className="ml-1.5 text-[11px] text-muted-foreground">
                            {w.s.payload.candidates?.length} candidates — pick the right one
                          </span>
                        </>
                      )}
                      {w.t === "artist" && (
                        <>
                          “{w.a.title}”
                          <span className="ml-1.5 text-[11px] text-muted-foreground">
                            {w.a.album_count} album{w.a.album_count === 1 ? "" : "s"} here,
                            unidentified
                          </span>
                        </>
                      )}
                      {w.t === "album_sug" && (
                        <>
                          “{w.s.payload.album_title}”
                          <span className="ml-1.5 text-[11px] text-muted-foreground">
                            {w.s.payload.groups?.length} possible albums — pick one
                          </span>
                        </>
                      )}
                    </div>
                    {w.t === "cluster" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={busy}
                        onClick={() => {
                          const pages = w.c.members.filter((m) => m.artist_id != null);
                          if (pages[0])
                            setClusterMatch({
                              cluster: w.c,
                              survivorId: pages[0].artist_id as number,
                            });
                        }}
                      >
                        Match…
                      </Button>
                    )}
                    {w.t === "artist" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={busy}
                        onClick={() => setMatchArtist(w.a.artist_id)}
                      >
                        Match…
                      </Button>
                    )}
                  </div>
                  {/* Suggestion rows carry their candidate picker inline,
                      always open — the decision happens IN the queue. */}
                  {w.t === "artist_sug" && (
                    <div className="pt-1">{renderArtistSuggestionBody(w.s)}</div>
                  )}
                  {w.t === "album_sug" && (
                    <div className="px-3 pb-2.5 pt-1">{renderAlbumSuggestionBody(w.s)}</div>
                  )}
                  </div>
                ))}
              </div>
              {bigUnlocks.length > 15 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  +{bigUnlocks.length - 15} more — the full lists live in Artists and Albums.
                </p>
              )}
            </div>
          )}
          {declaredFixes.length > 0 && (
            <div>
              <h4 className="mb-0.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <FileWarning size={14} />
                Source fixes ({declaredFixes.length}) — retag, then rescan
              </h4>
              <p className="mb-1.5 text-xs text-muted-foreground">
                Misspellings you flagged that still live in the files&rsquo; tags. Waverunner keeps
                them pointing at the right artist meanwhile — but the real fix is in the tags.
              </p>
              <div className="space-y-2">
                {declaredFixes.slice(0, 3).map((f) => (
                  <TagFixCard
                    key={`${f.artist_id}:${f.wrong}`}
                    fix={f}
                    busy={busy}
                    busyKey={busyKey}
                    onSetKind={setAliasKind}
                  />
                ))}
              </div>
              {declaredFixes.length > 3 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  +{declaredFixes.length - 3} more under File problems.
                </p>
              )}
            </div>
          )}
          {(cleanupFeatures > 0 ||
            cleanupAlbums > 0 ||
            unlinked.length > 0 ||
            variantFixes.length > 0 ||
            (review?.gaps.length ?? 0) > 0 ||
            conflictedClusters > 0) && (
            <div>
              <h4 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Cleanup — low yield, fine to leave for last
              </h4>
              <div className="overflow-hidden rounded-md border">
                {cleanupFeatures > 0 && (
                  <div className="flex items-center gap-3 px-3 py-2">
                    <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                      {cleanupFeatures} feature-only artist{cleanupFeatures === 1 ? "" : "s"} —
                      usually resolve themselves once albums are matched
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => goTo("artists", "sec-artists-features")}
                    >
                      View
                    </Button>
                  </div>
                )}
                {cleanupAlbums > 0 && (
                  <div
                    className={`flex items-center gap-3 px-3 py-2 ${cleanupFeatures > 0 ? "border-t" : ""}`}
                  >
                    <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                      {cleanupAlbums} album{cleanupAlbums === 1 ? "" : "s"} MusicBrainz couldn’t
                      find — manual search, rename, or ignore
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => goTo("albums", "sec-albums-unmatched")}
                    >
                      View
                    </Button>
                  </div>
                )}
                {unlinked.length > 0 && (
                  <div
                    className={`flex items-center gap-3 px-3 py-2 ${
                      cleanupFeatures > 0 || cleanupAlbums > 0 ? "border-t" : ""
                    }`}
                  >
                    <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                      {unlinked.length} unlinked credit{unlinked.length === 1 ? "" : "s"} — names
                      resolving to no artist page
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => goTo("credits")}
                    >
                      View
                    </Button>
                  </div>
                )}
                {variantFixes.length > 0 && (
                  <div
                    className={`flex items-center gap-3 px-3 py-2 ${
                      cleanupFeatures > 0 || cleanupAlbums > 0 || unlinked.length > 0
                        ? "border-t"
                        : ""
                    }`}
                  >
                    <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                      {variantFixes.length} spelling variant{variantFixes.length === 1 ? "" : "s"}{" "}
                      to classify — misspellings to fix, or nicknames to keep
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => goTo("files", "sec-files-variants")}
                    >
                      View
                    </Button>
                  </div>
                )}
                {(review?.gaps.length ?? 0) > 0 && (
                  <div
                    className={`flex items-center gap-3 px-3 py-2 ${
                      cleanupFeatures > 0 ||
                      cleanupAlbums > 0 ||
                      unlinked.length > 0 ||
                      variantFixes.length > 0
                        ? "border-t"
                        : ""
                    }`}
                  >
                    <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                      {review!.gaps.length} matched album{review!.gaps.length === 1 ? "" : "s"}{" "}
                      whose track lists differ from the MusicBrainz release
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => goTo("gaps")}
                    >
                      View
                    </Button>
                  </div>
                )}
                {conflictedClusters > 0 && (
                  <div
                    className={`flex items-center gap-3 px-3 py-2 ${
                      cleanupFeatures > 0 ||
                      cleanupAlbums > 0 ||
                      unlinked.length > 0 ||
                      variantFixes.length > 0 ||
                      (review?.gaps.length ?? 0) > 0
                        ? "border-t"
                        : ""
                    }`}
                  >
                    <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                      {conflictedClusters} name group{conflictedClusters === 1 ? "" : "s"} holding
                      different MusicBrainz identities — provably separate; eject the stranger
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => goTo("artists", "sec-artists-clusters")}
                    >
                      View
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}
      {pane === "map" && (
        <section className="space-y-4">
          {mapReds === 0 ? (
            <div className="flex items-center gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2">
              <CircleCheck size={16} className="shrink-0 text-emerald-400" />
              <p className="text-sm text-emerald-200/90">
                Nothing left to match — every artist and album is matched or ignored.
              </p>
            </div>
          ) : guideStage !== 0 ? (
            <div className="overflow-hidden rounded-md border">
              {(
                [
                  [
                    1,
                    "Match your artists",
                    guideOwnerLeft,
                    clusters.length + artistSuggestionsOwners.length,
                    "artists",
                    "Artists with albums in your library first — each one identified unlocks their whole discography for automatic matching on the next pass.",
                  ],
                  [
                    2,
                    "Match your albums",
                    guideAlbumsLeft,
                    albumSuggestions.length,
                    "albums",
                    "Matched albums prove the artists credited on them — pick exact releases where you can.",
                  ],
                  [
                    3,
                    "Feature artists",
                    guideFeatureLeft,
                    artistSuggestionsFeatures.length,
                    "artists",
                    "Mostly resolved automatically by the passes — what's left are the genuine questions.",
                  ],
                ] as const
              ).map(([n, title, left, ready, target, desc]) => (
                <div
                  key={n}
                  className={`flex items-center gap-3 px-3 py-2 ${n > 1 ? "border-t" : ""} ${
                    guideStage === n ? "bg-accent/40" : ""
                  }`}
                >
                  <span
                    className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                      left === 0
                        ? "border-primary bg-primary text-primary-foreground"
                        : guideStage === n
                          ? "border-primary text-primary"
                          : "border-border text-muted-foreground"
                    }`}
                  >
                    {left === 0 ? "✓" : n}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {title}
                      {left > 0 && (
                        <span className="font-normal text-muted-foreground"> — {left} left</span>
                      )}
                      {/* Cards waiting with pre-fetched candidates — the
                          cheapest clicks in the stage, so they're advertised
                          from here. */}
                      {ready > 0 && (
                        <span className="font-normal text-amber-300"> · {ready} with suggestions</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </div>
                  {left > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => goTo(target)}
                    >
                      Go
                    </Button>
                  )}
                </div>
              ))}
              {/* Only offered while a pass has something to act on: queued
                  matches, never-examined albums, or artists it can derive.
                  (The queue alone isn't the test — artist matches and
                  accepted cards don't enqueue, yet they're exactly what a
                  pass cashes in.) Staged changes keep the row visible in its
                  rescan-first form. */}
              {/* No pass button here — the queue banner at the top owns it.
                  (This whole checklist section is due for a redesign.) */}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {mapReds} unmatched — match them from their nodes below, or right-click to ignore
              what should stop counting.
            </p>
          )}

          {/* Legend. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-sm border border-emerald-500/60 bg-emerald-500/20" />
              matched
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-sm border border-amber-500/60 bg-amber-500/10" />
              album matched, release unmatched
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-sm border border-red-500/60" />
              unmatched
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-sm border border-transparent bg-muted" />
              ignored
            </span>
            <span className="ml-auto">click a node to match · right-click to ignore</span>
          </div>

          {/* Artist rows: the tree with containment instead of edges. Rows
              with red float to the top — the top of the wall IS the worklist. */}
          <div className="space-y-1.5">
            {ownerRows.map((a) => (
              <div key={a.artist_id} className="flex items-start gap-2">
                <ContextMenu>
                  <ContextMenuTrigger
                    render={
                      <button
                        onClick={() => !stagedLockedIds.has(a.artist_id) && setMatchArtist(a.artist_id)}
                        title={a.title}
                        className={`flex w-44 shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs transition-colors hover:bg-accent/50 ${
                          a.ignored ? "text-muted-foreground" : ""
                        }`}
                      />
                    }
                  >
                    <span
                      className={`inline-block size-2 shrink-0 rounded-full border ${
                        a.ignored
                          ? "border-transparent bg-muted-foreground/40"
                          : a.state === "matched"
                            ? "border-emerald-500 bg-emerald-500"
                            : "border-red-500 bg-transparent"
                      }`}
                    />
                    <span className="min-w-0 truncate">{a.title}</span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {stagedLockedIds.has(a.artist_id) ? (
                      <ContextMenuItem disabled>
                        Staged for rescan — Undo the staged change to edit
                      </ContextMenuItem>
                    ) : (
                      <>
                        <ContextMenuItem onClick={() => setMatchArtist(a.artist_id)}>
                          Match…
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() =>
                            a.ignored
                              ? setIgnored(a.artist_id, false)
                              : setConfirmIgnore({ entityId: a.artist_id, name: a.title })
                          }
                        >
                          {a.ignored ? "Un-ignore" : "Ignore"}
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
                <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {(albumsByArtist.get(a.artist_id) ?? []).map((al) => (
                    <ContextMenu key={al.album_id}>
                      <ContextMenuTrigger
                        render={
                          <button
                            onClick={() => !stagedLockedIds.has(al.album_id) && setMatchAlbum(al.album_id)}
                            title={al.title}
                            className={`max-w-48 truncate rounded border px-1.5 py-0.5 text-[11px] transition-colors hover:brightness-125 ${
                              al.ignored
                                ? "border-transparent bg-muted text-muted-foreground"
                                : al.state === "release"
                                  ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-200"
                                  : al.state === "album"
                                    ? "border-amber-500/60 bg-amber-500/10 text-amber-200"
                                    : "border-red-500/60 bg-transparent text-red-300"
                            }`}
                          />
                        }
                      >
                        {al.title}
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        {stagedLockedIds.has(al.album_id) ? (
                          <ContextMenuItem disabled>
                            Staged for rescan — Undo the staged change to edit
                          </ContextMenuItem>
                        ) : (
                          <>
                            <ContextMenuItem onClick={() => setMatchAlbum(al.album_id)}>
                              Match…
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() =>
                                al.ignored
                                  ? setIgnored(al.album_id, false)
                                  : setConfirmIgnore({ entityId: al.album_id, name: al.title })
                              }
                            >
                              {al.ignored ? "Un-ignore" : "Ignore"}
                            </ContextMenuItem>
                          </>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}
                </div>
              </div>
            ))}
            {orphanAlbums.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="w-44 shrink-0 px-1.5 py-0.5 text-xs italic text-muted-foreground">
                  No artist
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {orphanAlbums.map((al) => (
                    <ContextMenu key={al.album_id}>
                      <ContextMenuTrigger
                        render={
                          <button
                            onClick={() => !stagedLockedIds.has(al.album_id) && setMatchAlbum(al.album_id)}
                            title={al.title}
                            className={`max-w-48 truncate rounded border px-1.5 py-0.5 text-[11px] transition-colors hover:brightness-125 ${
                              al.ignored
                                ? "border-transparent bg-muted text-muted-foreground"
                                : al.state === "release"
                                  ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-200"
                                  : al.state === "album"
                                    ? "border-amber-500/60 bg-amber-500/10 text-amber-200"
                                    : "border-red-500/60 bg-transparent text-red-300"
                            }`}
                          />
                        }
                      >
                        {al.title}
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        {stagedLockedIds.has(al.album_id) ? (
                          <ContextMenuItem disabled>
                            Staged for rescan — Undo the staged change to edit
                          </ContextMenuItem>
                        ) : (
                          <>
                            <ContextMenuItem onClick={() => setMatchAlbum(al.album_id)}>
                              Match…
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() =>
                                al.ignored
                                  ? setIgnored(al.album_id, false)
                                  : setConfirmIgnore({ entityId: al.album_id, name: al.title })
                              }
                            >
                              {al.ignored ? "Un-ignore" : "Ignore"}
                            </ContextMenuItem>
                          </>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Artists with no albums here — features and loose-track credits.
              No children to branch, so they cluster as their own strip. */}
          {featureArtists.length > 0 && (
            <div>
              <h4 className="mb-1.5 mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Feature artists
              </h4>
              <div className="flex flex-wrap gap-1">
                {featureArtists.map((a) => (
                  <ContextMenu key={a.artist_id}>
                    <ContextMenuTrigger
                      render={
                        <button
                          onClick={() => !stagedLockedIds.has(a.artist_id) && setMatchArtist(a.artist_id)}
                          title={a.title}
                          className={`flex max-w-48 items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] transition-colors hover:brightness-125 ${
                            a.ignored
                              ? "border-transparent bg-muted text-muted-foreground"
                              : a.state === "matched"
                                ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-200"
                                : "border-red-500/60 bg-transparent text-red-300"
                          }`}
                        />
                      }
                    >
                      <span className="min-w-0 truncate">{a.title}</span>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {stagedLockedIds.has(a.artist_id) ? (
                        <ContextMenuItem disabled>
                          Staged for rescan — Undo the staged change to edit
                        </ContextMenuItem>
                      ) : (
                        <>
                          <ContextMenuItem onClick={() => setMatchArtist(a.artist_id)}>
                            Match…
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() =>
                              a.ignored
                                ? setIgnored(a.artist_id, false)
                                : setConfirmIgnore({ entityId: a.artist_id, name: a.title })
                            }
                          >
                            {a.ignored ? "Un-ignore" : "Ignore"}
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Where the library stands. Every number is a tally of `albums` below,
          so the summary and the list can never disagree — and each is a
          filter, because a count you can't open is just trivia. */}
      {pane === "albums" && (
      <section>
        <div className="mb-4 flex items-center gap-2">
          <h3 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="text-xl text-foreground">{albumsIdentified.length}</span> of{" "}
            <span className="text-xl text-foreground">{albums.length}</span> albums identified
          </h3>
          <div className="ml-auto w-44">
            <ClearableInput
              value={albumFilter}
              onValueChange={setAlbumFilter}
              placeholder="Filter…"
              className="h-7 text-xs"
            />
          </div>
          {counts.unchecked > 0 && !running && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={pending.length > 0}
              title={pending.length > 0 ? "Staged changes need a rescan first" : undefined}
              onClick={rerunMatching}
            >
              <RefreshCw size={13} />
              Match {counts.unchecked}
            </Button>
          )}
        </div>

        {/* Ready-to-answer cards first: the search already found candidates,
            so these clear faster than anything in the list below. */}
        {albumSuggestions.length > 0 && (
          <div className="mb-8">
            <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-amber-300">
              <TriangleAlert size={14} />
              Uncertain matches ({albumSuggestions.length})
            </h4>
            <div className="space-y-3">{albumSuggestions.map(renderAlbumCard)}</div>
          </div>
        )}

        {albumsUnmatched.length > 0 && (
          <div className="mb-8" id="sec-albums-unmatched">
            <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-red-400">
              <CircleSlash size={14} />
              Unmatched albums ({albumsUnmatched.length})
            </h4>
            <div className="overflow-hidden rounded-md border border-red-500/30">
              {albumsUnmatched.map((a, i) => (
                <AlbumRow
                  key={a.album_id}
                  a={a}
                  first={i === 0}
                  onMatch={setMatchAlbum}
                  onIgnore={(row) => setConfirmIgnore({ entityId: row.album_id, name: row.title })}
                  onCombine={(row) => {
                    setPartnerFilter("");
                    setCombinePartnerFor(row);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Group-matched albums know WHICH album they are but not which
            release — one pick in the dialog away from green, so they get
            their own amber shelf instead of hiding among the finished. */}
        {albumsReleaseUnknown.length > 0 && (
          <div className="mb-8">
            <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-amber-300">
              <TriangleAlert size={14} />
              Unmatched releases ({albumsReleaseUnknown.length})
            </h4>
            <p className="mb-1.5 text-xs text-muted-foreground">
              The album is known, but not which release your files are — until one is picked, the
              track list can’t be checked.
            </p>
            <div className="overflow-hidden rounded-md border border-amber-500/30">
              {albumsReleaseUnknown.map((a, i) => (
                <AlbumRow
                  key={a.album_id}
                  a={a}
                  first={i === 0}
                  onMatch={setMatchAlbum}
                  onCombine={(row) => {
                    setPartnerFilter("");
                    setCombinePartnerFor(row);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {albumsFullyIdentified.length > 0 && (
          <>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-emerald-400">
              <CircleCheck size={14} className="-translate-y-px" />
              Identified ({albumsFullyIdentified.length})
            </h4>
            <div className="overflow-hidden rounded-md border border-emerald-500/30">
              {albumsFullyIdentified.slice(0, albumLimit).map((a, i) => (
                <AlbumRow
                  key={a.album_id}
                  a={a}
                  first={i === 0}
                  onMatch={setMatchAlbum}
                  onCombine={(row) => {
                    setPartnerFilter("");
                    setCombinePartnerFor(row);
                  }}
                />
              ))}
              {albumsFullyIdentified.length > albumLimit && (
                <button
                  onClick={() => setAlbumLimit((n) => n + 100)}
                  className="w-full border-t px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  Show more of {albumsFullyIdentified.length}
                </button>
              )}
            </div>
          </>
        )}
      </section>
      )}

      {pane === "artists" && (
        <section>
          <div className="mb-4 flex items-center gap-2">
            {/* Numbers hold the larger size; the words step down and go to
                caps, so the counts read as the headline. */}
            {/* Words recede, numbers carry the message. */}
            <h3 className="text-base font-semibold uppercase tracking-wide text-muted-foreground">
              <span className="text-xl text-foreground">{artistsMatched}</span> of{" "}
              <span className="text-xl text-foreground">{artists.length}</span> artists identified
            </h3>
            <div className="ml-auto w-44">
              <ClearableInput
                value={artistFilter}
                onValueChange={setArtistFilter}
                placeholder="Filter…"
                className="h-7 text-xs"
              />
            </div>
          </div>
          {/* Ready-to-answer cards first — merges are one-click structural
              fixes, and the artist cards carry pre-fetched candidates. Then
              the lists, split along the guide's boundary: owners are the
              high-leverage answers, features usually resolve themselves once
              albums are matched. Matched ones are reference — below, cut
              short. */}
          {clusters.length > 0 && (
            <div className="mb-8" id="sec-artists-clusters">
              <h4 className="mb-0.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-amber-300">
                <GitMerge size={14} />
                Resolve identities ({clusters.length})
              </h4>
              <p className="mb-1.5 text-xs text-muted-foreground">
                Names that look like one artist spelled differently. Match settles who they are,
                merges every spelling, and adopts the MusicBrainz name — biggest unlocks first.
              </p>
              <div className="space-y-2">
                {clusters.map((c) => (
                  <ClusterCard
                    key={c.key}
                    cluster={c}
                    busy={busy}
                    busyKey={busyKey}
                    onMatch={(cluster, survivorId) => setClusterMatch({ cluster, survivorId })}
                    onMergeOnly={mergeCluster}
                    onEject={ejectMember}
                  />
                ))}
              </div>
            </div>
          )}
          {artistsUnmatchedOwners.length > 0 && (
            <div className="mb-8">
              <h4 className="mb-0.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-red-400">
                <CircleSlash size={14} />
                Unmatched artists with albums or loose tracks ({artistsUnmatchedOwners.length})
              </h4>
              <p className="mb-1.5 text-xs text-muted-foreground">
                Each one identified unlocks their whole discography for automatic matching on the
                next pass.
              </p>
              <div className="overflow-hidden rounded-md border border-red-500/30">
                {[...artistsUnmatchedOwners].sort(readyFirst).map((a, i) => {
                  const sug = suggestionByArtist.get(a.artist_id);
                  return (
                    <div key={a.artist_id} className={i === 0 ? "" : "border-t"}>
                      <ArtistRow
                        a={a}
                        first
                        disabled={!!sug}
                        onMatch={setMatchArtist}
                        onSplit={setSplitArtist}
                        onLink={(row) => setLinkSource({ name: row.title, artistId: row.artist_id })}
                        onPersona={(row) => setPersonaSource({ id: row.artist_id, name: row.title })}
                        onIgnore={(row) => setConfirmIgnore({ entityId: row.artist_id, name: row.title })}
                      />
                      {sug && renderArtistSuggestionBody(sug)}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {artistsUnmatchedFeatures.length > 0 && (
            <div className="mb-8" id="sec-artists-features">
              <h4 className="mb-0.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-amber-300">
                <TriangleAlert size={14} />
                Unmatched artists with only features ({artistsUnmatchedFeatures.length})
              </h4>
              <p className="mb-1.5 text-xs text-muted-foreground">
                Credited on tracks or albums but own nothing here — usually resolved automatically
                once their albums are matched. Match albums first.
              </p>
              <div className="overflow-hidden rounded-md border border-amber-500/30">
                {[...artistsUnmatchedFeatures].sort(readyFirst).map((a, i) => {
                  const sug = suggestionByArtist.get(a.artist_id);
                  return (
                    <div key={a.artist_id} className={i === 0 ? "" : "border-t"}>
                      <ArtistRow
                        a={a}
                        first
                        disabled={!!sug}
                        onMatch={setMatchArtist}
                        onSplit={setSplitArtist}
                        onLink={(row) => setLinkSource({ name: row.title, artistId: row.artist_id })}
                        onPersona={(row) => setPersonaSource({ id: row.artist_id, name: row.title })}
                        onIgnore={(row) => setConfirmIgnore({ entityId: row.artist_id, name: row.title })}
                      />
                      {sug && renderArtistSuggestionBody(sug)}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {artistsIdentified.length > 0 && (
            <>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-emerald-400">
                <CircleCheck size={14} className="-translate-y-px" />
                Identified ({artistsIdentified.length})
              </h4>
              <div className="overflow-hidden rounded-md border border-emerald-500/30">
                {artistsIdentified.slice(0, artistLimit).map((a, i) => (
                  <ArtistRow key={a.artist_id} a={a} first={i === 0} onMatch={setMatchArtist} onPersona={(row) => setPersonaSource({ id: row.artist_id, name: row.title })} />
                ))}
                {artistsIdentified.length > artistLimit && (
                  <button
                    onClick={() => setArtistLimit((n) => n + 100)}
                    className="w-full border-t px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Show more of {artistsIdentified.length}
                  </button>
                )}
              </div>
            </>
          )}
          {artistsUnmatched.length === 0 && artistsIdentified.length === 0 && (
            <p className="px-1 py-2 text-xs text-muted-foreground">Nothing here.</p>
          )}
        </section>
      )}

      {/* Credit names that resolve to no artist. */}
      {pane === "credits" && unlinked.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Credits without an artist ({unlinked.length})
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            These credit names don’t resolve to any artist page — usually because they look like an
            existing artist and creating a duplicate would have been a guess. Linking a name is a
            merge: everything credited to it moves to the artist you pick, durably. Undoable from
            History.
          </p>
          <div className="overflow-hidden rounded-md border border-amber-500/30">
            {unlinked.map((u, i) => (
              <div
                key={u.name}
                className={`flex items-center gap-3 px-3 py-1.5 text-sm ${i === 0 ? "" : "border-t"}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {u.name}
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {[
                      u.track_count > 0 && `${u.track_count} track${u.track_count === 1 ? "" : "s"}`,
                      u.album_count > 0 && `${u.album_count} album${u.album_count === 1 ? "" : "s"}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {u.near_miss_id != null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 gap-1 px-2 text-xs text-amber-300 hover:text-amber-200"
                    disabled={busy}
                    onClick={() =>
                      run(`link:${u.name}`, async () => {
                        await invoke("link_credit_name", {
                          libraryId,
                          name: u.name,
                          targetArtistId: u.near_miss_id,
                        });
                        toast.success(`“${u.name}” is now ${u.near_miss_title}.`);
                      })
                    }
                  >
                    {busyKey === `link:${u.name}` && <Spinner className="size-3" />}
                    <Equal size={12} />
                    Is “{u.near_miss_title}”
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 gap-1 px-2 text-xs"
                  disabled={busy}
                  onClick={() => setLinkSource({ name: u.name, artistId: null })}
                >
                  <Equal size={12} />
                  Alias
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
      {pane === "credits" && unlinked.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Every credit resolves to an artist.
        </p>
      )}

      {/* Matched, but the track lists disagree */}
      {pane === "gaps" && (review?.gaps.length ?? 0) > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Track lists that don’t line up ({review!.gaps.length})
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            These albums matched, but some tracks couldn’t be paired with the release. MusicBrainz
            data — artist credits included — was <span className="font-medium">not</span> applied to
            those tracks, so they keep whatever their tags said. Fix the tags at the source, rescan,
            then <span className="font-medium">Re-check</span>.{" "}
            <span className="font-medium">Partial</span> declares the missing tracks deliberate —
            you only keep part of this album — and holds through every future check.{" "}
            <span className="font-medium">Ignore</span> just hides the warning — it returns on the
            next check.
          </p>
          <div className="space-y-2">
            {review!.gaps.map((g) => {
              const mine = g.rows.filter((r) => r.side === "ours").length;
              const theirs = g.rows.length - mine;
              return (
                <div
                  key={`${g.album_id}:${g.release_label ?? ""}`}
                  className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 break-words text-sm">
                      <span className="font-medium">{g.title}</span>
                      {g.artist_title && (
                        <span className="text-muted-foreground"> — {g.artist_title}</span>
                      )}
                      {g.release_label && (
                        <span className="ml-1.5 rounded border border-muted-foreground/30 px-1 py-px text-[10px] text-muted-foreground">
                          {g.release_label}
                        </span>
                      )}
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-200/90">
                        <TriangleAlert size={12} className="shrink-0" />
                        {[
                          mine > 0 && `${mine} of your track${mine === 1 ? "" : "s"} unmatched`,
                          theirs > 0 && `${theirs} on the release missing here`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </p>
                    <div className="flex shrink-0 gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={busy}
                        onClick={() => recheck(g.album_id)}
                      >
                        {busyKey === `recheck:${g.album_id}` && <Spinner className="size-3" />}
                        Re-check
                      </Button>
                      {theirs > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          disabled={busy}
                          title="You deliberately keep only part of this album — the missing release tracks stop counting, durably. Undo from History."
                          onClick={() => markPartial(g.album_id)}
                        >
                          {busyKey === `partial:${g.album_id}` && <Spinner className="size-3" />}
                          Partial
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => dismissGaps(g.album_id)}
                      >
                        Ignore
                      </Button>
                    </div>
                  </div>
                  <ul className="mt-2 space-y-0.5">
                    {[...g.rows]
                      .sort((a, b) => (a.side === b.side ? 0 : a.side === "ours" ? -1 : 1))
                      .slice(0, 12)
                      .map((r) => (
                      <li
                        key={`${r.side}-${r.disc}-${r.position}`}
                        className="flex gap-2 text-xs text-muted-foreground"
                      >
                        <span className="shrink-0 tabular-nums opacity-70">
                          {r.disc}·{r.position}
                        </span>
                        <span className="min-w-0 break-words">
                          {r.side === "mb" ? (
                            <>
                              “{r.title}” — on MusicBrainz, nothing here
                            </>
                          ) : r.counterpart ? (
                            <>
                              “{r.title}” — MusicBrainz has “
                              <span className="text-foreground">{r.counterpart}</span>”
                            </>
                          ) : (
                            <>“{r.title}” — nothing at this position on MusicBrainz</>
                          )}
                        </span>
                      </li>
                    ))}
                    {g.rows.length > 12 && (
                      <li className="text-xs text-muted-foreground">
                        …and {g.rows.length - 12} more
                      </li>
                    )}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* File-level notes. Both are long by nature and neither is actionable
          inside waverunner, so they collapse to a line you open on purpose. */}
      {pane === "files" && declaredFixes.length > 0 && (
        <div className="mb-6">
          <h4 className="mb-0.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-amber-300">
            <FileWarning size={14} />
            Misspellings still in tags ({declaredFixes.length})
          </h4>
          <p className="mb-1.5 text-xs text-muted-foreground">
            Spellings you flagged as wrong that the files still carry. Retag them at the source and
            rescan — each entry disappears once its tags are clean.
          </p>
          <div className="space-y-2">
            {declaredFixes.map((f) => (
              <TagFixCard
                key={`${f.artist_id}:${f.wrong}`}
                fix={f}
                busy={busy}
                busyKey={busyKey}
                onSetKind={setAliasKind}
              />
            ))}
          </div>
        </div>
      )}
      {pane === "files" && variantFixes.length > 0 && (
        <div className="mb-6" id="sec-files-variants">
          <h4 className="mb-0.5 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <FileWarning size={14} />
            Spelling variants to classify ({variantFixes.length})
          </h4>
          <p className="mb-1.5 text-xs text-muted-foreground">
            Alternate spellings recorded by merges and matches, still present in your files. The
            machine takes no position: call each one a misspelling (flags its files for retagging)
            or a nickname (kept as intended, never flagged). Undoable from History either way.
          </p>
          <div className="space-y-2">
            {variantFixes.map((f) => (
              <TagFixCard
                key={`${f.artist_id}:${f.wrong}`}
                fix={f}
                busy={busy}
                busyKey={busyKey}
                onSetKind={setAliasKind}
              />
            ))}
          </div>
        </div>
      )}
      {pane === "files" && fallbacks.length > 0 && (
        <Collapsible
          title={`Incomplete tags (${fallbacks.length})`}
          note="Imported with fallbacks for the missing fields. They play normally — fix the tags externally and rescan."
          open
          onToggle={() => {}}
        >
          {fallbacks.map((f, i) => (
            <div key={f.track_id} className={`px-3 py-1.5 ${i > 0 ? "border-t" : ""}`}>
              <span className="block min-w-0 break-all font-mono text-xs">
                <FileWarning size={12} className="mr-1.5 inline text-muted-foreground" />
                {f.file_path}
              </span>
              <span className="block text-xs text-muted-foreground">missing {f.missing.join(", ")}</span>
            </div>
          ))}
        </Collapsible>
      )}

      {pane === "files" && issues.length > 0 && (
        <Collapsible
          title={`Unreadable files (${issues.length})`}
          note="The scanner could not read these at all."
          open
          onToggle={() => {}}
        >
          {issues.map((iss, i) => (
            <div key={iss.file_path} className={`px-3 py-1.5 ${i > 0 ? "border-t" : ""}`}>
              <span className="block min-w-0 break-all font-mono text-xs">
                <TriangleAlert size={12} className="mr-1.5 inline text-muted-foreground" />
                {iss.file_path}
              </span>
              <span className="block text-xs text-muted-foreground">{iss.reason}</span>
            </div>
          ))}
        </Collapsible>
      )}


      {/* Applied-changes log — an action per row, newest first, collapsed to a
          recent window. The label carries the album; the kinds line says what
          the action touched, so Undo's scope is visible before clicking. */}
      {pane === "history" && (review?.changes.length ?? 0) > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              History ({review!.changes.length})
            </h3>
            {review!.changes.some((c) => c.undone) && (
              <button
                onClick={() => setHideUndone((v) => !v)}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground"
              >
                {hideUndone ? "Show undone" : "Hide undone"}
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-md border">
            {visibleChanges.slice(0, changeLimit).map((c, i) => (
              <div
                key={c.id}
                className={`flex items-baseline gap-3 px-3 py-1.5 ${i > 0 ? "border-t" : ""} ${
                  c.undone ? "opacity-45" : ""
                }`}
              >
                <span className="w-16 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {c.created_at.slice(5, 10)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{c.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {KIND_LABELS(c.kinds)}
                    {c.change_count > 1 ? ` · ${c.change_count} changes` : ""}
                  </span>
                </span>
                {c.undone ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">undone</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
                    disabled={busy}
                    onClick={() => undo(c.id)}
                  >
                    {busyKey === `undo:${c.id}` ? <Spinner className="size-3" /> : <Undo2 size={12} />}
                    Undo
                  </Button>
                )}
              </div>
            ))}
            {visibleChanges.length > changeLimit && (
              <button
                onClick={() => setChangeLimit((n) => n + 50)}
                className="w-full border-t px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Show more of {visibleChanges.length}
              </button>
            )}
          </div>
        </section>
      )}

      {pane === "gaps" && (review?.gaps.length ?? 0) === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Every matched album's track list agrees with its release.
        </p>
      )}
      {pane === "files" && fallbacks.length === 0 && issues.length === 0 && tagFixes.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Every file read cleanly and carried the tags it needed.
        </p>
      )}
      {pane === "history" && (review?.changes.length ?? 0) === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Nothing has been applied yet.
        </p>
      )}

      {splitArtist && (
          <SplitArtistDialog
            artistId={splitArtist.artist_id}
            artistName={splitArtist.title}
            open={splitArtist !== null}
            onOpenChange={(o) => {
              if (!o) {
                setSplitArtist(null);
                // A staged split changes the pending banner — refetch.
                refresh();
              }
            }}
          />
        )}
      {clusterMatch && (
          <ClusterMatchDialog
            libraryId={libraryId}
            cluster={clusterMatch.cluster}
            survivorId={clusterMatch.survivorId}
            onOpenChange={(o) => !o && setClusterMatch(null)}
            onDone={() => {
              refresh();
              onChanged?.();
            }}
          />
        )}
      {personaSource && (
          <PersonaDialog
            libraryId={libraryId}
            personaId={personaSource.id}
            personaName={personaSource.name}
            onOpenChange={(o) => !o && setPersonaSource(null)}
            onDone={() => {
              refresh();
              onChanged?.();
            }}
          />
        )}
      {linkSource && (
          <LinkArtistDialog
            libraryId={libraryId}
            sourceName={linkSource.name}
            sourceArtistId={linkSource.artistId}
            onOpenChange={(o) => !o && setLinkSource(null)}
            onDone={() => {
              refresh();
              onChanged?.();
            }}
          />
        )}
      {matchArtist != null && (
          <MatchDialog
            kind="artist"
            entityId={matchArtist}
            open={matchArtist != null}
            onOpenChange={(o) => !o && setMatchArtist(null)}
            onChanged={() => {
              refresh();
              onChanged?.();
            }}
          />
        )}
      {matchAlbum != null && (
          <MatchDialog
            kind="album"
            entityId={matchAlbum}
            open={matchAlbum != null}
            onOpenChange={(o) => !o && setMatchAlbum(null)}
            onChanged={() => {
              refresh();
              onChanged?.();
            }}
          />
        )}
      {/* Combine, step 1: pick the album to fold together with. Step 2 is the
          shared configure dialog (keeper + mode), same as the grid's flow. */}
      <Dialog
        open={combinePartnerFor !== null}
        onOpenChange={(o) => !o && setCombinePartnerFor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Combine “{combinePartnerFor?.title}” with…</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={partnerFilter}
            onChange={(e) => setPartnerFilter(e.target.value)}
            className="h-8 text-sm"
            placeholder="Filter albums…"
          />
          <div className="max-h-72 overflow-y-auto rounded-md border">
            {albums
              .filter(
                (a) =>
                  a.album_id !== combinePartnerFor?.album_id &&
                  !stagedLockedIds.has(a.album_id) &&
                  (partnerFilter.trim() === "" ||
                    `${a.title} ${a.artist_title ?? ""}`
                      .toLowerCase()
                      .includes(partnerFilter.trim().toLowerCase())),
              )
              .slice(0, 50)
              .map((a, i) => (
                <button
                  key={a.album_id}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/50 ${
                    i > 0 ? "border-t" : ""
                  }`}
                  onClick={() => {
                    const from = combinePartnerFor;
                    if (!from) return;
                    setCombinePartnerFor(null);
                    setCombineSelect({
                      libraryId,
                      picked: [
                        { id: from.album_id, title: from.title },
                        { id: a.album_id, title: a.title },
                      ],
                      keeperId: from.album_id,
                      mode: "merge",
                      busy: false,
                      configuring: true,
                    });
                  }}
                >
                  <span className="min-w-0 truncate">{a.title}</span>
                  {a.artist_title && (
                    <span className="min-w-0 shrink-0 truncate text-xs text-muted-foreground">
                      {a.artist_title}
                    </span>
                  )}
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
      {combineSelect && (
        <CombineSelectedDialog
          selection={combineSelect}
          onKeeper={(id) => setCombineSelect((s) => (s ? { ...s, keeperId: id } : s))}
          onMode={(m) => setCombineSelect((s) => (s ? { ...s, mode: m } : s))}
          onOpenChange={(o) => {
            if (!o) setCombineSelect(null);
          }}
          onConfirm={async (targetReleaseFolder) => {
            const sel = combineSelect;
            if (!sel || sel.keeperId == null) return;
            setCombineSelect((s) => (s ? { ...s, busy: true } : s));
            try {
              await invoke("combine_albums_multi", {
                libraryId,
                sourceIds: sel.picked.filter((p) => p.id !== sel.keeperId).map((p) => p.id),
                targetId: sel.keeperId,
                mode: sel.mode,
                targetReleaseFolder,
              });
              setCombineSelect(null);
              // Staged — the banner picks it up on refresh.
              await refresh();
              onChanged?.();
            } catch (e) {
              toast.error(String(e));
              setCombineSelect((s) => (s ? { ...s, busy: false } : s));
            }
          }}
        />
      )}
      {/* Ignore confirmation — the one row action that would otherwise fire
          on a bare click. Undoable from History regardless. */}
      <Dialog open={confirmIgnore !== null} onOpenChange={(o) => !o && setConfirmIgnore(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ignore “{confirmIgnore?.name}”?</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            It leaves matching and every count, and shows gray on the library map. You can
            un-ignore it there any time, or undo from History.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmIgnore(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const c = confirmIgnore;
                setConfirmIgnore(null);
                if (c) void setIgnored(c.entityId, true);
              }}
            >
              Ignore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
    </div>
  );
}

interface MetadataCenterDialogProps {
  libraryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}

/** Standalone host — the sidebar's always-available entrance to the center. */
export function MetadataCenterDialog({
  libraryId,
  open,
  onOpenChange,
  onChanged,
}: MetadataCenterDialogProps) {
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (open) setReloadKey((k) => k + 1);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* pb-0: the nav/pane columns (and the nav's border-r) run to the modal's
          bottom edge; the nav's own pb-3 keeps History on the 12px rhythm. */}
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-[min(72rem,calc(100vw-3rem))] max-w-none flex-col overflow-hidden pr-0 pb-0">
        <DialogHeader>
          <DialogTitle>Metadata center</DialogTitle>
        </DialogHeader>
        {libraryId && open && (
          <MetadataCenter libraryId={libraryId} reloadKey={reloadKey} onChanged={onChanged} />
        )}
      </DialogContent>
    </Dialog>
  );
}
