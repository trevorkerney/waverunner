import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Per-library "hide MusicBrainz outside the metadata center" flag
 *  (library_setting key `hide_mb_outside_center` = "on", toggled from the
 *  center's Library map pane). Module-level store so every surface — album
 *  and artist chips, track context menus — reads one cached answer and
 *  updates live when the toggle flips, without prop-threading from App. */

const cache = new Map<string, boolean>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/** Re-read the flag from the backend (call after toggling the setting). */
export async function refreshMbHidden(libraryId: string): Promise<void> {
  if (inFlight.has(libraryId)) return;
  inFlight.add(libraryId);
  try {
    const ls = await invoke<Record<string, string>>("get_library_settings", { libraryId });
    cache.set(libraryId, ls["hide_mb_outside_center"] === "on");
  } catch {
    cache.set(libraryId, false); // unknowable → show, the default
  } finally {
    inFlight.delete(libraryId);
  }
  notify();
}

/** Instant local flip (the toggle's optimistic write). */
export function setMbHiddenLocal(libraryId: string, hidden: boolean) {
  cache.set(libraryId, hidden);
  notify();
}

/** The toggle: flip every subscriber at once, then persist. This store is
 *  the ONE source of truth for the flag — the metadata center reads it
 *  through useMbHidden like every other page, so a data refresh landing
 *  after the click can't overwrite the click with a stale read. */
export async function setMbHidden(libraryId: string, hidden: boolean): Promise<void> {
  setMbHiddenLocal(libraryId, hidden);
  await invoke("set_library_setting", {
    libraryId,
    key: "hide_mb_outside_center",
    value: hidden ? "on" : "off",
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Whether MB UI should hide on this library's pages. false until known —
 *  a brief flash of the chip beats hiding it for everyone while loading. */
export function useMbHidden(libraryId: string | null | undefined): boolean {
  const value = useSyncExternalStore(subscribe, () =>
    libraryId ? cache.get(libraryId) ?? false : false,
  );
  useEffect(() => {
    if (libraryId && !cache.has(libraryId)) void refreshMbHidden(libraryId);
  }, [libraryId]);
  return value;
}
