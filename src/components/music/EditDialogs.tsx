import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { notifyPendingWorkChanged } from "./PendingWork";
import { toast } from "sonner";
import {
  Dialog,
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Undo2, X } from "lucide-react";

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
  // One artist per row, main artist first — replaces the old free-text
  // textarea so existing artists can be picked instead of retyped.
  const [artistRows, setArtistRows] = useState<string[]>([""]);
  const [trackNo, setTrackNo] = useState("");
  const [discNo, setDiscNo] = useState("");
  const [busy, setBusy] = useState(false);

  // Existing-artist suggestions for the row being typed in.
  const [suggest, setSuggest] = useState<{ row: number; options: string[] } | null>(null);
  const suggestSeq = useRef(0);
  const suggestTimer = useRef<number | undefined>(undefined);
  const queryArtists = (row: number, q: string) => {
    window.clearTimeout(suggestTimer.current);
    const trimmed = q.trim();
    if (trimmed.length < 2 || trackId == null) {
      setSuggest(null);
      return;
    }
    const seq = ++suggestSeq.current;
    suggestTimer.current = window.setTimeout(async () => {
      try {
        const options = await invoke<string[]>("search_track_artist_options", {
          trackId,
          query: trimmed,
        });
        if (suggestSeq.current === seq) {
          setSuggest(options.length > 0 ? { row, options } : null);
        }
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
      artistRows.filter((_, i) => i !== row).map((a) => a.trim().toLowerCase()).filter(Boolean),
    );
    return suggest.options.filter((name) => !taken.has(name.toLowerCase()));
  };

  useEffect(() => {
    if (!open || trackId == null) return;
    setView(null);
    setSuggest(null);
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
              <Label>Artists (main artist first)</Label>
              <div className="flex flex-col gap-1">
                {artistRows.map((name, i) => {
                  const options = visibleOptions(i);
                  return (
                    <div key={i} className="flex gap-1">
                      <div className="relative flex-1">
                        <input
                          value={name}
                          onChange={(e) => {
                            const next = artistRows.slice();
                            next[i] = e.target.value;
                            setArtistRows(next);
                            queryArtists(i, e.target.value);
                          }}
                          // Delayed so a click on a suggestion (onMouseDown) wins the race.
                          onBlur={() => setTimeout(() => setSuggest((s) => (s?.row === i ? null : s)), 100)}
                          placeholder={i === 0 ? "Main artist" : "Additional artist"}
                          className="w-full rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
                        />
                        {options.length > 0 && (
                          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
                            {options.map((option) => (
                              <button
                                key={option}
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  const next = artistRows.slice();
                                  next[i] = option;
                                  setArtistRows(next);
                                  setSuggest(null);
                                }}
                                className="flex w-full items-center rounded px-2 py-1 text-left text-sm hover:bg-accent"
                              >
                                <span className="truncate">{option}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {artistRows.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setArtistRows(artistRows.filter((_, idx) => idx !== i))}
                        >
                          <X size={14} />
                        </Button>
                      )}
                    </div>
                  );
                })}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() => setArtistRows([...artistRows, ""])}
                >
                  + Add artist
                </Button>
              </div>
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
              Edits are saved in waverunner and survive rescans; your files stay untouched.
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
  /** Current artist credit (multi-artist rows, else the owning artist). */
  artist_credits: string[];
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
  // Album-level artist credit rows — a joint album ("Drake & Future") lists
  // every owner here and shows in each of their discographies.
  const [artistRows, setArtistRows] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);

  const [suggest, setSuggest] = useState<{ row: number; options: string[] } | null>(null);
  const suggestSeq = useRef(0);
  const suggestTimer = useRef<number | undefined>(undefined);
  const queryArtists = (row: number, q: string) => {
    window.clearTimeout(suggestTimer.current);
    const trimmed = q.trim();
    if (trimmed.length < 2 || albumId == null) {
      setSuggest(null);
      return;
    }
    const seq = ++suggestSeq.current;
    suggestTimer.current = window.setTimeout(async () => {
      try {
        // Library-scoped artist suggestions; resolves via any entry id.
        const options = await invoke<string[]>("search_artist_options", {
          artistId: albumId,
          query: trimmed,
        });
        if (suggestSeq.current === seq) {
          setSuggest(options.length > 0 ? { row, options } : null);
        }
      } catch {
        /* best-effort */
      }
    }, 150);
  };
  const visibleOptions = (row: number): string[] => {
    if (!suggest || suggest.row !== row) return [];
    // Other rows only — the typed row keeps its own exact match visible.
    const taken = new Set(
      artistRows.filter((_, i) => i !== row).map((a) => a.trim().toLowerCase()).filter(Boolean),
    );
    return suggest.options.filter((name) => !taken.has(name.toLowerCase()));
  };

  useEffect(() => {
    if (!open || albumId == null) return;
    setView(null);
    setSuggest(null);
    (async () => {
      try {
        const v = await invoke<AlbumEditView>("get_album_edit", { albumId });
        setView(v);
        setTitle(v.title);
        setDate(v.release_date ?? "");
        setType(v.album_type);
        setGenresText(v.genres.join("\n"));
        setArtistRows(v.artist_credits.length > 0 ? v.artist_credits : [""]);
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
    const artists = artistRows.map((a) => a.trim()).filter(Boolean);
    if (JSON.stringify(artists) !== JSON.stringify(view.artist_credits)) {
      fields.artist_credits = artists;
    }
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
              <Label>Artists (all credited owners, first is primary)</Label>
              <div className="flex flex-col gap-1">
                {artistRows.map((name, i) => {
                  const options = visibleOptions(i);
                  return (
                    <div key={i} className="flex gap-1">
                      <div className="relative flex-1">
                        <input
                          value={name}
                          onChange={(e) => {
                            const next = artistRows.slice();
                            next[i] = e.target.value;
                            setArtistRows(next);
                            queryArtists(i, e.target.value);
                          }}
                          onBlur={() => setTimeout(() => setSuggest((s) => (s?.row === i ? null : s)), 100)}
                          placeholder={i === 0 ? "Primary artist" : "Co-artist"}
                          className="w-full rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
                        />
                        {options.length > 0 && (
                          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
                            {options.map((option) => (
                              <button
                                key={option}
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  const next = artistRows.slice();
                                  next[i] = option;
                                  setArtistRows(next);
                                  setSuggest(null);
                                }}
                                className="flex w-full items-center rounded px-2 py-1 text-left text-sm hover:bg-accent"
                              >
                                <span className="truncate">{option}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {artistRows.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setArtistRows(artistRows.filter((_, idx) => idx !== i))}
                        >
                          <X size={14} />
                        </Button>
                      )}
                    </div>
                  );
                })}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() => setArtistRows([...artistRows, ""])}
                >
                  + Add artist
                </Button>
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
  artistName,
  open,
  onOpenChange,
}: {
  artistId: number | null;
  artistName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Each row is a decision — an existing artist, a name to create, or nothing
  // yet — rather than free text, so the dialog can show who was chosen.
  const [members, setMembers] = useState<(PickedArtist | null)[]>([null, null]);
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    try {
      await invoke<string>("split_artist", { artistId, members: list });
      onOpenChange(false);
      // STAGED, not applied: the migration is a rescan, and splits batch up
      // behind one rescan with every other staged directive instead of each
      // forcing its own. The metadata center's pending banner shows the batch
      // and offers the rescan.
      toast("Split staged — it applies on the next rescan");
      notifyPendingWorkChanged();
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
          <DialogTitle>Split artist</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
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
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto overflow-x-hidden pr-1 [scrollbar-gutter:stable]">
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
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={apply}>
            {busy ? "Staging…" : "Stage split"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
