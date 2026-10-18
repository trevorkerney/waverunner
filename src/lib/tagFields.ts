import { invoke } from "@tauri-apps/api/core";

/** The tag field registry (tag_fields.rs), as the editors see it: one
 *  entry per per-track field waverunner holds in its own tier of tags.
 *  Fetched once per session — the list is static. */
export interface TagFieldInfo {
  key: string;
  label: string;
  shape: "text" | "long_text" | "list" | "int";
  scope: "track" | "disc" | "release" | "album";
  /** No file tag at all (release membership, the identity token). */
  app_only: boolean;
  /** A change regroups: which album the track lands in, or which release. */
  grouping: boolean;
  /** Offered in the editors (ids and app-only fields are not). */
  editable: boolean;
  /** A MusicBrainz id. */
  id: boolean;
}

let cached: Promise<TagFieldInfo[]> | null = null;

export function loadTagFields(): Promise<TagFieldInfo[]> {
  if (!cached) {
    cached = invoke<TagFieldInfo[]>("get_tag_fields").catch((e) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}

/** Stored form → the editor's form value: lists are JSON arrays, everything
 *  else is the text itself. */
export function fromStored(shape: TagFieldInfo["shape"], stored: string | undefined): string | string[] {
  const raw = stored ?? "";
  if (shape === "list") {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map((s) => String(s)) : [];
    } catch {
      return [];
    }
  }
  return raw;
}

/** Stored form → one line for hints ("File tag: …"). */
export function displayStored(shape: TagFieldInfo["shape"], stored: string | undefined): string {
  const v = fromStored(shape, stored);
  return Array.isArray(v) ? v.join(", ") : v;
}

/** Form value → what apply_track_edits takes: an array for lists, a number
 *  (or "" = none) for ints, trimmed text otherwise. */
export function toEditValue(shape: TagFieldInfo["shape"], value: string | string[]): unknown {
  if (shape === "list") {
    return (Array.isArray(value) ? value : [value]).map((s) => s.trim()).filter(Boolean);
  }
  const text = Array.isArray(value) ? value.join("\n") : value;
  if (shape === "int") {
    const n = parseInt(text.trim(), 10);
    return Number.isNaN(n) || n <= 0 ? "" : n;
  }
  return shape === "long_text" ? text.trimEnd() : text.trim();
}

/** Two form values mean the same thing (so nothing is written). */
export function sameValue(shape: TagFieldInfo["shape"], a: string | string[], b: string | string[]): boolean {
  return JSON.stringify(toEditValue(shape, a)) === JSON.stringify(toEditValue(shape, b));
}
