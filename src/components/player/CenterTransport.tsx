import { Play, Pause, SkipBack, SkipForward } from "lucide-react";

interface CenterTransportProps {
  isPlaying: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  visible: boolean;
  onPrev: () => void;
  onPlayPause: () => void;
  onNext: () => void;
}

export function CenterTransport({
  isPlaying,
  hasPrev,
  hasNext,
  visible,
  onPrev,
  onPlayPause,
  onNext,
}: CenterTransportProps) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div
        className="pointer-events-auto grid items-center"
        style={{ gridTemplateColumns: "80px 96px 80px", gap: "32px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onPrev}
          className="flex items-center justify-center text-black transition-opacity hover:opacity-50 dark:text-white"
          style={{ visibility: hasPrev ? "visible" : "hidden" }}
          aria-label="Previous episode"
        >
          <SkipBack className="h-12 w-12" fill="currentColor" />
        </button>
        <button
          type="button"
          onClick={onPlayPause}
          className="flex items-center justify-center text-black transition-opacity hover:opacity-50 dark:text-white"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <Pause className="h-20 w-20" fill="currentColor" strokeWidth={0} />
          ) : (
            <Play className="h-20 w-20" fill="currentColor" strokeWidth={0} />
          )}
        </button>
        <button
          type="button"
          onClick={onNext}
          className="flex items-center justify-center text-black transition-opacity hover:opacity-50 dark:text-white"
          style={{ visibility: hasNext ? "visible" : "hidden" }}
          aria-label="Next episode"
        >
          <SkipForward className="h-12 w-12" fill="currentColor" />
        </button>
      </div>
    </div>
  );
}
