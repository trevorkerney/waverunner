import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton, useHandoff } from "@/components/ui/skeleton";
import { setTagWritingLocal } from "@/lib/tagWriting";

/** One setting row's stand-in while the settings load. */
function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <Skeleton className="h-5 w-9 rounded-full" />
    </div>
  );
}

/** Per-library settings, staged behind Save/Cancel (dialog settings are
 *  explicit commits, unlike in-app implicit prefs). Settings: the
 *  online-metadata opt-out, and (music) the tag-writing opt-in. */
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
  // Music only: may waverunner write tags into this library's files? Off by
  // default — touching files is a choice made once, per library.
  const [tagWriting, setTagWriting] = useState(false);
  const [savedTagWriting, setSavedTagWriting] = useState(false);
  const [saving, setSaving] = useState(false);
  // Skeleton rows after 500ms, then the hand-off.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { stage, skeletonSeen, shown, contentVisible } = useHandoff(loaded, bodyRef);

  useEffect(() => {
    if (!library) {
      setLoaded(false);
      return;
    }
    setLoaded(false);
    void (async () => {
      try {
        const ls = await invoke<Record<string, string>>("get_library_settings", {
          libraryId: library.id,
        });
        const on = ls["online_metadata"] !== "off";
        setOnline(on);
        setSavedOnline(on);
        const tw = ls["tag_writing"] === "on";
        setTagWriting(tw);
        setSavedTagWriting(tw);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setLoaded(true);
      }
    })();
  }, [library]);

  const dirty = online !== savedOnline || tagWriting !== savedTagWriting;

  async function save() {
    if (!library) return;
    setSaving(true);
    try {
      await invoke("set_library_setting", {
        libraryId: library.id,
        key: "online_metadata",
        value: online ? "on" : "off",
      });
      if (tagWriting !== savedTagWriting) {
        await invoke("set_library_setting", {
          libraryId: library.id,
          key: "tag_writing",
          value: tagWriting ? "on" : "off",
        });
        setTagWritingLocal(library.id, tagWriting);
      }
      if (online && !savedOnline) {
        toast.success(
          library.format === "music"
            ? "Online metadata is on — run a matching pass from the metadata center to start identifying."
            : "Online metadata is on — open Metadata to start matching.",
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

  const music = library?.format === "music";
  const rows = music ? 3 : 1;

  return (
    <Dialog open={library !== null} onOpenChange={(o) => { if (!o) onOpenChange(false); }}>
      {/* Static per format: 136 (frame) + rows of 88 with 16 between —
          video has the one setting, music three. */}
      <DialogContent height={`${(136 + 88 * rows + 16 * (rows - 1)) / 16}rem`}>
        <DialogHeader>
          <DialogTitle className="truncate">Library settings — {library?.name}</DialogTitle>
        </DialogHeader>
        <DialogBody ref={bodyRef} className="relative">
          {!shown && skeletonSeen && (
            <div
              className={`absolute inset-x-0 top-0 flex flex-col gap-4 transition-opacity duration-200 ${
                stage === "hidden" ? "" : "opacity-0"
              }`}
            >
              {Array.from({ length: rows }, (_, i) => (
                <RowSkeleton key={i} />
              ))}
            </div>
          )}
          {loaded && (
            <div
              className={`flex flex-col gap-4 transition-opacity duration-200 will-change-[opacity] ${
                contentVisible ? "opacity-100" : "opacity-0"
              }`}
            >
              <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Online metadata</p>
                  <p className="text-xs text-muted-foreground">
                    {music
                      ? "Identify albums and artists on MusicBrainz."
                      : "Identify movies and shows on TMDB and OMDB."}{" "}
                    Off keeps this library fully offline: no matching passes, no provider sections in
                    the metadata center.
                  </p>
                </div>
                <Switch checked={online} onCheckedChange={setOnline} />
              </div>
              {music && (
                <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Write tags to files</p>
                    <p className="text-xs text-muted-foreground">
                      Adds a Write-to-files action on albums, artists and tracks that pushes what
                      waverunner shows — your edits, else MusicBrainz — into the files' own tags,
                      MusicBrainz ids included. Always previewed, never automatic.
                    </p>
                  </div>
                  <Switch checked={tagWriting} onCheckedChange={setTagWriting} />
                </div>
              )}
              {/* Instant action, not a staged setting — Save/Cancel don't apply.
                  Progress appears under the library's name in the sidebar and in
                  the reattachable progress window. */}
              {music && library && (
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
            </div>
          )}
        </DialogBody>
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
