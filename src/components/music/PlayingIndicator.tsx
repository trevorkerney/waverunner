/** Animated three-bar equalizer marking the currently playing track row.
 *  Bars freeze in place while playback is paused. Keyframes (`eq-bar`) and
 *  the .eq-icon height (baseline-to-cap-height via the `cap` unit) live in
 *  App.css; render it inside an `items-baseline` flex row so its bottom sits
 *  on the text baseline. */
export function PlayingIndicator({ paused = false, className }: { paused?: boolean; className?: string }) {
  return (
    <span
      className={`eq-icon inline-flex items-end gap-[2px] ${className ?? ""}`}
      aria-label={paused ? "Paused" : "Playing"}
      title={paused ? "Paused" : "Playing"}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-full w-[2px] origin-bottom rounded-full bg-primary"
          style={{
            animation: `eq-bar 1s ease-in-out ${i * 0.25}s infinite`,
            animationPlayState: paused ? "paused" : "running",
          }}
        />
      ))}
    </span>
  );
}
