import type { ReactNode } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { MoveUpDropZone } from "@/components/cards/MoveUpDropZone";
import { useGridDnd, type GridDndAdapter } from "@/hooks/useGridDnd";
import type { MediaEntry } from "@/types";

/** DnD-enabled grid body for media views. Owns DndContext, SortableContext, DragOverlay,
 *  and (optionally) the move-up drop zone. View-kind agnostic — the view supplies an
 *  `adapter` (library vs playlist) and a `renderCard` function that knows how to render
 *  each item with the appropriate per-card handlers. */
export function SortableCoverGrid({
  items,
  coverSize,
  adapter,
  sortableIdFor,
  renderCard,
  renderDragOverlay,
  moveUpEnabled,
}: {
  items: MediaEntry[];
  coverSize: number;
  adapter: GridDndAdapter;
  sortableIdFor: (entry: MediaEntry) => string | number;
  renderCard: (entry: MediaEntry, dragActive: boolean) => ReactNode;
  renderDragOverlay: (entry: MediaEntry) => ReactNode;
  moveUpEnabled: boolean;
}) {
  const { sensors, dragId, handleDragStart, handleDragEnd, collisionDetection, onDragCancel } =
    useGridDnd(adapter);

  const dragEntry =
    dragId != null ? items.find((e) => sortableIdFor(e) === dragId) ?? null : null;
  const dragActive = dragId != null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={onDragCancel}
    >
      {moveUpEnabled && <MoveUpDropZone isActive={dragActive} />}
      <SortableContext items={items.map(sortableIdFor)} strategy={rectSortingStrategy}>
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))`,
            alignItems: "center",
            justifyItems: "center",
          }}
        >
          {items.map((entry) => (
            <div key={sortableIdFor(entry)}>{renderCard(entry, dragActive)}</div>
          ))}
        </div>
      </SortableContext>
      <DragOverlay>{dragEntry && renderDragOverlay(dragEntry)}</DragOverlay>
    </DndContext>
  );
}
