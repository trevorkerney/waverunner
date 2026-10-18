import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "@/lib/toast";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { MATCH_LOCK_TITLE, useMatchLock } from "@/hooks/libraryRuns";
import { loadTagFields, toEditValue, type TagFieldInfo } from "@/lib/tagFields";
import { editableFields, FieldControl, SuggestMenu } from "./EditDialogs";

/** The bulk editor: one write over every selected track. Each row is a
 *  thing to set, armed by its checkbox — the unarmed rows leave their field
 *  alone. The structural rows (disc number, renumbering, album, album
 *  artists, release) are what turns a box set's nine folders into one
 *  album: the same album and album artists on every track regroup them,
 *  the disc numbers lay them out, renumbering fixes the order. Everything
 *  lands as user-tier overrides, applied on the spot and undone from
 *  History. */

/** The hosting album's releases, for "Move to release". */
export interface BulkRelease {
  id: number;
  label: string | null;
  folder: string;
  folder_path: string;
}

/** An album a track can be moved into (search_album_options): its effective
 *  tag identity — what the tracks must carry to land in it. */
interface AlbumOption {
  id: number;
  title: string;
  artist: string | null;
  album_tag: string;
  album_artists: string[];
}

/** Rows with a control of their own (not drawn from the registry loop). */
const STRUCTURAL = new Set(["title", "credits", "album", "album_artists", "track_number", "disc_number"]);

export function BulkEditDialog({
  libraryId,
  trackIds,
  releases,
  open,
  onOpenChange,
  onSaved,
}: {
  libraryId: string;
  /** The selected tracks, in the order the page lists them (renumbering
   *  follows it). */
  trackIds: number[];
  releases: BulkRelease[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [fields, setFields] = useState<TagFieldInfo[]>([]);
  // Which rows are armed, and their values.
  const [armed, setArmed] = useState<Set<string>>(new Set());
  const [disc, setDisc] = useState("");
  const [renumberFrom, setRenumberFrom] = useState("1");
  const [album, setAlbum] = useState("");
  const [albumArtists, setAlbumArtists] = useState<string[]>([""]);
  const [credits, setCredits] = useState<string[]>([""]);
  const [releaseFolder, setReleaseFolder] = useState<string>("");
  const [generic, setGeneric] = useState<Record<string, string | string[]>>({});
  const [busy, setBusy] = useState(false);
  // A pass on the library holds every write here (the backend refuses it).
  const locked = useMatchLock(libraryId);
  // Album suggestions as typed: existing albums of the library, picked to
  // take their album tag and album artists at once.
  const [albumOptions, setAlbumOptions] = useState<AlbumOption[]>([]);
  const albumInputRef = useRef<HTMLInputElement | null>(null);
  const albumSeq = useRef(0);
  const albumTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setArmed(new Set());
    setDisc("");
    setRenumberFrom("1");
    setAlbum("");
    setAlbumArtists([""]);
    setCredits([""]);
    setReleaseFolder("");
    setGeneric({});
    setAlbumOptions([]);
    loadTagFields()
      .then((all) => setFields(editableFields(all)))
      .catch((e) => toast.error(String(e)));
  }, [open]);

  const arm = (key: string, on: boolean) =>
    setArmed((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const queryAlbums = (q: string) => {
    window.clearTimeout(albumTimer.current);
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setAlbumOptions([]);
      return;
    }
    const mine = ++albumSeq.current;
    albumTimer.current = window.setTimeout(async () => {
      try {
        const rows = await invoke<AlbumOption[]>("search_album_options", { libraryId, query: trimmed });
        if (albumSeq.current === mine) setAlbumOptions(rows);
      } catch {
        /* suggestions are best-effort */
      }
    }, 150);
  };

  const pickAlbum = (option: AlbumOption) => {
    setAlbum(option.album_tag);
    setAlbumOptions([]);
    // The album's identity is its tag AND its album artists — a track lands
    // in it only carrying both, so the pick fills (and arms) both rows.
    if (option.album_artists.length > 0) {
      setAlbumArtists(option.album_artists);
      arm("album_artists", true);
    }
  };

  const searchArtists = (query: string) =>
    invoke<string[]>("search_track_artist_options", { trackId: trackIds[0], query });

  const save = async () => {
    if (armed.size === 0) {
      onOpenChange(false);
      return;
    }
    const discNo = parseInt(disc, 10);
    if (armed.has("disc_number") && (Number.isNaN(discNo) || discNo <= 0)) {
      toast.error("Disc number must be a whole number above zero");
      return;
    }
    const start = parseInt(renumberFrom, 10);
    if (armed.has("renumber") && (Number.isNaN(start) || start <= 0)) {
      toast.error("Renumbering needs a starting number above zero");
      return;
    }
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const edits = trackIds.map((trackId, i) => {
      const out: Record<string, unknown> = {};
      if (armed.has("disc_number")) out.disc_number = discNo;
      if (armed.has("renumber")) out.track_number = start + i;
      if (armed.has("album")) out.album = album.trim();
      if (armed.has("album_artists")) out.album_artists = toEditValue("list", albumArtists);
      if (armed.has("credits")) out.credits = toEditValue("list", credits);
      // "" = back to its own folder: the override goes (null = fall back).
      if (armed.has("release_key")) out.release_key = releaseFolder === "" ? null : releaseFolder;
      for (const key of armed) {
        const def = byKey.get(key);
        if (!def || STRUCTURAL.has(key)) continue;
        out[key] = toEditValue(def.shape, generic[key] ?? (def.shape === "list" ? [] : ""));
      }
      return { track_id: trackId, fields: out };
    });
    setBusy(true);
    try {
      await invoke("apply_track_edits", { libraryId, edits });
      toast.success(`Edited ${trackIds.length} tracks. Undo from History on the Metadata page.`);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const generics = fields.filter((f) => !STRUCTURAL.has(f.key));

  /** One armed row: checkbox, label, and the control (dimmed until armed). */
  const row = (key: string, label: string, control: React.ReactNode, hint?: string) => {
    const on = armed.has(key);
    return (
      <div key={key} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1">
        <Checkbox
          checked={on}
          onCheckedChange={(v) => arm(key, v === true)}
          className="mt-[3px]"
          aria-label={`Set ${label}`}
        />
        <div className="grid min-w-0 gap-1.5">
          <Label
            className={on ? "" : "text-muted-foreground"}
            onClick={() => arm(key, !on)}
          >
            {label}
          </Label>
          <div className={on ? "" : "opacity-50"} onFocusCapture={() => !on && arm(key, true)}>
            {control}
          </div>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      {/* Static (modal rule): the rows outnumber the frame — the body
          scrolls. lg wide, like the track editor. */}
      <DialogContent size="lg" height="xl">
        <DialogHeader>
          <DialogTitle>Edit {trackIds.length} tracks</DialogTitle>
          <DialogDescription>
            Tick what to set; everything else is left as it is. The same album and album
            artists on every track make them one album.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="-mx-1 grid content-start gap-4 px-1">
          {row(
            "disc_number",
            "Disc number",
            <Input
              value={disc}
              onChange={(e) => setDisc(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="e.g. 2"
              className="w-32"
            />,
            "Every selected track goes on this disc.",
          )}
          {row(
            "renumber",
            "Renumber tracks in list order",
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">starting at</span>
              <Input
                value={renumberFrom}
                onChange={(e) => setRenumberFrom(e.target.value.replace(/[^0-9]/g, ""))}
                className="w-20"
              />
            </div>,
            "Track numbers follow the order the page lists the selection in.",
          )}
          {row(
            "album",
            "Album",
            <div className="relative">
              <Input
                ref={albumInputRef}
                value={album}
                onChange={(e) => {
                  setAlbum(e.target.value);
                  queryAlbums(e.target.value);
                }}
                onBlur={() => setTimeout(() => setAlbumOptions([]), 100)}
                placeholder="Album title as tagged"
              />
              <SuggestMenu
                anchorEl={albumOptions.length > 0 ? albumInputRef.current : null}
                options={albumOptions.map((o) =>
                  o.artist ? `${o.album_tag} — ${o.artist}` : o.album_tag,
                )}
                onPick={(label) => {
                  const hit = albumOptions.find(
                    (o) => (o.artist ? `${o.album_tag} — ${o.artist}` : o.album_tag) === label,
                  );
                  if (hit) pickAlbum(hit);
                }}
              />
            </div>,
            "Type a new title, or pick an existing album to move the tracks into it (its album artists come along).",
          )}
          {row(
            "album_artists",
            "Album artists",
            <FieldControl
              def={{
                key: "album_artists",
                label: "Album artists",
                shape: "list",
                scope: "album",
                app_only: false,
                grouping: true,
                editable: true,
                id: false,
              }}
              value={albumArtists}
              onChange={(v) => setAlbumArtists(Array.isArray(v) ? v : [v])}
              search={searchArtists}
            />,
          )}
          {row(
            "credits",
            "Artists (main artist first)",
            <FieldControl
              def={{
                key: "credits",
                label: "Artists",
                shape: "list",
                scope: "track",
                app_only: false,
                grouping: false,
                editable: true,
                id: false,
              }}
              value={credits}
              onChange={(v) => setCredits(Array.isArray(v) ? v : [v])}
              search={searchArtists}
            />,
          )}
          {releases.length > 1 &&
            row(
              "release_key",
              "Release",
              <Select value={releaseFolder} onValueChange={(v) => setReleaseFolder((v as string) ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a release…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Each track's own folder</SelectItem>
                  {releases.map((r) => (
                    <SelectItem key={r.id} value={r.folder_path}>
                      {r.label ?? "1"} · {r.folder}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
              "Which version of this album the tracks belong to.",
            )}
          {generics.map((f) =>
            row(
              f.key,
              f.label,
              <FieldControl
                def={f}
                value={generic[f.key] ?? (f.shape === "list" ? [] : "")}
                onChange={(v) => setGeneric((s) => ({ ...s, [f.key]: v }))}
                search={searchArtists}
              />,
            ),
          )}
          <p className="text-xs text-muted-foreground">
            Edits are saved in waverunner, not your files, and apply right away.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || locked || armed.size === 0}
            title={locked ? MATCH_LOCK_TITLE : undefined}
            onClick={save}
          >
            {busy ? "Saving…" : `Apply to ${trackIds.length} tracks`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
