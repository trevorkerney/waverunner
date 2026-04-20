import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

export function GridSearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative flex-1">
      <Search
        size={14}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search..."
        className="h-8 pl-8 text-sm"
      />
    </div>
  );
}
