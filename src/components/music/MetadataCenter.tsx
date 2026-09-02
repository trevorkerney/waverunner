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
import { Switch } from "@/components/ui/switch";
import { useMbBusy } from "./MbBusy";
import { setMbHiddenLocal } from "@/lib/mbVisibility";
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
    /** Library side of the question, injected at read time by mb_get_review. */
    library_tracks?: number;
    library_versions?: number;
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
      /** MB's English artist-name alias when the canonical is another
       *  script — absent on suggestions stored before this existed. */
      en_name?: string | null;
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
  /** Version counts: state 'release' now means EVERY version is resolved
   *  (pinned or declared); the map shows resolved/releases on multi-version
   *  cards so a half-pinned card can't read as done. */
  releases: number;
  resolved_releases: number;
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

type PaneId = "map" | "albums" | "artists" | "credits" | "gaps" | "files" | "history";

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
  /** MB's English artist-name alias when the canonical is another script. */
  en_name: string | null;
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
  const mbBusy = useMbBusy();
  const [applying, setApplying] = useState<string | null>(null);
  // Per-candidate "adopt the English name instead of the canonical script".
  const [useEnglish, setUseEnglish] = useState<Record<string, boolean>>({});
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

  const apply = async (mbid: string, preferredName?: string | null) => {
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
      await invoke("mb_apply_entity_match", {
        kind: "artist",
        entityId: survivorId,
        mbid,
        preferredName: preferredName ?? null,
      });
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
                {r.en_name && (
                  <label className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={!!useEnglish[r.mbid]}
                      onChange={(e) =>
                        setUseEnglish((m) => ({ ...m, [r.mbid]: e.target.checked }))
                      }
                    />
                    use English name “{r.en_name}”
                  </label>
                )}
              </div>
              <button
                type="button"
                className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => openUrl(`https://musicbrainz.org/artist/${r.mbid}`)}
              >
                view
              </button>
              <Button
                size="sm"
                disabled={applying !== null}
                onClick={() => apply(r.mbid, useEnglish[r.mbid] ? r.en_name : null)}
              >
                {applying === r.mbid && <Spinner className="size-3" />}
                Yes, it&apos;s them
              </Button>
            </div>
          ))}
          {(results ?? []).length === 0 && (
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
              <Search size={12} />
              {searching || results === null
                ? mbBusy
                  ? "MusicBrainz is busy — retrying…"
                  : "Searching MusicBrainz…"
                : "No candidates found"}
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
  onDismiss,
}: {
  cluster: IdentityCluster;
  busy: boolean;
  busyKey: string | null;
  onMatch: (cluster: IdentityCluster, survivorId: number) => void;
  onMergeOnly: (cluster: IdentityCluster, survivorId: number) => void;
  onDismiss: (cluster: IdentityCluster) => void;
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
        {/* One card-level out instead of per-row "not the same" links: it
            records standing ejections for every non-primary spelling, so the
            card dissolves and merging is never re-suggested. */}
        <button
          type="button"
          disabled={busy}
          onClick={() => onDismiss(cluster)}
          className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {busyKey === `dismiss:${cluster.key}` ? "…" : "dismiss suggestion"}
        </button>
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
          </label>
        ))}
      </div>
      {conflicted ? (
        <p className="text-[11px] text-muted-foreground">
          Two of these hold different MusicBrainz identities — provably separate artists. Dismiss
          the suggestion to stop it appearing.
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
          {identityKnown && (
            <span className="text-[11px] text-muted-foreground">
              already matched — one click finishes it
            </span>
          )}
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
            {a.releases > 1 ? `Pick releases · ${a.resolved_releases}/${a.releases}` : "Pick release"}
          </>
        ) : (
          <>
            <Search size={12} />
            Match
          </>
        )}
      </Button>
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
  // Per-candidate "adopt the English name" ticks, keyed `${suggestionId}|${mbid}`.
  const [useEnglish, setUseEnglish] = useState<Record<string, boolean>>({});
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
  // Per-library: hide MB chips/menu items everywhere OUTSIDE this center.
  const [hideOutside, setHideOutside] = useState(false);

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
      setHideOutside(ls["hide_mb_outside_center"] === "on");
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
  // Card-level dismissal: a standing ejection for every non-primary spelling
  // dissolves the cluster and stops the merge ever being re-suggested (each
  // one is a rejected suggestion row — undoable from History like before).
  const dismissCluster = (c: IdentityCluster) =>
    run(`dismiss:${c.key}`, async () => {
      for (const m of c.members.slice(1)) {
        await invoke("mb_keep_separate", { libraryId, name: m.name });
      }
    });
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
      pane === "map"
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
    // The map is home — the whole-library picture and the guided path.
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
      {/* The library side of the question. A fused album (two bodies of work
          sharing one tag pair) shows a track count matching NEITHER candidate
          and several versions — the tell that no single answer is right. */}
      {s.payload.library_tracks != null && (
        <p className="text-xs text-muted-foreground">
          Your album:{" "}
          <span className="text-foreground/80">
            {s.payload.library_tracks} tracks
            {(s.payload.library_versions ?? 1) > 1
              ? ` across ${s.payload.library_versions} versions`
              : ""}
          </span>
        </p>
      )}
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
                {/* MB's English alias, adoptable instead of the canonical
                    script. Disabled until this option is the pick. */}
                {c.en_name && c.en_name !== c.title && (
                  <span
                    className={`mt-0.5 flex items-center gap-1.5 text-[11px] ${
                      chosen === c.mbid ? "text-muted-foreground" : "text-muted-foreground/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      disabled={busy || chosen !== c.mbid}
                      checked={!!useEnglish[`${s.id}|${c.mbid}`]}
                      onChange={(e) =>
                        setUseEnglish((m) => ({ ...m, [`${s.id}|${c.mbid}`]: e.target.checked }))
                      }
                    />
                    use English name “{c.en_name}”
                  </span>
                )}
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
                  preferredName:
                    (chosen &&
                      useEnglish[`${s.id}|${chosen}`] &&
                      candidates.find((c) => c.mbid === chosen)?.en_name) ||
                    null,
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

  // Declared misspellings nag (Source fixes band + File problems); neutral
  // variants wait quietly under File problems for the user to classify.
  const declaredFixes = tagFixes.filter((f) => f.kind === "misspelling");
  const variantFixes = tagFixes.filter((f) => f.kind === "variant");
  // `count` is the size of the pane; `alert` (red) is the blocking work —
  // unidentified owners / unidentified albums — and `warn` (amber) the softer
  // tier: feature-only names and albums awaiting a release pick. Same colors
  // as the pane's own section headings, so the rail predicts the page.
  // "Needs a decision" leads — it's required work, not reference — and it
  // only exists while there IS something to decide.
  // Opted out of online metadata: only the LOCAL panes remain — unlinked
  // credits, file problems (and History below). Everything MusicBrainz-backed
  // disappears rather than sitting permanently "unfinished".
  // The map keeps the top slot — the whole-library picture, with the guided
  // steps and the how-it-works primer living right on it.
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
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={busy || running || pending.length > 0}
              title={pending.length > 0 ? "Staged changes need a rescan first" : undefined}
              onClick={rerunMatching}
            >
              <RefreshCw size={13} />
              {pending.length > 0 ? "Rescan first" : running ? "Pass running…" : "Run pass now"}
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
      {pane === "map" && (
        <section className="space-y-4">
          {/* The doctrine, up front: every name and every album ends in one
              of a handful of states, and the grind has an order. Collapsed by
              default so veterans never scroll past it twice. */}
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium">
              How matching works
            </summary>
            <div className="mt-2 space-y-3 text-xs text-muted-foreground">
              <p>
                Work top-down:{" "}
                <span className="text-foreground">main artists first</span> — each one identified
                unlocks their whole discography for the next pass —{" "}
                <span className="text-foreground">then albums</span>,{" "}
                <span className="text-foreground">then exact releases</span>. Feature artists are
                filled in automatically as releases are matched; matching them directly is almost
                never needed.
              </p>
              <div>
                <p className="mb-1 font-medium text-foreground">
                  Every artist name ends in exactly one of:
                </p>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>
                    <span className="text-foreground">Matched</span> — one MusicBrainz artist.
                  </li>
                  <li>
                    <span className="text-foreground">Alias</span> — another spelling of an artist
                    you already have; merging keeps every spelling working.
                  </li>
                  <li>
                    <span className="text-foreground">Persona</span> — a separate identity the same
                    person releases under; both keep their own page.
                  </li>
                  <li>
                    <span className="text-foreground">Split</span> — a joint credit (“A & B”, “A/B”):
                    split it into its members and match each on their own. Never match a joint name
                    directly — MusicBrainz has no artist for it.
                  </li>
                  <li>
                    <span className="text-foreground">Ignored</span> — real but not on MusicBrainz,
                    or not an artist at all (a label, “Soundtrack”, a game title). Ignore stops it
                    counting.
                  </li>
                </ul>
              </div>
              <div>
                <p className="mb-1 font-medium text-foreground">Every album ends in one of:</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>
                    <span className="text-foreground">Release matched</span> — the exact release is
                    pinned (per version, on multi-version cards).
                  </li>
                  <li>
                    <span className="text-foreground">Unknown release</span> — the album is
                    identified but no release picked yet.
                  </li>
                  <li>
                    <span className="text-foreground">No official release</span> — declared: this
                    copy has no MusicBrainz counterpart, and never will.
                  </li>
                  <li>
                    <span className="text-foreground">Deliberately partial</span> — tracks are
                    missing on purpose; the gaps stop warning.
                  </li>
                  <li>
                    <span className="text-foreground">Ignored</span> — stops counting entirely.
                  </li>
                </ul>
              </div>
              <div>
                <p className="mb-1 font-medium text-foreground">
                  Some things only a retag can fix — tags are the source of truth:
                </p>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>
                    <span className="text-foreground">Album membership</span> — which album a track
                    belongs to IS its ALBUM tag. Moving a track between albums, or making it a
                    loose track (clear the ALBUM tag), happens in the files.
                  </li>
                  <li>
                    <span className="text-foreground">How albums group</span> — same artist + album
                    tags = one album; different = separate. Two different works sharing one name,
                    or one work split across mismatched tags, are tag edits.
                  </li>
                  <li>
                    <span className="text-foreground">A wrong name on specific files</span> — a
                    label or junk string in the artist tag of one rip. Alias is a permanent
                    everywhere-rule for real spellings, not a per-file correction.
                  </li>
                  <li>
                    <span className="text-foreground">Anything under File problems</span> —
                    unreadable or stacked tags are rewritten at the source, then rescanned.
                  </li>
                </ul>
                <p className="mt-1">
                  Everything else — joint credits (Split), spellings (Alias), identities (Persona),
                  one album in several editions (Combine), credits and dates (matching) — is
                  handled here and survives every rescan.
                </p>
              </div>
              <p>
                After a batch of decisions, run the pass — it cashes them in, harvesting credits
                and identifying feature artists, and often clears more than you clicked.
              </p>
            </div>
          </details>
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
                    "Don't match these directly — matched releases identify them automatically. What's left once your albums are done are the genuine questions.",
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

          {/* The pass entry point when nothing is queued — a pass still has
              work with an empty queue (unchecked albums, suggestion sweeps,
              original-date backfill), and the amber queue banner only exists
              while rows wait. Hidden when that banner is up: one button. */}
          {pendingPass.length === 0 && (
            <div className="flex items-center gap-3 rounded-md border px-3 py-2">
              <RefreshCw size={14} className="shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                A pass checks unmatched albums and sweeps for suggestions — run one after a batch
                of decisions, or any time.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5"
                disabled={busy || running || pending.length > 0}
                title={pending.length > 0 ? "Staged changes need a rescan first" : undefined}
                onClick={rerunMatching}
              >
                <RefreshCw size={13} />
                {pending.length > 0 ? "Rescan first" : running ? "Pass running…" : "Run pass now"}
              </Button>
            </div>
          )}

          {/* Legend. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-sm border border-emerald-500/60 bg-emerald-500/20" />
              matched
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-sm border border-amber-500/60 bg-amber-500/10" />
              album matched, releases unresolved (· n/m on multi-version cards)
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

          {/* Presentation, per library: the grind can live entirely in here —
              flipping this clears MB chips and Match menu items from album
              and artist pages and track lists, without touching matching
              itself. The sidebar's pending-work triangle stays (cheap to
              clear, and it marks real queued work). */}
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
            <div>
              <p className="text-sm">Hide MusicBrainz outside this center</p>
              <p className="text-xs text-muted-foreground">
                Match status chips, track-list check, and “Match to MusicBrainz” menu items stay
                in here; the rest of the app shows none of it. Matching keeps working.
              </p>
            </div>
            <Switch
              checked={hideOutside}
              onCheckedChange={async (v) => {
                setHideOutside(v);
                setMbHiddenLocal(libraryId, v); // outside pages flip instantly
                try {
                  await invoke("set_library_setting", {
                    libraryId,
                    key: "hide_mb_outside_center",
                    value: v ? "on" : "off",
                  });
                } catch (e) {
                  toast.error(String(e));
                }
              }}
            />
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
                        {/* Multi-version cards say how much of the release
                            stage is done — amber with 1/3 instead of a green
                            that rounds up. */}
                        {al.releases > 1 && !al.ignored && (
                          <span className="opacity-75"> · {al.resolved_releases}/{al.releases}</span>
                        )}
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
                        {/* Multi-version cards say how much of the release
                            stage is done — amber with 1/3 instead of a green
                            that rounds up. */}
                        {al.releases > 1 && !al.ignored && (
                          <span className="opacity-75"> · {al.resolved_releases}/{al.releases}</span>
                        )}
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
                    onDismiss={dismissCluster}
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
          title={`Damaged files (${issues.length})`}
          note="Files the scanner could not read, or whose tag structure silently misreads — fix at the source, then rescan."
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
