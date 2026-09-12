import { useEffect, useState } from "react";
import { MetadataCenter, type CenterFocus } from "@/components/music/MetadataCenter";
import { VideoMetadataCenterPage } from "@/components/VideoMetadataCenter";
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
  // A fresh visit refetches — same as the modal reopening did.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    setReloadKey((k) => k + 1);
  }, [libraryId]);
  if (format === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (format !== "music") {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-2">
        <VideoMetadataCenterPage libraryId={libraryId} onChanged={onChanged} />
      </div>
    );
  }
  // pl-4/pr-0: the center backs out of the left padding for its full-width
  // rule and keeps the pane scrollbar flush right — same hosting the wizard
  // gives it.
  return (
    <div className="flex min-h-0 flex-1 flex-col pl-4 pr-0 pt-2">
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
