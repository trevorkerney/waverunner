import { useEffect, useMemo, useState } from "react";
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
}

interface Disc {
  disc_no: number;
  track_count: number;
  /** The name the disc already carries — a DISCSUBTITLE tag or an earlier
   *  rename — or null. */
  title: string | null;
}

interface Edition {
  release_id: number;
  label: string | null;
  folder_path: string;
  is_default: boolean;
  track_count: number;
  discs: Disc[];
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
}

/** A disc name to write on the keeper's edition before the combine. */
export interface DiscName {
  releaseId: number;
  discNo: number;
  /** "" clears an earlier rename. */
  title: string;
}

interface AlbumInfo {
  id: number;
  title: string;
  artist: string | null;
  track_count: number;
  /** What picking this keeper KEEPS — shown per option so the choice is
   *  informed: its year, genres, and cover survive alongside the title. */
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
}

const editionName = (e: Edition) => e.label ?? "1";

// The frame's arithmetic (measured live). Base: header, list label, mode
// picker, footer. Per picked album: 56px rows, 2 between.
const BASE_PX = 264;
const ROW_PX = 58;
// Title block: gap 12 + label 20 + 6 + input 32 + 4 + a two-line hint (the
// suggested-title sentence wraps at this width) 32 + slack 6.
const TITLE_BLOCK_PX = 12 + 20 + 6 + 32 + 4 + 32 + 6;
// Disc-name block: gap 12 + label 20 + 6 + a 32px field per disc with 4
// between + 4 + a one-line hint 16 + slack 6.
const discBlockPx = (rows: number) =>
  rows > 0 ? 12 + 20 + 6 + rows * 32 + (rows - 1) * 4 + 4 + 16 + 6 : 0;
// Album-artist block: same frame as the edition pick — label 34, two
// 30px radio rows.
const ARTIST_BLOCK_PX = 34 + 30 * 2;
// The frame never outgrows a two-album, two-disc merge (his rule): more
// albums, more discs, an edition pick or a warning scroll the body. Two
// albums by two artists ask the album-artist question, so that block is
// part of the cap.
const CAP_PX = BASE_PX + ROW_PX * 2 + ARTIST_BLOCK_PX + TITLE_BLOCK_PX + discBlockPx(2);

/** "Various Artists" — the credit a compilation carries; the matching pass
 *  scopes such an album by Various Artists' MusicBrainz id. */
export const VARIOUS_ARTISTS = "Various Artists";

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
   *  keeper's own ("Various Artists"); null = keep the keeper's. */
  onConfirm: (
    targetReleaseFolder: string | null,
    title: string | null,
    discs: DiscName[],
    albumArtist: string | null,
  ) => void;
}) {
  const { picked, keeperId, mode, busy, configuring } = selection;
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
  // Which keeper edition a merge pours into (folder path); null = default.
  const [targetFolder, setTargetFolder] = useState<string | null>(null);
  // The title nudge: a merge offers the combined album's title, prefilled
  // with what the picked titles share (else the keeper's, with a disc
  // suffix cut). Editable; empty = keep the keeper's title.
  const [title, setTitle] = useState("");
  // Per-disc names for the merged track list, keyed by disc number.
  const [discNames, setDiscNames] = useState<Record<number, string>>({});
  // The combined album's artist: the keeper's own credit, or Various Artists.
  const [artistChoice, setArtistChoice] = useState<"keeper" | "various">("keeper");

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
  const keeperEditions = keeper?.editions ?? [];
  // A keeper edition must be chosen only when there's a choice to make.
  useEffect(() => {
    setTargetFolder(null);
  }, [keeperId, mode]);
  // Every merge offers the title (user's call, 2026-09-26): prefilled with
  // what the picked titles share — "Mellon Collie…: Dawn to Dusk" + "…:
  // Twilight to Starlight" offers the set's name — else the keeper's, with
  // a disc suffix cut when it has one. Keyed on the PICK, not the fetched
  // info: the picked titles are known before the info lands, so the field
  // (and the frame's height) is right from the first paint instead of
  // growing in when the fetch returns.
  const keeperIdx = Math.max(0, picked.findIndex((p) => p.id === keeperId));
  const keeperTitle = picked[keeperIdx]?.title ?? "";
  const vote = useMemo(
    () => commonTitle(picked.map((p) => p.title), keeperIdx),
    [picked, keeperIdx],
  );
  const showTitle = mode === "merge" && keeperId != null;
  const suggestedTitle = vote.common ?? (keeperTitle ? stripDiscSuffix(keeperTitle) : null);
  useEffect(() => {
    setTitle(suggestedTitle ?? keeperTitle);
  }, [suggestedTitle, keeperTitle]);

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
  const showArtist =
    keeperId != null && distinct.length >= 2 && !keeperIsVarious && !keeperSettled;
  const distinctKey = distinct.join("\u0000");
  useEffect(() => {
    setArtistChoice(distinct.length >= 3 ? "various" : "keeper");
    // Re-defaults only when the set of credits changes — never under a click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distinctKey]);

  // The merged track list's discs — the union of disc numbers across the
  // keeper's target edition and each other album's only edition (one with
  // several is refused below anyway) — with a name suggested per disc: a
  // name already on either side wins (keeper first; this also carries a
  // source's rename across, which the merge would otherwise strand on the
  // source's folder), else the album's title remainder when it brings
  // exactly this one disc, else nothing — an album that brings several
  // discs is already a set, and its remainder names the set, not a disc.
  const mergedDiscs = useMemo<MergedDisc[]>(() => {
    if (mode !== "merge" || !info || keeperId == null || !targetEdition) return [];
    const contributors: { title: string; remainder: string; edition: Edition }[] = [];
    picked.forEach((p, i) => {
      const album = info.find((a) => a.id === p.id);
      if (!album) return;
      const edition = p.id === keeperId ? targetEdition : album.editions[0];
      if (!edition || (p.id !== keeperId && album.editions.length > 1)) return;
      const entry = { title: p.title, remainder: vote.remainders[i] ?? "", edition };
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
        const suggested =
          existing || (sole && sole.c.edition.discs.length === 1 ? sole.c.remainder : "");
        const keeperExisting =
          targetEdition.discs.find((d) => d.disc_no === disc_no)?.title ?? "";
        return { disc_no, from: sole?.c.title ?? null, keeperExisting, suggested };
      });
  }, [mode, info, keeperId, targetEdition, picked, vote]);
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
    ROW_PX * picked.length +
    (editionRows > 0 ? 34 + 30 * editionRows : 0) +
    (showArtist ? ARTIST_BLOCK_PX : 0) +
    (showTitle ? TITLE_BLOCK_PX : 0) +
    discBlockPx(discRows) +
    (blocked ? 76 : 0);
  const height = `${Math.min(px, CAP_PX) / 16}rem`;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent size="lg" height={height}>
        <DialogHeader>
          <DialogTitle>Combine {picked.length} albums</DialogTitle>
          <DialogDescription>
            The albums become one. Your files are never touched, and the combine
            is remembered through every future rescan.
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0 everywhere down the chain: a flex/grid item's default
            min-width:auto lets one unbreakable title widen the whole dialog
            past its max-w instead of truncating. */}
        <DialogBody className="-mx-1 flex min-w-0 flex-col gap-3 px-1">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Keep the info of
            </p>
            <div className="flex min-w-0 flex-col gap-0.5">
              {picked.map((a) => {
                const meta = byId(a.id);
                // Everything the surviving card would take from this pick:
                // title, artist, year, cover, genres — shown per option so
                // "keep the info of" is a visible choice, not a guess.
                const sub = [
                  meta?.artist,
                  meta?.year,
                  meta ? `${meta.track_count} track${meta.track_count === 1 ? "" : "s"}` : null,
                  meta && meta.editions.length > 1 ? `${meta.editions.length} editions` : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
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
                      <span className="block truncate text-sm">{a.title}</span>
                      {sub && (
                        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
                      )}
                      {(meta?.genres.length ?? 0) > 0 && (
                        <span className="block truncate text-[11px] text-muted-foreground/70">
                          {meta!.genres.join(", ")}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex gap-1">
              {([
                ["merge", "Merge"],
                ["versions", "Separate releases"],
              ] as const).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => onMode(m)}
                  disabled={busy}
                  className={`flex-1 rounded-md border px-2 py-1 text-xs ${
                    mode === m
                      ? "border-primary bg-primary/10 font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {mode === "merge"
                ? "One track list. Refused if two tracks contain the same disc & track number — retag them yourself first."
                : "One album, several editions: the others become entries in the release picker (alternate cuts of the same album)."}
            </p>
          </div>

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
                {(
                  [
                    ["keeper", keeperArtist ?? "No artist", "the keeper's own credit"],
                    [
                      "various",
                      VARIOUS_ARTISTS,
                      `${distinct.length} artists across these albums — a compilation`,
                    ],
                  ] as const
                ).map(([choice, label, note]) => (
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
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                {suggestedTitle && suggestedTitle !== keeperTitle
                  ? vote.common
                    ? `What the titles share — suggested. Clear it to keep “${keeperTitle}”.`
                    : `The keeper is titled as one disc of a set — suggested from its title. Clear it to keep “${keeperTitle}”.`
                  : "The keeper's title, unless you change it here."}
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
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-200">
              {multiEditionOthers.map((a) => `“${a.title}”`).join(", ")}{" "}
              {multiEditionOthers.length === 1 ? "has" : "have"} multiple editions, which can't be
              poured into one track list. Separate their editions first, or combine as separate
              releases.
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={busy || blocked || locked || keeperId == null || picked.length < 2}
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
                    discs.push({ releaseId: targetEdition.release_id, discNo: d.disc_no, title: value });
                  }
                }
              }
              onConfirm(
                mode === "merge" ? targetFolder : null,
                showTitle && t && t !== keeperTitle ? t : null,
                discs,
                showArtist && artistChoice === "various" ? VARIOUS_ARTISTS : null,
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
