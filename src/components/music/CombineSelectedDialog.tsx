import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Disc3 } from "lucide-react";
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
import { Spinner } from "../ui/spinner";
import { commonTitle, stripDiscSuffix } from "@/lib/commonTitle";
/** "Various Artists" — the credit a compilation carries; the matching pass
 *  scopes such an album by Various Artists' MusicBrainz id. */
const VARIOUS_ARTISTS = "Various Artists";
import { MATCH_LOCK_TITLE, useMatchLock } from "@/hooks/libraryRuns";

export interface AlbumSelection {
  libraryId: string;
  picked: { id: number; title: string }[];
  /** The "keeper": every other pick folds INTO this album — its title,
   *  metadata, edits, and identity survive. */
  keeperId: number | null;
  mode: "merge" | "versions";
  busy: boolean;
  /** The configure dialog is open. */
  configuring: boolean;
  /** From a shape hint: the album artist the evidence names (a shared main
   *  artist, Various Artists) — offered and preselected in the Album-artist
   *  block. Null/absent = the usual choice. */
  suggestedArtist?: string | null;
  /** From a shape hint: a title for the combined album (a box folder's
   *  name) — prefilled in place of the titles' vote, and the discs then
   *  take their albums' full titles as names. */
  suggestedTitle?: string | null;
  /** From a shape hint (mode merge): the disc number each album's tracks
   *  take with the combine, by album id — a box ripped with every disc
   *  tagged 1, numbered by its folder order. The disc-name fields follow
   *  these numbers, and the combine writes them. */
  discBySource?: Record<number, number> | null;
  /** From a shape hint: why these were suggested, shown under the title. */
  hintReason?: string | null;
}

type CombineMode = "merge" | "versions";

/** The mode on screen against the one asked for. A switch while the
 *  dialog is open: the region under the mode buttons fades out (200ms),
 *  the content swaps, the frame resizes to the new measurement — the
 *  shell's in-place morph, run while the region is invisible — and the
 *  region fades in (from 400ms). Closed, it follows at once, so the dialog
 *  opens straight on the mode it was asked for. (The shell's
 *  useContentSwap, plus that closed rule.) */
function useModeSwap(requested: CombineMode, open: boolean): { mode: CombineMode; visible: boolean } {
  const [shown, setShown] = useState(requested);
  const [visible, setVisible] = useState(true);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (requested === shownRef.current) return;
    if (!open) {
      setShown(requested);
      setVisible(true);
      return;
    }
    setVisible(false);
    const t1 = window.setTimeout(() => setShown(requested), 200);
    const t2 = window.setTimeout(() => setVisible(true), 400);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [requested, open]);
  return { mode: shown, visible };
}

/** One track of a disc: its number (null when untagged — takes no slot,
 *  as in the merge gate) and title. */
interface Track {
  track_no: number | null;
  title: string;
}

interface Disc {
  disc_no: number;
  track_count: number;
  /** The name the disc already carries — a DISCSUBTITLE tag or an earlier
   *  rename — or null. */
  title: string | null;
  tracks: Track[];
}

interface Edition {
  release_id: number;
  label: string | null;
  folder_path: string;
  is_default: boolean;
  track_count: number;
  discs: Disc[];
  /** The release as the card would show it: its own title and year, and
   *  its cover (its pick, else its own art, else the album's). */
  title: string | null;
  year: string | null;
  cover: string | null;
}

/** One disc of the merged track list, as the name fields see it. */
interface MergedDisc {
  disc_no: number;
  /** The one album bringing this disc, for the field's placeholder; null
   *  when two albums' tracks land on the same disc number. */
  from: string | null;
  /** The name on file for this disc on the KEEPER's edition ("" when the
   *  disc comes from another album) — what a field is diffed against. */
  keeperExisting: string;
  /** The prefill: a name already on either side, else the album's title
   *  remainder when it brings exactly this one disc, else "". */
  suggested: string;
  /** The merged disc as the slot preview reads it (user's ask,
   *  2026-10-18): how many tracks land on it, the numbered slots they
   *  fill, the numbers left empty below the highest, the untagged count,
   *  and any slot two albums both claim — the merge gate's refusal, named
   *  here before the button is reached. */
  total: number;
  covered: number[];
  gaps: number[];
  unnumbered: number;
  overlaps: { track_no: number; titles: string[] }[];
}

/** "1–3, 5–12" from a sorted list of numbers. */
function ranges(nums: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i + 1 ? `${nums[i]}–${nums[j]}` : j === i + 1 ? `${nums[i]}, ${nums[j]}` : `${nums[i]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** "7", "7 and 9", "7, 9 and 11". */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The slots an album's edition fills, for its disc-numbers row: "tracks
 *  1–3, 5–12" for one disc, "tracks 1–12 · 1–10" across several, with
 *  untagged tracks counted apart. */
function slotsOf(ed: Edition | undefined): { text: string; full: string } {
  if (!ed || !ed.discs) return { text: "", full: "" };
  const parts: string[] = [];
  const fullParts: string[] = [];
  let unnumbered = 0;
  for (const d of ed.discs) {
    const nums = (d.tracks ?? [])
      .map((t) => t.track_no)
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);
    unnumbered += (d.tracks ?? []).length - nums.length;
    if (nums.length > 0) {
      parts.push(ranges(nums));
      fullParts.push(`disc ${d.disc_no}: tracks ${ranges(nums)}`);
    }
  }
  const one = parts.length === 1 && !parts[0].includes("–") && !parts[0].includes(",");
  const head = parts.length === 0 ? "" : `${one ? "track" : "tracks"} ${parts.join(" · ")}`;
  const tail = unnumbered > 0 ? `${unnumbered} unnumbered` : "";
  const join = (a: string, b: string) => [a, b].filter(Boolean).join(" · ");
  return { text: join(head, tail), full: join(fullParts.join("; "), tail) };
}

/** A disc name for the merged track list — written, in the combine's own
 *  write, onto every track landing on that disc number. */
export interface DiscName {
  discNo: number;
  /** "" clears an earlier rename. */
  title: string;
}

/** Where an album's first disc lands in the merged list (its other discs
 *  follow). Only albums whose number differs from their files' are sent. */
export interface DiscStart {
  album_id: number;
  disc_no: number;
}

/** The lowest disc an edition's tracks sit on (1 when it has none). */
const firstDiscOf = (e: Edition | undefined) =>
  e && e.discs && e.discs.length > 0 ? Math.min(...e.discs.map((d) => d.disc_no)) : 1;

interface AlbumInfo {
  id: number;
  title: string;
  artist: string | null;
  track_count: number;
  /** Rebuilt from the merged tags at the rescan whichever keeper is
   *  picked — not shown on the option rows any more (2026-10-18). */
  year: string | null;
  genres: string[];
  /** Display cover (cached path). */
  cover: string | null;
  editions: Edition[];
  /** Matched to MusicBrainz — its credits are MB's; the album-artist choice
   *  isn't offered on such a keeper (his call, 2026-09-27). */
  mb_matched: boolean;
  /** Credits set by hand — likewise not offered; the edit stands. */
  credits_edited: boolean;
  /** What rides on this album's row surviving as the keeper (user's call,
   *  2026-10-18): the album-level MusicBrainz group match, album fields set
   *  by hand ("title", "release_date", "album_type") and — poured into one
   *  list only — its release preferences ("cover", "default",
   *  "pre_emphasis", "label"). Not the keeper's, whichever is picked: notes
   *  (concatenated), year, genres, the track count (rebuilt from the merged
   *  tags), and as separate releases the pins and preferences (re-keyed by
   *  folder). */
  group_matched: boolean;
  edited_fields: string[];
  prefs: string[];
}

/** The keeper-bound facts of one album in a mode, keyed so options can be
 *  compared fact by fact; the value is what the row says. */
function keeperFacts(a: AlbumInfo, mode: CombineMode): Map<string, string> {
  const f = new Map<string, string>();
  f.set("match", a.group_matched ? "Matched to the MusicBrainz album" : "Not matched");
  const edited = [
    ...a.edited_fields.map((x) => ({ title: "title", release_date: "year", album_type: "type" })[x] ?? x),
    ...(a.credits_edited ? ["credit"] : []),
  ];
  f.set(
    "edits",
    edited.length > 0 ? `${listWords(edited).replace(/^./, (c) => c.toUpperCase())} set by hand` : "",
  );
  if (mode === "merge") {
    const prefs = a.prefs.map(
      (p) => ({ cover: "a cover pick", default: "a default release", pre_emphasis: "a pre-emphasis setting", label: "a release label" })[p] ?? p,
    );
    f.set("prefs", prefs.length > 0 ? `Has ${listWords(prefs)}` : "");
  }
  return f;
}

/** How much an album has to keep — the preselected keeper is the one with
 *  the most (the group match outranks; edits and, in a merge, preferences
 *  count one each). */
function keeperScore(a: AlbumInfo, mode: CombineMode): number {
  return (
    (a.group_matched ? 3 : 0) +
    a.edited_fields.length +
    (a.credits_edited ? 1 : 0) +
    (mode === "merge" ? a.prefs.length : 0)
  );
}

const editionName = (e: Edition) => e.label ?? "1";

// The frame's arithmetic (measured live). Base: header, list label, mode
// picker, footer. Per picked album: 56px rows, 2 between.
const BASE_PX = 264;
const ROW_PX = 58;
// Title block: gap 12 + label 20 + 6 + input 32 + 4 + a one-line hint 16
// + slack 6.
const TITLE_BLOCK_PX = 12 + 20 + 6 + 32 + 4 + 16 + 6;
// Disc-name block: gap 12 + label 20 + 6 + a 32px field per disc with 4
// between + 4 + a one-line hint 16 + slack 6.
const discBlockPx = (rows: number) =>
  rows > 0 ? 12 + 20 + 6 + rows * 32 + (rows - 1) * 4 + 4 + 16 + 6 : 0;
// Album-artist block: same frame as the edition pick — label 34, two
// 30px radio rows.
const ARTIST_BLOCK_PX = 34 + 30 * 2;
// Disc-number block (merge): gap 12 + label 20 + 4 + a 36px two-line row
// per album with 2 between + 4 + a 16px result line per merged disc + a
// one-line hint 16.
const discStartsPx = (rows: number, discs: number) =>
  rows > 0 ? 12 + 20 + 4 + rows * 36 + (rows - 1) * 2 + 4 + discs * 16 + 16 : 0;
// The frame never outgrows a THREE-album, three-disc merge (user's call,
// 2026-10-18): more albums, more discs, an edition pick or a warning scroll
// the body. Three albums by different artists ask the album-artist
// question, so that block is part of the cap, as are the disc-number rows.
// The arithmetic is the cap and the opening estimate only: once open, the
// frame follows the MEASURED content (see `measured`).
const CAP_PX = BASE_PX + ROW_PX * 3 + ARTIST_BLOCK_PX + TITLE_BLOCK_PX + discBlockPx(3) + discStartsPx(3, 3);

/** Distinct credit lines among the picked albums, case-blind. */
function distinctArtists(info: AlbumInfo[] | null): string[] {
  const names = (info ?? []).map((a) => a.artist ?? "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = n.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n.trim());
  }
  return out;
}

/** Configure step for combining the current selection: pick the keeper, pick
 *  the mode, confirm. A normal centered dialog — the grid keeps its full
 *  width while selecting, and nothing hovers over it. */
export function CombineSelectedDialog({
  selection,
  onKeeper,
  onMode,
  onOpenChange,
  onConfirm,
}: {
  selection: AlbumSelection;
  onKeeper: (id: number) => void;
  onMode: (mode: "merge" | "versions") => void;
  onOpenChange: (open: boolean) => void;
  /** `title`: a new title for the keeper, when the user accepted (or typed)
   *  one in the title nudge; null = keep the keeper's title. `discs`: the
   *  disc names that differ from what the keeper's edition has on file.
   *  `albumArtist`: the combined album's credit when it differs from the
   *  keeper's own ("Various Artists"); null = keep the keeper's.
   *  `discStarts`: mode merge — where each album's first disc lands, for
   *  the albums whose number was changed from what their files say. */
  onConfirm: (
    targetReleaseFolder: string | null,
    title: string | null,
    discs: DiscName[],
    albumArtist: string | null,
    discStarts: DiscStart[],
  ) => void;
}) {
  const { picked, keeperId, mode: requestedMode, busy, configuring } = selection;
  // A pass on this library holds the combine (the backend refuses it).
  const locked = useMatchLock(selection.libraryId);
  // The albums' info (credits, editions, discs), fetched when the picks are
  // confirmed — and the dialog OPENS ONLY ONCE IT'S HERE (his rule,
  // 2026-09-27: a modal opens at one size and stays there). Every term of
  // the frame's height comes from this info, so a frame computed before it
  // landed was a guess that then visibly corrected itself. A local read of
  // a few albums: milliseconds. Keyed on the picks, so a result for other
  // albums never opens the frame; the last result stays through the exit.
  const key = picked.map((p) => p.id).join(",");
  const [loaded, setLoaded] = useState<{ key: string; info: AlbumInfo[] } | null>(null);
  const info: AlbumInfo[] | null = loaded?.key === key ? loaded.info : null;
  const open = configuring && info !== null;
  // The mode ON SCREEN. The Merge / Separate releases buttons sit above
  // everything they change, and a switch while open runs the swap: the
  // region under the buttons fades out, the content changes, the frame
  // resizes to the new measurement, the region fades in (user's call,
  // 2026-10-18). Everything below renders from this, not the request.
  const { mode, visible } = useModeSwap(requestedMode, open);
  // Which keeper edition a merge pours into (folder path); null = default.
  const [targetFolder, setTargetFolder] = useState<string | null>(null);
  // The title nudge: a merge offers the combined album's title, prefilled
  // with what the picked titles share (else the keeper's, with a disc
  // suffix cut). Editable; empty = keep the keeper's title.
  const [title, setTitle] = useState("");
  // Per-disc names for the merged track list, keyed by disc number.
  const [discNames, setDiscNames] = useState<Record<number, string>>({});
  // The combined album's artist: the keeper's own credit, Various Artists,
  // or (from a shape hint) the main artist every credit shares.
  const [artistChoice, setArtistChoice] = useState<"keeper" | "various" | "suggested">("keeper");
  const suggestedArtist = selection.suggestedArtist?.trim() || null;
  // mode merge: where each album's first disc lands, by album id, as typed.
  // Prefilled from the shape hint's numbering (folder order) when there is
  // one, else from the album's own first disc — so a box ripped with every
  // disc tagged 1 is numbered right here (user's call, 2026-10-18: the
  // Star Wars box, whose disc layout no rule can know).
  const [discStarts, setDiscStarts] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!configuring) return;
    let cancelled = false;
    invoke<AlbumInfo[]>("get_combine_info", { albumIds: picked.map((p) => p.id) })
      .then((result) => {
        if (!cancelled) setLoaded({ key, info: result });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, info: [] });
      });
    return () => {
      cancelled = true;
    };
    // `key` stands in for `picked`: album membership is what the fetch
    // keys on, and it only changes when the selection does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configuring, key]);

  const byId = (id: number) => info?.find((a) => a.id === id);
  const keeper = keeperId != null ? byId(keeperId) : undefined;
  // How the option rows identify and compare the picks: no title line at
  // all (user's call, 2026-10-18 — the title has its own field below and
  // the disc rows name each album); the folder leaf only when folders
  // differ; a keeper-bound fact only when the options don't all agree.
  const leafOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  const foldersDiffer =
    !!info && new Set(info.map((a) => a.editions[0]?.folder_path.toLowerCase() ?? "")).size > 1;
  const differingFacts = useMemo(() => {
    const out = new Set<string>();
    if (!info || info.length < 2) return out;
    const all = info.map((a) => keeperFacts(a, mode));
    for (const key of all[0].keys()) {
      const values = new Set(all.map((f) => f.get(key) ?? ""));
      if (values.size > 1) out.add(key);
    }
    return out;
  }, [info, mode]);
  // The keeper is picked for them (user's call, 2026-10-18). Merge: nothing
  // keeper-bound differs → the section collapses to one line and the
  // largest album is the keeper (a coin flip otherwise); something differs
  // → the rows stay, the album with the most to keep preselected, so the
  // common case is zero clicks. Separate releases: the section is a
  // DEFAULT-RELEASE pick (which version the card shows), and the keeper is
  // whichever album that release belongs to — preselected the same way,
  // on its own default release. Only while no keeper is set — a pick of
  // theirs stands.
  const nothingDiffers = mode === "merge" && !!info && info.length >= 2 && differingFacts.size === 0;
  const autoKeeper = useMemo(() => {
    if (!info || info.length < 2) return null;
    const ordered = picked.map((p) => byId(p.id)).filter((a): a is AlbumInfo => !!a);
    if (ordered.length === 0) return null;
    const best = ordered.reduce((b, a) => {
      if (differingFacts.size > 0) {
        const d = keeperScore(a, mode) - keeperScore(b, mode);
        if (d !== 0) return d > 0 ? a : b;
      }
      return a.track_count > b.track_count ? a : b;
    });
    return best.id;
    // byId reads `info`, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, info, picked, differingFacts]);
  useEffect(() => {
    if (keeperId == null && autoKeeper != null && configuring) onKeeper(autoKeeper);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keeperId, autoKeeper, configuring]);
  const keeperEditions = keeper?.editions ?? [];
  const discBySource = selection.discBySource ?? null;
  // Prefill the disc starts when the info lands (or the hint's numbering
  // changes) — never under the user's typing.
  const discPrefillKey = `${key}|${info ? "1" : "0"}|${JSON.stringify(discBySource ?? null)}`;
  useEffect(() => {
    if (!info) return;
    const next: Record<number, string> = {};
    for (const p of picked) {
      const a = info.find((x) => x.id === p.id);
      const own = firstDiscOf(a?.editions[0]);
      next[p.id] = String(discBySource?.[p.id] ?? own);
    }
    setDiscStarts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discPrefillKey]);
  /** The typed start for an album, when it's a usable number. */
  const startOf = (id: number): number | null => {
    const n = parseInt(discStarts[id] ?? "", 10);
    return Number.isNaN(n) || n <= 0 ? null : n;
  };
  // The picked release folder is only meaningful on the keeper it belongs
  // to: a keeper change clears it unless the new keeper owns it (the
  // separate-releases rows set both in one click — the folder must not be
  // wiped by the keeper landing a render later).
  useEffect(() => {
    setTargetFolder((f) =>
      f != null && keeperId != null && byId(keeperId)?.editions.some((e) => e.folder_path === f) ? f : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keeperId, mode]);
  // Every merge offers the title (user's call, 2026-09-26): prefilled with
  // what the picked titles share — "Mellon Collie…: Dawn to Dusk" + "…:
  // Twilight to Starlight" offers the set's name — else the keeper's, with
  // a disc suffix cut when it has one. Keyed on the PICK, not the fetched
  // info: the picked titles are known before the info lands, so the field
  // (and the frame's height) is right from the first paint instead of
  // growing in when the fetch returns.
  const keeperIdx = Math.max(0, picked.findIndex((p) => p.id === keeperId));
  // "" until a keeper is picked: the keeper's title is only a FALLBACK
  // (no shared head, no hint), and the field shouldn't show album one's
  // title as if it were the keeper's.
  const keeperTitle = keeperId != null ? (picked[keeperIdx]?.title ?? "") : "";
  const vote = useMemo(
    () => commonTitle(picked.map((p) => p.title), keeperIdx),
    [picked, keeperIdx],
  );
  // The title and disc names show from the start (user's call, 2026-10-18:
  // "pointless that this waits until I pick a keeper"): what they offer
  // comes from the picked titles and the discs each album brings, not
  // from the keeper. Picking one refines in place — the fallback title,
  // the names its release already has, which release of a multi-release
  // keeper counts. Only the artist question still waits: its options ARE
  // the keeper's.
  const showTitle = mode === "merge";
  // A shape hint's title (a box folder's name) outranks the vote: a box
  // whose discs are titled as their own albums has no shared head worth
  // naming the set by.
  const hintTitle = selection.suggestedTitle?.trim() || null;
  const votedTitle = vote.common ?? (keeperTitle ? stripDiscSuffix(keeperTitle) : null);
  const suggestedTitle = hintTitle ?? votedTitle;
  // Keyed on the prefill VALUE: with the field showing before a keeper is
  // picked, a keeper pick that doesn't change the prefill (a suggestion
  // stands) must not wipe what was typed.
  const prefillTitle = suggestedTitle ?? keeperTitle;
  useEffect(() => {
    setTitle(prefillTitle);
  }, [prefillTitle]);
  // With the set named from its folder, each disc is named by its album's
  // whole title ("Buffalo Springfield (Mono)"), not by what that title adds
  // beyond a shared head ("Mono") — UNLESS the folder's name contains that
  // shared head: then the head IS the set's name (the folder just carries
  // an artist prefix or a label tail the detector left) and what each
  // title adds names its disc ("Mellon Collie…: Dawn to Dusk" → "Dawn to
  // Dusk"; 2026-10-18, when the whole-title rule swallowed these).
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const discNamesFromTitles =
    !!hintTitle && (!vote.common || !norm(hintTitle).includes(norm(vote.common)));
  const remainderOf = (i: number) =>
    discNamesFromTitles
      ? (stripDiscSuffix(picked[i].title) ?? picked[i].title)
      : (vote.remainders[i] ?? "");

  // The keeper edition a merge lands in: the picked one, else the default.
  const targetEdition =
    keeperEditions.find((e) => targetFolder === e.folder_path) ??
    keeperEditions.find((e) => e.is_default) ??
    keeperEditions[0];

  // The album-artist question (user's call, 2026-09-27): albums by
  // different artists combined into one is either a collaboration keeping
  // the keeper's credit, or a compilation — Various Artists. Asked whenever
  // the picks carry two or more distinct credits; three or more is a
  // compilation until said otherwise, so Various Artists leads there. Not
  // asked when the keeper already IS Various Artists (nothing to choose),
  // when all picks share one credit, or when the keeper's credit is
  // settled already — matched to MusicBrainz (MB's credit stands) or set
  // by hand (the edit stands).
  const distinct = useMemo(() => distinctArtists(info), [info]);
  const keeperArtist = keeper?.artist ?? null;
  const keeperIsVarious = keeperArtist?.trim().toLowerCase() === VARIOUS_ARTISTS.toLowerCase();
  const keeperSettled = !!keeper && (keeper.mb_matched || keeper.credits_edited);
  // A suggested artist worth its own row: named, not Various Artists (that
  // row exists), not already the keeper's credit.
  const suggestedIsVarious = suggestedArtist?.toLowerCase() === VARIOUS_ARTISTS.toLowerCase();
  const suggestedRow =
    !!suggestedArtist &&
    !suggestedIsVarious &&
    suggestedArtist.toLowerCase() !== (keeperArtist ?? "").trim().toLowerCase()
      ? suggestedArtist
      : null;
  const showArtist =
    keeperId != null &&
    (distinct.length >= 2 || !!suggestedRow) &&
    !keeperIsVarious &&
    !keeperSettled;
  const distinctKey = distinct.join("\u0000");
  useEffect(() => {
    setArtistChoice(
      suggestedRow ? "suggested" : suggestedIsVarious || distinct.length >= 3 ? "various" : "keeper",
    );
    // Re-defaults only when the set of credits (or the suggestion) changes —
    // never under a click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distinctKey, suggestedRow, suggestedIsVarious]);
  const artistOptions: { choice: "keeper" | "suggested" | "various"; label: string; note: string }[] = [
    { choice: "keeper", label: keeperArtist ?? "No artist", note: "the keeper's own credit" },
    ...(suggestedRow
      ? [{ choice: "suggested" as const, label: suggestedRow, note: "the artist every credit starts with" }]
      : []),
    {
      choice: "various",
      label: VARIOUS_ARTISTS,
      note: `${distinct.length} artists across these albums — a compilation`,
    },
  ];

  // The merged track list's discs — the union of disc numbers across the
  // keeper's target edition and each other album's only edition (one with
  // several is refused below anyway) — with a name suggested per disc: a
  // name already on either side wins (keeper first; this also carries a
  // source's rename across, which the merge would otherwise strand on the
  // source's folder), else the album's title remainder when it brings
  // exactly this one disc, else nothing — an album that brings several
  // discs is already a set, and its remainder names the set, not a disc.
  const mergedDiscs = useMemo<MergedDisc[]>(() => {
    if (mode !== "merge" || !info) return [];
    const contributors: { title: string; remainder: string; edition: Edition }[] = [];
    picked.forEach((p, i) => {
      const album = info.find((a) => a.id === p.id);
      if (!album) return;
      // No keeper yet: every album counts as a contributor, so one with
      // several releases sits out until it's picked (its release is then
      // the target one).
      const raw = p.id === keeperId ? (targetEdition ?? album.editions[0]) : album.editions[0];
      if (!raw || (p.id !== keeperId && album.editions.length > 1)) return;
      // The album's discs as they'll land: moved so its first disc sits on
      // the typed number (names on file ride along with the tracks).
      const start = startOf(p.id);
      const shift = start != null ? start - firstDiscOf(raw) : 0;
      const edition: Edition =
        shift !== 0 && raw.discs
          ? { ...raw, discs: raw.discs.map((d) => ({ ...d, disc_no: d.disc_no + shift })) }
          : raw;
      const entry = { title: p.title, remainder: remainderOf(i), edition };
      if (p.id === keeperId) contributors.unshift(entry);
      else contributors.push(entry);
    });
    const byDisc = new Map<number, { c: (typeof contributors)[number]; disc: Disc }[]>();
    for (const c of contributors) {
      // `?? []`: a backend built before editions carried discs sends none —
      // the fields stay off instead of the dialog breaking.
      for (const disc of c.edition.discs ?? []) {
        const list = byDisc.get(disc.disc_no) ?? [];
        list.push({ c, disc });
        byDisc.set(disc.disc_no, list);
      }
    }
    return [...byDisc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([disc_no, entries]) => {
        const existing = entries.find((e) => e.disc.title)?.disc.title ?? "";
        const sole = entries.length === 1 ? entries[0] : null;
        // Many albums bringing one disc that all name it the same way
        // (a box split per track, each file tagged "… (1951-1955)"): their
        // shared remainder is the disc's name as surely as a sole one's.
        const oneDiscEach = entries.every((e) => e.c.edition.discs.length === 1);
        const remainders = new Set(entries.map((e) => e.c.remainder.trim()));
        const unanimous =
          oneDiscEach && remainders.size === 1 ? [...remainders][0] : "";
        const suggested =
          existing || (sole && sole.c.edition.discs.length === 1 ? sole.c.remainder : "") || unanimous;
        const keeperExisting =
          targetEdition?.discs.find((d) => d.disc_no === disc_no)?.title ?? "";
        // The slot preview: who fills which numbers on this disc.
        const claims = new Map<number, string[]>();
        let total = 0;
        let unnumbered = 0;
        for (const e of entries) {
          for (const t of e.disc.tracks ?? []) {
            total++;
            if (t.track_no == null) unnumbered++;
            else claims.set(t.track_no, [...(claims.get(t.track_no) ?? []), e.c.title]);
          }
        }
        const covered = [...claims.keys()].sort((a, b) => a - b);
        const top = covered[covered.length - 1] ?? 0;
        const gaps: number[] = [];
        for (let n = 1; n <= top; n++) if (!claims.has(n)) gaps.push(n);
        const overlaps = covered
          .filter((n) => claims.get(n)!.length > 1)
          .map((n) => ({ track_no: n, titles: claims.get(n)! }));
        return {
          disc_no,
          from: sole?.c.title ?? null,
          keeperExisting,
          suggested,
          total,
          covered,
          gaps,
          unnumbered,
          overlaps,
        };
      });
    // remainderOf reads `vote` and `discNamesFromTitles`, startOf reads
    // `discStarts` — all listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, info, keeperId, targetEdition, picked, vote, discNamesFromTitles, discStarts]);
  // The disc-number rows: one per picked album (merge only). An album
  // spread over several discs shows its range; the number is where the
  // first one lands.
  const showDiscStarts = mode === "merge" && !!info && picked.length > 0;
  const discStartRows = showDiscStarts
    ? picked.map((p) => {
        const a = byId(p.id);
        const ed = a?.editions[0];
        const discs = (ed?.discs ?? []).map((d) => d.disc_no);
        const count = discs.length;
        const own = firstDiscOf(ed);
        const start = startOf(p.id);
        const landing =
          start != null && count > 1 ? `→ discs ${start}–${start + count - 1}` : start != null ? `→ disc ${start}` : "";
        const tagged = count > 1 ? `tagged discs ${own}–${own + count - 1}` : `tagged disc ${own}`;
        const slots = slotsOf(ed);
        return { id: p.id, title: p.title, tagged, landing, slots };
      })
    : [];
  // One line per merged disc under the rows: what lands there, the
  // numbers left empty, and a collision — named, so the gate's "refused"
  // is explained before the button is reached (user's ask, 2026-10-18).
  const discResults = mergedDiscs.map((d) => {
    if (d.overlaps.length > 0) {
      const nums = d.overlaps.map((o) => String(o.track_no));
      const titles = [...new Set(d.overlaps.flatMap((o) => o.titles))];
      const where =
        titles.length === 2 && titles[0] !== titles[1]
          ? `both “${titles[0]}” and “${titles[1]}”`
          : "more than one of these albums";
      return {
        disc_no: d.disc_no,
        bad: true,
        text: `Disc ${d.disc_no}: ${nums.length === 1 ? "track" : "tracks"} ${listWords(nums)} ${nums.length === 1 ? "is" : "are"} in ${where} — refused until one moves.`,
      };
    }
    const span = d.covered.length > 0 ? `, ${ranges(d.covered)}` : "";
    const missing = d.gaps.length > 0 ? ` with ${listWords(d.gaps.map(String))} missing` : "";
    const untagged = d.unnumbered > 0 ? ` and ${d.unnumbered} unnumbered` : "";
    return {
      disc_no: d.disc_no,
      bad: false,
      text: `Disc ${d.disc_no}: ${d.total} ${d.total === 1 ? "track" : "tracks"}${span}${missing}${untagged}.`,
    };
  });
  const collides = mode === "merge" && discResults.some((r) => r.bad);
  // Re-prefill only when the suggestions themselves change (keeper, target
  // edition, or the info landing) — never under the user's typing.
  const suggestionKey = JSON.stringify(mergedDiscs.map((d) => [d.disc_no, d.suggested]));
  useEffect(() => {
    const next: Record<number, string> = {};
    for (const d of mergedDiscs) next[d.disc_no] = d.suggested;
    setDiscNames(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestionKey]);
  // An empty info (fetch failed) shows none.
  const showDiscs = showTitle && mergedDiscs.length > 0;
  const discRows = showDiscs ? mergedDiscs.length : 0;

  // Merge can't pour a set of alternate cuts into one track list — those
  // albums have to be separated first (matches the backend's refusal).
  const multiEditionOthers = (info ?? []).filter(
    (a) => a.id !== keeperId && a.editions.length > 1,
  );
  const blocked = mode === "merge" && multiEditionOthers.length > 0;

  // The frame follows the content up to the cap: base, plus a row per
  // picked album, plus the edition pick, the title, the disc names and the
  // warning when they show.
  const editionRows = mode === "merge" && keeperEditions.length > 1 ? keeperEditions.length : 0;
  const px =
    BASE_PX +
    (nothingDiffers
      ? 36
      : mode === "versions"
        ? ROW_PX * (info ?? []).reduce((n, a) => n + Math.max(1, a.editions.length), 0) + 32
        : ROW_PX * picked.length) +
    (editionRows > 0 ? 34 + 30 * editionRows : 0) +
    (showArtist ? 34 + 30 * artistOptions.length : 0) +
    (showTitle ? TITLE_BLOCK_PX : 0) +
    discBlockPx(discRows) +
    (showDiscStarts ? discStartsPx(discStartRows.length, discResults.length) : 0) +
    (blocked ? 76 : 0);
  // The frame's height, MEASURED (user's call, 2026-10-18: the arithmetic
  // left a band of air under the last block). The header, the body's
  // content and the footer are observed; their heights plus the content
  // box's padding and gaps are what the frame needs. The arithmetic above
  // is the opening estimate (the first paint has no measurement yet) and
  // the cap; a change in what the body shows re-measures and the shell
  // grows or shrinks the frame in place.
  const headerRef = useRef<HTMLDivElement | null>(null);
  const bodyContentRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setMeasured(null);
      return;
    }
    const els = [headerRef.current, bodyContentRef.current, footerRef.current];
    if (els.some((el) => !el)) return;
    const read = () => {
      const hs = els.map((el) => el!.offsetHeight);
      // Nothing laid out — the shell hasn't attached the content yet (it
      // portals into a detached node until the stack renders its slot), or
      // the dialog is parked under another one (display:none). Reading
      // zeros here declared a 64px frame on open (2026-10-18); the
      // observer fires again once the parts have a size.
      if (hs.some((h) => h === 0)) return;
      const [h, c, f] = hs;
      // p-4 top and bottom, gap-4 between the three parts.
      setMeasured(16 + h + 16 + c + 16 + f + 16);
    };
    read();
    const ro = new ResizeObserver(read);
    for (const el of els) ro.observe(el!);
    return () => ro.disconnect();
  }, [open]);
  const height = `${Math.min(measured ?? px, CAP_PX) / 16}rem`;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      {/* 2xl, the review list's width (user's call, 2026-10-18: too much
          cut-off text at lg) — and a combine opened from that list now
          morphs height only. */}
      <DialogContent size="2xl" height={height}>
        <DialogHeader ref={headerRef}>
          <DialogTitle>Combine {picked.length} albums</DialogTitle>
          <DialogDescription>
            The albums become one, right away. Your files are never touched, and the
            combine survives every future rescan.
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0 everywhere down the chain: a flex/grid item's default
            min-width:auto lets one unbreakable title widen the whole dialog
            past its max-w instead of truncating. -mr-4 / pr-4 run the
            scroll region to the dialog's edge so the bar rides it; the
            gutter stays reserved so content never shifts sideways when the
            bar comes or goes (user's call, 2026-10-18). The inner wrapper
            is what the frame measures — its height is the content's,
            whether or not the body is scrolling. */}
        <DialogBody className="-ml-1 -mr-4 min-w-0 overflow-x-hidden pl-1 pr-4 [scrollbar-gutter:stable]">
          <div ref={bodyContentRef} className="flex min-w-0 flex-col gap-3">
          {/* The mode buttons lead: everything under them is theirs to
              change, and a switch swaps that region with a fade-out, a
              resize and a fade-in (user's call, 2026-10-18). The active
              button follows the REQUEST so the click shows at once; the
              region below follows the mode on screen. */}
          <div className="flex gap-1">
            {([
              ["merge", "Merge"],
              ["versions", "Separate releases"],
            ] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => visible && onMode(m)}
                disabled={busy}
                className={`flex-1 rounded-md border px-2 py-1 text-xs ${
                  requestedMode === m
                    ? "border-primary bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className={`flex min-w-0 flex-col gap-3 transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
          >
          <p className="text-[11px] leading-snug text-muted-foreground">
            {mode === "merge"
              ? "One track list. Refused if two tracks contain the same disc & track number — retag them yourself first."
              : "One album, several editions: the others become entries in the release picker (alternate cuts of the same album)."}
          </p>
          <div className="min-w-0">
            {/* Merge: the section says what the choice decides — the match,
                edits and preferences that ride on one album's row surviving
                (title and artist have their own controls) — and isn't asked
                at all when nothing differs. Separate releases: a DEFAULT-
                RELEASE pick — which version the card shows — one row per
                release of every album, and the keeper follows the pick
                (user's call, 2026-10-18). */}
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {mode === "merge" ? "Which album's match and edits survive" : "Default release"}
            </p>
            {nothingDiffers ? (
              <p className="text-[11px] leading-snug text-muted-foreground">
                Nothing to choose here: {picked.length === 2 ? "neither" : "none of these"} album
                {picked.length === 2 ? "" : "s"} carries a MusicBrainz match, hand edits or release
                preferences of its own, so {picked.length === 2 ? "either" : "any"} can be the keeper.
              </p>
            ) : mode === "versions" ? (
              <div className="flex min-w-0 flex-col gap-0.5">
                {picked.flatMap((p) => {
                  const a = byId(p.id);
                  if (!a) return [];
                  const facts = keeperFacts(a, mode);
                  const keeps = [...facts.entries()]
                    .filter(([k, v]) => differingFacts.has(k) && v)
                    .map(([, v]) => v)
                    .join(" · ");
                  return a.editions.map((e) => {
                    const checked =
                      keeperId === a.id &&
                      (targetFolder === e.folder_path || (targetFolder === null && e.is_default));
                    const sub = [
                      a.artist,
                      e.year,
                      `${e.track_count} track${e.track_count === 1 ? "" : "s"}`,
                      leafOf(e.folder_path),
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    const pick = () => {
                      onKeeper(a.id);
                      setTargetFolder(e.folder_path);
                    };
                    const cover = e.cover ?? a.cover;
                    return (
                      <button
                        key={e.release_id}
                        type="button"
                        onClick={pick}
                        disabled={busy}
                        className="flex h-14 min-w-0 items-center gap-2 rounded px-1 text-left hover:bg-accent/50"
                      >
                        <input
                          type="radio"
                          name="combine-default-release"
                          checked={checked}
                          onChange={pick}
                          disabled={busy}
                          tabIndex={-1}
                          className="pointer-events-none size-3.5 shrink-0 accent-primary"
                        />
                        {cover ? (
                          <img
                            src={convertFileSrc(cover)}
                            alt=""
                            className="size-12 shrink-0 rounded-[2px] object-cover"
                            draggable={false}
                          />
                        ) : (
                          <span className="flex size-12 shrink-0 items-center justify-center rounded-[2px] bg-muted">
                            <Disc3 size={16} className="text-muted-foreground" />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">
                            {e.title ?? a.title}
                            {a.editions.length > 1 && (
                              <span className="ml-1.5 text-[11px] text-muted-foreground">{editionName(e)}</span>
                            )}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
                          {keeps && (
                            <span className="block truncate text-[11px] text-foreground/90" title={keeps}>
                              {keeps}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  });
                })}
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  The card shows this release's cover, title and year; the rest sit in its release
                  picker. Its album's match and edits survive too.
                </p>
              </div>
            ) : (
            <div className="flex min-w-0 flex-col gap-0.5">
              {picked.map((a) => {
                const meta = byId(a.id);
                // The row identifies the album by its credit, track count
                // and (when they differ) folder — never by title — and
                // then says what picking it KEEPS: the facts that ride on
                // its row surviving, as plain sentences, only where the
                // options differ (user's call, 2026-10-18 — year and genres
                // came off: the rescan rebuilds them either way).
                const sub = [
                  meta?.artist,
                  meta ? `${meta.track_count} track${meta.track_count === 1 ? "" : "s"}` : null,
                  meta && meta.editions.length > 1 ? `${meta.editions.length} editions` : null,
                  foldersDiffer && meta ? leafOf(meta.editions[0]?.folder_path ?? "") : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                const facts = meta ? keeperFacts(meta, mode) : null;
                const keeps = facts
                  ? [...facts.entries()]
                      .filter(([k, v]) => differingFacts.has(k) && v)
                      .map(([, v]) => v)
                  : [];
                const keepsLine =
                  !info
                    ? ""
                    : differingFacts.size === 0
                      ? "Same either way"
                      : keeps.length > 0
                        ? keeps.join(" · ")
                        : "Nothing of its own";
                return (
                  // The whole row picks the keeper — the radio is an indicator,
                  // not the only target. Unpicking an album is done in the grid.
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onKeeper(a.id)}
                    disabled={busy}
                    // Fixed row height (three lines' worth) so the frame's
                    // per-row arithmetic is exact; the lines a row does have
                    // centre against the cover.
                    className="flex h-14 min-w-0 items-center gap-2 rounded px-1 text-left hover:bg-accent/50"
                  >
                    <input
                      type="radio"
                      name="combine-keeper"
                      checked={keeperId === a.id}
                      onChange={() => onKeeper(a.id)}
                      disabled={busy}
                      tabIndex={-1}
                      className="pointer-events-none size-3.5 shrink-0 accent-primary"
                    />
                    {meta?.cover ? (
                      <img
                        src={convertFileSrc(meta.cover)}
                        alt=""
                        // As tall as a three-line row's text.
                        className="size-12 shrink-0 rounded-[2px] object-cover"
                        draggable={false}
                      />
                    ) : (
                      // Coverless: the same disc placeholder the album grids use.
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-[2px] bg-muted">
                        <Disc3 size={16} className="text-muted-foreground" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      {sub && <span className="block truncate text-sm">{sub}</span>}
                      {keepsLine && (
                        <span
                          className={`block truncate text-[11px] ${
                            differingFacts.size === 0 ? "text-muted-foreground" : "text-foreground/90"
                          }`}
                          title={keepsLine}
                        >
                          {keepsLine}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            )}
          </div>

          {showDiscStarts && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Disc numbers
              </p>
              <div className="flex flex-col gap-0.5">
                {discStartRows.map((r) => (
                  <label key={r.id} className="flex h-9 min-w-0 items-center gap-2">
                    {/* Two lines: the title, then the slots the album fills
                        and the disc numbers its files carry. */}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm leading-5" title={r.title}>
                        {r.title}
                      </span>
                      <span
                        className="truncate text-[11px] leading-[14px] text-muted-foreground"
                        title={[r.slots.full, r.tagged].filter(Boolean).join(" · ")}
                      >
                        {[r.slots.text, r.tagged].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <input
                      value={discStarts[r.id] ?? ""}
                      onChange={(e) =>
                        setDiscStarts((s) => ({ ...s, [r.id]: e.target.value.replace(/[^0-9]/g, "") }))
                      }
                      disabled={busy}
                      inputMode="numeric"
                      className="h-7 w-12 shrink-0 rounded-md border border-input bg-transparent px-2 text-center text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{r.landing}</span>
                  </label>
                ))}
              </div>
              {/* The result, one line per merged disc, then the one-line
                  rule (the frame math counts both). */}
              {discResults.length > 0 && (
                <div className="mt-1 flex flex-col">
                  {discResults.map((r) => (
                    <p
                      key={r.disc_no}
                      className={`truncate text-[11px] leading-4 ${r.bad ? "text-destructive" : "text-foreground/80"}`}
                      title={r.text}
                    >
                      {r.text}
                    </p>
                  ))}
                </div>
              )}
              <p className="mt-1 truncate text-[11px] leading-snug text-muted-foreground">
                Where each album's first disc lands; the rest follow. Your files keep their own numbers.
              </p>
            </div>
          )}

          {/* Only a choice when the keeper HAS editions to choose between. */}
          {mode === "merge" && keeperEditions.length > 1 && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Merge into which edition of “{keeper?.title}”
              </p>
              <div className="flex flex-col gap-0.5">
                {keeperEditions.map((e) => (
                  <button
                    key={e.release_id}
                    type="button"
                    onClick={() => setTargetFolder(e.folder_path)}
                    disabled={busy}
                    className="flex items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/50"
                  >
                    <input
                      type="radio"
                      name="combine-target-edition"
                      checked={
                        targetFolder === e.folder_path || (targetFolder === null && e.is_default)
                      }
                      onChange={() => setTargetFolder(e.folder_path)}
                      disabled={busy}
                      tabIndex={-1}
                      className="pointer-events-none size-3.5 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {editionName(e)}
                      <span className="ml-1.5 text-[11px] text-muted-foreground">
                        {e.track_count} track{e.track_count === 1 ? "" : "s"}
                        {e.is_default ? " · default" : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {showArtist && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Album artist
              </p>
              <div className="flex flex-col gap-0.5">
                {artistOptions.map(({ choice, label, note }) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => setArtistChoice(choice)}
                    disabled={busy}
                    className="flex items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/50"
                  >
                    <input
                      type="radio"
                      name="combine-album-artist"
                      checked={artistChoice === choice}
                      onChange={() => setArtistChoice(choice)}
                      disabled={busy}
                      tabIndex={-1}
                      className="pointer-events-none size-3.5 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {label}
                      <span className="ml-1.5 text-[11px] text-muted-foreground">{note}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {showTitle && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Title for the combined album
              </p>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
                placeholder={keeperTitle}
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              {/* One line, and the same whichever keeper is picked: naming
                  the keeper's title here wrapped to a second line on the
                  pick and grew the frame (user's call, 2026-10-18). */}
              <p className="mt-1 truncate text-[11px] leading-snug text-muted-foreground">
                {suggestedTitle && suggestedTitle !== keeperTitle
                  ? `${
                      hintTitle
                        ? "The set's folder name — suggested."
                        : vote.common
                          ? "What the titles share — suggested."
                          : "Suggested from the keeper's title, its disc part cut."
                    } Clear it to keep the kept album's own title.`
                  : "The kept album's title, unless you change it here."}
              </p>
            </div>
          )}

          {showDiscs && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Disc names
              </p>
              <div className="flex flex-col gap-1">
                {mergedDiscs.map((d) => (
                  <label key={d.disc_no} className="flex min-w-0 items-center gap-2">
                    <span className="w-12 shrink-0 text-xs text-muted-foreground">Disc {d.disc_no}</span>
                    <input
                      value={discNames[d.disc_no] ?? ""}
                      onChange={(e) =>
                        setDiscNames((s) => ({ ...s, [d.disc_no]: e.target.value }))
                      }
                      disabled={busy}
                      // The album this disc comes from, greyed — a name is
                      // optional, and this says which one it would name.
                      placeholder={d.from ?? ""}
                      className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                  </label>
                ))}
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                Shown beside each disc number on the album page. Blank leaves a disc unnamed.
              </p>
            </div>
          )}

          {blocked && (
            <p className="rounded-md border border-primary/40 bg-primary/10 p-2 text-[11px] leading-snug text-primary">
              {multiEditionOthers.map((a) => `“${a.title}”`).join(", ")}{" "}
              {multiEditionOthers.length === 1 ? "has" : "have"} multiple editions, which can't be
              poured into one track list. Separate their editions first, or combine as separate
              releases.
            </p>
          )}
          </div>
          </div>
        </DialogBody>

        <DialogFooter ref={footerRef}>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={busy || !visible || blocked || collides || locked || keeperId == null || picked.length < 2}
            title={locked ? MATCH_LOCK_TITLE : undefined}
            onClick={() => {
              const t = title.trim();
              // Only names that differ from the keeper edition's own: a
              // disc another album brings has nothing on file, so any name
              // typed for it is written and an empty field is left alone.
              const discs: DiscName[] = [];
              if (showDiscs && targetEdition) {
                for (const d of mergedDiscs) {
                  const value = (discNames[d.disc_no] ?? "").trim();
                  if (value !== d.keeperExisting) {
                    discs.push({ discNo: d.disc_no, title: value });
                  }
                }
              }
              // Disc starts: only the albums whose typed number differs
              // from where their files already put them.
              const starts: DiscStart[] = [];
              if (mode === "merge" && info) {
                for (const p of picked) {
                  const start = startOf(p.id);
                  const own = firstDiscOf(byId(p.id)?.editions[0]);
                  if (start != null && start !== own) starts.push({ album_id: p.id, disc_no: start });
                }
              }
              onConfirm(
                // Merge: the keeper edition poured into (null = its
                // default). Separate releases: the default release picked.
                targetFolder,
                showTitle && t && t !== keeperTitle ? t : null,
                discs,
                !showArtist
                  ? null
                  : artistChoice === "various"
                    ? VARIOUS_ARTISTS
                    : artistChoice === "suggested"
                      ? suggestedRow
                      : null,
                starts,
              );
            }}
          >
            {busy && <Spinner className="size-3" />}
            Combine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
