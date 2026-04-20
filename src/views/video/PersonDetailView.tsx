import { GridView } from "@/views/video/GridView";
import type { ComponentProps } from "react";

/** person-detail. Read-only grid (context menu stripped to "Add to playlist" on cards;
 *  background menu disabled entirely). Shares the search/sort header and DnD scaffolding
 *  with library views via [GridView](./GridView.tsx) but renders in readOnly mode. */
export function PersonDetailView(
  props: Omit<ComponentProps<typeof GridView>, "view"> & {
    view: Extract<ComponentProps<typeof GridView>["view"], { kind: "person-detail" }>;
  },
) {
  return <GridView {...props} />;
}
