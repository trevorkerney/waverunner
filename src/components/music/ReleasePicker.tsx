import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Disc3, FolderOpen, Merge, Pencil, Scissors, Star } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { notifyPendingWorkChanged } from "./PendingWork";
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
  const release = detail.releases.find((r) => r.id === releaseId) ?? null;
  if (detail.releases.length <= 1 || !release) return null;
  return (
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
                  title="Make this the default release"
                  className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
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
                title="Rename this release's label"
                className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
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
                  title={`Merge into “${releaseLabel(release)}” — one track list (staged — applies on the next rescan)`}
                  className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  onClick={async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    try {
                      await invoke<string>("merge_album_release", { releaseId: r.id, intoReleaseId: releaseId });
                      toast("Merge staged — it applies on the next rescan");
                      notifyPendingWorkChanged();
                    } catch (err) {
                      toast.error(String(err));
                    }
                  }}
                >
                  <Merge size={13} />
                </button>
              )}
              <button
                type="button"
                title="Separate into its own album (staged — applies on the next rescan)"
                className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                onClick={async (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  try {
                    await invoke<string>("split_album_release", { releaseId: r.id });
                    toast("Separation staged — it applies on the next rescan");
                    notifyPendingWorkChanged();
                  } catch (err) {
                    toast.error(String(err));
                  }
                }}
              >
                <Scissors size={13} />
              </button>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
