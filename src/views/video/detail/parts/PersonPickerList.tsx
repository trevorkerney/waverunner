import { useState } from "react";
import { Trash2, User, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PersonPickerDialog, type PersonPick } from "@/components/dialogs/PersonPickerDialog";
import type { CastUpdateInfo, PersonUpdateInfo } from "@/types";

/** A row in a cast or crew edit list. Rows carry the full [CastUpdateInfo] or
 *  [PersonUpdateInfo] shape so backend apply commands can preserve identity via
 *  `person_id` when the row came from an existing-library pick. */
type Row = CastUpdateInfo | PersonUpdateInfo;

/** List of cast/crew people with add/edit/remove via the PersonPickerDialog.
 *  Replaces the old PeopleListEdit — same label + add/remove UX but the source of
 *  each row is a real person record (existing, TMDB, or manually created) rather
 *  than a free-text string. The optional `secondaryField` enables the cast-specific
 *  "character" column next to each row. */
export function PersonPickerList<T extends Row>({
  label,
  items,
  onChange,
  secondaryField,
  secondaryLabel,
}: {
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  /** Present only for cast (the "role"/character field). Crew lists omit it. */
  secondaryField?: "role";
  secondaryLabel?: string;
}) {
  // Null when adding a new row; number when editing the row at that index.
  const [pickerForIndex, setPickerForIndex] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const addingNew = pickerOpen && pickerForIndex === null;

  const setSecondary = (i: number, value: string) => {
    if (!secondaryField) return;
    const next = items.slice();
    next[i] = { ...next[i], [secondaryField]: value || null } as T;
    onChange(next);
  };

  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));

  const rowFromPick = (pick: PersonPick, existingSecondary: string | null): T => {
    const base = {
      role: secondaryField ? existingSecondary : undefined,
    } as Partial<CastUpdateInfo>;

    if (pick.kind === "existing") {
      return {
        ...base,
        person_id: pick.personId,
        name: pick.name,
        tmdb_id: pick.tmdbId,
        profile_path: null,
      } as unknown as T;
    }
    if (pick.kind === "tmdb") {
      return {
        ...base,
        name: pick.name,
        tmdb_id: pick.tmdbId,
        profile_path: pick.profilePath,
      } as unknown as T;
    }
    // kind === "new"
    return {
      ...base,
      name: pick.name,
      tmdb_id: null,
      profile_path: null,
    } as unknown as T;
  };

  const handlePick = (pick: PersonPick) => {
    const existingSecondary =
      secondaryField && pickerForIndex !== null
        ? (items[pickerForIndex] as unknown as Record<string, string | null>)[secondaryField] ?? null
        : null;
    const newRow = rowFromPick(pick, existingSecondary);
    if (pickerForIndex === null) {
      onChange([...items, newRow]);
    } else {
      const next = items.slice();
      next[pickerForIndex] = newRow;
      onChange(next);
    }
    setPickerForIndex(null);
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex flex-col gap-1">
        {items.map((item, i) => {
          const p = item as unknown as Row & { profile_path?: string | null };
          const imgSrc =
            // TMDB-sourced row: use the remote poster path.
            p.tmdb_id != null && p.profile_path
              ? `https://image.tmdb.org/t/p/w185${p.profile_path}`
              : null;
          const secondary =
            secondaryField && ((item as unknown as Record<string, string | null>)[secondaryField] ?? "");
          return (
            <div key={i} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setPickerForIndex(i);
                  setPickerOpen(true);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-transparent px-2 py-1 text-left hover:bg-accent focus:bg-accent focus:outline-none"
                title="Change person"
              >
                <Avatar src={imgSrc} name={p.name} />
                <span className="truncate text-sm">{p.name}</span>
              </button>
              {secondaryField && (
                <Input
                  value={secondary ?? ""}
                  onChange={(e) => setSecondary(i, e.target.value)}
                  placeholder={secondaryLabel ?? ""}
                  className="h-8 flex-1 text-sm"
                />
              )}
              <Button size="sm" variant="ghost" onClick={() => remove(i)} title="Remove">
                <Trash2 size={14} />
              </Button>
            </div>
          );
        })}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setPickerForIndex(null);
            setPickerOpen(true);
          }}
          className="w-fit"
        >
          <Plus size={14} /> Add
        </Button>
      </div>

      <PersonPickerDialog
        open={pickerOpen}
        onOpenChange={(o) => {
          setPickerOpen(o);
          if (!o) setPickerForIndex(null);
        }}
        initialName={
          !addingNew && pickerForIndex !== null ? items[pickerForIndex].name : undefined
        }
        onPick={handlePick}
      />
    </div>
  );
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
      {src ? (
        <img src={src} alt={name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <User className="h-4 w-4 text-muted-foreground" />
      )}
    </div>
  );
}
