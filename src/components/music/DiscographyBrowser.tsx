import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Search } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { FadeIn, SkeletonRows, useSkeletonDelay } from "../ui/skeleton";
import { WindowedGrid } from "../WindowedGrid";
import { MBID_RE, looksLikeMbRef } from "./mbRef";

/** The match dialog's discography browser: an unmatched album whose
 *  credited artist IS identified either is or isn't among that artist's
 *  release groups, so the dialog lists them (capped at 500 by the backend;
 *  Pearl Jam has 1,200+, mostly bootlegs) with a filter box on top.
 *
 *  A component of its own, and a memoized one, because the list is big and
 *  the dialog around it is bigger: with the filter's text as dialog state,
 *  every keystroke re-rendered 2,000 lines of dialog and re-reconciled 500
 *  rows (4,500 elements) before the character showed up — 100–200ms of
 *  main thread per key in the dev build (2026-09-26). Now a keystroke
 *  renders this component: the input at once, and the list at transition
 *  priority from the DEFERRED filter, so typing is never held behind the
 *  list catching up. The rows are windowed on top (WindowedGrid's list
 *  mode): ~20 mounted at a time, which is also what made the dialog open
 *  and close without a stall — a cached discography used to mount all 500
 *  rows in the open's own frame and unmount them in the close's. */

/** One release group of the album's matched artist. */
export interface ArtistGroup {
  group_id: string;
  title: string;
  artist: string;
  album_type: string | null;
  first_release_date: string | null;
  disambiguation: string | null;
}

/** A discography row plus which credited artist's page(s) it came from —
 *  the "All" view is a union across artists and says so per row. */
export type BrowseRow = ArtistGroup & { via: string[] };

/** A credited artist whose discography can be browsed. */
export interface BrowseTarget {
  name: string;
  mbid: string;
}

/** Title, type · date line, and the id line, plus the row's padding —
 *  what a row is before any of them are measured. */
const ROW_ESTIMATE = 68;

const GroupRow = memo(function GroupRow({
  g,
  showVia,
  held,
  applying,
  onApply,
}: {
  g: BrowseRow;
  /** Union view: say which credited artist's page listed it. */
  showVia: boolean;
  held: boolean;
  applying: boolean;
  onApply: (groupId: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-accent/50">
      <span className="min-w-0">
        <span className="block break-words text-sm">{g.title}</span>
        <span className="block break-words text-xs text-muted-foreground">
          {[
            g.album_type,
            g.first_release_date,
            g.disambiguation,
            showVia ? `via ${g.via.join(" & ")}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span className="block break-all font-mono text-[10px] text-muted-foreground/70">
          {g.group_id}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void openUrl(`https://musicbrainz.org/release-group/${g.group_id}`)}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          view
        </button>
        <Button size="sm" className="gap-1.5" disabled={held} onClick={() => onApply(g.group_id)}>
          {applying && <Spinner className="size-3" />}
          Apply
        </Button>
      </span>
    </div>
  );
});

export const DiscographyBrowser = memo(function DiscographyBrowser({
  groups,
  loading,
  total,
  targets,
  contextName,
  held,
  applyingId,
  searching,
  mbBusy,
  onApply,
  onSearchAll,
  onLookupRef,
  onSearchScoped,
}: {
  /** The merged, sorted discography; null until the first list lands. */
  groups: BrowseRow[] | null;
  loading: boolean;
  /** MusicBrainz's own count for the browsed artist(s), 0 = not known yet.
   *  Above the listed count it means the list is capped. */
  total: number;
  /** Whose discography is on show — one artist, or the union's members. */
  targets: BrowseTarget[];
  /** The album's context artist name, for the placeholder when no target
   *  has a name of its own. */
  contextName: string | null;
  /** Every decision waits: an apply in flight, or a matching pass. */
  held: boolean;
  /** The group whose apply is running here (never from the metadata page,
   *  where applies queue and close the dialog). */
  applyingId: string | null;
  /** A text search is in flight — the pasted-reference lookup shows it. */
  searching: boolean;
  mbBusy: boolean;
  onApply: (groupId: string) => void;
  /** "Not here? Search all of MusicBrainz." */
  onSearchAll: () => void;
  /** A MusicBrainz link or ID landed in the filter box: look it up directly. */
  onLookupRef: (text: string) => void;
  /** The filter found nothing listed: search the artist's catalogue for it. */
  onSearchScoped: (query: string) => void;
}) {
  const [filter, setFilter] = useState("");
  // The list follows the filter one step behind, at transition priority:
  // the keystroke's render shows the character with the list as it was,
  // and the re-filter lands right after — or is dropped for the next key.
  const deferredFilter = useDeferredValue(filter);
  const q = deferredFilter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!groups) return [];
    if (!q) return groups;
    return groups.filter((g) => g.title.toLowerCase().includes(q));
  }, [groups, q]);

  // The parent's apply handler is a fresh function every render; the rows
  // get one that never changes, so a parent render leaves them alone.
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  const applyStable = useCallback((id: string) => onApplyRef.current(id), []);
  const showVia = targets.length > 1;
  const renderRow = useCallback(
    (g: BrowseRow) => (
      <GroupRow
        key={g.group_id}
        g={g}
        showVia={showVia}
        held={held}
        applying={applyingId === g.group_id}
        onApply={applyStable}
      />
    ),
    [showVia, held, applyingId, applyStable],
  );

  // Skeleton after 500ms of a cold load (a cached list shows at once), and
  // a fade-in keyed by what arrived — the list itself, not its filtering,
  // so typing never re-fades it.
  const showSkeleton = useSkeletonDelay(loading && !groups);
  const groupsKey = groups ? `${groups.length}:${groups[0]?.group_id ?? ""}` : "none";

  const whose =
    targets.length > 1 ? "these artists" : `${targets[0]?.name ?? contextName ?? "this artist"}’s`;
  // "Showing N of M": the list is capped and a big catalogue (bootlegs,
  // mostly) is never fully listed, so the line always says how much of it
  // is on screen — and, while filtering, how much of the listed part.
  const listed = groups?.length ?? 0;
  const capped = total > listed;
  const n = (v: number) => v.toLocaleString();
  const countLine = !groups
    ? ""
    : q
      ? `Showing ${n(filtered.length)} of ${n(listed)} release groups${
          capped ? ` · ${n(total)} on MusicBrainz` : ""
        }`
      : capped
        ? `Showing ${n(listed)} of ${n(total)} release groups`
        : `${n(listed)} release group${listed === 1 ? "" : "s"}`;

  return (
    <>
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="h-8 w-full text-sm"
        placeholder={`Filter ${whose} releases — or paste a MusicBrainz link or ID…`}
      />
      {/* One fixed line under the box: the count on the left, the way out
          on the right. Always present, so nothing below it shifts. */}
      <div className="-mt-1.5 flex items-center justify-between gap-3 px-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{countLine}</span>
        <button
          type="button"
          onClick={onSearchAll}
          className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
        >
          Not here? Search all of MusicBrainz
        </button>
      </div>
      {/* A pasted link routes straight to the id lookup (which the search
          path already parses) — the consistency check still guards the
          Apply. */}
      {looksLikeMbRef(filter) && (
        <Button
          size="sm"
          variant="outline"
          className="self-start gap-1.5"
          disabled={searching}
          onClick={() => onLookupRef(filter)}
        >
          {searching ? <Spinner className="size-3" /> : <Search size={13} />}
          Look up pasted MusicBrainz {MBID_RE.test(filter.trim()) ? "ID" : "link"}
        </Button>
      )}
      {loading && !groups ? (
        showSkeleton ? (
          <div className="rounded-md border">
            <SkeletonRows rows={6} />
            {mbBusy && (
              <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                MusicBrainz is busy — retrying…
              </p>
            )}
          </div>
        ) : null
      ) : (
        groups && (
          <FadeIn key={groupsKey} className="rounded-md border">
            {groups.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                MusicBrainz lists nothing for {targets.length > 1 ? "these artists" : "this artist"}.
              </p>
            )}
            {/* The filter found nothing listed. With a capped catalogue
                that isn't "not on MusicBrainz" — hand off to a search
                scoped to the artist. */}
            {groups.length > 0 && q && filtered.length === 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
                <span>Nothing listed matches “{deferredFilter.trim()}”.</span>
                <button
                  type="button"
                  onClick={() => onSearchScoped(filter.trim())}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Search {targets.length > 1 ? "their" : `${targets[0]?.name ?? "the artist"}’s`}{" "}
                  releases on MusicBrainz for it
                </button>
              </div>
            )}
            <WindowedGrid
              items={filtered}
              renderItem={renderRow}
              estimateRowHeight={ROW_ESTIMATE}
              overscan={4}
              resetKey={`${groupsKey}|${deferredFilter}`}
              className="divide-y"
            />
          </FadeIn>
        )
      )}
    </>
  );
});
