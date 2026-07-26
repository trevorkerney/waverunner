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

/** The work a character edit targets — enough identity for the cast-role
 *  commands without dragging a full MediaEntry through every call site. */
export interface CharacterEditTarget {
  entryId: number;
  entryType: "movie" | "show";
  title: string;
}

/** Edit the character name a person plays in a single work. Mass-updates every
 *  cast row (`show_cast`, all `season_cast`, all `episode_cast`) for shows;
 *  just `movie_cast` for movies. On open it fetches the current stored role as
 *  the pre-fill and the distinct-variant count to warn when one save will
 *  replace several names (voice actors / anthology guests). */
export function EditCharacterNameDialog({
  open,
  onOpenChange,
  personId,
  personName,
  target,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personId: number | null;
  personName: string;
  target: CharacterEditTarget | null;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [hadRole, setHadRole] = useState(false);
  const [variantCount, setVariantCount] = useState<number>(1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !personId || !target) return;
    let cancelled = false;
    setValue("");
    setLoaded(false);
    setHadRole(false);
    setVariantCount(1);
    const args = { personId, entryId: target.entryId, entryType: target.entryType };
    invoke<string | null>("get_person_cast_role", args)
      .then((role) => {
        if (cancelled) return;
        setValue(role ?? "");
        setHadRole(!!role);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    invoke<number>("count_person_role_variants", args)
      .then((n) => {
        if (!cancelled) setVariantCount(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, personId, target]);

  const handleSave = async () => {
    if (!personId || !target) return;
    setSaving(true);
    try {
      await invoke("update_person_cast_role", {
        personId,
        entryId: target.entryId,
        entryType: target.entryType,
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
          <DialogTitle>{hadRole ? "Edit character name" : "Add character name"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          <p className="text-xs text-muted-foreground">
            {personName} in <span className="font-medium text-foreground">{target?.title}</span>
          </p>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={loaded ? "Character name" : "Loading…"}
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
          <Button onClick={handleSave} disabled={saving || !loaded}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
