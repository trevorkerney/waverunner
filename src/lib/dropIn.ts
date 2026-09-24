// The "page load-in" animation: cards slide down + scale up + fade in. Shared so the
// library grid, the playlists list, and the people pages all reveal identically.
//
// `list`: for row lists (the Tracks page). A full-width row scaling up from
// 0.96 reads as spreading OUTWARD left and right, which looks odd on text
// rows; the list variant keeps the same drop and fade with only a trace of
// scale (half a percent — a few px on a wide row), so the motion reads as
// settling down into place.
export function playDropIn(elements: Iterable<Element>, opts?: { list?: boolean }) {
  const scale = opts?.list ? 0.995 : 0.96;
  for (const el of elements) {
    (el as HTMLElement).animate(
      [
        { transform: `translateY(-12px) scale(${scale})`, opacity: 0 },
        { transform: "translateY(0px) scale(1)", opacity: 1 },
      ],
      { duration: 280, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "backwards" },
    );
  }
}
