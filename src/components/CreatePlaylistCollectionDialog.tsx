import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { NameDialog } from "@/components/NameDialog";

interface CreatePlaylistCollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Exactly one of parent_playlist_id or parent_collection_id must be set. */
  parentPlaylistId: number | null;
  parentCollectionId: number | null;
  onCreated: (collectionId: number) => void;
}

/** Create a collection inside a playlist: the one name form, with its
 *  optional cover. */
export function CreatePlaylistCollectionDialog({
  open,
  onOpenChange,
  parentPlaylistId,
  parentCollectionId,
  onCreated,
}: CreatePlaylistCollectionDialogProps) {
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create collection"
      placeholder="Star Wars"
      submitLabel="Create"
      withCover
      onSubmit={async (name, coverSource) => {
        try {
          const id = await invoke<number>("create_playlist_collection", {
            title: name,
            parentPlaylistId,
            parentCollectionId,
          });
          if (coverSource) {
            try {
              await invoke("add_playlist_collection_cover", { collectionId: id, sourcePath: coverSource });
            } catch (e) {
              toast.error(`Collection created but cover failed: ${e}`);
            }
          }
          onCreated(id);
        } catch (e) {
          toast.error(String(e));
        }
      }}
    />
  );
}
