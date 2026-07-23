import { useEffect } from "react";

/**
 * Album-page deselect semantics for the other track lists: clicking anywhere
 * that isn't a track row or an interactive control clears the selection.
 * Document-level so the "background" includes everything around the list,
 * not just gaps inside its own container.
 */
export function useDeselectOnBackgroundClick(clear: () => void) {
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      const el = ev.target;
      if (
        el instanceof Element &&
        el.closest(
          '[data-track-row], button, [role="link"], [role="menu"], [role="menuitem"], input, textarea, select, img',
        )
      ) {
        return;
      }
      clear();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [clear]);
}
