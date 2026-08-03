import * as React from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** An Input with an X at its right edge whenever it holds text — one click
 *  back to empty, focus kept so the user can immediately retype. Used by
 *  every search/filter bar; a search you can't cheaply undo gets abandoned
 *  mid-word instead. */
export function ClearableInput({
  value,
  onValueChange,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
  value: string;
  onValueChange: (v: string) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        // pr reserves the X's space so text never slides beneath it.
        className={cn(className, value !== "" && "pr-7")}
        {...props}
      />
      {value !== "" && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => {
            onValueChange("");
            inputRef.current?.focus();
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          title="Clear"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
