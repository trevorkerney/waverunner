import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** True while MusicBrainz is answering 503s. The backend emits `mb-busy`
 *  each time a request enters its retry backoff (payload carries the wait);
 *  the flag holds through the announced wait plus slack for the retry
 *  itself, and clears once the beacons stop. */
export function useMbBusy(): boolean {
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    const unlisten = listen<{ retryInMs: number }>("mb-busy", (e) => {
      setBusy(true);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(
        () => setBusy(false),
        (e.payload.retryInMs ?? 5000) + 8000,
      );
    });
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      unlisten.then((fn) => fn());
    };
  }, []);
  return busy;
}

/** Spinner caption for MusicBrainz-backed loads: names the wait, and owns up
 *  when the wait is MusicBrainz shedding load rather than the app hanging. */
export function MbLoadingNote({ busy, label }: { busy: boolean; label: string }) {
  return (
    <p className="text-[11px] text-muted-foreground">
      {busy ? "MusicBrainz is busy — retrying…" : label}
    </p>
  );
}
