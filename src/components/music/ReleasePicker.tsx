import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Disc3, Ellipsis, FolderOpen, Merge, NotebookPen, Pencil, Scissors, Star } from "lucide-react";
import { ConfirmDialog } from "../ConfirmDialog";
import { NoteDialog } from "../NoteDialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { notifyPendingWorkChanged } from "./PendingWork";
import { MATCH_LOCK_TITLE, useMatchLock } from "@/hooks/libraryRuns";
import { releaseCover } from "./musicQueue";
import type { MusicAlbumDetail, MusicRelease } from "../../types";

export function releaseLabel(r: MusicRelease): string {
  // The default release stores no label — it's version "1" by convention.
  const label = r.label ?? "1";
  return r.year ? `${label} (${r.year})` : label;
}

/** Each row is this tall exactly (three text lines — label, facts, folder
 *  — 8px above and below); the frame is sized to its rows, up to this
 *  many, and the list scrolls past that (user's call, 2026-09-27). */
const ROW_PX = 68;
const ROWS_MAX = 4;

/** The versions picker — the album page's "1 (2008)" pill, also on each
 *  multi-release album of an artist page's detail view. A MODAL (user's
 *  call, 2026-09-27; the 380px dropdown truncated every label): one row
 *  per release, with its own art and a facts line (title · year · tracks ·
 *  folder) to tell your copies apart when the labels can't. Clicking a row
 *  makes it the version the page shows and closes; the row's icons — set
 *  default, open folder, note, rename label, merge into the shown one,
 *  separate — act in place. Merge and separate confirm on top; the note
 *  editor opens on top too. */
export function ReleasePicker({
  detail,
  releaseId,
  onPick,
  getFullCoverUrl,
  onRename,
  onChanged,
  mbHidden,
}: {
  detail: MusicAlbumDetail;
  /** The release currently shown. */
  releaseId: number;
  onPick: (releaseId: number) => void;
  getFullCoverUrl: (filePath: string) => string;
  /** Rename this release's label (the host owns the dialog). */
  onRename: (release: MusicRelease) => void;
  /** A release changed (default switched, note saved) — the host refetches. */
  onChanged: () => void;
  mbHidden: boolean;
}) {
  const [open, setOpen] = useState(false);
  // A pass on this library holds every release write here (default, label,
  // merge, split) — the backend refuses them meanwhile. Above the early
  // return: hooks run on every render.
  const locked = useMatchLock(detail.library_id);
  // Merge and separate ask first (user's call, 2026-09-26): both are one
  // click on a small icon in a row of them, and both reshape the album on
  // the next rescan. The confirm names what folds into what.
  const [confirm, setConfirm] = useState<{ kind: "merge" | "split"; release: MusicRelease } | null>(
    null,
  );
  // A version's note, edited from its row (user's call, 2026-09-27): the
  // current text is fetched on the click, then the note dialog opens on
  // it. Never locked — a note is the user's remark, not library data.
  const [noteFor, setNoteFor] = useState<{ release: MusicRelease; text: string } | null>(null);
  // The row whose action icons are unfolded (user's call, 2026-09-27: one
  // "more" button per row; a click unfolds the icons leftward over the
  // text, the same button folds them back). One row at a time.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const release = detail.releases.find((r) => r.id === releaseId) ?? null;
  if (detail.releases.length <= 1 || !release) return null;
  const openNote = async (r: MusicRelease) => {
    try {
      const text = await invoke<string | null>("get_note", { kind: "release", subjectId: r.id });
      setNoteFor({ release: r, text: text ?? "" });
    } catch (err) {
      toast.error(String(err));
    }
  };
  const merge = async (r: MusicRelease) => {
    try {
      await invoke<string>("merge_album_release", { releaseId: r.id, intoReleaseId: releaseId });
      toast("Merge staged — it applies on the next rescan");
      notifyPendingWorkChanged();
    } catch (err) {
      toast.error(String(err));
    }
  };
  const split = async (r: MusicRelease) => {
    try {
      await invoke<string>("split_album_release", { releaseId: r.id });
      toast("Separation staged — it applies on the next rescan");
      notifyPendingWorkChanged();
    } catch (err) {
      toast.error(String(err));
    }
  };
  const iconButton =
    "rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40";
  return (
    <>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title={confirm?.kind === "split" ? "Separate this release?" : "Merge releases?"}
        message={
          confirm?.kind === "split"
            ? `“${confirm ? releaseLabel(confirm.release) : ""}” becomes its own album. Files stay put; it applies on the next rescan and can be undone until then.`
            : `“${confirm ? releaseLabel(confirm.release) : ""}” merges into “${releaseLabel(release)}” — one track list. Files stay put; it applies on the next rescan and can be undone until then.`
        }
        lines={3}
        confirmLabel={confirm?.kind === "split" ? "Separate" : "Merge"}
        destructive={false}
        onConfirm={() => {
          if (!confirm) return;
          void (confirm.kind === "split" ? split(confirm.release) : merge(confirm.release));
        }}
      />
      <NoteDialog
        open={noteFor !== null}
        onOpenChange={(o) => {
          if (!o) setNoteFor(null);
        }}
        label="note"
        subject={noteFor ? `${detail.title} · ${releaseLabel(noteFor.release)}` : undefined}
        initialValue={noteFor?.text ?? ""}
        onSubmit={async (text) => {
          if (!noteFor) return;
          try {
            await invoke("set_note", { kind: "release", subjectId: noteFor.release.id, text });
          } catch (err) {
            toast.error(String(err));
            throw err;
          }
          // The page shows the note under the header — refetch.
          onChanged();
        }}
      />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Disc3 size={13} />
        {releaseLabel(release)}
      </button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setExpandedId(null);
        }}
      >
        {/* Programmatic: 16 pad + 14 title (leading-none) + 8 + 20 album +
            16 gap + the rows (68px each, 1px rules between, at most four)
            + 16 gap + 69 footer (36 button, 16 above and below, 1 rule).
            Exact, so the last row sits 16px above the footer — the same
            as the rows' side inset. Two versions = 296px, four or more =
            434px; past four the list scrolls in the body. */}
        <DialogContent
          size="xl"
          height={`${159 + Math.min(detail.releases.length, ROWS_MAX) * (ROW_PX + 1) - 1}px`}
        >
          <DialogHeader>
            <DialogTitle>Releases</DialogTitle>
            {/* "Artist — Album": the full credit for a joint album, the
                owner otherwise, the bare title for a credit-less one. */}
            <DialogDescription>
              {(() => {
                const artist =
                  detail.artist_credits.length > 0
                    ? detail.artist_credits.map((c) => c.name).join(" · ")
                    : detail.artist_title;
                return artist ? `${artist} \u{2014} ${detail.title}` : detail.title;
              })()}
            </DialogDescription>
          </DialogHeader>
          {/* Right side backs out of the frame padding (-mr-4, pr-4 restores
              the content inset) so the scrollbar rides the dialog's edge;
              the left keeps a lane for focus rings. */}
          <DialogBody className="-ml-1 -mr-4 overflow-x-hidden pl-1 pr-4">
            <div className="divide-y">
              {detail.releases.map((r) => {
                const rc = releaseCover(detail, r);
                const current = r.id === releaseId;
                return (
                  // A div, not a button: the row holds buttons of its own.
                  <div
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      onPick(r.id);
                      setOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onPick(r.id);
                        setOpen(false);
                      }
                    }}
                    className={`flex cursor-pointer items-center gap-3 rounded-md px-2 outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                      current ? "bg-accent/30" : ""
                    }`}
                    style={{ height: ROW_PX }}
                  >
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      {current ? (
                        <Disc3 size={14} />
                      ) : (
                        <span className="block size-2.5 rounded-full border border-muted-foreground/50" />
                      )}
                    </span>
                    {/* Each release's own art. */}
                    {rc ? (
                      <img
                        src={getFullCoverUrl(rc)}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded-[2px] object-cover"
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] bg-muted text-muted-foreground">
                        <Disc3 size={16} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm">{releaseLabel(r)}</span>
                        {current && (
                          <span className="shrink-0 text-[10px] text-emerald-400">showing</span>
                        )}
                        {r.is_default && (
                          <span className="shrink-0 text-[10px] text-amber-300">default</span>
                        )}
                        {!r.mb_matched && r.has_mb_tag && !mbHidden ? (
                          <span
                            className="shrink-0 rounded border border-muted-foreground/30 px-1 py-px text-[10px] text-muted-foreground"
                            title="Files carry a MusicBrainz release id — the next matching pass pins it automatically"
                          >
                            MB
                          </span>
                        ) : null}
                      </span>
                      {/* Facts on one line, the folder on its own: the folder
                          is the long part and kept overflowing the facts
                          (user's call, 2026-09-27). */}
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[
                          r.title,
                          r.year,
                          `${r.tracks.length} track${r.tracks.length === 1 ? "" : "s"}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground/70" title={r.folder}>
                        {r.folder}
                      </span>
                    </span>
                    {/* The row's actions, folded behind one button. The
                        icons live in a grid column that animates 0fr → 1fr
                        (its natural width — no pixel guessing per row),
                        right-anchored and clipped, so they slide out from
                        under the toggle leftward; the text block beside
                        them is flex-1, so it gives way and truncates
                        earlier as they unfold, and recovers as they fold.
                        Each icon stops the click so the row doesn't pick. */}
                    <span className="flex shrink-0 items-center">
                      <span
                        className="grid transition-[grid-template-columns] duration-200 ease-out"
                        style={{ gridTemplateColumns: expandedId === r.id ? "1fr" : "0fr" }}
                        // Folded icons are out of the tab order and unclickable.
                        inert={expandedId !== r.id}
                      >
                        <span className="flex min-w-0 items-center justify-end gap-0.5 overflow-hidden">
                      {!r.is_default && (
                        <button
                          type="button"
                          disabled={locked}
                          title={locked ? MATCH_LOCK_TITLE : "Make this the default release"}
                          className={iconButton}
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await invoke("set_default_release", { releaseId: r.id });
                              onChanged();
                            } catch (err) {
                              toast.error(String(err));
                            }
                          }}
                        >
                          <Star size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        title="Open this release's folder in Explorer"
                        className={iconButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          invoke("open_release_folder", { releaseId: r.id }).catch((err) =>
                            toast.error(String(err)),
                          );
                        }}
                      >
                        <FolderOpen size={13} />
                      </button>
                      <button
                        type="button"
                        title="Note for this version…"
                        className={iconButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          void openNote(r);
                        }}
                      >
                        <NotebookPen size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={locked}
                        title={locked ? MATCH_LOCK_TITLE : "Rename this release's label"}
                        className={iconButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRename(r);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                      {!current && (
                        <button
                          type="button"
                          disabled={locked}
                          title={
                            locked
                              ? MATCH_LOCK_TITLE
                              : `Merge into “${releaseLabel(release)}” — one track list (staged — applies on the next rescan)`
                          }
                          className={iconButton}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirm({ kind: "merge", release: r });
                          }}
                        >
                          <Merge size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={locked}
                        title={
                          locked
                            ? MATCH_LOCK_TITLE
                            : "Separate into its own album (staged — applies on the next rescan)"
                        }
                        className={iconButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirm({ kind: "split", release: r });
                        }}
                      >
                        <Scissors size={13} />
                      </button>
                        </span>
                      </span>
                      <button
                        type="button"
                        title={expandedId === r.id ? "Hide actions" : "Actions…"}
                        aria-expanded={expandedId === r.id}
                        className={`${iconButton} ml-0.5`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedId((cur) => (cur === r.id ? null : r.id));
                        }}
                      >
                        <Ellipsis size={13} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </DialogBody>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}
