import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import { NoteDialog } from "./NoteDialog";

/** The user's free-text note on a page — an artist, album, movie, show,
 *  video collection or person — or a playlist's description, which is the
 *  same thing under the name playlists use. Shows the note as the page's
 *  quiet subtext (styled like a track row's artist line) and, where the
 *  page lets it, edits it in the NoteDialog. Fetches and saves itself, so
 *  a page only says what it is about. Plain text with line breaks kept.
 *  Never locked by a matching pass or a staged change: a note is the
 *  user's remark, not library data. App data only — never written to
 *  files, never seeded from tags, shown here and nowhere else. */

/** "release" keys on the album_release row id of the version on show (the
 *  backend resolves it to the album + folder the note is stored under). */
export type NoteKind = "entry" | "person" | "playlist" | "playlist_collection" | "release";

export function NoteBlock({
  kind,
  subjectId,
  subject,
  label = "note",
  prefix,
  editable = true,
  reloadKey = 0,
  className = "",
}: {
  kind: NoteKind;
  subjectId: number;
  /** The entity's name, for the dialog's header. */
  subject?: string;
  /** What the page calls it: "note" (default) or "description" (playlists). */
  label?: "note" | "description";
  /** Shown before the text in slightly stronger type — a release note's
   *  version label, so it reads as a different thing from the card note. */
  prefix?: string;
  /** False = display only: no "Add a note" link, no pencil, no dialog —
   *  the page edits this note somewhere else (the album page: Edit album
   *  for the card note, the versions picker for a version's), and shows
   *  nothing at all while there is none (user's call, 2026-09-27). */
  editable?: boolean;
  /** Bump to refetch: the note was edited elsewhere on the page. */
  reloadKey?: number;
  className?: string;
}) {
  // undefined = not loaded yet (renders nothing, so "Add a note" never
  // flashes before an existing note lands); null = there is none.
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let stale = false;
    setText(undefined);
    setOpen(false);
    invoke<string | null>("get_note", { kind, subjectId })
      .then((t) => {
        if (!stale) setText(t);
      })
      .catch((e) => {
        if (stale) return;
        setText(null);
        toast.error(String(e));
      });
    return () => {
      stale = true;
    };
  }, [kind, subjectId, reloadKey]);

  const save = async (next: string) => {
    try {
      await invoke("set_note", { kind, subjectId, text: next });
      setText(next === "" ? null : next);
    } catch (e) {
      toast.error(String(e));
      throw e;
    }
  };

  if (text === undefined) return null;
  if (text === null && !editable) return null;

  return (
    <>
      {text === null ? (
        <div className={className}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus size={12} />
            Add a {label}
          </button>
        </div>
      ) : (
        // No heading (user's call): the note reads as the page's quiet
        // subtext, styled like a track row's artist line. The pencil trails
        // the last line and shows on hover, like the disc-name pencil.
        <p
          className={`group/note whitespace-pre-line text-xs leading-relaxed text-muted-foreground ${className}`}
        >
          {prefix && <span className="font-medium text-foreground/75">{prefix} · </span>}
          {text}
          {editable && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              title={`Edit ${label}`}
              className="ml-1.5 inline-flex rounded p-0.5 align-middle opacity-0 transition-opacity hover:text-foreground group-hover/note:opacity-100"
            >
              <Pencil size={11} />
            </button>
          )}
        </p>
      )}
      {/* Mounted whenever it can open (open=false when closed) — the modal
          system's rule. A display-only block has no editor at all. */}
      {editable && (
        <NoteDialog
          open={open}
          onOpenChange={setOpen}
          label={label}
          subject={subject}
          initialValue={text ?? ""}
          onSubmit={save}
        />
      )}
    </>
  );
}
