import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Undo2 } from "lucide-react";

/** Metadata editors — the user tier of the provenance model. Edits are stored
 *  as overrides in waverunner's database (files stay untouched) and survive
 *  rescans and MusicBrainz passes. Writing INTO the file's tags is a separate,
 *  explicit option that only appears when enabled in Settings → Audio Player. */

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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after any change lands (save / reset) so the host can refetch. */
  onSaved: () => void;
}

export function TrackEditDialog({ trackId, open, onOpenChange, onSaved }: TrackEditDialogProps) {
  const [view, setView] = useState<TrackEditView | null>(null);
  const [title, setTitle] = useState("");
  const [artistsText, setArtistsText] = useState("");
  const [trackNo, setTrackNo] = useState("");
  const [discNo, setDiscNo] = useState("");
  const [writebackAllowed, setWritebackAllowed] = useState(false);
  const [writeToFile, setWriteToFile] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || trackId == null) return;
    setView(null);
    setWriteToFile(false);
    (async () => {
      try {
        const [v, settings] = await Promise.all([
          invoke<TrackEditView>("get_track_edit", { trackId }),
          invoke<Record<string, string>>("get_settings"),
        ]);
        setView(v);
        setTitle(v.title);
        setArtistsText(v.credits.join("\n"));
        setTrackNo(v.track_number != null ? String(v.track_number) : "");
        setDiscNo(v.disc_number != null ? String(v.disc_number) : "");
        setWritebackAllowed(settings["allow_tag_writeback"] === "true");
      } catch (e) {
        toast.error(String(e));
        onOpenChange(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trackId]);

  const save = async () => {
    if (!view || trackId == null) return;
    const artists = artistsText
      .split("\n")
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
      if (writeToFile) {
        await invoke("write_track_tags", { trackId });
        toast.success("Tags written to file");
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit track</DialogTitle>
        </DialogHeader>
        {!view ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="grid gap-4">
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
              <Label htmlFor="te-artists">Artists (one per line, main artist first)</Label>
              <textarea
                id="te-artists"
                value={artistsText}
                onChange={(e) => setArtistsText(e.target.value)}
                rows={Math.min(6, Math.max(2, artistsText.split("\n").length))}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
            {writebackAllowed && (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={writeToFile}
                  onChange={(e) => setWriteToFile(e.target.checked)}
                />
                Also write these tags into the file
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              Edits are saved in waverunner and survive rescans; your files stay untouched
              {writebackAllowed ? " unless you tick the write option" : ""}.
            </p>
          </div>
        )}
        <DialogFooter>
          {view && view.overridden.length > 0 && (
            <Button variant="ghost" className="mr-auto gap-1.5" disabled={busy} onClick={reset}>
              <Undo2 size={14} />
              Reset to file tags
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !view} onClick={save}>
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
  overridden: string[];
}

interface AlbumEditDialogProps {
  albumId: number | null;
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

export function AlbumEditDialog({ albumId, open, onOpenChange, onSaved }: AlbumEditDialogProps) {
  const [view, setView] = useState<AlbumEditView | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [type, setType] = useState("album");
  const [genresText, setGenresText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || albumId == null) return;
    setView(null);
    (async () => {
      try {
        const v = await invoke<AlbumEditView>("get_album_edit", { albumId });
        setView(v);
        setTitle(v.title);
        setDate(v.release_date ?? "");
        setType(v.album_type);
        setGenresText(v.genres.join("\n"));
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
    setBusy(true);
    try {
      if (Object.keys(fields).length > 0) {
        await invoke("set_album_fields", { albumId, fields });
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
      toast("Overrides cleared — tag values return on the next rescan");
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit album</DialogTitle>
        </DialogHeader>
        {!view ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="grid gap-4">
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
            <div className="grid gap-1.5">
              <Label htmlFor="ae-genres">Genres (one per line)</Label>
              <textarea
                id="ae-genres"
                value={genresText}
                onChange={(e) => setGenresText(e.target.value)}
                rows={Math.min(6, Math.max(2, genresText.split("\n").length))}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Edits are saved in waverunner and survive rescans and MusicBrainz matching; your
              files stay untouched.
            </p>
          </div>
        )}
        <DialogFooter>
          {view && view.overridden.length > 0 && (
            <Button variant="ghost" className="mr-auto gap-1.5" disabled={busy} onClick={reset}>
              <Undo2 size={14} />
              Clear overrides
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !view} onClick={save}>
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function ArtistEditDialog({ artistId, open, onOpenChange, onSaved }: ArtistEditDialogProps) {
  const [view, setView] = useState<ArtistEditView | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);

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
    if (!open || artistId == null) return;
    setView(null);
    (async () => {
      try {
        const v = await invoke<ArtistEditView>("get_artist_edit", { artistId });
        setView(v);
        setName(v.title);
        setBio(v.biography ?? "");
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
      toast("Rename cleared — the tag name returns on the next rescan");
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit artist</DialogTitle>
        </DialogHeader>
        {!view ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="grid gap-4">
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
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                placeholder="Shown on the artist page."
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
        <DialogFooter>
          {view && view.overridden.length > 0 && (
            <Button variant="ghost" className="mr-auto gap-1.5" disabled={busy} onClick={reset}>
              <Undo2 size={14} />
              Clear rename
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !view} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
