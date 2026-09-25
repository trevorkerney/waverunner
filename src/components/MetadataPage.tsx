import { useEffect, useRef, useState } from "react";
import { MetadataCenter, type CenterFocus } from "@/components/music/MetadataCenter";
import { VideoMetadataCenterPage } from "@/components/VideoMetadataCenter";
import { MatchRunStrip } from "@/components/LibraryRunUi";
import { Spinner } from "@/components/ui/spinner";

/** The metadata center as a page — the sidebar's Metadata row under every
 *  library (user's call, 2026-09-10: a page like Sources, not a modal).
 *  Music gets the MusicBrainz center, video the TMDB match report; both
 *  own their scrolling, so the host gives them the full content height
 *  rather than an outer scroller. */
export function MetadataPage({
  libraryId,
  format,
  focus,
  onChanged,
  onOpenAlbum,
  onOpenArtist,
}: {
  libraryId: string;
  /** null while the library list hasn't caught up (a library the wizard just
   *  created) — the page waits rather than guessing a center. */
  format: string | null;
  /** One-shot landing (an album's "N tracks unmatched" → its differ card). */
  focus: CenterFocus | null;
  onChanged: () => void;
  onOpenAlbum: (albumId: number, title: string, releaseId: number | null, trackId?: number) => void;
  onOpenArtist: (artistId: number, name: string) => void;
}) {
  // Switching libraries while mounted refetches. Not on mount: the center
  // fetches on its own mount, and bumping here too meant every arrival ran
  // its nine calls twice.
  const [reloadKey, setReloadKey] = useState(0);
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    setReloadKey((k) => k + 1);
  }, [libraryId]);
  // One-frame yield before the center mounts: its first commit is the
  // whole page (nav, map, dialogs), and mounting it inside the click's own
  // tick left the previous page on screen until it finished. Blank for a
  // frame, then the center — the same two-commit switch the grids use.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (format === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!mounted) return <div className="flex-1" />;
  if (format !== "music") {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-2">
        {/* A running pass's detail lives here (the sidebar line leads here).
            The music center renders its own, in its banner slot. */}
        <MatchRunStrip libraryId={libraryId} className="-mx-4 -mt-2 mb-2 border-b" />
        <VideoMetadataCenterPage libraryId={libraryId} onChanged={onChanged} />
      </div>
    );
  }
  // pl-4/pr-0: the center backs out of the left padding for its full-width
  // rule and keeps the pane scrollbar flush right. No top padding: the tabs
  // sit flush at the top, and the banners above them carry their own.
  return (
    <div className="flex min-h-0 flex-1 flex-col pl-4 pr-0">
      <MetadataCenter
        libraryId={libraryId}
        reloadKey={reloadKey}
        onChanged={onChanged}
        onOpenAlbum={onOpenAlbum}
        onOpenArtist={onOpenArtist}
        focus={focus}
      />
    </div>
  );
}
