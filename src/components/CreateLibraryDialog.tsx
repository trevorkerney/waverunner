import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { FolderOpen, Film, Tv, Music, CircleHelp } from "lucide-react";

interface CreateLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function CreateLibraryDialog({
  open: isOpen,
  onOpenChange,
  onCreated,
}: CreateLibraryDialogProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [format, setFormat] = useState("movies");
  const [portable, setPortable] = useState(false);
  const [creating, setCreating] = useState(false);
  const [scanProgress, setScanProgress] = useState("");

  useEffect(() => {
    if (!creating) return;
    const unlisten = listen<string>("scan-progress", (event) => {
      setScanProgress(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [creating]);

  async function browsePath() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setPath(selected as string);
      if (!name) {
        const parts = (selected as string).replace(/\\/g, "/").split("/");
        setName(parts[parts.length - 1] || "");
      }
    }
  }

  async function handleCreate() {
    if (!name || !path) return;
    setCreating(true);
    setScanProgress("");
    try {
      await invoke("create_library", { name, path, format, portable });
      onCreated();
      onOpenChange(false);
      setName("");
      setPath("");
      setFormat("movies");
      setPortable(false);
    } catch (e) {
      console.error("Failed to create library:", e);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Library</DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 py-4">
          <div className="grid gap-3">
            <Label>Format</Label>
            <ToggleGroup
              value={[format]}
              onValueChange={(v) => { if (v.length) setFormat(v[v.length - 1]); }}
              spacing={1}
              className="grid w-full grid-cols-3 gap-3"
            >
              <ToggleGroupItem
                value="movies"
                className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-4 data-[state=on]:border-primary data-[state=on]:bg-accent"
              >
                <Film size={28} />
                <span className="text-sm font-medium">Movies</span>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="tv"
                className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-4 data-[state=on]:border-primary data-[state=on]:bg-accent"
              >
                <Tv size={28} />
                <span className="text-sm font-medium">TV</span>
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
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={format === "movies" ? "Movies" : format === "tv" ? "TV Shows" : "Music"}
            />
          </div>
          <div className="grid gap-3">
            <Label htmlFor="path">Folder</Label>
            <div className="flex gap-2">
              <Input
                id="path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="Select a folder..."
                className="flex-1"
              />
              <Button variant="outline" onClick={browsePath} className="h-9 w-9 shrink-0 p-0">
                <FolderOpen size={16} />
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-center gap-2">
            <Switch
              id="portable"
              checked={portable}
              onCheckedChange={setPortable}
            />
            <span className="text-xs font-normal tracking-wide">Portable</span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<CircleHelp size={13} className="text-muted-foreground cursor-help" />} />
                <TooltipContent>
                  Store the library index alongside your media files so it travels with them and can be imported on other devices without re-scanning. Ideal for portable, external drives. When the library is located on a slower drive than the one where waverunner is installed, keep this setting off to store the index locally for better performance.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
        <DialogFooter>
          {creating ? (
            <div className="flex w-full items-center gap-2">
              <Spinner className="size-3.5" />
              <span className="truncate text-xs text-muted-foreground">
                {scanProgress || "Scanning..."}
              </span>
            </div>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={!name || !path}>
                Create
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
