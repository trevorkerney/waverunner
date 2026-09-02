import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";

/** Per-library settings, staged behind Save/Cancel (dialog settings are
 *  explicit commits, unlike in-app implicit prefs). First setting: the
 *  online-metadata opt-out. */
export function LibrarySettingsDialog({
  library,
  onOpenChange,
  onChanged,
}: {
  library: { id: string; name: string; format: string } | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: (libraryId: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [savedOnline, setSavedOnline] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!library) return;
    setLoaded(false);
    void (async () => {
      try {
        const ls = await invoke<Record<string, string>>("get_library_settings", {
          libraryId: library.id,
        });
        const on = ls["online_metadata"] !== "off";
        setOnline(on);
        setSavedOnline(on);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setLoaded(true);
      }
    })();
  }, [library]);

  const dirty = online !== savedOnline;

  async function save() {
    if (!library) return;
    setSaving(true);
    try {
      await invoke("set_library_setting", {
        libraryId: library.id,
        key: "online_metadata",
        value: online ? "on" : "off",
      });
      if (online && !savedOnline) {
        toast.success(
          library.format === "music"
            ? "Online metadata is on — run a matching pass from the metadata center to start identifying."
            : "Online metadata is on — open the metadata center to start matching.",
        );
      }
      onChanged?.(library.id);
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={library !== null} onOpenChange={(o) => { if (!o) onOpenChange(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Library settings — {library?.name}</DialogTitle>
        </DialogHeader>
        {!loaded ? (
          <div className="flex items-center justify-center py-6">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Online metadata</p>
              <p className="text-xs text-muted-foreground">
                {library?.format === "music"
                  ? "Identify albums and artists on MusicBrainz."
                  : "Identify movies and shows on TMDB and OMDB."}{" "}
                Off keeps this library fully offline: no matching passes, no provider sections in
                the metadata center.
              </p>
            </div>
            <Switch checked={online} onCheckedChange={setOnline} />
          </div>
        )}
        {/* Instant action, not a staged setting — Save/Cancel don't apply.
            Progress appears under the library's name in the sidebar and in
            the reattachable progress window. */}
        {loaded && library?.format === "music" && (
          <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Preload waveforms</p>
              <p className="text-xs text-muted-foreground">
                Compute and cache every track's waveform now instead of on first play. Runs in
                the background.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("waverunner:waveform-preload", {
                    detail: { libraryId: library.id },
                  }),
                );
                onOpenChange(false);
              }}
            >
              Preload now
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!dirty || saving} className="gap-1.5">
            {saving && <Spinner className="size-3" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
