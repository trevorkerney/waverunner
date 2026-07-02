import { invoke } from "@tauri-apps/api/core";

// Subtitle styling lives in the settings table as sub_* keys and drives mpv's
// sub-* properties. Shared by the settings dialog (live apply while a video
// plays) and usePlayer (apply at playback start).

export const SUBTITLE_DEFAULTS = {
  /** Percent; 100 = mpv's native size. */
  sub_scale: "100",
  sub_bold: "false",
  /** Font family name; empty = player default (sans-serif). */
  sub_font: "",
  sub_color: "#ffffff",
  /** Outline thickness around glyphs, 0–8. */
  sub_border_size: "3",
  sub_border_color: "#000000",
  /** Percent opacity of the black box behind subtitles; 0 = none. */
  sub_back_opacity: "0",
  /** mpv sub-pos: vertical position in % of screen height, 100 = bottom edge. */
  sub_pos: "100",
  /** true = force these settings onto ASS/SSA subs that carry their own styling. */
  sub_ass_override: "false",
} as const;

export type SubtitleSettingKey = keyof typeof SUBTITLE_DEFAULTS;

export function subtitleSetting(settings: Record<string, string>, key: SubtitleSettingKey): string {
  const v = settings[key];
  return v == null || v === "" ? SUBTITLE_DEFAULTS[key] : v;
}

function clampNum(raw: string, lo: number, hi: number, fallback: number): number {
  const n = parseFloat(raw);
  return Number.isNaN(n) ? fallback : Math.max(lo, Math.min(hi, n));
}

function safeColor(raw: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
}

/** The mpv properties (name, value) the current settings map to. */
export function subtitleMpvProps(settings: Record<string, string>): Array<[string, string]> {
  const get = (k: SubtitleSettingKey) => subtitleSetting(settings, k);
  const scale = clampNum(get("sub_scale"), 50, 200, 100) / 100;
  const backOpacity = clampNum(get("sub_back_opacity"), 0, 100, 0);
  const backOn = backOpacity > 0;
  // mpv colors are "#AARRGGBB"; the background box is always black + alpha.
  const backAlpha = Math.round((backOpacity / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  const outlineSize = String(clampNum(get("sub_border_size"), 0, 8, 3));
  const outlineColor = safeColor(get("sub_border_color"), "#000000");
  return [
    ["sub-scale", scale.toFixed(2)],
    ["sub-bold", get("sub_bold") === "true" ? "yes" : "no"],
    ["sub-font", subtitleSetting(settings, "sub_font").trim() || "sans-serif"],
    ["sub-color", safeColor(get("sub_color"), "#ffffff")],
    // mpv ≥0.36 renamed border-* to outline-*; both are set (the caller ignores
    // per-property failures) so either vintage of libmpv picks its name up.
    ["sub-border-size", outlineSize],
    ["sub-outline-size", outlineSize],
    ["sub-border-color", outlineColor],
    ["sub-outline-color", outlineColor],
    ["sub-back-color", `#${backAlpha}000000`],
    // mpv ≥0.37 draws the back color only when the border style asks for a box
    // (older mpv keys the box off the alpha alone and rejects this property).
    ["sub-border-style", backOn ? "background-box" : "outline-and-shadow"],
    // At shadow-offset 0 the box hugs the glyphs; give it a little padding.
    // Reset when the box is off so the offset can't become a stray text shadow.
    ["sub-shadow-offset", backOn ? "2" : "0"],
    ["sub-pos", String(Math.round(clampNum(get("sub_pos"), 20, 100, 100)))],
    ["sub-ass-override", get("sub_ass_override") === "true" ? "force" : "scale"],
  ];
}

/** Push the style onto the live player. A closed player rejects — ignored. */
export async function applySubtitleStyleToPlayer(settings: Record<string, string>): Promise<void> {
  await Promise.all(
    subtitleMpvProps(settings).map(([name, value]) =>
      invoke("set_player_property", { name, value }).catch(() => {}),
    ),
  );
}
