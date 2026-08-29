import { invoke } from "@tauri-apps/api/core";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { ContextMenuItem } from "../ui/context-menu";

/** "Reveal in Explorer" context-menu item: opens the track's source folder
 *  with the file selected. Takes a resolver like LoveMenuItem so delegated
 *  menus (one menu, a ref naming the row under the pointer) read the CURRENT
 *  target at open time. */
export function RevealMenuItem({ resolve }: { resolve: () => number | null }) {
  const trackId = resolve();
  if (trackId == null) return null;
  return (
    <ContextMenuItem
      onClick={() =>
        invoke("reveal_track_file", { trackId }).catch((e) => toast.error(String(e)))
      }
    >
      <FolderOpen size={14} />
      Reveal in Explorer
    </ContextMenuItem>
  );
}
