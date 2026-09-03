import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
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
import { useMbBusy, MbLoadingNote } from "./MbBusy";
import { fmtTrackTime, fmtAlbumRuntime } from "./musicQueue";
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
  title: string;
  /** Owning artist (album) or album (track) — narrows the search. */
  context: string | null;
  /** Albums only: first MATCHED credited artist's MBID — enables browsing
   *  their discography instead of text-searching all of MusicBrainz. */
  context_mbid: string | null;
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

/** One release group of the album's matched artist — the discography browser. */
interface ArtistGroup {
  group_id: string;
  title: string;
  artist: string;
  album_type: string | null;
  first_release_date: string | null;
  disambiguation: string | null;
}

/** An unmatched album credited to the artist being matched — the "match their
 *  releases instead" escape for names that aren't on MusicBrainz at all. */
interface ArtistAlbumLead {
  album_id: number;
  title: string;
  artist_title: string | null;
  /** "notfound" — the pass searched and missed; "unchecked" — never tried. */
  state: string;
}

/** One release inside a matched group — what the release picker lists. */
interface GroupRelease {
  release_id: string;
  title: string;
  artist: string;
  date: string | null;
  track_count: number | null;
  country: string | null;
  /** Every release event's country — multi-region pressings carry several. */
  countries: string[];
  format: string | null;
  label: string | null;
  status: string | null;
  disambiguation: string | null;
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

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ISO country code → flag emoji, MusicBrainz-style. MB's special codes:
 *  XW = worldwide (globe), XE = Europe (EU flag). Rendering on Windows works
 *  through the country-flag polyfill font loaded at startup. */
function countryFlag(code: string): string {
  if (code === "XW") return "🌐";
  if (code === "XE") return "🇪🇺";
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** "US" → "🇺🇸 US" (flag-prefixed when one exists). */
function countryLabel(code: string | null): string | null {
  if (!code) return null;
  const flag = countryFlag(code);
  return flag ? `${flag} ${code}` : code;
}
/** Does this look like a pasted MusicBrainz URL or bare MBID? The backends
 *  parse these in every search path; the browse UIs use this to offer a
 *  direct route when someone pastes into a filter box. */
function looksLikeMbRef(text: string): boolean {
  const t = text.trim();
  return /musicbrainz\.org\/(release-group|release|artist|recording)\//.test(t) || MBID_RE.test(t);
}

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
}: {
  kind: MbEntityKind;
  entityId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A match was applied or cleared — the host should refetch. */
  onChanged?: () => void;
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
  // Group-matched albums don't search — the group already names the album,
  // so the dialog lists the group's releases to pick from instead.
  const [groupReleases, setGroupReleases] = useState<GroupRelease[] | null>(null);
  const [loadingReleases, setLoadingReleases] = useState(false);
  // Matched-artist albums don't search either — they browse the artist's
  // discography. searchAll is the escape hatch (compilations, V/A albums).
  const [artistGroups, setArtistGroups] = useState<ArtistGroup[] | null>(null);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [groupFilter, setGroupFilter] = useState("");
  const [searchAll, setSearchAll] = useState(false);
  // Pasted release link/ID for the release picker (MB pages a group's
  // releases at 25, so a deep pressing may not be in the fetched list).
  const [releaseRef, setReleaseRef] = useState("");
  // Release-picker filters: free text plus country/format/track-count
  // dropdowns built from the fetched list — a 77-release group (Brothers in
  // Arms) is unfindable without them.
  const [relFilter, setRelFilter] = useState("");
  const [relCountry, setRelCountry] = useState("all");
  const [relFormat, setRelFormat] = useState("all");
  const [relTracks, setRelTracks] = useState("all");
  // Rows whose full country list is expanded — digital releases can carry
  // 100+ release events, so the picker shows 3 flags and "N more…" (same
  // collapse MusicBrainz itself uses).
  const [expandedCountries, setExpandedCountries] = useState<Set<string>>(new Set());
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
  // behind it. Collapsed by default (box sets run to 50+ rows) and fetched
  // only on first expand. undefined = not loaded yet, null = nothing to show.
  const [tracksOpen, setTracksOpen] = useState(false);
  const [ourTracks, setOurTracks] = useState<MusicRelease | null | undefined>(undefined);
  const [loadingTracks, setLoadingTracks] = useState(false);

  useEffect(() => {
    if (!open || !tracksOpen || kind !== "album" || ourTracks !== undefined) return;
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
  }, [open, tracksOpen, kind, entityId, releaseId, ourTracks]);

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
    setResults(null);
    setGroupReleases(null);
    setArtistGroups(null);
    setGroupFilter("");
    setSearchAll(false);
    setConfirmApply(null);
    setReleaseRef("");
    setTracksOpen(false);
    setOurTracks(undefined);
    setAlbumLeads(null);
    setLeadAlbum(null);
    setJustApplied(false);
    setConfirmIgnore(false);
    setExpandedCountries(new Set());
    load().catch((e) => toast.error(String(e)));
  }, [open, load]);

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
  const artistMbid =
    kind === "album" && !groupId && !status?.staged && !status?.declared_none
      ? (status?.context_mbid ?? null)
      : null;
  const browseMode = !!artistMbid && !searchAll;
  useEffect(() => {
    if (!open || !artistMbid) {
      setArtistGroups(null);
      return;
    }
    let stale = false;
    setLoadingGroups(true);
    invoke<ArtistGroup[]>("mb_artist_release_groups", { artistMbid })
      .then((rows) => {
        if (!stale) setArtistGroups(rows);
      })
      .catch((e) => {
        if (!stale) toast.error(String(e));
      })
      .finally(() => {
        if (!stale) setLoadingGroups(false);
      });
    return () => {
      stale = true;
    };
  }, [open, artistMbid]);
  useEffect(() => {
    if (!open || !groupId || status?.staged || status?.declared_none) {
      setGroupReleases(null);
      // A fresh open (or another album's group) starts unfiltered.
      setRelFilter("");
      setRelCountry("all");
      setRelFormat("all");
      setRelTracks("all");
      return;
    }
    let stale = false;
    setLoadingReleases(true);
    invoke<GroupRelease[]>("mb_group_releases", {
      groupId,
      // The matched release (album kind stores it as status.mbid): the
      // backend pins it into the list if the group pages past it, so the
      // green "current" always has a row to sit on.
      currentReleaseId: status?.mbid ?? null,
    })
      .then((rows) => {
        if (!stale) setGroupReleases(rows);
      })
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
    setBusy(`apply:${mbid}`);
    try {
      await invoke("mb_apply_entity_match", {
        kind,
        entityId,
        mbid,
        mbidKind,
        // Release applies pin the version this dialog was opened on.
        releaseDbId: releaseId ?? null,
        // Artists: adopt this display name instead of MB's canonical one.
        preferredName: preferredName ?? null,
      });
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

  // A mismatch found by the consistency check, awaiting the user's yes.
  const [confirmApply, setConfirmApply] = useState<{
    mbid: string;
    mbidKind?: string;
    credited: string;
  } | null>(null);

  // Consistency check before applying from the free-text search: that path
  // can hand back anyone's album, so a target whose MB credit lacks the
  // album's matched artist warns first. The browse/release lists skip this —
  // they're consistent by construction.
  const applyChecked = async (mbid: string, mbidKind?: string) => {
    if (
      kind === "album" &&
      status?.context_mbid &&
      (mbidKind === "release-group" || mbidKind === "release")
    ) {
      setBusy(`check:${mbid}`);
      try {
        const chk = await invoke<{ credited: string[]; includes: boolean }>("mb_credit_check", {
          mbidKind,
          mbid,
          artistMbid: status.context_mbid,
        });
        if (!chk.includes) {
          setConfirmApply({ mbid, mbidKind, credited: chk.credited.join(" · ") || "another artist" });
          setBusy(null);
          return;
        }
      } catch (e) {
        toast.error(String(e));
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    await apply(mbid, mbidKind);
  };

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
  // Ignoring confirms first (it's the one action here that would otherwise
  // fire on a bare click); un-ignoring is instant — it only returns the
  // entity to the pool.
  const [confirmIgnore, setConfirmIgnore] = useState(false);
  const setIgnored = async (ignored: boolean) => {
    setBusy("ignore");
    try {
      await invoke("mb_set_ignored", { entityId, ignored });
      setConfirmIgnore(false);
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

  // Distinct dropdown values from the fetched releases, and the filtered
  // view of them. Free-text matching is spacing/dash-insensitive on both
  // sides so a catalog number typed “510130 2” finds “510 130 2”.
  const releaseCountryOptions = Array.from(
    new Set(
      (groupReleases ?? []).flatMap((r) =>
        r.countries.length > 0 ? r.countries : r.country ? [r.country] : [],
      ),
    ),
  ).sort();
  const releaseFormatOptions = Array.from(
    new Set((groupReleases ?? []).flatMap((r) => (r.format ? [r.format] : []))),
  ).sort();
  const releaseTrackOptions = Array.from(
    new Set((groupReleases ?? []).flatMap((r) => (r.track_count != null ? [r.track_count] : []))),
  ).sort((a, b) => a - b);
  const condense = (s: string) => s.toLowerCase().replace(/[\s-]/g, "");
  const filteredGroupReleases = (groupReleases ?? []).filter((r) => {
    if (relCountry !== "all" && !(r.countries.includes(relCountry) || r.country === relCountry))
      return false;
    if (relFormat !== "all" && r.format !== relFormat) return false;
    if (relTracks !== "all" && String(r.track_count ?? "") !== relTracks) return false;
    const q = relFilter.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      r.title,
      r.artist,
      r.date,
      r.label,
      r.format,
      r.status,
      r.disambiguation,
      r.country,
      r.countries.join(" "),
      r.track_count?.toString(),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const hayC = condense(hay);
    return q.split(/\s+/).every((tok) => hay.includes(tok) || hayC.includes(condense(tok)));
  });

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
      {/* flex + overflow-hidden: tall content (status + release lists) must
          shrink and scroll inside the rounded frame, not spill past it. */}
      <DialogContent className="flex max-h-[85vh] w-[min(38rem,calc(100vw-3rem))] max-w-none flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Match {kind} to MusicBrainz</DialogTitle>
          <DialogDescription>
            {status?.title}
            {status?.context ? ` — ${status.context}` : ""}
          </DialogDescription>
        </DialogHeader>

        {/* -mx-1/px-1: the scroll container clips at its box edge, which cut
            focus rings off on the left — the counter-padding gives rings
            room without shifting the layout. */}
        {/* pb-1 matches the ring counter-padding vertically — without it the
            last child's bottom edge (the paste-a-release row) clips at the
            scroll container's boundary. */}
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-1">
          {/* Where it stands now */}
          <div className="flex items-center justify-between gap-3 rounded-md border p-2.5">
            <div className="min-w-0">
              {/* leading-none makes the text's line box equal its font size,
                  so it matches the icon's box and items-center genuinely
                  centers the two — instead of centering against a taller box
                  (descender room) and needing a 1px fudge to look right. */}
              <p className={`flex items-center gap-1.5 text-sm leading-none ${stateColor}`}>
                <StateIcon size={14} className="shrink-0" />
                {st.label}
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
                    disabled={busy !== null}
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
                    disabled={busy !== null}
                    onClick={() => setConfirmIgnore(true)}
                  >
                    <CircleSlash size={13} />
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
                    disabled={busy !== null}
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
                    disabled={busy !== null}
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
                    disabled={busy !== null}
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
                    busy !== null ||
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
                  <div className="flex justify-center border-t py-3">
                    <Spinner className="size-4" />
                  </div>
                ) : ourTracks && ourTracks.tracks.length > 0 ? (
                  <div className="max-h-56 overflow-y-auto border-t py-1.5">
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

          {/* Two-step, same shape as the credit-consistency warning below. */}
          {confirmIgnore && (
            <div className="flex items-center gap-3 rounded-md border px-3 py-2">
              <CircleSlash size={14} className="shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Stop counting this {NOUN[kind]}? It leaves every matching pass, count and work
                list, and goes gray on the library map. Reversible here at any time.
              </p>
              <Button
                size="sm"
                className="shrink-0"
                disabled={busy !== null}
                onClick={() => setIgnored(true)}
              >
                {busy === "ignore" && <Spinner className="size-3" />}
                Ignore
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => setConfirmIgnore(false)}
              >
                Cancel
              </Button>
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
              <Input
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                className="h-8 w-full text-sm"
                placeholder={`Filter ${status?.context ?? "this artist"}’s releases — or paste a MusicBrainz link or ID…`}
              />
              <button
                type="button"
                onClick={() => setSearchAll(true)}
                className="-mt-1.5 self-start px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Not here? Search all of MusicBrainz
              </button>
              {/* A pasted link routes straight to the id lookup (which the
                  search path already parses) — the consistency check still
                  guards the Apply. */}
              {looksLikeMbRef(groupFilter) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start gap-1.5"
                  disabled={searching}
                  onClick={() => {
                    setSearchAll(true);
                    setQuery(groupFilter);
                    void search(groupFilter);
                  }}
                >
                  {searching ? <Spinner className="size-3" /> : <Search size={13} />}
                  Look up pasted MusicBrainz {MBID_RE.test(groupFilter.trim()) ? "ID" : "link"}
                </Button>
              )}
              {loadingGroups ? (
                <div className="flex flex-col items-center gap-1.5 py-4">
                  <Spinner className="size-4" />
                  <MbLoadingNote busy={mbBusy} label="Loading discography from MusicBrainz…" />
                </div>
              ) : (
                artistGroups && (
                  <div className="max-h-72 overflow-y-auto overflow-x-hidden rounded-md border">
                    {artistGroups.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        MusicBrainz lists nothing for this artist.
                      </p>
                    )}
                    {artistGroups
                      .filter(
                        (g) =>
                          groupFilter.trim() === "" ||
                          g.title.toLowerCase().includes(groupFilter.trim().toLowerCase()),
                      )
                      .map((g, i) => (
                        <div
                          key={g.group_id}
                          className={`flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-accent/50 ${
                            i > 0 ? "border-t" : ""
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block break-words text-sm">{g.title}</span>
                            <span className="block break-words text-xs text-muted-foreground">
                              {[g.album_type, g.first_release_date, g.disambiguation]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                            <span className="block break-all font-mono text-[10px] text-muted-foreground/70">
                              {g.group_id}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                void openUrl(`https://musicbrainz.org/release-group/${g.group_id}`)
                              }
                              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                            >
                              view
                            </button>
                            <Button
                              size="sm"
                              className="gap-1.5"
                              disabled={busy !== null}
                              onClick={() => apply(g.group_id, "release-group")}
                            >
                              {busy === `apply:${g.group_id}` && <Spinner className="size-3" />}
                              Apply
                            </Button>
                          </span>
                        </div>
                      ))}
                  </div>
                )
              )}
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
              {(groupReleases?.length ?? 0) > 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={relFilter}
                    onChange={(e) => setRelFilter(e.target.value)}
                    className="h-8 min-w-40 flex-1 text-sm"
                    placeholder="Filter — title, label, catalog number…"
                  />
                  <select
                    value={relCountry}
                    onChange={(e) => setRelCountry(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="all">Any country</option>
                    {releaseCountryOptions.map((c) => (
                      <option key={c} value={c}>
                        {countryLabel(c) ?? c}
                      </option>
                    ))}
                  </select>
                  <select
                    value={relFormat}
                    onChange={(e) => setRelFormat(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="all">Any format</option>
                    {releaseFormatOptions.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <select
                    value={relTracks}
                    onChange={(e) => setRelTracks(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="all">Any track count</option>
                    {releaseTrackOptions.map((n) => (
                      <option key={n} value={String(n)}>
                        {n} tracks
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {loadingReleases ? (
                <div className="flex flex-col items-center gap-1.5 py-4">
                  <Spinner className="size-4" />
                  <MbLoadingNote busy={mbBusy} label="Loading releases from MusicBrainz…" />
                </div>
              ) : (
                groupReleases && (
                  <div className="max-h-72 overflow-y-auto overflow-x-hidden rounded-md border">
                    {groupReleases.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        MusicBrainz lists no releases in this group.
                      </p>
                    )}
                    {groupReleases.length > 0 && filteredGroupReleases.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        No releases match the filter.
                      </p>
                    )}
                    {filteredGroupReleases.map((r: GroupRelease, i: number) => (
                      <div
                        key={r.release_id}
                        className={`flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-accent/50 ${
                          i > 0 ? "border-t" : ""
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block break-words text-sm">
                            {r.title}
                            {r.release_id === status?.mbid && (
                              <span className="ml-1.5 text-[11px] text-emerald-400">current</span>
                            )}
                          </span>
                          <span className="block break-words text-xs text-muted-foreground">
                            {r.date}
                            {/* 3 flags, then "N more…" — a digital release
                                can carry 100+ release events, and past a few
                                the flags stop being a signal. Expanding
                                shows the full wall (per row). */}
                            {r.countries.length > 0 && (
                              <>
                                {r.date ? " · " : ""}
                                {(expandedCountries.has(r.release_id)
                                  ? r.countries
                                  : r.countries.slice(0, 3)
                                )
                                  .map((c) => countryLabel(c))
                                  .join(" ")}
                                {r.countries.length > 3 && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedCountries((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(r.release_id)) next.delete(r.release_id);
                                        else next.add(r.release_id);
                                        return next;
                                      })
                                    }
                                    className="ml-1 underline underline-offset-2 hover:text-foreground"
                                  >
                                    {expandedCountries.has(r.release_id)
                                      ? "collapse"
                                      : `+ ${r.countries.length - 3} more…`}
                                  </button>
                                )}
                              </>
                            )}
                            {(() => {
                              const tail = [
                                r.format,
                                r.track_count != null ? `${r.track_count} tracks` : null,
                                r.label,
                                r.status && r.status !== "Official" ? r.status : null,
                                r.disambiguation,
                              ].filter(Boolean);
                              const hasHead = !!r.date || r.countries.length > 0;
                              return tail
                                .map((p, j) => (hasHead || j > 0 ? ` · ${p}` : `${p}`))
                                .join("");
                            })()}
                          </span>
                          <span className="block break-all font-mono text-[10px] text-muted-foreground/70">
                            {r.release_id}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              void openUrl(`https://musicbrainz.org/release/${r.release_id}`)
                            }
                            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            view
                          </button>
                          <Button
                            size="sm"
                            className="gap-1.5"
                            // A matched release must be explicitly let go of
                            // before another can take its place — switching
                            // is Unmatch release, then Apply.
                            disabled={busy !== null || !!status?.mbid}
                            title={status?.mbid ? "Unmatch the release first" : undefined}
                            onClick={() => apply(r.release_id, "release")}
                          >
                            {busy === `apply:${r.release_id}` && <Spinner className="size-3" />}
                            Apply
                          </Button>
                        </span>
                      </div>
                    ))}
                  </div>
                )
              )}
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
                  disabled={busy !== null || !looksLikeMbRef(releaseRef) || !!status?.mbid}
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

          {/* The consistency warning: MB's credit disagrees with the album's
              matched artist. A yes proceeds — compilations and V/A albums
              really do live under other artists. */}
          {confirmApply && (
            <div className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
              <TriangleAlert size={14} className="shrink-0 text-amber-300" />
              <p className="min-w-0 flex-1 text-xs text-amber-200/90">
                MusicBrainz credits this album to{" "}
                <span className="font-medium">{confirmApply.credited}</span>
                {status?.context ? ` — not ${status.context}` : ""}. Match anyway?
              </p>
              <Button
                size="sm"
                className="shrink-0"
                disabled={busy !== null}
                onClick={() => {
                  const c = confirmApply;
                  setConfirmApply(null);
                  void apply(c.mbid, c.mbidKind);
                }}
              >
                Match anyway
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => setConfirmApply(null)}
              >
                Cancel
              </Button>
            </div>
          )}

          {/* Results */}
          {searching ? (
            <div className="flex flex-col items-center gap-1.5 py-4">
              <Spinner className="size-4" />
              <MbLoadingNote busy={mbBusy} label="Searching MusicBrainz…" />
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
                          use English name “{c.en_name}”
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
                        disabled={busy !== null}
                        onClick={() =>
                          c.kind === "artist"
                            ? apply(c.mbid, c.kind, useEnglish[c.mbid] ? c.en_name : null)
                            : applyChecked(c.mbid, c.kind)
                        }
                      >
                        {(busy === `apply:${c.mbid}` || busy === `check:${c.mbid}`) && (
                          <Spinner className="size-3" />
                        )}
                        Apply
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
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
        </div>

        <DialogFooter>
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
