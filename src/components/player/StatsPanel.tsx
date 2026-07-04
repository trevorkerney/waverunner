import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PlayerStats, InteractiveDebug } from "../../types";

// Stats-for-nerds: a small always-on-top readout polled while visible.
// Player numbers come from mpv properties; the interactive section is the
// engine's own bookkeeping (segment, story clock, branch-jump latency).

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-white/45">{label}</span>
      <span className="min-w-0 break-all text-white/90">{value}</span>
    </div>
  );
}

export function StatsPanel({ interactive }: { interactive: boolean }) {
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [debug, setDebug] = useState<InteractiveDebug | null>(null);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const s = await invoke<PlayerStats | null>("get_player_stats");
        if (live) setStats(s);
      } catch {
        // Player torn down mid-poll — panel just goes quiet.
      }
      if (interactive) {
        try {
          const d = await invoke<InteractiveDebug | null>("interactive_debug");
          if (live) setDebug(d);
        } catch {
          if (live) setDebug(null);
        }
      } else if (live) {
        setDebug(null);
      }
    };
    poll();
    const id = setInterval(poll, 500);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [interactive]);

  if (!stats) return null;
  const fps =
    stats.container_fps != null
      ? `${stats.container_fps.toFixed(3)}${stats.estimated_fps != null ? ` (est ${stats.estimated_fps.toFixed(2)})` : ""}`
      : "–";
  const res = stats.width != null && stats.height != null ? `${stats.width}×${stats.height}` : "–";
  const m = debug?.metrics;

  return (
    <div className="absolute left-3 top-12 z-30 w-80 max-w-[85%] select-text rounded-md bg-black/75 p-3 font-mono text-[11px] leading-4 shadow-lg ring-1 ring-white/15 backdrop-blur-sm">
      <p className="mb-1.5 font-semibold text-white">Stats for nerds</p>
      <div className="flex flex-col gap-0.5">
        <Row label="file" value={stats.file ?? "–"} />
        <Row label="codec" value={`${stats.video_codec ?? "–"} · ${res}`} />
        <Row label="fps" value={fps} />
        <Row label="dropped" value={`${stats.dropped_frames ?? 0}`} />
        <Row label="hwdec" value={stats.hwdec ?? "no"} />
        <Row label="cache" value={stats.cache_secs != null ? `${stats.cache_secs.toFixed(1)}s` : "–"} />
        <Row
          label="position"
          value={
            stats.position != null
              ? `${stats.position.toFixed(3)}s / ${stats.duration?.toFixed(3) ?? "?"}s`
              : "–"
          }
        />
      </div>
      {debug && (
        <>
          <p className="mb-1.5 mt-2.5 font-semibold text-white">Interactive engine</p>
          <div className="flex flex-col gap-0.5">
            <Row
              label="segment"
              value={`${debug.segmentId} [${fmtMs(debug.segmentStartMs)} → ${debug.segmentEndMs != null ? fmtMs(debug.segmentEndMs) : "EOF"}]`}
            />
            <Row label="story time" value={debug.storyMs != null ? fmtMs(debug.storyMs) : "–"} />
            <Row label="pending" value={debug.pendingTarget ?? (debug.choiceOpen ? "(choice open)" : "–")} />
            <Row label="decisions" value={`${debug.snapshotCount} (path ${debug.pathLen} segments)`} />
            <Row label="state" value={`${debug.persistentSet} persistent · ${debug.globalSet} global set`} />
            {m && (
              <Row
                label="jumps"
                value={`${m.jumps} (${m.seekJumps} seeks)${
                  m.lastLatencyMs != null ? ` · last ${m.lastFrom ?? "?"}→${m.lastTo ?? "?"} ${m.lastLatencyMs}ms` : ""
                }`}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
