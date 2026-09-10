import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Per-library "write tags to files" opt-in (library_setting key
 *  `tag_writing` = "on", toggled in Library settings). Module-level store so
 *  every surface that offers a Write-to-files action — album and artist
 *  headers, track context menus — reads one cached answer and updates live
 *  when the setting flips. Off (the default) hides the action entirely:
 *  touching files is a choice the user makes once, per library. */

const cache = new Map<string, boolean>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export async function refreshTagWriting(libraryId: string): Promise<void> {
  if (inFlight.has(libraryId)) return;
  inFlight.add(libraryId);
  try {
    const ls = await invoke<Record<string, string>>("get_library_settings", { libraryId });
    cache.set(libraryId, ls["tag_writing"] === "on");
  } catch {
    cache.set(libraryId, false);
  } finally {
    inFlight.delete(libraryId);
  }
  notify();
}

/** Instant local flip (the settings dialog's save). */
export function setTagWritingLocal(libraryId: string, on: boolean) {
  cache.set(libraryId, on);
  notify();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Whether this library allows writing tags to its files. false until known. */
export function useTagWriting(libraryId: string | null | undefined): boolean {
  const value = useSyncExternalStore(subscribe, () =>
    libraryId ? cache.get(libraryId) ?? false : false,
  );
  useEffect(() => {
    if (libraryId && !cache.has(libraryId)) void refreshTagWriting(libraryId);
  }, [libraryId]);
  return value;
}
