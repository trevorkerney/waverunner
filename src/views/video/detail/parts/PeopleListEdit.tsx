import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CastUpdateInfo } from "@/types";

export function PeopleListEdit<T extends CastUpdateInfo>({
  label,
  items,
  onChange,
  secondaryField,
  secondaryLabel,
}: {
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  secondaryField: "role";
  secondaryLabel: string;
}) {
  const update = (i: number, patch: Partial<T>) => {
    const next = items.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () =>
    onChange([...items, { name: "", [secondaryField]: null, tmdb_id: null } as unknown as T]);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex flex-col gap-1">
        {items.map((item, i) => (
          <div key={i} className="flex gap-1">
            <input
              value={item.name}
              onChange={(e) => update(i, { name: e.target.value } as Partial<T>)}
              placeholder="Name"
              className="flex-1 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
            />
            <input
              value={(item as unknown as Record<string, string | null>)[secondaryField] ?? ""}
              onChange={(e) =>
                update(i, { [secondaryField]: e.target.value || null } as unknown as Partial<T>)
              }
              placeholder={secondaryLabel}
              className="flex-1 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
            />
            <Button size="sm" variant="ghost" onClick={() => remove(i)}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={add} className="w-fit">
          + Add
        </Button>
      </div>
    </div>
  );
}
