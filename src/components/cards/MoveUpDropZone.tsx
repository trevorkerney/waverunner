import { useDroppable } from "@dnd-kit/core";
import { ArrowUp } from "lucide-react";

export function MoveUpDropZone({ isActive }: { isActive: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "move-up-zone",
  });

  if (!isActive) return null;

  return (
    <div
      ref={setNodeRef}
      className={`mb-4 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm transition-colors ${
        isOver
          ? "border-primary bg-primary/10 text-primary"
          : "border-muted-foreground/30 text-muted-foreground"
      }`}
    >
      <ArrowUp size={16} />
      Move up a level
    </div>
  );
}
