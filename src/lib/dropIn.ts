// The "page load-in" animation: cards slide down + scale up + fade in. Shared so the
// library grid, the playlists list, and the people pages all reveal identically.
export function playDropIn(elements: Iterable<Element>) {
  for (const el of elements) {
    (el as HTMLElement).animate(
      [
        { transform: "translateY(-12px) scale(0.96)", opacity: 0 },
        { transform: "translateY(0px) scale(1)", opacity: 1 },
      ],
      { duration: 280, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "backwards" },
    );
  }
}
