// Player keyboard shortcuts: a fixed set of actions, each with a default key
// and an optional user override. Overrides live in the settings table as one
// JSON object under `player_keybinds` ({ actionId: key }), edited from the
// Settings → Keybinds menu (staged behind Save like every dialog setting).
//
// Escape is deliberately not an action here — exit-fullscreen/close stays a
// fixed key so a rebind can never lock the user inside the player.

export type PlayerActionId =
  | "play_pause"
  | "seek_back"
  | "seek_forward"
  | "volume_up"
  | "volume_down"
  | "prev_frame"
  | "next_frame"
  | "fullscreen"
  | "mute";

export interface PlayerActionDef {
  id: PlayerActionId;
  label: string;
  defaultKey: string;
}

export const KEYBINDS_SETTING = "player_keybinds";

export const PLAYER_ACTIONS: PlayerActionDef[] = [
  { id: "play_pause", label: "Play / Pause", defaultKey: " " },
  { id: "seek_back", label: "Seek back 10s", defaultKey: "ArrowLeft" },
  { id: "seek_forward", label: "Seek forward 10s", defaultKey: "ArrowRight" },
  { id: "volume_up", label: "Volume up", defaultKey: "ArrowUp" },
  { id: "volume_down", label: "Volume down", defaultKey: "ArrowDown" },
  { id: "prev_frame", label: "Previous frame", defaultKey: "," },
  { id: "next_frame", label: "Next frame", defaultKey: "." },
  { id: "fullscreen", label: "Toggle fullscreen", defaultKey: "f" },
  { id: "mute", label: "Toggle mute", defaultKey: "m" },
];

/** Single-char keys match case-insensitively (f and F both toggle fullscreen). */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function parseKeybindOverrides(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function boundKey(overrides: Record<string, string>, action: PlayerActionDef): string {
  return overrides[action.id] ?? action.defaultKey;
}

// Runtime copy read by the App-level keydown handler on every press. Hydrated
// from settings on launch; refreshed when the settings dialog saves new binds.
let runtimeOverrides: Record<string, string> = {};

export function setRuntimeKeybinds(raw: string | null | undefined): void {
  runtimeOverrides = parseKeybindOverrides(raw);
}

export function actionForKey(key: string): PlayerActionId | null {
  const norm = normalizeKey(key);
  for (const a of PLAYER_ACTIONS) {
    if (normalizeKey(boundKey(runtimeOverrides, a)) === norm) return a.id;
  }
  return null;
}

/** Human-readable key name for the keybinds menu ("Space", "←", "K"). */
export function displayKey(key: string): string {
  switch (key) {
    case " ":
      return "Space";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}
