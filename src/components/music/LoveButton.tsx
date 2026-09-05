import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Heart, HeartOff } from "lucide-react";
import { ContextMenuItem } from "../ui/context-menu";
import { LoveLevel } from "../../types";

// Session-wide heart state, two tiers ('liked' = rose outline, 'loved' =
// filled). Fetched rows carry a snapshot (`loved` on track queries); any
// change — heart click or context-menu item — lands in this override map and
// notifies every mounted control, so the surfaces never disagree without a
// refetch. Optimistic: reverts (and re-notifies) on a failed write.
const overrides = new Map<number, LoveLevel>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function currentLoved(trackId: number, fallback: LoveLevel): LoveLevel {
  return overrides.has(trackId) ? overrides.get(trackId)! : fallback;
}

/** The heart's click cycle: none → liked → loved → none. */
export function nextLevel(level: LoveLevel): LoveLevel {
  return level === null ? "liked" : level === "liked" ? "loved" : null;
}

export function setTrackLoved(trackId: number, level: LoveLevel): void {
  const hadOverride = overrides.has(trackId);
  const prev = overrides.get(trackId);
  overrides.set(trackId, level);
  notify();
  invoke("set_track_loved", { trackId, level })
    .then(() => {
      // The write landed — surfaces showing heart AGGREGATES (the artists
      // grid's counts and Most-loved order) refresh off this; per-track
      // hearts already update through the override store above.
      window.dispatchEvent(
        new CustomEvent("waverunner:loved-changed", { detail: { trackId } }),
      );
    })
    .catch(() => {
      if (hadOverride) overrides.set(trackId, prev ?? null);
      else overrides.delete(trackId);
      notify();
    });
}

/** Live heart state for a track: the override when one exists, else the
 *  caller's fetched snapshot. Re-renders on any change anywhere. */
export function useLoved(trackId: number, fallback: LoveLevel): LoveLevel {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return currentLoved(trackId, fallback);
}

/**
 * Heart on track rows — click cycles none → liked (outline) → loved (filled)
 * → none. Rendered as a bare icon (not a <button>) so it can live inside rows
 * that are themselves buttons.
 */
export function LoveButton({
  trackId,
  loved,
  reveal = "",
  className = "",
}: {
  trackId: number;
  loved: LoveLevel;
  /** Host row's hover-reveal class for the heartless state, e.g. "group-hover/track:opacity-100". */
  reveal?: string;
  /** Always-applied extras (spacing etc.) — unlike `reveal`, survives every state. */
  className?: string;
}) {
  const level = useLoved(trackId, loved);
  const label = level === null ? "Like" : level === "liked" ? "Love" : "Remove heart";
  return (
    <span
      role="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        setTrackLoved(trackId, nextLevel(level));
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`shrink-0 cursor-pointer transition-colors ${className} ${
        level !== null
          ? "text-rose-500 hover:text-rose-400"
          : `text-muted-foreground/60 opacity-0 hover:text-foreground ${reveal}`
      }`}
    >
      {/* Liked = outline only; a hair thicker than lucide's default 2 so the
          tiny hollow heart doesn't read as faint next to the filled one. */}
      <Heart
        size={10}
        fill={level === "loved" ? "currentColor" : "none"}
        strokeWidth={level === "liked" ? 2.5 : 2}
      />
    </span>
  );
}

/** Like / Love context-menu items — the menu-shaped twin of LoveButton, with
 *  direct access to either tier (no cycling through). Takes a resolver, not
 *  props: menu content mounts fresh per open and the resolver runs then, so
 *  delegated menus (one menu, a ref naming the row under the pointer) read
 *  the CURRENT target — direct props would freeze whatever the page's last
 *  render saw. */
export function LoveMenuItem({
  resolve,
}: {
  resolve: () => { id: number; loved: LoveLevel } | null;
}) {
  const t = resolve();
  if (!t) return null;
  const level = currentLoved(t.id, t.loved);
  return (
    <>
      <ContextMenuItem
        onClick={() => setTrackLoved(t.id, level === "liked" ? null : "liked")}
      >
        {level === "liked" ? <HeartOff size={14} /> : <Heart size={14} />}
        {level === "liked" ? "Remove from Liked" : "Like"}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => setTrackLoved(t.id, level === "loved" ? null : "loved")}
      >
        {level === "loved" ? <HeartOff size={14} /> : <Heart size={14} fill="currentColor" />}
        {level === "loved" ? "Remove from Loved" : "Love"}
      </ContextMenuItem>
    </>
  );
}
