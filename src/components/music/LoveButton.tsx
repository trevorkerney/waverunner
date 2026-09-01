import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Heart, HeartOff } from "lucide-react";
import { ContextMenuItem } from "../ui/context-menu";

// Session-wide loved state. Fetched rows carry a snapshot (`loved` on track
// queries); any toggle — heart button or context-menu item — lands in this
// override map and notifies every mounted control, so the surfaces never
// disagree without a refetch. Optimistic: reverts (and re-notifies) on a
// failed write.
const overrides = new Map<number, boolean>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function currentLoved(trackId: number, fallback: boolean): boolean {
  return overrides.get(trackId) ?? fallback;
}

export function setTrackLoved(trackId: number, loved: boolean): void {
  overrides.set(trackId, loved);
  notify();
  invoke("set_track_loved", { trackId, loved })
    .then(() => {
      // The write landed — surfaces showing loved AGGREGATES (the artists
      // grid's "N loved" subtitles and Most-loved order) refresh off this;
      // per-track hearts already update through the override store above.
      window.dispatchEvent(
        new CustomEvent("waverunner:loved-changed", { detail: { trackId } }),
      );
    })
    .catch(() => {
      overrides.set(trackId, !loved);
      notify();
    });
}

/** Live loved state for a track: the override when one exists, else the
 *  caller's fetched snapshot. Re-renders on any toggle anywhere. */
export function useLoved(trackId: number, fallback: boolean): boolean {
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
 * Heart toggle on track rows. Rendered as a bare icon (not a <button>) so it
 * can live inside rows that are themselves buttons.
 */
export function LoveButton({
  trackId,
  loved,
  reveal = "",
  className = "",
}: {
  trackId: number;
  loved: boolean;
  /** Host row's hover-reveal class for the unloved state, e.g. "group-hover/track:opacity-100". */
  reveal?: string;
  /** Always-applied extras (spacing etc.) — unlike `reveal`, survives the loved state. */
  className?: string;
}) {
  const on = useLoved(trackId, loved);
  return (
    <span
      role="button"
      aria-label={on ? "Unlove" : "Love"}
      title={on ? "Unlove" : "Love"}
      onClick={(e) => {
        e.stopPropagation();
        setTrackLoved(trackId, !on);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`shrink-0 cursor-pointer transition-colors ${className} ${
        on
          ? "text-rose-500 hover:text-rose-400"
          : `text-muted-foreground/60 opacity-0 hover:text-rose-400 ${reveal}`
      }`}
    >
      <Heart size={10} fill={on ? "currentColor" : "none"} />
    </span>
  );
}

/** "Add to Loved" / "Remove from Loved" context-menu item — the menu-shaped
 *  twin of LoveButton. Takes a resolver, not props: menu content mounts fresh
 *  per open and the resolver runs then, so delegated menus (one menu, a ref
 *  naming the row under the pointer) read the CURRENT target — direct props
 *  would freeze whatever the page's last render saw. */
export function LoveMenuItem({
  resolve,
}: {
  resolve: () => { id: number; loved: boolean } | null;
}) {
  const t = resolve();
  if (!t) return null;
  const on = currentLoved(t.id, t.loved);
  return (
    <ContextMenuItem onClick={() => setTrackLoved(t.id, !on)}>
      {on ? <HeartOff size={14} /> : <Heart size={14} />}
      {on ? "Remove from Loved" : "Add to Loved"}
    </ContextMenuItem>
  );
}
