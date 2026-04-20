import { GridView } from "@/views/video/GridView";
import type { ComponentProps } from "react";

/** playlist-detail. Shares grid/DnD shell with library views via [GridView](./GridView.tsx)
 *  — this wrapper narrows `view` to playlist-detail and routes through the same rendering
 *  so in-level reorder + nested playlist_collection moves + move-up-a-level all work
 *  through one code path. */
export function PlaylistDetailView(
  props: Omit<ComponentProps<typeof GridView>, "view"> & {
    view: Extract<ComponentProps<typeof GridView>["view"], { kind: "playlist-detail" }>;
  },
) {
  return <GridView {...props} />;
}
