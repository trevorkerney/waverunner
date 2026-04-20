import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import type { Library, BreadcrumbItem } from "@/types";

export function NewCollectionDialog({
  open,
  onOpenChange,
  selectedLibrary,
  breadcrumbs,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedLibrary: Library | null;
  breadcrumbs: BreadcrumbItem[];
  onCreate: (name: string, basePath?: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, path || undefined);
    setName("");
    setPath("");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setName("");
          setPath("");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New Collection</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Collection name"
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) submit();
            }}
            autoFocus
          />
          {selectedLibrary?.managed && selectedLibrary.paths.length > 1 && breadcrumbs.length <= 1 && (
            <Select value={path} onValueChange={(v) => setPath(v ?? "")}>
              <SelectTrigger className="text-xs">
                {path || "Select location"}
              </SelectTrigger>
              <SelectContent>
                {selectedLibrary.paths.map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} onClick={submit}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
