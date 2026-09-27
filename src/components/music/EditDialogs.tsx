import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { notifyPendingWorkChanged } from "./PendingWork";
import { toast } from "sonner";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ArtistPicker, ArtistChoice, PickedArtist } from "./ArtistPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Skeleton, useHandoff } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Undo2, X } from "lucide-react";
import { MATCH_LOCK_TITLE, useMatchLock } from "@/hooks/libraryRuns";

/** Metadata editors — the user tier of the provenance model. Edits are stored
 *  as overrides in waverunner's database (files stay untouched) and survive
 *  rescans and MusicBrainz passes. Writing INTO the file's tags is a separate,
 *  explicit option that only appears when enabled in Settings → Audio Player. */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** The fade-in class for a form once its data is in (see useHandoff). */
// grid-cols-[minmax(0,1fr)]: an auto grid column is sized from its items'
// min-content, and a picker row (avatar + name + note + X) reports more than
// the scrolling body's width — the whole form then ran under the scrollbar
// with its right edge clipped. A minmax(0, 1fr) track can't exceed the box.
const formFade = (visible: boolean) =>
  `grid grid-cols-[minmax(0,1fr)] gap-4 transition-opacity duration-200 will-change-[opacity] ${visible ? "opacity-100" : "opacity-0"}`;
/** The skeleton overlay: same layout as the form, fades out first. */
const skeletonFade = (stage: string) =>
  `absolute inset-x-1 top-0 grid gap-4 transition-opacity duration-200 ${stage === "hidden" ? "" : "opacity-0"}`;

/** Grey stand-ins for a label + field. */
function FieldSkeleton({ field = "h-9" }: { field?: string }) {
  return (
    <div className="grid gap-1.5">
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className={`w-full ${field}`} />
    </div>
  );
}

/** Existing-artist suggestions under an artist row. Portaled at fixed
 *  coordinates (like ArtistPicker's menu): the form body scrolls, and an
 *  absolute menu inside it would be clipped by that box. */
function SuggestMenu({
  anchorEl,
  options,
  onPick,
}: {
  anchorEl: HTMLElement | null;
  options: string[];
  onPick: (option: string) => void;
}) {
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchorEl) {
      setAnchor(null);
      return;
    }
    const place = () => {
      const r = anchorEl.getBoundingClientRect();
      setAnchor({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    place();
    // Capture phase: the scroll happens on an ancestor, not on window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorEl]);
  if (!anchor || options.length === 0) return null;
  return createPortal(
    <div
      style={{ position: "fixed", left: anchor.left, top: anchor.top, width: anchor.width }}
      className="z-[60] max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(option);
          }}
          className="flex w-full items-center rounded px-2 py-1 text-left text-sm hover:bg-accent"
        >
          <span className="truncate">{option}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** One artist per row (first is the main / primary one), each with
 *  existing-artist suggestions as it's typed — the track and album editors
 *  share this. `search` is the dialog's own lookup command. */
function ArtistRows({
  rows,
  onChange,
  placeholders,
  search,
}: {
  rows: string[];
  onChange: (rows: string[]) => void;
  placeholders: [string, string];
  search: (query: string) => Promise<string[]>;
}) {
  const [suggest, setSuggest] = useState<{ row: number; options: string[] } | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const rowEls = useRef<Map<number, HTMLDivElement>>(new Map());

  const query = (row: number, q: string) => {
    window.clearTimeout(timer.current);
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setSuggest(null);
      return;
    }
    const mine = ++seq.current;
    timer.current = window.setTimeout(async () => {
      try {
        const options = await search(trimmed);
        if (seq.current === mine) setSuggest(options.length > 0 ? { row, options } : null);
      } catch {
        /* suggestions are best-effort */
      }
    }, 150);
  };
  // Hide names already taken by OTHER rows — the row being typed in must keep
  // its own match visible, or the suggestion vanishes the moment the name is
  // fully typed out.
  const visibleOptions = (row: number): string[] => {
    if (!suggest || suggest.row !== row) return [];
    const taken = new Set(
      rows.filter((_, i) => i !== row).map((a) => a.trim().toLowerCase()).filter(Boolean),
    );
    return suggest.options.filter((name) => !taken.has(name.toLowerCase()));
  };

  return (
    <div className="flex flex-col gap-1">
      {rows.map((name, i) => (
        <div key={i} className="flex gap-1">
          <div
            className="relative flex-1"
            ref={(el) => {
              if (el) rowEls.current.set(i, el);
              else rowEls.current.delete(i);
            }}
          >
            <input
              value={name}
              onChange={(e) => {
                const next = rows.slice();
                next[i] = e.target.value;
                onChange(next);
                query(i, e.target.value);
              }}
              // Delayed so a click on a suggestion (onMouseDown) wins the race.
              onBlur={() => setTimeout(() => setSuggest((s) => (s?.row === i ? null : s)), 100)}
              placeholder={i === 0 ? placeholders[0] : placeholders[1]}
              className="w-full rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
            />
            <SuggestMenu
              anchorEl={suggest?.row === i ? (rowEls.current.get(i) ?? null) : null}
              options={visibleOptions(i)}
              onPick={(option) => {
                const next = rows.slice();
                next[i] = option;
                onChange(next);
                setSuggest(null);
              }}
            />
          </div>
          {rows.length > 1 && (
            <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>
              <X size={14} />
            </Button>
          )}
        </div>
      ))}
      <Button size="sm" variant="outline" className="w-fit" onClick={() => onChange([...rows, ""])}>
        + Add artist
      </Button>
    </div>
  );
}

interface TrackEditView {
  id: number;
  title: string;
  credits: string[];
  track_number: number | null;
  disc_number: number | null;
  overridden: string[];
  file_name: string;
  file_tags: {
    title: string | null;
    artists: string[];
    track_number: number | null;
    disc_number: number | null;
  } | null;
}

interface TrackEditDialogProps {
  trackId: number | null;
  /** The track's library — a pass running on it holds the save. */
  libraryId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after any change lands (save / reset) so the host can refetch. */
  onSaved: () => void;
}

export function TrackEditDialog({ trackId, libraryId, open, onOpenChange, onSaved }: TrackEditDialogProps) {
  const [view, setView] = useState<TrackEditView | null>(null);
  const [title, setTitle] = useState("");
  // One artist per row, main artist first — replaces the old free-text
  // textarea so existing artists can be picked instead of retyped.
  const [artistRows, setArtistRows] = useState<string[]>([""]);
  const [trackNo, setTrackNo] = useState("");
  const [discNo, setDiscNo] = useState("");
  const [busy, setBusy] = useState(false);
  // A pass on the library holds every write here (the backend refuses it).
  const locked = useMatchLock(libraryId);
  // Skeleton form after 500ms, then skeleton out / form in (the dialog
  // portals its last-open content through the exit, so clearing `view` on
  // close is safe and keeps a reopen from flashing the previous track).
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { stage, skeletonSeen, shown, contentVisible } = useHandoff(!!view, bodyRef);

  useEffect(() => {
    if (!open) {
      setView(null);
      return;
    }
    if (trackId == null) return;
    setView(null);
    (async () => {
      try {
        const v = await invoke<TrackEditView>("get_track_edit", { trackId });
        setView(v);
        setTitle(v.title);
        setArtistRows(v.credits.length > 0 ? v.credits : [""]);
        setTrackNo(v.track_number != null ? String(v.track_number) : "");
        setDiscNo(v.disc_number != null ? String(v.disc_number) : "");
      } catch (e) {
        toast.error(String(e));
        onOpenChange(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trackId]);

  const save = async () => {
    if (!view || trackId == null) return;
    const artists = artistRows
      .map((s) => s.trim())
      .filter(Boolean);
    const fields: Record<string, unknown> = {};
    if (title.trim() !== view.title) fields.title = title.trim();
    if (JSON.stringify(artists) !== JSON.stringify(view.credits)) fields.credits = artists;
    const numOf = (s: string) => {
      const n = parseInt(s, 10);
      return Number.isNaN(n) || n <= 0 ? null : n;
    };
    if (numOf(trackNo) !== view.track_number) fields.track_number = numOf(trackNo);
    if (numOf(discNo) !== view.disc_number) fields.disc_number = numOf(discNo);

    setBusy(true);
    try {
      if (Object.keys(fields).length > 0) {
        await invoke("set_track_fields", { trackId, fields });
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (trackId == null) return;
    setBusy(true);
    try {
      await invoke("reset_track_fields", { trackId });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const ft = view?.file_tags;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Static: the usual track (one artist row + its file-tag line) plus
          a little room; more rows scroll. (27.75rem scrolled by a hair.) */}
      <DialogContent size="md" height="30rem">
        <DialogHeader>
          <DialogTitle>Edit track</DialogTitle>
        </DialogHeader>
        <DialogBody ref={bodyRef} className="relative -mx-1 px-1">
        {view && (
          <div className={formFade(contentVisible)}>
            <p className="truncate font-mono text-xs text-muted-foreground" title={view.file_name}>
              {view.file_name}
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="te-title">Title</Label>
              <Input
                id="te-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={ft?.title ?? "Untitled"}
              />
              {ft && (ft.title ?? "") !== title.trim() && (
                <p className="text-xs text-muted-foreground">File tag: {ft.title ?? "(none)"}</p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label>Artists (main artist first)</Label>
              <ArtistRows
                rows={artistRows}
                onChange={setArtistRows}
                placeholders={["Main artist", "Additional artist"]}
                search={(query) =>
                  invoke<string[]>("search_track_artist_options", { trackId, query })
                }
              />
              {ft && ft.artists.length > 0 && (
                <p className="text-xs text-muted-foreground">File tag: {ft.artists.join(", ")}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="te-track">Track #</Label>
                <Input
                  id="te-track"
                  value={trackNo}
                  onChange={(e) => setTrackNo(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder={ft?.track_number != null ? String(ft.track_number) : "—"}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="te-disc">Disc #</Label>
                <Input
                  id="te-disc"
                  value={discNo}
                  onChange={(e) => setDiscNo(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder={ft?.disc_number != null ? String(ft.disc_number) : "—"}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Edits are saved in waverunner, not your files. Retagging a field at the source
              replaces the edit on it.
            </p>
          </div>
        )}
        {!shown && skeletonSeen && (
          <div className={skeletonFade(stage)}>
            <Skeleton className="h-3 w-48" />
            <FieldSkeleton />
            <div className="grid gap-1.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-[30px] w-full" />
              <Skeleton className="h-[30px] w-full" />
              <Skeleton className="h-8 w-24" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FieldSkeleton />
              <FieldSkeleton />
            </div>
          </div>
        )}
        </DialogBody>
        <DialogFooter>
          {view && view.overridden.length > 0 && (
            <Button
              variant="ghost"
              className="mr-auto gap-1.5"
              disabled={busy || locked}
              title={locked ? MATCH_LOCK_TITLE : undefined}
              onClick={reset}
            >
              <Undo2 size={14} />
              Reset to file tags
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || locked || !view}
            title={locked ? MATCH_LOCK_TITLE : undefined}
            onClick={save}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AlbumEditView {
  id: number;
  title: string;
  release_date: string | null;
  album_type: string;
  genres: string[];
  /** Current artist credit (multi-artist rows, else the owning artist). */
  artist_credits: string[];
  overridden: string[];
  /** Every release, for the per-release pre-emphasis switch. */
  releases: {
    id: number;
    label: string | null;
    folder: string;
    is_default: boolean;
    /** The scanner found FLAGS PRE in the release folder's cue sheet. */
    cue_pre_emphasis: boolean;
    /** Your override; null = go by the cue. */
    pre_emphasis_pref: boolean | null;
  }[];
  /** Albums a combine folded into this one — shown here (and only here on
   *  the album's side: on the surface a merged album is one album) with an
   *  Undo each. */
  absorbed: { combine_id: number; name: string; mode: string }[];
}

interface AlbumEditDialogProps {
  albumId: number | null;
  /** The album's library — a pass running on it holds the save. */
  libraryId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

const ALBUM_TYPES = [
  { value: "album", label: "Album" },
  { value: "ep", label: "EP" },
  { value: "single", label: "Single" },
  { value: "compilation", label: "Compilation" },
];

export function AlbumEditDialog({ albumId, libraryId, open, onOpenChange, onSaved }: AlbumEditDialogProps) {
  const [view, setView] = useState<AlbumEditView | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [type, setType] = useState("album");
  const [genresText, setGenresText] = useState("");
  // The user's note on the album (entry_note): its own store, not a field
  // override — saved on its own, never touched by Clear overrides, never
  // written to files. Edited here rather than on the page (user's call,
  // 2026-09-27).
  const [note, setNote] = useState("");
  const [noteInitial, setNoteInitial] = useState("");
  // Album-level artist credit rows — a joint album ("Drake & Future") lists
  // every owner here and shows in each of their discographies. Pickers, as
  // in the split dialog (user's call, 2026-09-25): each row is a decision
  // drawn as a profile (image, release count), not free text; a typed name
  // that matches nothing becomes a new page on save.
  const [artistPicks, setArtistPicks] = useState<(PickedArtist | null)[]>([null]);
  // Per-release pre-emphasis: the user's override per release id (null =
  // defer to the cue sheet). Staged here, written on Save.
  const [preEmphasis, setPreEmphasis] = useState<Map<number, boolean | null>>(new Map());
  const [busy, setBusy] = useState(false);
  // A pass on the library holds every write here (the backend refuses it).
  const locked = useMatchLock(libraryId);
  // Combines marked for undo in this dialog. Nothing is written at the
  // click (user's call, 2026-09-27): the row is struck and reads "save to
  // apply", Save stages every un-combine with the other edits, and Cancel
  // forgets them.
  const [undoneCombines, setUndoneCombines] = useState<Set<number>>(new Set());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { stage, skeletonSeen, shown, contentVisible } = useHandoff(!!view, bodyRef);

  const undoCombine = (combineId: number) =>
    setUndoneCombines((s) => new Set(s).add(combineId));

  useEffect(() => {
    if (!open) {
      setView(null);
      return;
    }
    if (albumId == null) return;
    setView(null);
    (async () => {
      try {
        const v = await invoke<AlbumEditView>("get_album_edit", { albumId });
        const n = await invoke<string | null>("get_note", { kind: "entry", subjectId: albumId });
        // The current credits as profiles (image, release count) — resolved
        // before the form shows so the rows land drawn, not as bare names.
        const choices = await invoke<(ArtistChoice | null)[]>("resolve_artist_choices", {
          artistId: albumId,
          names: v.artist_credits,
        });
        const picks: PickedArtist[] = v.artist_credits.map((name, i) => {
          const c = choices[i];
          return c
            ? { name: c.name, id: c.id, image: c.image, releaseCount: c.release_count }
            : { name, isNew: true };
        });
        setView(v);
        setTitle(v.title);
        setDate(v.release_date ?? "");
        setType(v.album_type);
        setGenresText(v.genres.join("\n"));
        setNote(n ?? "");
        setNoteInitial(n ?? "");
        setArtistPicks(picks.length > 0 ? picks : [null]);
        setPreEmphasis(new Map(v.releases.map((r) => [r.id, r.pre_emphasis_pref])));
        setUndoneCombines(new Set());
      } catch (e) {
        toast.error(String(e));
        onOpenChange(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, albumId]);

  const save = async () => {
    if (!view || albumId == null) return;
    const fields: Record<string, unknown> = {};
    if (title.trim() !== view.title && title.trim() !== "") fields.title = title.trim();
    if (date.trim() !== (view.release_date ?? "")) fields.release_date = date.trim();
    if (type !== view.album_type) fields.album_type = type;
    const genres = genresText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (JSON.stringify(genres) !== JSON.stringify(view.genres)) fields.genres = genres;
    const artists = artistPicks.flatMap((p) => {
      const name = p?.name.trim() ?? "";
      return name ? [name] : [];
    });
    if (JSON.stringify(artists) !== JSON.stringify(view.artist_credits)) {
      fields.artist_credits = artists;
    }
    setBusy(true);
    try {
      if (Object.keys(fields).length > 0) {
        await invoke("set_album_fields", { albumId, fields });
      }
      for (const r of view.releases) {
        const next = preEmphasis.get(r.id) ?? null;
        if (next !== r.pre_emphasis_pref) {
          await invoke("set_release_pre_emphasis", { releaseId: r.id, value: next });
        }
      }
      if (note.trim() !== noteInitial) {
        await invoke("set_note", { kind: "entry", subjectId: albumId, text: note.trim() });
      }
      // The un-combines LAST: each one stages the album for rescan, and
      // staged is immutable — a field written after it would be refused.
      for (const combineId of undoneCombines) {
        await invoke("undo_album_combine", { combineId });
      }
      if (undoneCombines.size > 0) {
        toast(
          undoneCombines.size === 1
            ? "Un-combine staged — it applies on the next rescan"
            : `${undoneCombines.size} un-combines staged — they apply on the next rescan`,
        );
        notifyPendingWorkChanged();
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (albumId == null) return;
    setBusy(true);
    try {
      await invoke("reset_album_fields", { albumId });
      toast("Edits cleared — back to what MusicBrainz or the tags say");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* STATIC height (user's call, 2026-09-25): the frame never grows —
          not on load (the skeleton opens at the final size), not per artist
          row, release, or combined album. 38rem holds a one-artist,
          one-release album with room to spare; anything longer scrolls in
          the body. xl wide (2026-09-27): the Playback rows name a release
          by label and folder, and at lg the switches fell off the edge. */}
      <DialogContent size="xl" height="38rem">
        <DialogHeader>
          <DialogTitle>Edit album</DialogTitle>
        </DialogHeader>
        {/* The body backs out of the frame's right padding (-mr-4, pr-4
            puts the content back) so its scrollbar rides the dialog's edge
            rather than sitting 16px in from it; the left keeps the 4px ring
            room. overflow-x-hidden: a scrolling box clips both axes, and the
            negative margins would otherwise summon a horizontal bar. */}
        <DialogBody ref={bodyRef} className="relative -ml-1 -mr-4 overflow-x-hidden pl-1 pr-4">
        {view && (
          <div className={formFade(contentVisible)}>
            <div className="grid gap-1.5">
              <Label htmlFor="ae-title">Title</Label>
              <Input id="ae-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ae-date">Release date</Label>
                <Input
                  id="ae-date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  placeholder="YYYY or YYYY-MM-DD"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Type</Label>
                <Select value={type} onValueChange={(v) => v && setType(v as string)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALBUM_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
              {/* Owners are equal (a joint album sits in every member's
                  discography); the order is the credit's reading order, and
                  the first name is what stands for the album where only one
                  fits (card subtitle, now playing, the library map, the
                  matching pass's search scope). Not "primary owner". */}
              <Label>Artists (all credited owners, in credit order)</Label>
              {/* Same rows as the split dialog: picker + one X that cancels
                  the choice or, on an empty row, drops the row (never below
                  one). The body scrolls as a whole, so the rows just stack. */}
              <div className="flex flex-col gap-1">
                {artistPicks.map((picked, i) => (
                  <div key={i} className="flex min-w-0 items-center gap-1">
                    <ArtistPicker
                      value={picked}
                      onChange={(v) => {
                        const next = artistPicks.slice();
                        next[i] = v;
                        setArtistPicks(next);
                      }}
                      // The search scopes to the album's library (any entry
                      // id resolves it); the album itself is never an artist.
                      contextArtistId={albumId}
                      exclude={artistPicks
                        .filter((_, idx) => idx !== i)
                        .map((m) => m?.name ?? "")
                        .filter(Boolean)}
                      placeholder={i === 0 ? "Artist…" : "Co-artist…"}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={picked == null && artistPicks.length <= 1}
                      onClick={() => {
                        if (picked != null) {
                          const next = artistPicks.slice();
                          next[i] = null;
                          setArtistPicks(next);
                        } else {
                          setArtistPicks(artistPicks.filter((_, idx) => idx !== i));
                        }
                      }}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() => setArtistPicks([...artistPicks, null])}
              >
                + Add artist
              </Button>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ae-genres">Genres (one per line)</Label>
              {/* Fixed rows: the frame is static, so the field is too — a
                  long list scrolls inside it. */}
              <textarea
                id="ae-genres"
                value={genresText}
                onChange={(e) => setGenresText(e.target.value)}
                rows={4}
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ae-note">Note</Label>
              {/* The album's note (a version's own is edited from the
                  versions picker). Fixed rows like Genres. */}
              <textarea
                id="ae-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                placeholder="Anything worth remembering about this album…"
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
            {view.releases.length > 0 && (
              // minmax(0,1fr), like the sections below: a row's nowrap
              // label would otherwise size this auto column past the body
              // and carry the switch off the right edge (it did).
              <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                <Label>Playback</Label>
                {view.releases.map((r) => {
                  const pref = preEmphasis.get(r.id) ?? null;
                  const effective = pref ?? r.cue_pre_emphasis;
                  const name = `${r.label ?? "1"}${view.releases.length > 1 ? ` · ${r.folder}` : ""}`;
                  return (
                    <div key={r.id} className="flex h-10 items-center gap-3 rounded-md border px-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          De-emphasize
                          {view.releases.length > 1 && (
                            <span className="ml-1.5 text-xs text-muted-foreground">{name}</span>
                          )}
                        </p>
                        <p className="truncate text-[11px] leading-none text-muted-foreground">
                          {pref === null
                            ? r.cue_pre_emphasis
                              ? "cue sheet flags the rip pre-emphasized"
                              : "no cue sheet flag — plays as is"
                            : (
                              <>
                                your setting ·{" "}
                                <button
                                  type="button"
                                  className="underline underline-offset-2 hover:text-foreground"
                                  onClick={() => setPreEmphasis((m) => new Map(m).set(r.id, null))}
                                >
                                  use the cue sheet
                                </button>
                              </>
                            )}
                        </p>
                      </div>
                      <Switch
                        checked={effective}
                        onCheckedChange={(v) => setPreEmphasis((m) => new Map(m).set(r.id, v))}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {view.absorbed.length > 0 && (
              // Same minmax(0,1fr) column as the form: a row's nowrap title
              // would otherwise size this section's auto column past the
              // body, and the Undo links walked off the right edge.
              <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                <Label>Combined albums</Label>
                {/* Fixed 28px rows; a row marked for undo stays (struck) so
                    the frame never moves while the dialog is open. */}
                <div className="flex min-w-0 flex-col">
                  {view.absorbed.map((a) => {
                    const undone = undoneCombines.has(a.combine_id);
                    return (
                      <div key={a.combine_id} className="flex h-7 min-w-0 items-center gap-2 text-sm">
                        <span
                          className={`min-w-0 flex-1 truncate ${undone ? "text-muted-foreground line-through" : ""}`}
                          title={a.name}
                        >
                          {a.name}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {undone
                            ? `${a.mode === "merge" ? "unmerging" : "separating"} · save to apply`
                            : a.mode === "merge"
                              ? "merged in"
                              : "as a release"}
                        </span>
                        {!undone && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => undoCombine(a.combine_id)}
                            className="shrink-0 text-[11px] underline underline-offset-2 hover:text-foreground"
                            title="Back to its own album on the next rescan — staged when you save"
                          >
                            Undo
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Edits are saved in waverunner, not your files, and outrank MusicBrainz. Retagging
              a field at the source replaces the edit on it.
            </p>
          </div>
        )}
        {!shown && skeletonSeen && (
          <div className={skeletonFade(stage)}>
            <FieldSkeleton />
            <div className="grid grid-cols-2 gap-3">
              <FieldSkeleton />
              <FieldSkeleton />
            </div>
            <div className="grid gap-1.5">
              <Skeleton className="h-3.5 w-56" />
              <Skeleton className="h-[30px] w-full" />
              <Skeleton className="h-[30px] w-full" />
              <Skeleton className="h-8 w-24" />
            </div>
            <FieldSkeleton field="h-[98px]" />
            <FieldSkeleton field="h-[98px]" />
          </div>
        )}
        </DialogBody>
        <DialogFooter>
          {view && view.overridden.length > 0 && (
            <Button
              variant="ghost"
              className="mr-auto gap-1.5"
              disabled={busy || locked}
              title={locked ? MATCH_LOCK_TITLE : undefined}
              onClick={reset}
            >
              <Undo2 size={14} />
              Clear overrides
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || locked || !view}
            title={locked ? MATCH_LOCK_TITLE : undefined}
            onClick={save}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ArtistEditView {
  id: number;
  title: string;
  biography: string | null;
  overridden: string[];
}

interface ArtistEditDialogProps {
  artistId: number | null;
  /** The artist's library — a pass running on it holds the save. */
  libraryId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function ArtistEditDialog({ artistId, libraryId, open, onOpenChange, onSaved }: ArtistEditDialogProps) {
  const [view, setView] = useState<ArtistEditView | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  // The user's note on the artist (entry_note): its own store, saved on
  // its own, never touched by Clear overrides.
  const [note, setNote] = useState("");
  const [noteInitial, setNoteInitial] = useState("");
  const [busy, setBusy] = useState(false);
  // A pass on the library holds every write here (the backend refuses it).
  const locked = useMatchLock(libraryId);
  const [fetching, setFetching] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { stage, skeletonSeen, shown, contentVisible } = useHandoff(!!view, bodyRef);

  const fetchImage = async () => {
    if (artistId == null) return;
    setFetching(true);
    try {
      const found = await invoke<boolean>("music_fetch_artist_image", { artistId });
      if (found) {
        toast.success("Artist image fetched");
        onSaved();
      } else {
        toast("No image found on Wikidata or Deezer for this artist");
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setView(null);
      return;
    }
    if (artistId == null) return;
    setView(null);
    (async () => {
      try {
        const v = await invoke<ArtistEditView>("get_artist_edit", { artistId });
        const n = await invoke<string | null>("get_note", { kind: "entry", subjectId: artistId });
        setView(v);
        setName(v.title);
        setBio(v.biography ?? "");
        setNote(n ?? "");
        setNoteInitial(n ?? "");
      } catch (e) {
        toast.error(String(e));
        onOpenChange(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, artistId]);

  const save = async () => {
    if (!view || artistId == null) return;
    const fields: Record<string, unknown> = {};
    if (name.trim() !== view.title && name.trim() !== "") fields.title = name.trim();
    if (bio.trim() !== (view.biography ?? "")) fields.biography = bio.trim();
    setBusy(true);
    try {
      if (Object.keys(fields).length > 0) {
        await invoke("set_artist_fields", { artistId, fields });
      }
      // The note is its own store (entry_note), not a field override —
      // saved beside the fields, never part of Clear overrides.
      if (note.trim() !== noteInitial) {
        await invoke("set_note", { kind: "entry", subjectId: artistId, text: note.trim() });
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (artistId == null) return;
    setBusy(true);
    try {
      await invoke("reset_artist_fields", { artistId });
      toast("Rename cleared — back to what MusicBrainz or the tags say");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Static: 136 + 94 name (+ its two-line note) + 16 + 138 biography
          (5 rows) + 16 + 118 note (4 rows) + 16 + 32 fetch row = 566px. */}
      <DialogContent size="md" height="35.375rem">
        <DialogHeader>
          <DialogTitle>Edit artist</DialogTitle>
        </DialogHeader>
        <DialogBody ref={bodyRef} className="relative -mx-1 px-1">
        {view && (
          <div className={formFade(contentVisible)}>
            <div className="grid gap-1.5">
              <Label htmlFor="are-name">Name</Label>
              <Input id="are-name" value={name} onChange={(e) => setName(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                Renaming keeps everything linked — the tag name lives on behind the scenes, so
                rescans and credits still find this artist.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="are-bio">Biography</Label>
              <textarea
                id="are-bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={5}
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                placeholder="Shown on the artist page."
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="are-note">Note</Label>
              {/* The user's own note (user's call, 2026-09-27: edited here,
                  not on the page). Kept apart from the biography, which is
                  fetched-data territory. Fixed rows: the frame is static. */}
              <textarea
                id="are-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                placeholder="Anything worth remembering about this artist…"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground">
                Look up a photo on Wikidata (via MusicBrainz identity), falling back to Deezer.
              </p>
              <Button variant="outline" size="sm" disabled={fetching} onClick={fetchImage}>
                {fetching ? <Spinner className="size-3.5" /> : "Fetch image"}
              </Button>
            </div>
          </div>
        )}
        {!shown && skeletonSeen && (
          <div className={skeletonFade(stage)}>
            <div className="grid gap-1.5">
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
            <FieldSkeleton field="h-[118px]" />
            {/* The note: four rows. */}
            <FieldSkeleton field="h-[98px]" />
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-8 w-24" />
            </div>
          </div>
        )}
        </DialogBody>
        <DialogFooter>
          {view && view.overridden.length > 0 && (
            <Button
              variant="ghost"
              className="mr-auto gap-1.5"
              disabled={busy || locked}
              title={locked ? MATCH_LOCK_TITLE : undefined}
              onClick={reset}
            >
              <Undo2 size={14} />
              Clear rename
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || locked || !view}
            title={locked ? MATCH_LOCK_TITLE : undefined}
            onClick={save}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Split artist — "JAY-Z & Kanye West" is really two artists
// ---------------------------------------------------------------------------

/** Best-guess member prefill: try the explicit separators a joint name is
 *  usually written with. The user confirms or corrects — nothing splits
 *  without their say-so ("Earth, Wind & Fire" stays whole forever unless
 *  they split it themselves). */
function guessSplitMembers(name: string): string[] {
  for (const sep of [";", " & ", " x ", " X ", ", ", " and "]) {
    const parts = name
      .split(sep)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts;
  }
  return ["", ""];
}

/** Ceiling on split members. A tag naming more than a dozen artists is a
 *  compilation credit or a mistake, not a group, and an unbounded list lets
 *  the field stack run off the bottom of the dialog. */
const MAX_SPLIT_MEMBERS = 12;

/** Record a split directive for a joint-named artist entry, then kick a
 *  rescan to migrate: albums re-home under the first member (full list as
 *  the album's artist credit), matching track credits split, and the joint
 *  entry sweeps away. Rescan-proof — the directive re-applies every scan. */
export function SplitArtistDialog({
  artistId,
  libraryId,
  artistName,
  open,
  onOpenChange,
  beforeSplit,
  queue,
}: {
  artistId: number | null;
  /** The artist's library — a pass running on it holds the split. */
  libraryId?: string;
  artistName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs on confirm, BEFORE the split is staged — the identity card's
   *  "Merge & split" merges the spellings here, so the split's keys include
   *  the aliases the merge just made. Cancel never reaches it: nothing is
   *  merged until the members are confirmed. */
  beforeSplit?: () => Promise<void>;
  /** Given (the metadata page), confirming hands the staging to the host's
   *  apply queue and closes at once — the row leaves at the click. Absent,
   *  it runs here. */
  queue?: (job: { label: string; run: () => Promise<void> }) => void;
}) {
  // Each row is a decision — an existing artist, a name to create, or nothing
  // yet — rather than free text, so the dialog can show who was chosen.
  const [members, setMembers] = useState<(PickedArtist | null)[]>([null, null]);
  const [busy, setBusy] = useState(false);
  // A pass on the library holds every write here (the backend refuses it).
  const locked = useMatchLock(libraryId);

  useEffect(() => {
    if (!open) return;
    const guessed = guessSplitMembers(artistName);
    // Fill with the guess immediately, then upgrade any name that turns out
    // to be an artist the library already has — "2 Chainz, Lil Wayne" splits
    // into two names that both exist, and offering to create them would spawn
    // duplicates of the real pages.
    setMembers(guessed.map((n) => (n ? { name: n, isNew: true } : null)));
    if (artistId == null) return;
    let cancelled = false;
    invoke<(ArtistChoice | null)[]>("resolve_artist_choices", { artistId, names: guessed })
      .then((found) => {
        if (cancelled) return;
        setMembers(
          guessed.map((n, i) => {
            const hit = found[i];
            if (hit)
              return {
                name: hit.name,
                id: hit.id,
                image: hit.image,
                releaseCount: hit.release_count,
              };
            return n ? { name: n, isNew: true } : null;
          }),
        );
      })
      .catch(() => {
        /* keep the plain guess */
      });
    return () => {
      cancelled = true;
    };
  }, [open, artistName, artistId]);

  const apply = async () => {
    if (artistId == null) return;
    const list = members.map((m) => m?.name.trim() ?? "").filter(Boolean);
    if (list.length < 2) {
      toast.error("A split needs at least two artists");
      return;
    }
    // STAGED, not applied: the migration is a rescan, and splits batch up
    // behind one rescan with every other staged directive instead of each
    // forcing its own. The metadata center's pending banner shows the batch
    // and offers the rescan.
    const stage = async () => {
      if (beforeSplit) await beforeSplit();
      await invoke<string>("split_artist", { artistId, members: list });
      toast("Split staged — it applies on the next rescan");
      notifyPendingWorkChanged();
    };
    if (queue) {
      queue({ label: `Split \u{201c}${artistName}\u{201d} into ${list.join(", ")}`, run: stage });
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      await stage();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  // The frame follows the member count AND the intro's real height: the
  // intro wraps to four or five lines depending on the artist's name, so
  // it's measured, not assumed. 136 (frame) + intro + 12 + rows (38 each,
  // 4 between) + 12 + 32 add; up to six rows, past that the list scrolls
  // in place.
  const introRef = useRef<HTMLParagraphElement | null>(null);
  const [introHeight, setIntroHeight] = useState(80);
  useLayoutEffect(() => {
    const el = introRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.offsetHeight;
      if (h > 0) setIntroHeight(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  const sizedRows = Math.min(members.length, 6);
  const height = `${(136 + introHeight + 12 + 38 * sizedRows + 4 * (sizedRows - 1) + 12 + 32) / 16}rem`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" height={height}>
        <DialogHeader>
          <DialogTitle>Split artist</DialogTitle>
        </DialogHeader>
        {/* A DialogBody: it holds overflow while the frame grows for a new
            row, so the footer doesn't jump before the resize lands. */}
        <DialogBody className="grid content-start gap-3">
          <p ref={introRef} className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{artistName}</span> is really these{" "}
            <span className="font-medium text-foreground">{members.length}</span> artists. Their
            joint albums credit every member — in this order — and appear on each one's page;
            matching track credits split the same way. Staged now, applied by the next rescan,
            and it survives every rescan after.
          </p>
          {/* Long member lists scroll rather than pushing the footer off screen.
              scrollbar-gutter keeps that space reserved whether or not the bar
              is showing — otherwise adding the row that first overflows steals
              the width from every field and the whole stack jumps left. */}
          <div className="flex max-h-[248px] flex-col gap-1 overflow-y-auto overflow-x-hidden pr-1 [scrollbar-gutter:stable]">
            {members.map((picked, i) => {
              return (
                <div key={i} className="flex items-center gap-1">
                  <ArtistPicker
                    value={picked}
                    onChange={(v) => {
                      const next = members.slice();
                      next[i] = v;
                      setMembers(next);
                    }}
                    contextArtistId={artistId}
                    exclude={members
                      .filter((_, idx) => idx !== i)
                      .map((m) => m?.name ?? "")
                      .filter(Boolean)}
                    // Uniform on purpose: since credits became the record of
                    // whose album it is, no member "owns" anything — the only
                    // thing slot order controls is credit display order.
                    placeholder="Select an artist…"
                  />
                  {/* Always present, disabled at the two-member floor — a
                      button that appears and disappears shifts the field
                      widths as you add and remove rows. */}
                  {/* One control, two jobs: cancel the chosen artist, or —
                      when the row is already empty — drop the row. Disabled
                      only when there's neither a choice to cancel nor a
                      spare row to remove. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={picked == null && members.length <= 2}
                    onClick={() => {
                      if (picked != null) {
                        const next = members.slice();
                        next[i] = null;
                        setMembers(next);
                      } else {
                        setMembers(members.filter((_, idx) => idx !== i));
                      }
                    }}
                  >
                    <X size={14} />
                  </Button>
                </div>
              );
            })}
          </div>
          {/* Outside the scroll box on purpose: inside it, clicking Add moved
              the button down and the browser scrolled the freshly-focused
              button back into view, which made the scrollbar flash every time
              the list was near its height limit. Out here it also stays put
              instead of scrolling away. */}
          {members.length < MAX_SPLIT_MEMBERS && (
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => setMembers([...members, null])}
            >
              + Add artist
            </Button>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || locked}
            title={locked ? MATCH_LOCK_TITLE : undefined}
            onClick={apply}
          >
            {busy ? "Staging…" : "Stage split"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
