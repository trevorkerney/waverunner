import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Disc3, FolderOpen, Merge, NotebookPen, Pencil, Scissors, Star } from "lucide-react";
import { ConfirmDialog } from "../ConfirmDialog";
import { NoteDialog } from "../NoteDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { notifyPendingWorkChanged } from "./PendingWork";
import { MATCH_LOCK_TITLE, useMatchLock } from "@/hooks/libraryRuns";
import { releaseCover } from "./musicQueue";
import type { MusicAlbumDetail, MusicRelease } from "../../types";

export function releaseLabel(r: MusicRelease): string {
  // The default release stores no label — it's version "1" by convention.
  const label = r.label ?? "1";
  return r.year ? `${label} (${r.year})` : label;
}

/** The release picker — the album page's "1 (2008)" pill, also on each
 *  multi-release album of an artist page's detail view. One row per
 *  release: pick to view/play it; a facts line (title · year · tracks ·
 *  folder) tells your copies apart when the labels can't; per-row actions
 *  — set default, open folder, rename label, merge into the shown one,
 *  separate — instead of one ambiguous footer verb. */
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
  /** A release changed (default switched) — the host refetches. */
  onChanged: () => void;
  mbHidden: boolean;
}) {
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
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
        <Disc3 size={13} />
        {releaseLabel(release)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[380px]">
        {detail.releases.map((r) => (
          <DropdownMenuItem key={r.id} onClick={() => onPick(r.id)} className="items-start gap-2 py-2">
            <span className="flex size-3.5 shrink-0 items-center justify-center self-center">
              {r.id === releaseId ? (
                <Disc3 size={14} />
              ) : (
                <span className="block size-2.5 rounded-full border border-muted-foreground/50" />
              )}
            </span>
            {/* Each release's own art in the picker. */}
            {(() => {
              const rc = releaseCover(detail, r);
              return rc ? (
                <img
                  src={getFullCoverUrl(rc)}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded-[2px] object-cover"
                  loading="lazy"
                  draggable={false}
                />
              ) : null;
            })()}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm">{releaseLabel(r)}</span>
                {r.is_default && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">default</span>
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
              <span className="block truncate text-[11px] text-muted-foreground">
                {[
                  r.title,
                  r.year,
                  `${r.tracks.length} track${r.tracks.length === 1 ? "" : "s"}`,
                  r.folder,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              {!r.is_default && (
                <button
                  type="button"
                  disabled={locked}
                  title={locked ? MATCH_LOCK_TITLE : "Make this the default release"}
                  className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
                  onClick={async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
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
                className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  invoke("open_release_folder", { releaseId: r.id }).catch((err) => toast.error(String(err)));
                }}
              >
                <FolderOpen size={13} />
              </button>
              <button
                type="button"
                title="Note for this version…"
                className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  void openNote(r);
                }}
              >
                <NotebookPen size={13} />
              </button>
              <button
                type="button"
                disabled={locked}
                title={locked ? MATCH_LOCK_TITLE : "Rename this release's label"}
                className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onRename(r);
                }}
              >
                <Pencil size={13} />
              </button>
              {r.id !== releaseId && (
                <button
                  type="button"
                  disabled={locked}
                  title={
                    locked
                      ? MATCH_LOCK_TITLE
                      : `Merge into “${releaseLabel(release)}” — one track list (staged — applies on the next rescan)`
                  }
                  className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
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
                className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setConfirm({ kind: "split", release: r });
                }}
              >
                <Scissors size={13} />
              </button>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}
