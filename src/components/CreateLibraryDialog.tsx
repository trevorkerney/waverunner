import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
import { Spinner } from "@/components/ui/spinner";
import { FolderOpen, Film, Music, Server, HardDrive, Plus, X } from "lucide-react";

interface CreateLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

let creatingGlobal = false;

export function isCreatingLibrary(): boolean {
  return creatingGlobal;
}

export function CreateLibraryDialog({
  open: isOpen,
  onOpenChange,
  onCreated,
}: CreateLibraryDialogProps) {
  const [name, setName] = useState("");
  // Folders are tagged by kind: movies vs TV shows. At least one across both is required.
  const [moviePaths, setMoviePaths] = useState<string[]>([""]);
  const [showPaths, setShowPaths] = useState<string[]>([""]);
  const [format, setFormat] = useState("video");
  // Only 'local' is implemented; 'server' (Jellyfin/Plex/Emby client mode) is
  // shown disabled so the direction is visible in the UI.
  const [source, setSource] = useState("local");
  const [creating, setCreating] = useState(creatingGlobal);
  const [scanProgress, setScanProgress] = useState("");
  const toastIdRef = useRef<string | number | null>(null);

  useEffect(() => {
    if (!creating) return;
    const unlisten = listen<string>("scan-progress", (event) => {
      setScanProgress(event.payload);
      if (toastIdRef.current != null) {
        toast.loading(event.payload, { id: toastIdRef.current, duration: Infinity });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [creating]);

  // Fill the name from the first browsed folder if the user hasn't named the library yet.
  function maybeAutoName(folder: string) {
    if (name) return;
    const parts = folder.replace(/\\/g, "/").split("/");
    setName(parts[parts.length - 1] || "");
  }

  const validMoviePaths = moviePaths.filter((p) => p.trim() !== "");
  const validShowPaths = showPaths.filter((p) => p.trim() !== "");
  const totalValidPaths = validMoviePaths.length + validShowPaths.length;

  async function handleCancel() {
    try {
      await invoke("cancel_library_creation");
    } catch (e) {
      console.error("Failed to cancel:", e);
    }
  }

  function handleDialogClose(open: boolean) {
    if (!open && creating && toastIdRef.current == null) {
      toastIdRef.current = toast.loading(scanProgress || "Creating library...", {
        duration: Infinity,
        action: {
          label: "Cancel",
          onClick: handleCancel,
        },
      });
    }
    onOpenChange(open);
  }

  function resetForm() {
    setName("");
    setMoviePaths([""]);
    setShowPaths([""]);
    setFormat("video");
    setSource("local");
  }

  async function handleCreate() {
    if (!name || totalValidPaths === 0 || creatingGlobal) return;
    setCreating(true);
    creatingGlobal = true;
    setScanProgress("");
    try {
      const paths = [
        ...validMoviePaths.map((path) => ({ path, kind: "movie" })),
        ...validShowPaths.map((path) => ({ path, kind: "show" })),
      ];
      await invoke("create_library", { name, paths, format, source });
      if (toastIdRef.current != null) {
        toast.success(`Library "${name}" created`, { id: toastIdRef.current, duration: 4000, action: undefined });
        toastIdRef.current = null;
      }
      onCreated();
      onOpenChange(false);
      resetForm();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("cancelled")) {
        if (toastIdRef.current != null) {
          toast.info("Library creation cancelled", { id: toastIdRef.current, duration: 3000, action: undefined });
          toastIdRef.current = null;
        }
        onOpenChange(false);
        resetForm();
      } else if (toastIdRef.current != null) {
        toast.error(msg, { id: toastIdRef.current, duration: 4000, action: undefined });
        toastIdRef.current = null;
      } else {
        toast.error(msg);
      }
    } finally {
      setCreating(false);
      creatingGlobal = false;
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogClose}>
      <DialogContent className="sm:max-w-md overflow-hidden flex flex-col px-0 gap-0">
        <DialogHeader className="px-4 pb-2">
          <DialogTitle>Create Library</DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 py-4 px-4 overflow-y-auto min-h-0">
          <div className="grid gap-3">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={format === "video" ? "Videos" : "Music"}
            />
          </div>
          <div className="grid gap-3">
            <Label>Format</Label>
            <ToggleGroup
              value={[format]}
              // Only 'video' is implemented; other formats are shown for direction
              // but ignored here. Not using the disabled attribute — it suppresses
              // hover events, which would kill the coming-soon tooltips.
              onValueChange={(v) => { if (v.includes("video")) setFormat("video"); }}
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
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ToggleGroupItem
                        value="music"
                        aria-disabled
                        className="flex h-auto cursor-not-allowed flex-col items-center gap-2 rounded border border-border px-4 py-4 opacity-50"
                      >
                        <Music size={28} />
                        <span className="text-sm font-medium">Music</span>
                      </ToggleGroupItem>
                    }
                  />
                  <TooltipContent>
                    Coming soon. Music libraries with a dedicated audio player are planned.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
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
        <DialogFooter className="px-4 mx-0 -mb-4">
          {creating ? (
            <div className="flex w-full items-center gap-2">
              <Spinner className="size-3.5" />
              <span className="flex-1 truncate text-xs text-muted-foreground">
                {scanProgress || "Scanning..."}
              </span>
              <Button variant="outline" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={!name || totalValidPaths === 0}>
                Create
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A repeatable folder picker for one media kind (movies or shows). */
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
        <Button variant="ghost" size="sm" onClick={addPath} className="justify-start gap-1.5 text-muted-foreground">
          <Plus size={14} />
          Add folder
        </Button>
      </div>
    </div>
  );
}
