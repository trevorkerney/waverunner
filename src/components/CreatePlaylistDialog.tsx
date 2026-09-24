import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { NameDialog } from "@/components/NameDialog";

interface CreatePlaylistDialogProps {
  libraryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (playlistId: number) => void;
}

/** Create a playlist: the one name form, with its optional cover. */
export function CreatePlaylistDialog({
  libraryId,
  open,
  onOpenChange,
  onCreated,
}: CreatePlaylistDialogProps) {
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create playlist"
      placeholder="Cinematic Universes"
      submitLabel="Create"
      withCover
      onSubmit={async (name, coverSource) => {
        if (!libraryId) return;
        try {
          const id = await invoke<number>("create_playlist", { libraryId, title: name });
          if (coverSource) {
            // Non-fatal — the playlist exists; the cover can be retried
            // from its context menu.
            try {
              await invoke("add_playlist_cover", { playlistId: id, sourcePath: coverSource });
            } catch (e) {
              toast.error(`Playlist created but cover failed: ${e}`);
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
