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
// The frame never outgrows a two-album, two-disc merge (his rule): more
// albums, more discs, an edition pick or a warning scroll the body.
const CAP_PX = BASE_PX + ROW_PX * 2 + TITLE_BLOCK_PX + discBlockPx(2);

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
   *  disc names that differ from what the keeper's edition has on file. */
  onConfirm: (targetReleaseFolder: string | null, title: string | null, discs: DiscName[]) => void;
}) {
  const { picked, keeperId, mode, busy, configuring } = selection;
  // A pass on this library holds the combine (the backend refuses it).
  const locked = useMatchLock(selection.libraryId);
  const [info, setInfo] = useState<AlbumInfo[] | null>(null);
  // Which keeper edition a merge pours into (folder path); null = default.
  const [targetFolder, setTargetFolder] = useState<string | null>(null);
  // The title nudge: a merge offers the combined album's title, prefilled
  // with what the picked titles share (else the keeper's, with a disc
  // suffix cut). Editable; empty = keep the keeper's title.
  const [title, setTitle] = useState("");
  // Per-disc names for the merged track list, keyed by disc number.
  const [discNames, setDiscNames] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!configuring) return;
    setInfo(null);
    invoke<AlbumInfo[]>("get_combine_info", { albumIds: picked.map((p) => p.id) })
      .then(setInfo)
      .catch(() => setInfo([]));
    // Album membership only changes when the selection does.
  }, [configuring, picked]);

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
  // Before the info lands, one disc per pick keeps the frame's height
  // right for the common case; an empty info (fetch failed) shows none.
  const showDiscs = showTitle && (info === null || mergedDiscs.length > 0);
  const discRows = showDiscs ? (info === null ? picked.length : mergedDiscs.length) : 0;

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
    (showTitle ? TITLE_BLOCK_PX : 0) +
    discBlockPx(discRows) +
    (blocked ? 76 : 0);
  const height = `${Math.min(px, CAP_PX) / 16}rem`;

  return (
    <Dialog open={configuring} onOpenChange={(o) => !busy && onOpenChange(o)}>
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
                {(info === null
                  ? // Placeholders until the info lands: one per pick, the
                    // common case, so the frame doesn't grow in.
                    picked.map((_, i) => ({ disc_no: i + 1, from: null as string | null, pending: true }))
                  : mergedDiscs.map((d) => ({ disc_no: d.disc_no, from: d.from, pending: false }))
                ).map((d) => (
                  <label key={d.disc_no} className="flex min-w-0 items-center gap-2">
                    <span className="w-12 shrink-0 text-xs text-muted-foreground">Disc {d.disc_no}</span>
                    <input
                      value={d.pending ? "" : (discNames[d.disc_no] ?? "")}
                      onChange={(e) =>
                        setDiscNames((s) => ({ ...s, [d.disc_no]: e.target.value }))
                      }
                      disabled={busy || d.pending}
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
              if (showDiscs && info !== null && targetEdition) {
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
