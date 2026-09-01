import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Disc3 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

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

interface Edition {
  release_id: number;
  label: string | null;
  folder_path: string;
  is_default: boolean;
  track_count: number;
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
  onConfirm: (targetReleaseFolder: string | null) => void;
}) {
  const { picked, keeperId, mode, busy, configuring } = selection;
  const [info, setInfo] = useState<AlbumInfo[] | null>(null);
  // Which keeper edition a merge pours into (folder path); null = default.
  const [targetFolder, setTargetFolder] = useState<string | null>(null);

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

  // Merge can't pour a set of alternate cuts into one track list — those
  // albums have to be separated first (matches the backend's refusal).
  const multiEditionOthers = (info ?? []).filter(
    (a) => a.id !== keeperId && a.editions.length > 1,
  );
  const blocked = mode === "merge" && multiEditionOthers.length > 0;

  return (
    <Dialog open={configuring} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Combine {picked.length} albums</DialogTitle>
          <DialogDescription>
            The albums become one. Your files are never touched, and the combine
            is remembered through every future rescan.
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0 everywhere down the chain: DialogContent is a grid, and a
            grid item's default min-width:auto lets one unbreakable title
            widen the whole dialog past its max-w instead of truncating. */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Keep the info of
            </p>
            <div className="flex max-h-56 min-w-0 flex-col gap-0.5 overflow-y-auto">
              {picked.map((a) => {
                const meta = byId(a.id);
                // Everything the surviving card would take from this pick:
                // title, artist, year, cover, genres — shown per option so
                // "keep the info of" is a visible choice, not a guess.
                const sub = [
                  meta?.artist,
                  meta?.year,
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
                    className="flex min-w-0 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/50"
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
                        className="size-9 shrink-0 rounded-[2px] object-cover"
                        draggable={false}
                      />
                    ) : (
                      // Coverless: the same disc placeholder the album grids use.
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[2px] bg-muted">
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

          {blocked && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-200">
              {multiEditionOthers.map((a) => `“${a.title}”`).join(", ")}{" "}
              {multiEditionOthers.length === 1 ? "has" : "have"} multiple editions, which can't be
              poured into one track list. Separate their editions first, or combine as separate
              releases.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={busy || blocked || keeperId == null || picked.length < 2}
            onClick={() => onConfirm(mode === "merge" ? targetFolder : null)}
          >
            {busy && <Spinner className="size-3" />}
            Combine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
