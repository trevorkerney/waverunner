import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** One running background job (src-tauri/src/jobs.rs). Presence in the list
 *  means running; a finished job simply drops out. */
export interface BackgroundJob {
  id: string;
  /** "waveform-preload" | "mb-prefetch-groups" | "mb-prefetch-releases" … */
  kind: string;
  /** Sidebar line: "preloading waveforms". */
  label: string;
  library_id: string | null;
  done: number;
  total: number;
  /** What's being worked on right now, for a byline. */
  detail: string | null;
}

/** The live list of running jobs — fetched once, then pushed on every
 *  change. Every subscriber sees the same list, so the sidebar and any
 *  progress window agree. */
export function useBackgroundJobs(): BackgroundJob[] {
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  useEffect(() => {
    let stale = false;
    invoke<BackgroundJob[]>("background_jobs")
      .then((j) => {
        if (!stale) setJobs(j);
      })
      .catch(() => {});
    const un = listen<BackgroundJob[]>("background-jobs", (e) => {
      if (!stale) setJobs(e.payload);
    });
    return () => {
      stale = true;
      un.then((fn) => fn());
    };
  }, []);
  return jobs;
}

export function cancelBackgroundJob(id: string): Promise<void> {
  return invoke("background_job_cancel", { id });
}
