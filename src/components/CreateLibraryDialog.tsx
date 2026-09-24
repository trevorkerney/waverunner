import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTransition,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { useLibraryRuns } from "@/hooks/libraryRuns";
import { BookOpen, FolderOpen, Film, Music, Server, HardDrive, Plus, Tv, X } from "lucide-react";

/** Create a library: name, format, folders, online-metadata choice. Confirm
 *  hands off to the run controller (hooks/libraryRuns) and closes — the scan
 *  shows in place of the library's page, and the match question follows as
 *  a banner there. (This used to be a four-step wizard modal that held the
 *  scan and the matching pass; retired 2026-09-22.) */

interface CreateLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateLibraryDialog({ open: isOpen, onOpenChange }: CreateLibraryDialogProps) {
  const { createLibrary } = useLibraryRuns();
  const [name, setName] = useState("");
  // Folders are tagged by kind: movies vs TV shows (video) or music. At least
  // one folder for the chosen format is required.
  const [moviePaths, setMoviePaths] = useState<string[]>([""]);
  const [showPaths, setShowPaths] = useState<string[]>([""]);
  const [musicPaths, setMusicPaths] = useState<string[]>([""]);
  // Sounds (ambient/rain/etc) folders — optional sibling domain inside a
  // music library; everything under them is sound-marked at scan time.
  const [soundsPaths, setSoundsPaths] = useState<string[]>([""]);
  const [format, setFormat] = useState("video");
  // Only 'local' is implemented; 'server' (Jellyfin/Plex/Emby client mode) is
  // shown disabled so the direction is visible in the UI.
  const [source, setSource] = useState("local");
  // Per-library opt-out of online metadata (MusicBrainz / TMDB+OMDB),
  // recorded at creation. Default ON; "off" is the stored choice.
  const [onlineMetadata, setOnlineMetadata] = useState(true);
  // Create stays locked until the user has seen the whole form: it unlocks
  // once the body is scrolled to the bottom (or doesn't overflow at all),
  // and locks again on a format change, since the fields below it change.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [seenAll, setSeenAll] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setMoviePaths([""]);
    setShowPaths([""]);
    setMusicPaths([""]);
    setSoundsPaths([""]);
    setFormat("video");
    setSource("local");
    setOnlineMetadata(true);
    setSeenAll(false);
  }, [isOpen]);

  // A format change re-locks without moving the scroll. No immediate
  // re-check here: the transition pins the old height while it fades, so
  // the body would still read "at the bottom". The ResizeObserver below
  // re-checks as the new content's height settles — if the user was at
  // the bottom and it fits, it unlocks again on its own.
  useEffect(() => {
    setSeenAll(false);
  }, [format]);

  // Re-check on scroll and whenever the body's content changes height (the
  // format swap animates, folder rows get added). Once seen, it stays seen
  // until the next format change.
  useEffect(() => {
    if (!isOpen) return;
    const el = bodyRef.current;
    if (!el) return;
    const check = () => {
      // Not laid out yet (the shell hasn't shown the slot): 0 ≥ 0 would
      // pass. The ResizeObserver re-checks once it has a size.
      if (el.clientHeight === 0) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) setSeenAll(true);
    };
    // The dialog stays mounted between opens and keeps its scroll; a fresh
    // open starts at the top.
    el.scrollTop = 0;
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [isOpen]);

  // Fill the name from the first browsed folder if the user hasn't named the library yet.
  function maybeAutoName(folder: string) {
    if (name) return;
    const parts = folder.replace(/\\/g, "/").split("/");
    setName(parts[parts.length - 1] || "");
  }

  const validMoviePaths = moviePaths.filter((p) => p.trim() !== "");
  const validShowPaths = showPaths.filter((p) => p.trim() !== "");
  const validMusicPaths = musicPaths.filter((p) => p.trim() !== "");
  const validSoundsPaths = soundsPaths.filter((p) => p.trim() !== "");
  const totalValidPaths =
    format === "music"
      ? validMusicPaths.length + validSoundsPaths.length
      : validMoviePaths.length + validShowPaths.length;

  function handleCreate() {
    if (!name || totalValidPaths === 0) return;
    const paths =
      format === "music"
        ? [
            ...validMusicPaths.map((path) => ({ path, kind: "music" })),
            ...validSoundsPaths.map((path) => ({ path, kind: "sounds" })),
          ]
        : [
            ...validMoviePaths.map((path) => ({ path, kind: "movie" })),
            ...validShowPaths.map((path) => ({ path, kind: "show" })),
          ];
    // The controller owns the scan from here (it reports failures itself).
    void createLibrary({ name, paths, format, source, onlineMetadata });
    onOpenChange(false);
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent width="30rem" height="xl" className="gap-0 px-0">
        <DialogHeader className="px-4 pb-2">
          <DialogTitle>Create Library</DialogTitle>
        </DialogHeader>
        {/* Static frame: the form scrolls inside it (folder lists grow). */}
        <DialogBody ref={bodyRef} className="overflow-x-hidden">
          {/* min-w-0 down the chain: long unbreakable paths must truncate
              with an ellipsis instead of widening the modal. */}
          <div className="grid min-w-0 gap-6 px-4 py-4">
            <div className="grid gap-3">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={format === "video" ? "Movies/TV" : "Music"}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-3">
              <Label>Format</Label>
              <ToggleGroup
                value={[format]}
                onValueChange={(v) => {
                  if (v.includes("video")) setFormat("video");
                  else if (v.includes("music")) setFormat("music");
                }}
                spacing={1}
                className="grid w-full grid-cols-4 gap-3"
              >
                <ToggleGroupItem
                  value="video"
                  className="flex h-auto flex-col items-center gap-2 rounded border border-border px-2 py-4 data-[state=on]:border-primary data-[state=on]:bg-accent"
                >
                  <Film size={28} />
                  <span className="text-sm font-medium">Video</span>
                </ToggleGroupItem>
                {/* The stored format is still "music" — only the label changed. */}
                <ToggleGroupItem
                  value="music"
                  className="flex h-auto flex-col items-center gap-2 rounded border border-border px-2 py-4 data-[state=on]:border-primary data-[state=on]:bg-accent"
                >
                  <Music size={28} />
                  <span className="text-sm font-medium">Audio</span>
                </ToggleGroupItem>
                {/* Not implemented yet — shown disabled so the direction is
                    visible, like the media-server source below. */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ToggleGroupItem
                          value="books"
                          aria-disabled
                          className="flex h-auto cursor-not-allowed flex-col items-center gap-2 rounded border border-border px-2 py-4 opacity-50"
                        >
                          <BookOpen size={28} />
                          <span className="text-sm font-medium">Books</span>
                        </ToggleGroupItem>
                      }
                    />
                    <TooltipContent>Coming soon. Books and audiobooks.</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ToggleGroupItem
                          value="livetv"
                          aria-disabled
                          className="flex h-auto cursor-not-allowed flex-col items-center gap-2 rounded border border-border px-2 py-4 opacity-50"
                        >
                          <Tv size={28} />
                          <span className="text-sm font-medium">Live TV</span>
                        </ToggleGroupItem>
                      }
                    />
                    <TooltipContent>Coming soon. Live TV over IPTV.</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </ToggleGroup>
            </div>
            {/* Everything below the format tiles is per-format — source,
                folders, online metadata — so the whole block fades out and
                back in together on a format change. Video and audio happen
                to share the source + toggle today; future formats won't. */}
            <DialogTransition contentKey={format}>
            <div className="grid gap-6">
            <div className="grid gap-3">
              <Label>Source</Label>
              <ToggleGroup
                value={[source]}
                // Only 'local' is implemented — see the format group note above.
                onValueChange={(v) => { if (v.includes("local")) setSource("local"); }}
                spacing={1}
                className="grid w-full grid-cols-2 gap-3"
              >
                <ToggleGroupItem
                  value="local"
                  className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-5 data-[state=on]:border-primary data-[state=on]:bg-accent"
                >
                  <HardDrive size={32} />
                  <span className="text-sm font-medium">Local folders</span>
                </ToggleGroupItem>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ToggleGroupItem
                          value="server"
                          aria-disabled
                          className="flex h-auto cursor-not-allowed flex-col items-center gap-2 rounded border border-border px-4 py-5 opacity-50"
                        >
                          <Server size={32} />
                          <span className="text-sm font-medium">Media server</span>
                        </ToggleGroupItem>
                      }
                    />
                    <TooltipContent>
                      Coming soon. waverunner will be able to act as a client for a
                      Jellyfin, Plex, or Emby server.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </ToggleGroup>
            </div>
              {format === "music" ? (
                <div className="grid gap-6">
                  <FolderSection
                    label="Music folders"
                    paths={musicPaths}
                    setPaths={setMusicPaths}
                    onAutoName={maybeAutoName}
                  />
                  <FolderSection
                    label="Sounds folders"
                    paths={soundsPaths}
                    setPaths={setSoundsPaths}
                    onAutoName={maybeAutoName}
                  />
                </div>
              ) : (
                <div className="grid gap-6">
                  <FolderSection
                    label="Movie folders"
                    paths={moviePaths}
                    setPaths={setMoviePaths}
                    onAutoName={maybeAutoName}
                  />
                  <FolderSection
                    label="TV Show folders"
                    paths={showPaths}
                    setPaths={setShowPaths}
                    onAutoName={maybeAutoName}
                  />
                </div>
              )}
            <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Online metadata</p>
                <p className="text-xs text-muted-foreground">
                  {format === "music"
                    ? "Identify albums and artists on MusicBrainz."
                    : "Identify movies and shows on TMDB and OMDB."}{" "}
                  Off keeps this library fully offline — changeable later in Library
                  settings.
                </p>
              </div>
              <Switch checked={onlineMetadata} onCheckedChange={setOnlineMetadata} />
            </div>
            </div>
            </DialogTransition>
          </div>
        </DialogBody>

        <DialogFooter className="mx-0 -mb-4 items-center px-4">
          {!seenAll && (
            <p className="mr-auto text-xs text-yellow-500">
              Scroll to the bottom to enable Create.
            </p>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!seenAll || !name || totalValidPaths === 0}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A repeatable folder picker for one media kind (movies, shows, or music). */
function FolderSection({
  label,
  paths,
  setPaths,
  onAutoName,
}: {
  label: string;
  paths: string[];
  setPaths: Dispatch<SetStateAction<string[]>>;
  onAutoName: (folder: string) => void;
}) {
  function updatePath(index: number, value: string) {
    setPaths((prev) => prev.map((p, i) => (i === index ? value : p)));
  }
  function addPath() {
    setPaths((prev) => [...prev, ""]);
  }
  function removePath(index: number) {
    setPaths((prev) => prev.filter((_, i) => i !== index));
  }
  async function browsePath(index: number) {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      updatePath(index, selected as string);
      onAutoName(selected as string);
    }
  }

  return (
    <div className="grid gap-3">
      <Label>{label}</Label>
      <div className="grid gap-2">
        {paths.map((p, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={p}
              onChange={(e) => updatePath(i, e.target.value)}
              placeholder="Select a folder..."
              className="flex-1"
            />
            <Button variant="outline" onClick={() => browsePath(i)} className="h-9 w-9 shrink-0 p-0">
              <FolderOpen size={16} />
            </Button>
            {paths.length > 1 && (
              <Button variant="outline" onClick={() => removePath(i)} className="h-9 w-9 shrink-0 p-0">
                <X size={16} />
              </Button>
            )}
          </div>
        ))}
        {/* A quiet inline link, not a full-width row: takes the space it
            needs, no hover background, underline on hover. */}
        <button
          type="button"
          onClick={addPath}
          className="group/add flex w-fit items-center gap-1 px-2 pb-0 pt-0.5 text-xs text-foreground"
        >
          <Plus size={12} className="shrink-0" />
          <span className="leading-none group-hover/add:underline">add folder</span>
        </button>
      </div>
    </div>
  );
}
