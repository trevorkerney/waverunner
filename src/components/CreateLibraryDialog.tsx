import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
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
import { FolderOpen, Film, Music, Server, HardDrive, Plus, X } from "lucide-react";

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
      <DialogContent width="30rem" className="flex flex-col gap-0 overflow-hidden px-0">
        <DialogHeader className="px-4 pb-2">
          <DialogTitle>Create Library</DialogTitle>
        </DialogHeader>
        {/* Folder lists can outgrow a small window — the form scrolls. */}
        <div className="min-h-0 overflow-y-auto overflow-x-hidden">
          {/* min-w-0 down the chain: long unbreakable paths must truncate
              with an ellipsis instead of widening the modal. */}
          <div className="grid min-w-0 gap-6 px-4 py-4">
            <div className="grid gap-3">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={format === "video" ? "Videos" : "Music"}
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
                className="grid w-full grid-cols-2 gap-3"
              >
                <ToggleGroupItem
                  value="video"
                  className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-4 data-[state=on]:border-primary data-[state=on]:bg-accent"
                >
                  <Film size={28} />
                  <span className="text-sm font-medium">Video</span>
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="music"
                  className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-4 data-[state=on]:border-primary data-[state=on]:bg-accent"
                >
                  <Music size={28} />
                  <span className="text-sm font-medium">Music</span>
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
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
            {/* The folder sections change shape with the format — the swap
                fades out, resizes, fades in (never a visible jump). */}
            <DialogTransition contentKey={format} className="grid gap-6">
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
            </DialogTransition>
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
        </div>

        <DialogFooter className="mx-0 -mb-4 px-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!name || totalValidPaths === 0}>
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
