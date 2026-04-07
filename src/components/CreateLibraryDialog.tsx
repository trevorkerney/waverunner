import { useEffect, useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { FolderOpen, Film, Music, CircleHelp, FolderSync, FolderSearch, Plus, X } from "lucide-react";

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
  const [managed, setManaged] = useState(true);
  const [name, setName] = useState("");
  const [paths, setPaths] = useState<string[]>([""]);
  const [format, setFormat] = useState("video");
  const [portable, setPortable] = useState(false);
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
      if (!name && index === 0) {
        const parts = (selected as string).replace(/\\/g, "/").split("/");
        setName(parts[parts.length - 1] || "");
      }
    }
  }

  const validPaths = paths.filter((p) => p.trim() !== "");

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

  async function handleCreate() {
    if (!name || validPaths.length === 0 || creatingGlobal) return;
    setCreating(true);
    creatingGlobal = true;
    setScanProgress("");
    try {
      await invoke("create_library", { name, paths: validPaths, format, portable, managed });
      if (toastIdRef.current != null) {
        toast.success(`Library "${name}" created`, { id: toastIdRef.current, duration: 4000 });
        toastIdRef.current = null;
      }
      onCreated();
      onOpenChange(false);
      setManaged(true);
      setName("");
      setPaths([""]);
      setFormat("video");
      setPortable(false);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("cancelled")) {
        if (toastIdRef.current != null) {
          toast.info("Library creation cancelled", { id: toastIdRef.current, duration: 3000 });
          toastIdRef.current = null;
        }
        onOpenChange(false);
        setManaged(true);
        setName("");
        setPaths([""]);
        setFormat("video");
        setPortable(false);
      } else if (toastIdRef.current != null) {
        toast.error(msg, { id: toastIdRef.current, duration: 4000 });
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
        <DialogHeader className="px-4">
          <DialogTitle>Create Library</DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 py-4 px-4 overflow-y-auto min-h-0">
          <div className="grid gap-3">
            <Label>Library Type</Label>
            <ToggleGroup
              value={[managed ? "managed" : "unmanaged"]}
              onValueChange={(v) => { if (v.length) setManaged(v[v.length - 1] === "managed"); }}
              spacing={1}
              className="grid w-full grid-cols-2 gap-3"
            >
              <ToggleGroupItem
                value="managed"
                className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-5 data-[state=on]:border-primary data-[state=on]:bg-accent"
              >
                <FolderSync size={32} />
                <span className="text-sm font-medium">Managed</span>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="unmanaged"
                className="flex h-auto flex-col items-center gap-2 rounded border border-border px-4 py-5 data-[state=on]:border-primary data-[state=on]:bg-accent"
              >
                <FolderSearch size={32} />
                <span className="text-sm font-medium">Unmanaged</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="grid gap-3">
            <Label>Format</Label>
            <ToggleGroup
              value={[format]}
              onValueChange={(v) => { if (v.length) setFormat(v[v.length - 1]); }}
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
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={format === "video" ? "Videos" : "Music"}
            />
          </div>
          <div className="grid gap-3">
            <Label>Folders</Label>
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
              <Button onClick={handleCreate} disabled={!name || validPaths.length === 0}>
                Create
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
