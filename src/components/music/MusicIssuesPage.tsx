import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TriangleAlert, CircleCheck } from "lucide-react";
import { Spinner } from "../ui/spinner";
import { MusicScanIssue } from "../../types";

interface MusicIssuesPageProps {
  libraryId: string;
}

/** The strict scanner's "needs attention" report: files that failed the tag
 *  bar and were NOT imported. Fix the tags in a real tagger, then rescan. */
export function MusicIssuesPage({ libraryId }: MusicIssuesPageProps) {
  const [issues, setIssues] = useState<MusicScanIssue[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (reloadKey === 0) setIssues(null); // silent refetch after rescans
    invoke<MusicScanIssue[]>("get_music_scan_issues", { libraryId })
      .then((res) => {
        if (!cancelled) setIssues(res);
      })
      .catch((e) => {
        console.error("Failed to load scan issues:", e);
        if (!cancelled) setIssues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, reloadKey]);

  // A rescan rewrites the issue report this page displays.
  useEffect(() => {
    const onRescanned = () => setReloadKey((k) => k + 1);
    window.addEventListener("waverunner:library-rescanned", onRescanned);
    return () => window.removeEventListener("waverunner:library-rescanned", onRescanned);
  }, []);

  if (issues === null) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-24 text-muted-foreground">
        <CircleCheck size={36} />
        <p className="text-sm">Every scanned file passed the tag check.</p>
      </div>
    );
  }

  return (
    <div className="px-6 pb-8">
      <div className="flex items-center gap-2 py-5">
        <TriangleAlert size={18} className="text-amber-500" />
        <h1 className="font-heading text-xl font-bold">Needs attention</h1>
        <span className="text-sm text-muted-foreground">({issues.length})</span>
      </div>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        These files were skipped during the scan because required tags are missing or unreadable
        (album artist, album, title, track number). Fix them in a tagger like MusicBrainz Picard or
        Mp3tag, then rescan the library.
      </p>
      <div className="overflow-hidden rounded-md border">
        {issues.map((issue, i) => (
          <div
            key={`${issue.file_path}-${i}`}
            className={`flex flex-col gap-0.5 px-3 py-2 text-sm ${i > 0 ? "border-t" : ""}`}
          >
            <span className="break-all font-mono text-xs">{issue.file_path}</span>
            <span className="text-xs text-muted-foreground">{issue.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
