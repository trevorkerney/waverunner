import { useCallback, useState } from "react";
import {
  PointerSensor,
  pointerWithin,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type CollisionDetection,
} from "@dnd-kit/core";

/** Adapter shape — every grid DnD flow (library, playlist) wires these to its own
 *  backend commands. The hook owns the orchestration (sensor config, drag-id state,
 *  collision detection, the "is this move-up / move-into / reorder?" decision) and
 *  calls exactly one adapter outcome per successful drop. */
export type GridDndAdapter = {
  /** Sortable ids for the currently-rendered items — used to compute reorder indices. */
  items: Array<string | number>;
  /** When `"custom"`, reorder drops are allowed. Any other value suppresses reorder. */
  sortMode: string;
  /** Recognizes a drop target id as a "move-into" drop (drop one item INTO a container
   *  like a collection). Return the extracted target id, or null if this over.id is
   *  not a move-into target. */
  parseMoveIntoTarget: (overId: string) => number | null;
  onMoveInto: (activeId: string | number, targetId: number) => Promise<void> | void;
  onMoveUp: (activeId: string | number) => Promise<void> | void;
  onReorder: (oldIndex: number, newIndex: number) => void;
};

export function useGridDnd(adapter: GridDndAdapter) {
  const [dragId, setDragId] = useState<string | number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 500, tolerance: 5 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragId(event.active.id as string | number);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const overId = String(over.id);

      if (overId === "move-up-zone") {
        await adapter.onMoveUp(active.id as string | number);
        return;
      }
      const moveIntoId = adapter.parseMoveIntoTarget(overId);
      if (moveIntoId != null) {
        await adapter.onMoveInto(active.id as string | number, moveIntoId);
        return;
      }
      if (adapter.sortMode !== "custom") return;
      const oldIndex = adapter.items.indexOf(active.id as string | number);
      const newIndex = adapter.items.indexOf(over.id as string | number);
      if (oldIndex === -1 || newIndex === -1) return;
      adapter.onReorder(oldIndex, newIndex);
    },
    [adapter],
  );

  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const pw = pointerWithin(args);
      const special = pw.filter((c) => {
        const id = String(c.id);
        return id === "move-up-zone" || adapter.parseMoveIntoTarget(id) != null;
      });
      if (special.length > 0) return special;
      return closestCenter(args);
    },
    [adapter],
  );

  const onDragCancel = useCallback(() => setDragId(null), []);

  return { sensors, dragId, handleDragStart, handleDragEnd, collisionDetection, onDragCancel };
}
