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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { MediaEntry } from "@/types";

/** Edit the character name a person plays in a single work. Mass-updates every cast row
 *  (`show_cast`, all `season_cast`, all `episode_cast`) for shows; just `movie_cast` for
 *  movies. The variant count is fetched on open to warn when multiple distinct names
 *  exist (typically a voice actor or anthology guest playing several characters). */
export function EditCharacterNameDialog({
  open,
  onOpenChange,
  personId,
  personName,
  entry,
  initialRole,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personId: number | null;
  personName: string;
  entry: MediaEntry | null;
  /** Current label-source role value to pre-fill the input. Pass null/empty for an
   *  unfilled name. */
  initialRole: string | null;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [variantCount, setVariantCount] = useState<number>(1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(initialRole ?? "");
    if (!personId || !entry) {
      setVariantCount(1);
      return;
    }
    invoke<number>("count_person_role_variants", {
      personId,
      entryId: entry.id,
      entryType: entry.entry_type,
    })
      .then((n) => setVariantCount(n))
      .catch(() => setVariantCount(1));
  }, [open, personId, entry, initialRole]);

  const handleSave = async () => {
    if (!personId || !entry) return;
    setSaving(true);
    try {
      await invoke("update_person_cast_role", {
        personId,
        entryId: entry.id,
        entryType: entry.entry_type,
        newRole: value,
      });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{initialRole ? "Edit character name" : "Add character name"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          <p className="text-xs text-muted-foreground">
            {personName} in <span className="font-medium text-foreground">{entry?.title}</span>
          </p>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Character name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
          />
          {variantCount > 1 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              This person currently has {variantCount} different character names across episodes.
              Saving will replace all of them with the new name.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
