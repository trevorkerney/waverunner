import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, HardDriveDownload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** "Write to files" — the preview-then-commit dialog for pushing waverunner's
 *  resolved values (edits, else MusicBrainz, else tags) into the audio files.
 *  The backend builds the plan from the files as they are on disk; every
 *  change is listed per file before anything is touched. Only files with
 *  changes are written. Refused files (stacked ID3 tags, read-only) stay
 *  listed with the reason so the count is never a surprise. */

export interface TagWriteScope {
  kind: "album" | "track" | "artist";
  id: number;
}

interface TagChange {
  field: string;
  label: string;
  from: string;
  to: string;
}

interface TagFilePlan {
  track_id: number;
  file_name: string;
  folder: string;
  changes: TagChange[];
  refused: string | null;
}

interface TagWritePlan {
  title: string;
  files: TagFilePlan[];
  notes: string[];
  writable: number;
  unchanged: number;
  refused: number;
}

interface TagWriteOutcome {
  written: number;
  unchanged: number;
  failed: string[];
  mismatched: string[];
  edits_dropped: number;
}

const SCOPE_NOUN = { album: "album", track: "track", artist: "artist" } as const;

export function TagWriteDialog({
  scope,
  onOpenChange,
  onDone,
}: {
  scope: TagWriteScope | null;
  onOpenChange: (open: boolean) => void;
  /** Fired after a write landed (any file written) so the host refetches. */
  onDone?: () => void;
}) {
  const [plan, setPlan] = useState<TagWritePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!scope) return;
    setPlan(null);
    setError(null);
    setOpen(new Set());
    let cancelled = false;
    (async () => {
      try {
        const p = await invoke<TagWritePlan>("get_tag_write_plan", { scope: scope.kind, id: scope.id });
        if (cancelled) return;
        setPlan(p);
        // Small plans open every file's diff; big ones start folded.
        const changed = p.files.filter((f) => f.changes.length > 0);
        if (changed.length <= 12) setOpen(new Set(changed.map((f) => f.track_id)));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const toggle = (id: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const write = async () => {
    if (!scope || !plan) return;
    setBusy(true);
    try {
      const r = await invoke<TagWriteOutcome>("apply_tag_write", { scope: scope.kind, id: scope.id });
      const parts = [
        `${r.written} ${r.written === 1 ? "file" : "files"} written`,
        r.failed.length > 0 && `${r.failed.length} failed`,
        r.mismatched.length > 0 && `${r.mismatched.length} read back differently`,
        r.edits_dropped > 0 && `${r.edits_dropped} ${r.edits_dropped === 1 ? "edit" : "edits"} now in the files`,
      ].filter(Boolean);
      const detail = [...r.failed, ...r.mismatched].slice(0, 4).join("\n");
      if (r.failed.length > 0) {
        toast.warning(parts.join(" · "), { description: detail || undefined });
      } else {
        toast.success(parts.join(" · "), { description: detail || undefined });
      }
      if (r.written > 0) onDone?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Group by release folder when there's more than one.
  const folders = plan ? Array.from(new Set(plan.files.map((f) => f.folder))) : [];
  const grouped = folders.length > 1;

  return (
    <Dialog open={scope !== null} onOpenChange={(o) => { if (!o && !busy) onOpenChange(false); }}>
      <DialogContent className="flex max-h-[85vh] w-[min(40rem,calc(100vw-3rem))] max-w-none flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDriveDownload size={16} className="shrink-0 text-muted-foreground" />
            <span className="truncate">
              Write to files{plan ? ` — ${plan.title}` : ""}
            </span>
          </DialogTitle>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !plan ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Reading {scope ? SCOPE_NOUN[scope.kind] : ""} files…
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {plan.writable === 0
                ? "Every file already says what waverunner shows."
                : `${plan.writable} ${plan.writable === 1 ? "file changes" : "files change"}`}
              {plan.unchanged > 0 && ` · ${plan.unchanged} unchanged`}
              {plan.refused > 0 && ` · ${plan.refused} can't be written`}
              . Tags are rewritten in place; edits the files then carry are cleared unless
              MusicBrainz says otherwise.
            </p>
            {plan.notes.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {plan.notes.map((n, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="shrink-0">·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              <div className="flex flex-col gap-0.5">
                {folders.map((folder) => (
                  <div key={folder} className="flex flex-col gap-0.5">
                    {grouped && (
                      <p className="mt-2 truncate px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
                        {folder}
                      </p>
                    )}
                    {plan.files
                      .filter((f) => f.folder === folder)
                      .map((f) => {
                        const dim = f.refused !== null || f.changes.length === 0;
                        const expandable = f.changes.length > 0;
                        const isOpen = open.has(f.track_id);
                        return (
                          <div key={f.track_id} className="rounded-md">
                            <button
                              type="button"
                              disabled={!expandable}
                              onClick={() => toggle(f.track_id)}
                              className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm ${
                                expandable ? "hover:bg-accent" : "cursor-default"
                              } ${dim ? "text-muted-foreground" : ""}`}
                            >
                              <span className="w-3.5 shrink-0 text-muted-foreground">
                                {expandable &&
                                  (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{f.file_name}</span>
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                {f.refused !== null
                                  ? "won't write"
                                  : f.changes.length === 0
                                    ? "unchanged"
                                    : `${f.changes.length} ${f.changes.length === 1 ? "field" : "fields"}`}
                              </span>
                            </button>
                            {f.refused !== null && (
                              <p className="px-7 pb-1.5 text-xs text-muted-foreground">{f.refused}</p>
                            )}
                            {expandable && isOpen && (
                              <div className="mb-1 ml-5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs">
                                {f.changes.map((c) => (
                                  <ChangeRow key={c.field} change={c} />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || !plan || plan.writable === 0}
            onClick={write}
            className="gap-1.5"
          >
            {busy && <Spinner className="size-3" />}
            {plan && plan.writable > 0
              ? `Write ${plan.writable} ${plan.writable === 1 ? "file" : "files"}`
              : "Write"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeRow({ change }: { change: TagChange }) {
  return (
    <>
      <span className="text-muted-foreground">{change.label}</span>
      <span className="min-w-0">
        {change.from !== "" && (
          <span className="break-words text-muted-foreground line-through decoration-muted-foreground/60">
            {change.from}
          </span>
        )}
        {change.from !== "" && " "}
        {change.to !== "" ? (
          <span className="break-words">{change.to}</span>
        ) : (
          <span className="italic text-muted-foreground">removed</span>
        )}
      </span>
    </>
  );
}
