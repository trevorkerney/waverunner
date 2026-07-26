import { Music2 } from "lucide-react";

interface LooseTracksSectionProps {
  /** Loose-track count, delivered by the host FROM THE GRID PAYLOAD — this
   *  component fetches nothing, so it can only ever render in the same
   *  commit as the grid it sits above. */
  count: number;
  /** Open the Loose-tracks page (album-style listing). */
  onOpen?: () => void;
}

/** Header button above the Albums/Sounds grids: "Loose tracks (N)" → the
 *  loose-tracks page. Renders nothing when the library has none. */
export function LooseTracksSection({ count, onOpen }: LooseTracksSectionProps) {
  if (!count) return null;

  return (
    <button
      onClick={onOpen}
      className="mb-5 flex items-center gap-1.5 self-start text-sm font-semibold hover:underline"
    >
      <Music2 size={15} />
      Loose tracks
      <span className="font-normal text-muted-foreground">({count})</span>
    </button>
  );
}
