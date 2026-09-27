import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { useMbBusy } from "./MbBusy";
import { enqueueApply } from "@/lib/applyQueue";
import { useMatchLock } from "@/hooks/libraryRuns";
import { FadeIn, SkeletonRows, useSkeletonDelay } from "../ui/skeleton";
import { fmtTrackTime, fmtAlbumRuntime } from "./musicQueue";
import { DiscographyBrowser, type ArtistGroup, type BrowseRow } from "./DiscographyBrowser";
import { GroupReleaseBrowser, type GroupRelease } from "./GroupReleaseBrowser";
import { MBID_RE, looksLikeMbRef } from "./mbRef";
import type { MusicAlbumDetail, MusicRelease } from "../../types";
import {
  Search,
  Link2Off,
  CircleCheck,
  CircleSlash,
  TriangleAlert,
  CircleOff,
  PackageOpen,
  ChevronRight,
} from "lucide-react";

/** Match one album, artist, or track to MusicBrainz — the same dialog for all
 *  three, since the shape of the job is identical: see what it's matched to
 *  now, search or paste an id, apply, or forget the match entirely. */

export type MbEntityKind = "album" | "artist" | "track";

export interface MbStatus {
  kind: MbEntityKind;
  entity_id: number;
  /** The owning library — for opening the metadata center from here. */
  library_id: string;
  title: string;
  /** Owning artist (album) or album (track) — narrows the search. */
  context: string | null;
  /** Albums only: first MATCHED credited artist's MBID — enables browsing
   *  their discography instead of text-searching all of MusicBrainz. */
  context_mbid: string | null;
  /** Albums: every credited artist in credit order, MBID when identified.
   *  Two or more identified → per-artist chips plus "All" (union). */
  credited_artists: { name: string; mbid: string | null }[];
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
  /** User said "stop counting this" — named explicitly, not just unmatched. */
  ignored: boolean;
  /** A staged rescan action will dissolve this entity — the dialog names the
   *  state and hides every mutating control. */
  staged: boolean;
  /** Albums: releases of the card holding their own pinned pressing / total
   *  releases. The "2 of 4 versions resolved" line. Declared-no-MB releases
   *  count as resolved. */
  matched_releases: number;
  total_releases: number;
  /** Albums: releases holding a real pinned pressing. While any exist the
   *  group can't be unmatched — the pins go first. */
  pinned_releases: number;
  /** User declared the album deliberately partial — mb-side gaps are
   *  expected, not a problem. */
  partial: boolean;
  /** The viewed release carries the user's "no MusicBrainz counterpart"
   *  declaration — resolved, nothing matched, nothing to do. */
  declared_none: boolean;
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
  /** Artists: MB's English artist-name alias when the canonical name is in
   *  another script — adoptable via the row's checkbox. */
  en_name: string | null;
}

const GROUP_TYPE_RANK: Record<string, number> = { album: 0, ep: 1, single: 2, compilation: 3 };

/** MusicBrainz's Various Artists. A real, matchable identity for the pass,
 *  but its "discography" is every compilation ever entered — tens of
 *  thousands, capped here at 500 oldest-first — so the dialog never browses
 *  it: a Various Artists album opens straight onto the text search. */
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

/** An unmatched album credited to the artist being matched — the "match their
 *  releases instead" escape for names that aren't on MusicBrainz at all. */
interface ArtistAlbumLead {
  album_id: number;
  title: string;
  artist_title: string | null;
  /** "notfound" — the pass searched and missed; "unchecked" — never tried. */
  state: string;
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
  state: "matched" | "partial" | "mismatch" | "notfound" | "none" | "ignored" | "staged" | "declared";
  label: string;
} {
  if (!s) return { state: "none", label: "Not matched" };
  // Staged beats everything: whatever else is true, this entity is about to
  // be replaced, and that's the fact that matters.
  if (s.staged) return { state: "staged", label: "Staged for rescan" };
  // The user declared this release has no MB counterpart: resolved (green),
  // but the release itself is never worded as "matched" — that would be a
  // lie. The album half only claims matched when the group actually is.
  if (s.declared_none)
    return {
      state: "declared",
      label: s.release_group_id
        ? "Release group matched · No official release"
        : "No official release",
    };
  // A match (or partial match) outranks the flag for display; ignored only
  // matters while nothing is matched.
  if (s.ignored && !s.mbid && !s.release_group_id)
    return { state: "ignored", label: "Ignored — not counted" };
  if (s.mbid && s.gap_count > 0) {
    // A declared-partial album EXPECTS mb-side gaps — they stop warning and
    // get named for what they are; your-side gaps still do warn.
    if (s.partial && s.gap_ours === 0) {
      return {
        state: "matched",
        label: `Release matched - ${s.gap_mb} missing intentionally`,
      };
    }
    // Never sum the two sides: one song absent from both directions is a
    // single problem, and adding them reported "24 tracks" for a 12-track
    // album. Each side is counted and named separately.
    const parts = [
      s.gap_ours > 0 && `${s.gap_ours} ${s.gap_ours === 1 ? "track" : "tracks"} unmatched`,
      s.gap_mb > 0 &&
        (s.partial ? `${s.gap_mb} missing intentionally` : `${s.gap_mb} not in your files`),
    ].filter(Boolean);
    return { state: "mismatch", label: parts.join(" · ") || `${s.gap_count} don’t line up` };
  }
  if (s.mbid)
    return {
      state: "matched",
      label:
        s.kind === "album"
          ? "Release matched"
          : s.tier === "user"
            ? "Matched by you"
            : "Matched",
    };
  // The album is known but this version isn't pinned to a pressing.
  if (s.release_group_id)
    return { state: "partial", label: "Release group matched · Unknown release" };
  if (s.searched_not_found) return { state: "notfound", label: "Searched, not found" };
  return { state: "none", label: s.kind === "album" ? "Release group unknown" : "Not matched" };
}

export function MatchDialog({
  kind,
  entityId,
  open,
  onOpenChange,
  onChanged,
  releaseId,
  releaseLabel,
  queueApplies = false,
}: {
  kind: MbEntityKind;
  entityId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A match was applied or cleared — the host should refetch. */
  onChanged?: () => void;
  /** From the metadata page, applies ENQUEUE and close the dialog: album
   *  group applies (the stage-2 rhythm: groups now, releases in step 3)
   *  and artist applies alike — the row leaves at the click and the match
   *  lands in the background. Off, the apply runs here: an album page's
   *  dialog moves on to the release picker, since the user came to finish
   *  this one album. Release applies always run here. */
  queueApplies?: boolean;
  /** Albums: WHICH release of the card this dialog is matching — the version
   *  the album page was viewing. Applies pin that release; status and the
   *  track-list diff read it. Absent (metadata center), the default release. */
  releaseId?: number | null;
  /** Display name for that release, shown so "matched" can't be misread as
   *  card-wide when the card holds several versions. */
  releaseLabel?: string | null;
}) {
  const [status, setStatus] = useState<MbStatus | null>(null);
  const [query, setQuery] = useState("");
  const [context, setContext] = useState("");
  const [results, setResults] = useState<MbCandidateRow[] | null>(null);
  // Per-candidate "adopt the English name instead of the canonical script".
  const [useEnglish, setUseEnglish] = useState<Record<string, boolean>>({});
  const [searching, setSearching] = useState(false);
  const mbBusy = useMbBusy();
  const [busy, setBusy] = useState<string | null>(null);
  // A pass on this library holds every decision here (the backend refuses
  // them); the dialog stays open for looking, its actions wait.
  const locked = useMatchLock(status?.library_id);
  const held = busy !== null || locked;
  // Group-matched albums don't search — the group already names the album,
  // so the dialog lists the group's releases to pick from instead.
  const [groupReleases, setGroupReleases] = useState<GroupRelease[] | null>(null);
  const [loadingReleases, setLoadingReleases] = useState(false);
  // Matched-artist albums don't search either — they browse the artist's
  // discography. searchAll is the escape hatch (compilations, V/A albums).
  const [artistGroups, setArtistGroups] = useState<BrowseRow[] | null>(null);
  // Which credited artist's discography to browse: an MBID, or "all" for
  // the union of every identified credit (the default with 2+ identified).
  const [browseChip, setBrowseChip] = useState<string>("all");
  const [loadingGroups, setLoadingGroups] = useState(false);
  // What's still happening behind a list that's already on screen: more
  // pages of a cold fetch, or the silent refresh of a cached discography.
  const [groupsNote, setGroupsNote] = useState<string | null>(null);
  // The discography's filter box is DiscographyBrowser's own state, not
  // the dialog's: as dialog state, every keystroke re-rendered all of this
  // and 500 rows with it (see the browser's notes).
  const [searchAll, setSearchAll] = useState(false);
  // Pasted release link/ID for the release picker (MB pages a group's
  // releases at 25, so a deep pressing may not be in the fetched list).
  const [releaseRef, setReleaseRef] = useState("");
  // The release picker's filters and per-row country expansion live in
  // GroupReleaseBrowser, keyed on the group so another group starts clean.
  // Unmatched artists: the albums credited to them that also lack a match.
  // When identifying the artist fails, these are the other way in — matching
  // an album replaces bad-tag credits, which can dissolve the name entirely.
  const [albumLeads, setAlbumLeads] = useState<ArtistAlbumLead[] | null>(null);
  const [leadAlbum, setLeadAlbum] = useState<number | null>(null);
  // An album match just applied in THIS dialog session: surface the one
  // non-obvious consequence — artists the credits prove settle on the next
  // matching pass, not instantly (new credit pages are created after the
  // stamping walk, so the pass is what cashes matches in).
  const [justApplied, setJustApplied] = useState(false);
  // "Your tracks": the files being matched, numbered, for comparing against
  // a release's tracklist on MusicBrainz — the modal hides the album page
  // behind it. Collapsed by default (box sets run to 50+ rows) but fetched
  // on open: the header's count and runtime are what you compare against
  // the candidates, so they must be there before you expand anything.
  // undefined = not loaded yet, null = nothing to show.
  const [tracksOpen, setTracksOpen] = useState(false);
  const [ourTracks, setOurTracks] = useState<MusicRelease | null | undefined>(undefined);
  const [loadingTracks, setLoadingTracks] = useState(false);

  useEffect(() => {
    if (!open || kind !== "album" || ourTracks !== undefined) return;
    let stale = false;
    setLoadingTracks(true);
    invoke<MusicAlbumDetail>("get_album_detail", { entryId: entityId })
      .then((d) => {
        if (stale) return;
        setOurTracks(
          d.releases.find((r) => r.id === releaseId) ??
            d.releases.find((r) => r.is_default) ??
            d.releases[0] ??
            null,
        );
      })
      .catch(() => {
        if (!stale) setOurTracks(null);
      })
      .finally(() => {
        if (!stale) setLoadingTracks(false);
      });
    return () => {
      stale = true;
    };
  }, [open, kind, entityId, releaseId, ourTracks]);

  const load = useCallback(async () => {
    const s = await invoke<MbStatus>("mb_status", {
      kind,
      entityId,
      releaseDbId: releaseId ?? null,
    });
    setStatus(s);
    setQuery(s.title);
    setContext(s.context ?? "");
    return s;
  }, [kind, entityId, releaseId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setResults(null);
    setGroupReleases(null);
    setArtistGroups(null);
    setBrowseChip("all");
    setSearchAll(false);
    setReleaseRef("");
    setTracksOpen(false);
    setOurTracks(undefined);
    setAlbumLeads(null);
    setLeadAlbum(null);
    setJustApplied(false);
    load()
      .then((s) => {
        // Search the prefilled name at once (user's call, 2026-09-26): an
        // unmatched artist, loose track, or album with no discography to
        // browse opens on its candidates, not on a filled field and a Go
        // button. Matched, ignored, staged or declared entities open on
        // their status; a group-matched album opens on its releases.
        if (cancelled || s.mbid || s.ignored || s.staged || s.declared_none) return;
        if (kind === "album") {
          if (s.release_group_id) return;
          const canBrowse = (s.credited_artists ?? []).some(
            (c) => !!c.mbid && c.mbid.toLowerCase() !== VARIOUS_ARTISTS_MBID,
          );
          if (canBrowse) return;
        }
        if (!s.title.trim()) return;
        setSearching(true);
        invoke<MbCandidateRow[]>("mb_search_entity", {
          kind,
          query: s.title,
          context: s.context || null,
          artistMbid: kind === "track" ? (s.context_mbid ?? null) : null,
        })
          .then((rows) => {
            if (!cancelled) setResults(rows);
          })
          .catch((e) => {
            if (!cancelled) toast.error(String(e));
          })
          .finally(() => {
            if (!cancelled) setSearching(false);
          });
      })
      .catch((e) => toast.error(String(e)));
    return () => {
      cancelled = true;
    };
  }, [open, load, kind]);

  // The artist's own unmatched albums — fetched whenever the artist is
  // unmatched so the "match their releases instead" hint can appear the
  // moment identification fails. Local DB, no network. Re-runs when status
  // reloads (a lead matched through the nested dialog drops off the list).
  const wantLeads = kind === "artist" && !!status && !status.mbid && !status.staged;
  useEffect(() => {
    if (!open || !wantLeads) {
      setAlbumLeads(null);
      return;
    }
    let stale = false;
    invoke<ArtistAlbumLead[]>("mb_artist_unmatched_albums", { entityId })
      .then((rows) => {
        if (!stale) setAlbumLeads(rows);
      })
      .catch(() => {
        if (!stale) setAlbumLeads([]);
      });
    return () => {
      stale = true;
    };
  }, [open, wantLeads, entityId, status]);

  // The release picker's list — fetched whenever the dialog is open on a
  // group-matched album (and refetched if an apply/unmatch changes the group).
  const groupId = kind === "album" ? (status?.release_group_id ?? null) : null;
  // Discography browsing: album unmatched but a credited artist IS matched.
  // Nothing browses (or fetches) while staged — the dialog is read-only then.
  // Identified credits are the browse targets; "All" unions their pages
  // (a joint album may sit under either member).
  const browseTargets = useMemo(
    () =>
      kind === "album" && !groupId && !status?.staged && !status?.declared_none
        ? (status?.credited_artists ?? [])
            .filter((c): c is { name: string; mbid: string } => !!c.mbid)
            .filter((c) => c.mbid.toLowerCase() !== VARIOUS_ARTISTS_MBID)
            .filter((c, i, arr) => arr.findIndex((o) => o.mbid === c.mbid) === i)
        : [],
    [kind, groupId, status],
  );
  const browseMode = browseTargets.length > 0 && !searchAll;
  // MusicBrainz's own count for the browsed artist(s) — the browse stops at
  // 500 groups, so a big catalogue (Pearl Jam: 1,200+, mostly bootlegs)
  // is never fully listed. The browser's "Showing N of M" line says so
  // and its empty state hands off to a scoped search.
  const [groupsTotal, setGroupsTotal] = useState<number>(0);
  // The filter found nothing in the listed groups: search the artist's
  // catalogue on MusicBrainz for it (exact title, then prefix). Lands in
  // the search results, with the way back to the discography intact.
  const searchScoped = async (q: string) => {
    const target = activeTargets[0];
    if (!q || !target) return;
    setQuery(q);
    setSearchAll(true);
    setSearching(true);
    setResults(null);
    try {
      setResults(
        await invoke<MbCandidateRow[]>("mb_search_entity", {
          kind,
          query: q,
          context: null,
          artistMbid: target.mbid,
        }),
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSearching(false);
    }
  };
  // The chip's targets: one artist, or all of them. A single identified
  // credit ignores the chip state entirely.
  const activeTargets = useMemo(
    () =>
      browseTargets.length <= 1 || browseChip === "all"
        ? browseTargets
        : browseTargets.filter((c) => c.mbid === browseChip),
    [browseTargets, browseChip],
  );
  const activeKey = activeTargets.map((c) => c.mbid).join("|");
  useEffect(() => {
    if (!open || activeTargets.length === 0) {
      setArtistGroups(null);
      setGroupsNote(null);
      return;
    }
    let stale = false;
    // Per-artist lists, merged on every change: deduped by group with every
    // source artist noted, sorted the way a discography comes back —
    // albums, EPs, singles, compilations, oldest first within each.
    const perArtist = new Map<string, BrowseRow[]>();
    const publish = () => {
      if (stale) return;
      const byId = new Map<string, BrowseRow>();
      for (const rows of perArtist.values()) {
        for (const row of rows) {
          const have = byId.get(row.group_id);
          if (have) {
            for (const v of row.via) if (!have.via.includes(v)) have.via.push(v);
          } else byId.set(row.group_id, { ...row, via: [...row.via] });
        }
      }
      const merged = [...byId.values()];
      merged.sort((a, b) => {
        const ra = GROUP_TYPE_RANK[a.album_type ?? ""] ?? 4;
        const rb = GROUP_TYPE_RANK[b.album_type ?? ""] ?? 4;
        if (ra !== rb) return ra - rb;
        return (a.first_release_date ?? "9999").localeCompare(b.first_release_date ?? "9999");
      });
      setArtistGroups(merged);
    };
    const tag = (rows: ArtistGroup[], name: string): BrowseRow[] =>
      rows.map((g) => ({ ...g, via: [name] }));

    setLoadingGroups(true);
    setGroupsNote(null);
    setGroupsTotal(0);
    // MusicBrainz's count per artist — the cache's until the fresh first
    // page reports it — published as the sum (the "All" view of a joint
    // album browses several catalogues).
    const totals = new Map<string, number>();
    const publishTotal = () => {
      if (stale) return;
      let sum = 0;
      for (const t of totals.values()) sum += t;
      setGroupsTotal(sum);
    };
    (async () => {
      // 1. Cached discographies first — instant, no network.
      for (const c of activeTargets) {
        const cached = await invoke<{ groups: ArtistGroup[]; total: number | null } | null>(
          "mb_artist_groups_cached",
          { artistMbid: c.mbid },
        );
        if (stale) return;
        if (cached) {
          perArtist.set(c.mbid, tag(cached.groups, c.name));
          if (cached.total != null) totals.set(c.mbid, cached.total);
        }
      }
      if (perArtist.size > 0) {
        publish();
        publishTotal();
        setLoadingGroups(false);
      }
      // 2. Refresh from MusicBrainz, one artist at a time, page by page.
      //    A cold artist renders as pages land; a cached one keeps its
      //    list on screen and swaps in the fresh one once complete.
      for (const c of activeTargets) {
        const hadCache = perArtist.has(c.mbid);
        setGroupsNote(
          hadCache
            ? `Checking MusicBrainz for anything new from ${c.name}…`
            : `Loading more from MusicBrainz…`,
        );
        const fresh: BrowseRow[] = [];
        let offset = 0;
        for (;;) {
          const page = await invoke<{ groups: ArtistGroup[]; total: number; done: boolean }>(
            "mb_artist_release_groups_page",
            { artistMbid: c.mbid, offset },
          );
          if (stale) return;
          fresh.push(...tag(page.groups, c.name));
          const firstPage = offset === 0;
          offset += page.groups.length;
          if (firstPage) {
            totals.set(c.mbid, page.total);
            publishTotal();
          }
          if (!hadCache) {
            perArtist.set(c.mbid, [...fresh]);
            publish();
            setLoadingGroups(false);
          }
          if (page.done) break;
        }
        if (hadCache) {
          perArtist.set(c.mbid, fresh);
          publish();
        }
      }
    })()
      .catch((e) => {
        if (!stale) toast.error(String(e));
      })
      .finally(() => {
        if (!stale) {
          setLoadingGroups(false);
          setGroupsNote(null);
          if (perArtist.size === 0) setArtistGroups([]);
        }
      });
    return () => {
      stale = true;
    };
    // activeKey stands in for activeTargets (derived each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeKey]);
  useEffect(() => {
    if (!open || !groupId || status?.staged || status?.declared_none) {
      setGroupReleases(null);
      return;
    }
    let stale = false;
    setLoadingReleases(true);
    // The matched release (album kind stores it as status.mbid): the
    // backend pins it into the list if the group pages past it, so the
    // green "current" always has a row to sit on.
    const currentReleaseId = status?.mbid ?? null;
    (async () => {
      // Cached list first (the prefetch, or a previous open) — instant.
      const cached = await invoke<GroupRelease[] | null>("mb_group_releases_cached", {
        groupId,
        currentReleaseId,
      });
      if (stale) return;
      if (cached) {
        setGroupReleases(cached);
        setLoadingReleases(false);
      }
      // Then the fresh list, swapped in whole once it lands.
      const fresh = await invoke<GroupRelease[]>("mb_group_releases", { groupId, currentReleaseId });
      if (!stale) setGroupReleases(fresh);
    })()
      .catch((e) => {
        if (!stale) toast.error(String(e));
      })
      .finally(() => {
        if (!stale) setLoadingReleases(false);
      });
    return () => {
      stale = true;
    };
    // status?.mbid: applying/unmatching a release must refetch so the pinned
    // "current" row tracks the actual match, not the one from dialog-open.
  }, [open, groupId, status?.mbid]);

  // A track whose credited artist is matched searches THAT catalogue, not
  // all of MusicBrainz — same certainty move as the album dialog browsing
  // the matched artist's discography. searchAll is the escape hatch (covers,
  // remixes filed under someone else).
  const trackScope = kind === "track" && !searchAll ? (status?.context_mbid ?? null) : null;
  const search = async (queryOverride?: string, allOverride?: boolean) => {
    const q = queryOverride ?? query;
    const scope =
      kind === "track" && !(allOverride ?? searchAll) ? (status?.context_mbid ?? null) : null;
    setSearching(true);
    setResults(null);
    try {
      setResults(
        await invoke<MbCandidateRow[]>("mb_search_entity", {
          kind,
          query: q,
          context: context || null,
          artistMbid: scope,
        }),
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSearching(false);
    }
  };

  const apply = async (mbid: string, mbidKind?: string, preferredName?: string | null) => {
    // From the METADATA PAGE a group apply queues and closes (user's call,
    // 2026-09-25): the album is matched in the background on the same
    // queue the page's cards use, and the user is straight on to the next
    // album — the stage-2 rhythm (groups now, prefetch, then releases).
    // From an album page the dialog applies here and moves on to the
    // release picker: the user came to finish this one album.
    if (
      queueApplies &&
      status &&
      (kind === "artist" || (kind === "album" && mbidKind !== "release"))
    ) {
      const cand = results?.find((c) => c.mbid === mbid);
      const grp = artistGroups?.find((g) => g.group_id === mbid);
      const title =
        preferredName ?? cand?.title ?? grp?.title ?? (kind === "artist" ? "artist" : "release group");
      const year = grp?.first_release_date?.slice(0, 4);
      enqueueApply({
        libraryId: status.library_id,
        label: `Match \u{201c}${status.title}\u{201d} \u{2192} ${title}${year ? ` (${year})` : ""}`,
        target: kind === "artist" ? { artistId: entityId } : { albumId: entityId },
        run: async () => {
          const outcome = await invoke<{ merged_into: { artist_id: number; title: string } | null }>(
            "mb_apply_entity_match",
            {
              kind,
              entityId,
              mbid,
              mbidKind,
              releaseDbId: releaseId ?? null,
              preferredName: preferredName ?? null,
            },
          );
          // Another page already held that id: this one was folded into
          // it. Said from the background, since the dialog is long closed.
          if (outcome.merged_into) {
            toast.success(
              `Merged into “${outcome.merged_into.title}” — that page already holds this MusicBrainz artist.`,
            );
          }
        },
      });
      onChanged?.();
      onOpenChange(false);
      return;
    }
    setBusy(`apply:${mbid}`);
    try {
      const outcome = await invoke<{ merged_into: { artist_id: number; title: string } | null }>(
        "mb_apply_entity_match",
        {
          kind,
          entityId,
          mbid,
          mbidKind,
          // Release applies pin the version this dialog was opened on.
          releaseDbId: releaseId ?? null,
          // Artists: adopt this display name instead of MB's canonical one.
          preferredName: preferredName ?? null,
        },
      );
      // Another page already held that id, so this one was folded into it
      // — the artist this dialog was opened on no longer exists. Say so and
      // close; reloading would only fail on the vanished row.
      if (outcome.merged_into) {
        toast.success(
          `Merged into “${outcome.merged_into.title}” — that page already holds this MusicBrainz artist.`,
        );
        onChanged?.();
        onOpenChange(false);
        return;
      }
      // No success toast — the status card flips to Matched right here in
      // view, which says it better than a popup.
      await load();
      setResults(null);
      if (kind === "album") setJustApplied(true);
      onChanged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  // No credit-consistency confirmation before applying (user decision
  // 2026-09-09): the apply adopts MusicBrainz's credit wholesale — new
  // artist rows where needed, the album re-credited — and that IS the
  // wanted outcome even when MB's credit names someone else. A wrong pick
  // is one Unmatch away, with history rows for every side effect.

  // Pasted release for a group-matched album: HARD guard — a release from a
  // different group contradicts the existing album match; the fix for that
  // is Unmatch, not a silent re-group.
  const applyPastedRelease = async () => {
    const t = releaseRef.trim();
    if (t.includes("/release-group/")) {
      toast.error("That's the album link — paste a specific release from the group.");
      return;
    }
    const fromUrl = t.match(/\/release\/([0-9a-f-]{36})/i)?.[1];
    const id = fromUrl ?? (MBID_RE.test(t) ? t : null);
    if (!id) {
      toast.error("That doesn't look like a MusicBrainz release link or ID.");
      return;
    }
    setBusy(`check:${id}`);
    try {
      const grp = await invoke<string | null>("mb_release_group_of", { releaseMbid: id });
      if (grp !== groupId) {
        toast.error(
          "This release belongs to a different album on MusicBrainz — unmatch first to switch albums.",
        );
        return;
      }
    } catch (e) {
      toast.error(String(e));
      return;
    } finally {
      setBusy(null);
    }
    await apply(id, "release");
  };

  // Two-stage for albums: the first unmatch forgets the RELEASE only (the
  // dialog drops to the release picker), the second forgets the album too.
  const releaseStage = kind === "album" && !!status?.mbid;
  // "Not on MusicBrainz — stop counting this." The honest end state for an
  // entity MB has no entry for (an alter ego it doesn't model, a bootleg, a
  // junk tag): excluded from passes, counts and work lists, gray on the map.
  // Instant both ways (his call, 2026-09-25: no confirm step — the header
  // states the outcome and Un-ignore is one click away).
  const setIgnored = async (ignored: boolean) => {
    setBusy("ignore");
    try {
      await invoke("mb_set_ignored", { entityId, ignored });
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };
  // "This release has no MB counterpart" — the per-release cousin of Ignore,
  // but GREEN: resolved by your call, not excluded from anything. Instant
  // both ways (his call: no confirm step — it's cheap to flip back).
  const setNoMb = async (declared: boolean) => {
    setBusy("nomb");
    try {
      await invoke("mb_set_release_no_mb", {
        entityId,
        releaseDbId: releaseId ?? null,
        declared,
      });
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };
  // "The missing tracks are missing on purpose" — flips instantly both ways
  // (reversible, and the label says exactly what it does).
  const setPartial = async (partial: boolean) => {
    setBusy("partial");
    try {
      await invoke("mb_set_partial", { entityId, partial });
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const unmatch = async () => {
    setBusy("unmatch");
    try {
      if (releaseStage) {
        await invoke("mb_unmatch_release", { entityId, releaseDbId: releaseId ?? null });
        toast.success("Release unmatched — the album match stays. Pick a release below.");
      } else {
        await invoke("mb_unmatch_entity", { kind, entityId });
        toast.success("Match forgotten and its changes reverted.");
      }
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const artistSettled = kind === "artist" && !!status?.mbid;
  // The failure moment for an artist: the pass already searched and missed,
  // or a search right here came back empty. That's when the album route is
  // worth pointing at — never before, since a findable artist is still the
  // higher-leverage match.
  const showLeads =
    kind === "artist" &&
    !!status &&
    !status.mbid &&
    !status.staged &&
    (status.searched_not_found || (results !== null && !searching && results.length === 0)) &&
    (albumLeads?.length ?? 0) > 0;
  const st = mbStateOf(status);
  // Skeletons after 500ms of loading (fast loads show nothing), and a
  // fade-in keyed by what just arrived, so a re-search doesn't snap.
  const showSearchSkeleton = useSkeletonDelay(searching);
  const showTracksSkeleton = useSkeletonDelay(tracksOpen && loadingTracks);
  const resultsKey = results ? `${results.length}:${results[0]?.mbid ?? ""}` : "none";
  // The group or release whose apply runs HERE — the browsers put the
  // spinner on that row. (From the metadata page, applies queue and close
  // the dialog instead, so there never is one.)
  const applyingId = busy?.startsWith("apply:") ? busy.slice("apply:".length) : null;
  const StateIcon =
    st.state === "matched" || st.state === "declared"
      ? CircleCheck
      : st.state === "mismatch" || st.state === "staged"
        ? TriangleAlert
        : CircleSlash;
  // Same vocabulary as the library map: green matched (and declared-no-MB —
  // resolved is resolved), amber partial (mismatch / release unknown), red
  // unmatched, gray ignored.
  const stateColor =
    st.state === "matched" || st.state === "declared"
      ? "text-emerald-400"
      : st.state === "mismatch" || st.state === "partial" || st.state === "staged"
        ? "text-amber-400"
        : st.state === "ignored"
          ? "text-muted-foreground"
          : "text-red-400";
  // Staged = immutable everywhere in this dialog: search, browse, pickers,
  // and Unmatch all hide; the status card explains the way out.
  const stagedLock = !!status?.staged;
  // Declared-no-MB hides the search/browse/pickers too — there is nothing to
  // look for. Softer than the staged lock: Reconsider reopens everything.
  const resolvedLock = stagedLock || !!status?.declared_none;

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      {/* STATIC height per kind (modal rule): the frame never follows the
          content — results, a discography, a release list all load into a
          scrolling body at the same size, as skeleton rows first. Albums
          carry the most (status, your tracks, chips, filters, list, paste
          row); tracks the least. */}
      <DialogContent
        width="38rem"
        height={kind === "album" ? "40rem" : kind === "artist" ? "36rem" : "30rem"}
      >
        <DialogHeader>
          <DialogTitle>Match {kind} to MusicBrainz</DialogTitle>
          <DialogDescription>
            {status?.title}
            {/* Albums name the full credit, not just the first artist. */}
            {status?.credited_artists?.length
              ? ` — ${status.credited_artists.map((c) => c.name).join(" · ")}`
              : status?.context
                ? ` — ${status.context}`
                : ""}
          </DialogDescription>
        </DialogHeader>

        {/* -mx-1/px-1: the scroll container clips at its box edge, which cut
            focus rings off on the left — the counter-padding gives rings
            room without shifting the layout. */}
        {/* pb-1 matches the ring counter-padding vertically — without it the
            last child's bottom edge (the paste-a-release row) clips at the
            scroll container's boundary. overflow-x-hidden: a scrolling box
            clips both axes and the counter-margins would summon a
            horizontal bar. */}
        {/* Right side backs out of the frame padding (-mr-4, pr-4 restores
            the content inset) so the scrollbar rides the dialog's edge. */}
        <DialogBody className="-ml-1 -mr-4 flex flex-col gap-3 overflow-x-hidden pl-1 pr-4 pb-1">
          {/* Where it stands now */}
          <div className="flex items-center justify-between gap-3 rounded-md border p-2.5">
            <div className="min-w-0">
              {/* leading-none makes the text's line box equal its font size,
                  so it matches the icon's box and items-center genuinely
                  centers the two — instead of centering against a taller box
                  (descender room) and needing a 1px fudge to look right. */}
              <p className={`flex items-center gap-1.5 text-sm leading-none ${stateColor}`}>
                <StateIcon size={14} className="shrink-0" />
                {/* A track-list mismatch is a link: the metadata center's
                    differ pane is where the tracks get accepted or fixed,
                    so the count takes you straight to this album's card. */}
                {kind === "album" && st.state === "mismatch" && status ? (
                  <button
                    type="button"
                    className="underline decoration-current/40 underline-offset-2 hover:decoration-current"
                    title="See these tracks in the metadata center"
                    onClick={() => {
                      onOpenChange(false);
                      window.dispatchEvent(
                        new CustomEvent("waverunner:open-music-center", {
                          detail: {
                            libraryId: status.library_id,
                            focus: { pane: "gaps", albumId: status.entity_id },
                          },
                        }),
                      );
                    }}
                  >
                    {st.label}
                  </button>
                ) : (
                  st.label
                )}
              </p>
              {/* Albums carry TWO ids — the release group (the album as a
                  work) ABOVE the release (the pressing), mirroring how they
                  unmatch: release first, group second. Both links; group
                  alone means the release is still unmatched. */}
              {kind === "album" && status?.release_group_id && (
                <button
                  type="button"
                  onClick={() =>
                    void openUrl(`https://musicbrainz.org/release-group/${status.release_group_id}`)
                  }
                  className="mt-0.5 block w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  <span className="mr-1.5 font-sans text-muted-foreground/70">release group</span>
                  {status.release_group_id}
                </button>
              )}
              {status?.mbid && (
                // Opener plugin, not an anchor: the webview ignores _blank.
                <button
                  type="button"
                  onClick={() =>
                    void openUrl(
                      `https://musicbrainz.org/${kind === "album" ? "release" : ENTITY_URL[kind]}/${status.mbid}`,
                    )
                  }
                  className="mt-0.5 block w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  {kind === "album" && (
                    <span className="mr-1.5 font-sans text-muted-foreground/70">release</span>
                  )}
                  {status.mbid}
                </button>
              )}
              {/* Multi-version cards: matching is PER VERSION — say which one
                  this dialog is about and how the card stands overall. */}
              {kind === "album" && (status?.total_releases ?? 0) > 1 && !stagedLock && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {releaseLabel ? (
                    <>
                      This match is for the <span className="font-medium">“{releaseLabel}”</span>{" "}
                      version ·{" "}
                    </>
                  ) : null}
                  {status!.matched_releases} of {status!.total_releases} versions resolved
                </p>
              )}
              {stagedLock && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  A staged change (split or combine) replaces this on the next rescan — matching
                  and editing are locked until it applies. To edit now, undo the staged change in
                  the metadata center’s banner.
                </p>
              )}
            </div>
            {/* Anything to forget at all, not just a release id: an album
                matched before 12.5 has a release GROUP and applied changes,
                and refusing to unmatch it would strand ~190 albums. */}
            <span className="flex shrink-0 flex-col items-end gap-1">
              {/* Ignore lives here rather than on the page: it's a statement
                  about MusicBrainz identity, so it belongs beside the id and
                  the unmatch. Tracks are excluded — the counts and work lists
                  it exempts you from are album/artist ones. */}
              {kind !== "track" && !stagedLock && !status?.mbid && !status?.release_group_id && (
                status?.ignored ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 leading-none"
                    disabled={held}
                    onClick={() => setIgnored(false)}
                  >
                    {busy === "ignore" ? <Spinner className="size-3" /> : <CircleSlash size={13} />}
                    Un-ignore
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 leading-none"
                    disabled={held}
                    onClick={() => setIgnored(true)}
                  >
                    {busy === "ignore" ? <Spinner className="size-3" /> : <CircleSlash size={13} />}
                    Ignore
                  </Button>
                )
              )}
              {/* "No MB release": the release-level truth-teller for pressings
                  MusicBrainz will never list (unofficial remasters, bootlegs).
                  Green resolved, never worded as matched. */}
              {kind === "album" && !stagedLock && !status?.mbid && (
                status?.declared_none ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 leading-none"
                    disabled={held}
                    onClick={() => setNoMb(false)}
                  >
                    {busy === "nomb" ? <Spinner className="size-3" /> : <CircleOff size={13} />}
                    Un-declare
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 leading-none"
                    disabled={held}
                    onClick={() => setNoMb(true)}
                  >
                    <CircleOff size={13} />
                    No MB release
                  </Button>
                )
              )}
              {/* "The missing tracks are supposed to be missing" — melts the
                  mb-side gap warning into a green matched state. */}
              {kind === "album" &&
                !stagedLock &&
                status?.mbid &&
                (status.gap_mb > 0 || status.partial) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 leading-none"
                    disabled={held}
                    onClick={() => setPartial(!status.partial)}
                  >
                    {busy === "partial" ? <Spinner className="size-3" /> : <PackageOpen size={13} />}
                    {status.partial ? "No longer partial" : "Deliberately partial"}
                  </Button>
                )}
              {(status?.mbid || status?.release_group_id) && !stagedLock && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1.5"
                  // The group can't be forgotten while any release is still
                  // pinned inside it — unmatch the release(s) first. The
                  // backend refuses too; this just says so up front.
                  disabled={
                    held ||
                    (kind === "album" && !releaseStage && (status?.pinned_releases ?? 0) > 0)
                  }
                  title={
                    kind === "album" && !releaseStage && (status?.pinned_releases ?? 0) > 0
                      ? status!.pinned_releases === 1
                        ? "A release is still matched — unmatch it first"
                        : `${status!.pinned_releases} releases are still matched — unmatch them first`
                      : undefined
                  }
                  onClick={unmatch}
                >
                  {busy === "unmatch" ? <Spinner className="size-3" /> : <Link2Off size={13} />}
                  {kind === "album"
                    ? releaseStage
                      ? "Unmatch release"
                      : "Unmatch album"
                    : "Unmatch"}
                </Button>
              )}
            </span>
          </div>

          {/* Your tracks, numbered — what the picker's "view" links are
              compared against. Disc headers mirror MusicBrainz's tracklist
              so a 5-disc box set lines up disc by disc. */}
          {kind === "album" && (
            <div className="rounded-md border">
              <button
                type="button"
                onClick={() => setTracksOpen((o) => !o)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  size={14}
                  className={`shrink-0 transition-transform ${tracksOpen ? "rotate-90" : ""}`}
                />
                <span className="min-w-0 flex-1 truncate">
                  Your tracks
                  {ourTracks
                    ? [
                        `${ourTracks.tracks.length} track${ourTracks.tracks.length === 1 ? "" : "s"}`,
                        fmtAlbumRuntime(ourTracks.tracks.reduce((s, t) => s + (t.runtime_secs ?? 0), 0)),
                      ]
                        .filter(Boolean)
                        .map((p) => ` · ${p}`)
                        .join("")
                    : ""}
                  {releaseLabel ? ` · ${releaseLabel}` : ""}
                </span>
              </button>
              {tracksOpen &&
                (loadingTracks ? (
                  showTracksSkeleton ? (
                    <SkeletonRows rows={4} className="border-t" />
                  ) : (
                    <div className="border-t" />
                  )
                ) : ourTracks && ourTracks.tracks.length > 0 ? (
                  <div className="border-t py-1.5">
                    {(() => {
                      const rows = [...ourTracks.tracks].sort(
                        (a, b) =>
                          (a.disc_number ?? 1) - (b.disc_number ?? 1) ||
                          (a.track_number ?? Number.MAX_SAFE_INTEGER) -
                            (b.track_number ?? Number.MAX_SAFE_INTEGER),
                      );
                      const multiDisc = new Set(rows.map((t) => t.disc_number ?? 1)).size > 1;
                      let lastDisc: number | null = null;
                      return rows.map((t) => {
                        const disc = t.disc_number ?? 1;
                        const header = multiDisc && disc !== lastDisc;
                        lastDisc = disc;
                        const discTitle = ourTracks.disc_titles.find((d) => d.disc === disc)?.title;
                        const fileName = t.file_path.replace(/\\/g, "/").split("/").pop() ?? "";
                        return (
                          <div key={t.id}>
                            {header && (
                              <p className="bg-muted/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Disc {disc}
                                {discTitle ? ` — ${discTitle}` : ""}
                              </p>
                            )}
                            <div className="flex items-center gap-2 px-3 py-0.5">
                              <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                                {t.track_number ?? "–"}
                              </span>
                              <span
                                className="min-w-0 flex-1 truncate text-xs"
                                title={t.title.trim() ? fileName : undefined}
                              >
                                {t.title.trim() || fileName}
                              </span>
                              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                {fmtTrackTime(t.runtime_secs)}
                              </span>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                ) : (
                  <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                    No tracks to show.
                  </p>
                ))}
            </div>
          )}

          {/* The non-obvious half of a match: artists the recorded credits
              prove are identified by the PASS, not by the apply — pages for
              newly-credited names don't exist until after the stamping walk. */}
          {justApplied && kind === "album" && (
            <p className="rounded-md border px-3 py-2 text-[11px] text-muted-foreground">
              Artists credited on this release are identified by the next{" "}
              <span className="font-medium text-foreground">matching pass</span> — after a batch of
              matches, run one from the metadata center’s library map to cash them in.
            </p>
          )}

          {/* Discography browser: the album is unmatched but a credited
              artist is identified, so the album either is or isn't in THEIR
              release groups — no text search against all of MusicBrainz.
              searchAll escapes for albums genuinely filed elsewhere
              (compilations, V/A). */}
          {browseMode && (
            <>
              {/* Joint albums: whose discography to browse. "All" unions
                  every identified credit; a credit MusicBrainz hasn't
                  identified yet shows disabled — match the artist first. */}
              {(status?.credited_artists.length ?? 0) > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {browseTargets.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setBrowseChip("all")}
                      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                        browseChip === "all"
                          ? "border-primary bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      All
                    </button>
                  )}
                  {status!.credited_artists.map((c) =>
                    c.mbid?.toLowerCase() === VARIOUS_ARTISTS_MBID ? (
                      <span
                        key={c.name}
                        title="MusicBrainz's Various Artists catalogue is every compilation ever entered — too big to browse; use the search"
                        className="rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground/60"
                      >
                        {c.name}
                      </span>
                    ) : c.mbid ? (
                      <button
                        key={`${c.name}-${c.mbid}`}
                        type="button"
                        onClick={() => setBrowseChip(c.mbid!)}
                        className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                          browseChip === c.mbid || browseTargets.length === 1
                            ? "border-primary bg-primary/10 text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {c.name}
                      </button>
                    ) : (
                      <span
                        key={c.name}
                        title="Not identified on MusicBrainz yet — match this artist to browse their releases"
                        className="rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground/60"
                      >
                        {c.name}
                      </span>
                    ),
                  )}
                </div>
              )}
              {/* The filter box, the "Showing N of M" line, and the
                  windowed list — its own component, so typing in the box
                  never renders this dialog (see DiscographyBrowser). */}
              <DiscographyBrowser
                groups={artistGroups}
                loading={loadingGroups}
                total={groupsTotal}
                targets={activeTargets}
                contextName={status?.context ?? null}
                held={held}
                applyingId={applyingId}
                searching={searching}
                mbBusy={mbBusy}
                onApply={(id) => void apply(id, "release-group")}
                onSearchAll={() => setSearchAll(true)}
                onLookupRef={(text) => {
                  setSearchAll(true);
                  setQuery(text);
                  void search(text);
                }}
                onSearchScoped={(q) => void searchScoped(q)}
              />
            </>
          )}

          {/* An identified artist has nothing left to search for — there is
              one right answer and it's already stored. Unmatch first if it's
              wrong. A GROUP-matched album doesn't search either: the group
              already names the album, so its releases are listed below to
              pick from — Unmatch is the way to a different album entirely.
              And a matched-ARTIST album browses the discography above unless
              the user explicitly widens out. */}
          {!artistSettled && !groupId && !browseMode && !resolvedLock && (
            <>
          {/* Widened out of the discography (search-all / pasted link):
              the way back, so the chips are never one-way. */}
          {browseTargets.length > 0 && searchAll && (
            <button
              type="button"
              onClick={() => {
                setSearchAll(false);
                setResults(null);
              }}
              className="self-start px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              ← Back to {browseTargets.length > 1 ? "their" : `${browseTargets[0].name}’s`} releases
            </button>
          )}
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
            <Button size="sm" variant="outline" className="h-8" disabled={searching} onClick={() => search()}>
              {searching ? <Spinner className="size-3" /> : <Search size={13} />}
              Go
            </Button>
          </div>
          {trackScope && (
            <p className="-mt-1.5 px-1 text-[11px] text-muted-foreground">
              Searching only the matched artist’s recordings.{" "}
              <button
                type="button"
                onClick={() => {
                  setSearchAll(true);
                  if (results !== null) void search(undefined, true);
                }}
                className="underline underline-offset-2 hover:text-foreground"
              >
                Search all of MusicBrainz
              </button>
            </p>
          )}
          {/* A pasted link or bare id skips the text search entirely — say so
              the moment one lands in the box, so pasting doesn't feel like a
              guess. */}
          {looksLikeMbRef(query) ? (
            <p className="-mt-1.5 flex items-center gap-1 px-1 text-[11px] text-emerald-400">
              <CircleCheck size={12} className="shrink-0" />
              MusicBrainz {MBID_RE.test(query.trim()) ? "ID" : "link"} — Go looks it up directly.
            </p>
          ) : (
            <p className="-mt-1.5 px-1 text-[11px] text-muted-foreground">
              {CONTEXT_LABEL[kind]
                ? `Paste a MusicBrainz link or ID for an exact match. Clear the ${CONTEXT_LABEL[kind].toLowerCase()} to widen the search — a wrong tag there hides every real result.`
                : "Paste a MusicBrainz link or ID for an exact match."}
            </p>
          )}
            </>
          )}

          {/* Release picker: every release of the matched group, pick the one
              your files are. Applying brings its track list and credits. */}
          {groupId && !resolvedLock && (
            <>
              <p className="px-1 text-[11px] text-muted-foreground">
                Releases of this album on MusicBrainz — pick the one your files are. Applying it
                brings its track list and credits.
              </p>
              {/* Filters and the windowed list — its own component, keyed
                  on the group so another group starts unfiltered (see
                  GroupReleaseBrowser). */}
              <GroupReleaseBrowser
                key={groupId}
                releases={groupReleases}
                loading={loadingReleases}
                mbBusy={mbBusy}
                currentId={status?.mbid ?? null}
                held={held}
                applyingId={applyingId}
                onApply={(id) => void apply(id, "release")}
              />
              {/* Deep pressings can be missing from the fetched page (MB
                  lists 25 per request) — a pasted release link covers them.
                  Guarded: the release must belong to THIS group. */}
              <div className="flex gap-2">
                <Input
                  value={releaseRef}
                  onChange={(e) => setReleaseRef(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" &&
                    looksLikeMbRef(releaseRef) &&
                    !status?.mbid &&
                    applyPastedRelease()
                  }
                  className="h-8 flex-1 text-sm"
                  placeholder="Not listed? Paste a MusicBrainz release link or ID…"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5"
                  disabled={held || !looksLikeMbRef(releaseRef) || !!status?.mbid}
                  title={status?.mbid ? "Unmatch the release first" : undefined}
                  onClick={applyPastedRelease}
                >
                  {(busy?.startsWith("check:") || busy?.startsWith("apply:")) &&
                  releaseRef.trim() !== "" ? (
                    <Spinner className="size-3" />
                  ) : null}
                  Apply
                </Button>
              </div>
            </>
          )}

          {/* The fused-album case (see the metadata page's card): several
              versions here, several albums on MusicBrainz of this name —
              one group match can't cover two different records. Separate
              lives in the versions picker behind this dialog. */}
          {kind === "album" &&
            !releaseStage &&
            (status?.total_releases ?? 0) > 1 &&
            results != null &&
            results.length > 1 && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200/90">
                {status!.total_releases} versions here and {results.length} albums on MusicBrainz
                answer to this name. If your versions are different albums that share a name,
                close this and use Separate in the album's versions picker first — each then
                matches on its own.
              </p>
            )}
          {/* Results */}
          {searching ? (
            showSearchSkeleton ? (
              <div className="rounded-md border">
                <SkeletonRows rows={5} />
                {mbBusy && (
                  <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                    MusicBrainz is busy — retrying…
                  </p>
                )}
              </div>
            ) : null
          ) : (
            results && (
              <FadeIn key={resultsKey} className="rounded-md border">
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
                          <span className="ml-1.5 text-[11px] text-amber-300">one release</span>
                        )}
                        {c.mbid === status?.mbid && (
                          <span className="ml-1.5 text-[11px] text-emerald-400">current</span>
                        )}
                      </span>
                      <span className="block break-words text-xs text-muted-foreground">
                        {[c.subtitle, c.detail].filter(Boolean).join(" · ")}
                      </span>
                      <span className="block break-all font-mono text-[10px] text-muted-foreground/70">
                        {c.mbid}
                      </span>
                      {c.kind === "artist" && c.en_name && c.en_name !== c.title && (
                        <label className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={!!useEnglish[c.mbid]}
                            onChange={(e) =>
                              setUseEnglish((m) => ({ ...m, [c.mbid]: e.target.checked }))
                            }
                          />
                          use alias “{c.en_name}”
                        </label>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {/* Candidate kinds mirror MB's URL paths verbatim. */}
                      <button
                        type="button"
                        onClick={() => void openUrl(`https://musicbrainz.org/${c.kind}/${c.mbid}`)}
                        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        view
                      </button>
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={held}
                        onClick={() =>
                          c.kind === "artist"
                            ? apply(c.mbid, c.kind, useEnglish[c.mbid] ? c.en_name : null)
                            : apply(c.mbid, c.kind)
                        }
                      >
                        {busy === `apply:${c.mbid}` && <Spinner className="size-3" />}
                        Apply
                      </Button>
                    </span>
                  </div>
                ))}
              </FadeIn>
            )
          )}

          {/* The other way in: a name that isn't on MusicBrainz (game title,
              label, junk tag) can't be matched directly — but matching the
              albums credited to it brings their real credits, which replace
              the name. Shown only once identification has actually failed. */}
          {showLeads && (
            <div className="rounded-md border p-2.5">
              <p className="text-xs text-muted-foreground">
                If this name comes from bad tags, it may not be on MusicBrainz at all. Match this
                artist’s albums instead — a matched album brings its real credits, and those
                replace the name here.
              </p>
              <div className="mt-2 overflow-hidden rounded-md border">
                {albumLeads!.map((l, i) => (
                  <div
                    key={l.album_id}
                    className={`flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-accent/50 ${
                      i > 0 ? "border-t" : ""
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block break-words text-sm">{l.title}</span>
                      <span className="block break-words text-xs text-muted-foreground">
                        {[
                          l.artist_title,
                          l.state === "notfound" ? "searched, not found" : "not yet checked",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 gap-1.5"
                      disabled={busy !== null}
                      onClick={() => setLeadAlbum(l.album_id)}
                    >
                      <Search size={13} />
                      Match
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          {/* Background fetch notes live HERE, not above the list: a line
              that appears and vanishes in the body shoved the list up and
              down with it. The footer's height never changes. */}
          {locked ? (
            <p className="mr-auto flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <Spinner className="size-3 shrink-0" />
              <span className="truncate">
                Matching pass running — decisions wait until it finishes
              </span>
            </p>
          ) : groupsNote && artistGroups ? (
            <p className="mr-auto flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <Spinner className="size-3 shrink-0" />
              <span className="truncate">{groupsNote}</span>
            </p>
          ) : null}
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* An album lead opens the full album dialog on top of this one; when it
        closes, the artist status reloads — a harvested credit may have
        identified this very artist, and matched leads drop off the list. */}
    {leadAlbum != null && (
      <MatchDialog
        kind="album"
        entityId={leadAlbum}
        open
        onOpenChange={(o) => {
          if (!o) {
            setLeadAlbum(null);
            load().catch(() => {});
          }
        }}
        onChanged={onChanged}
      />
    )}
    </>
  );
}

/** Compact status pill for a detail-page header. Fetches its own status so a
 *  page only has to say which entity it is. */
export function MbStatusChip({
  kind,
  entityId,
  reloadKey = 0,
  onClick,
  releaseId,
}: {
  kind: MbEntityKind;
  entityId: number;
  reloadKey?: number;
  onClick?: () => void;
  /** Albums: scope the chip to one release of the card — the version the
   *  page is viewing — so "Matched" tracks the version, not the card. */
  releaseId?: number | null;
}) {
  const [status, setStatus] = useState<MbStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    // Refetches (version switch, post-match reload) keep the OLD chip on
    // screen until the new status lands — blanking it collapsed the header
    // for a frame and everything below jumped. Only a change of ENTITY
    // starts from scratch.
    invoke<MbStatus>("mb_status", { kind, entityId, releaseDbId: releaseId ?? null })
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [kind, entityId, reloadKey, releaseId]);
  useEffect(() => {
    setLoaded(false);
    setStatus(null);
  }, [kind, entityId]);

  if (!loaded && !status) {
    // Reserve the chip's exact footprint while the first load is in flight —
    // the header must not reflow when it appears.
    return (
      <span className="invisible inline-block rounded-full border px-2 py-0.5 text-[11px]">
        MusicBrainz · …
      </span>
    );
  }
  const st = mbStateOf(status);
  // Same traffic light as the metadata center's lists and the library map:
  // green identified, amber one step short (album known but not the release,
  // track lists disagreeing, staged), red unmatched. Grey is ONLY "ignored" —
  // the state where nothing is wrong because you said so.
  const tone =
    st.state === "matched" || st.state === "declared"
      ? "border-emerald-500/40 text-emerald-300"
      : st.state === "ignored"
        ? "border-border text-muted-foreground"
        : st.state === "partial" || st.state === "mismatch" || st.state === "staged"
          ? "border-amber-500/40 text-amber-300"
          : "border-red-500/40 text-red-400";

  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:text-foreground ${tone}`}
    >
      MusicBrainz · {st.label}
    </button>
  );
}
