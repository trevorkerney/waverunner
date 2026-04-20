import { GridView } from "@/views/video/GridView";
import type { ComponentProps } from "react";

/** library-root / movies-only / shows-only. Shell and DnD are shared with playlist-detail
 *  and person-detail via [GridView](./GridView.tsx); this file narrows the `view` prop to
 *  the three library kinds so MainContent's router type-checks. */
export function LibraryGridView(
  props: Omit<ComponentProps<typeof GridView>, "view"> & {
    view: Extract<ComponentProps<typeof GridView>["view"], { kind: "library-root" | "movies-only" | "shows-only" }>;
  },
) {
  return <GridView {...props} />;
}
