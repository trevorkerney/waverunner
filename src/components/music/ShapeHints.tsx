import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Layers, RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ShapeHintLite } from "@/types";
import { MbDot } from "./MbDot";

/** Shape hints — albums that look like ONE album (music_shape.rs). The
 *  scanner groups by tags; a box ripped per film, a compilation whose files
 *  name each track's group as ALBUMARTIST, a two-disc set tagged "(CD1)" /
 *  "(CD2)" land as several albums. The detector runs at the end of every
 *  scan and the Albums page shows what it found: a banner with a count, a
 *  pill on every member card (both from the grid payload, see
 *  EntriesResponse.shape_hints), and this review list. Every hint is a
 *  suggestion — Combine opens the ordinary combine dialog with the group
 *  picked and the mode set, nothing is chosen for you (not even the keeper),
 *  and "Keep apart" is a standing no for exactly that group. */

export interface ShapeMember {
  album_id: number;
  title: string;
  /** The credit line as the card shows it. */
  credit: string;
  /** The same credit, one entry per name, each linkable when it has a page. */
  credits: { name: string; artist_id: number | null }[];
  /** Folder leaf — tells same-titled members apart. */
  folder: string;
  year: string | null;
  track_count: number;
  mb_state: string | null;
}

/** The review list's form: a hint with its members hydrated. */
export interface ShapeHint extends ShapeHintLite {
  folder: string;
  members: ShapeMember[];
}

export interface ShapeHints {
  hints: ShapeHint[];
  /** Groups kept apart earlier that the detector still finds. */
  dismissed: number;
}

export const KIND_LABEL: Record<string, string> = {
  split_folder: "Split by tags",
  discs: "Discs of one set",
  editions: "Editions",
};

export function fetchShapeHints(libraryId: string): Promise<ShapeHints> {
  return invoke<ShapeHints>("get_album_shape_hints", { libraryId });
}

/** The pill on a member card: how many albums the hint joins. Amber like
 *  the "needs a look" vocabulary elsewhere; the hover text says why. */
export function ShapeHintPill({ size, reason, onClick }: { size: number; reason: string; onClick: () => void }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      title={`Looks like one album with ${size - 1} ${size - 1 === 1 ? "other" : "others"} — ${reason}. Click to review.`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="ml-1.5 inline-flex -translate-y-px cursor-pointer items-center gap-0.5 rounded-full border border-primary/50 px-1.5 align-middle text-[10px] font-normal text-primary hover:bg-primary/15"
    >
      <Layers size={10} />
      {size}
    </span>
  );
}

/** The strip above the Albums grid: one line and a Review button, in the
 *  pending-work strip's palette and height (user's call, 2026-10-18). */
export function ShapeHintsBanner({ count, onReview }: { count: number; onReview: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-md border border-primary/25 bg-primary/5 px-3 py-1.5">
      <Layers size={13} className="shrink-0 text-primary" />
      <p className="min-w-0 flex-1 truncate text-xs">
        {count} suggested {count === 1 ? "combine" : "combines"}
      </p>
      <Button size="sm" variant="outline" className="h-6 shrink-0 gap-1.5 px-2 text-xs" onClick={onReview}>
        Review
      </Button>
    </div>
  );
}

/** A clickable name inside a truncating line. Not a <button>: Chromium
 *  lays a button out as an atomic inline-block whatever its display, and
 *  a truncating line elides an atomic box WHOLE — a credit that ran past
 *  the line vanished into the "…" and took the dot behind it with it
 *  (2026-10-18). A span is text, so the ellipsis clips inside the name.
 *  role="link" gets the pointer from App.css's base rule. */
function InlineLink({ className, onClick, children }: { className: string; onClick: () => void; children: ReactNode }) {
  return (
    <span
      role="link"
      tabIndex={0}
      className={className}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </span>
  );
}

/** One hint in the review list. */
function HintCard({
  hint,
  busy,
  highlighted,
  onCombine,
  onDismiss,
  onOpenAlbum,
  onOpenArtist,
}: {
  hint: ShapeHint;
  busy: boolean;
  /** The card a pill click asked for: outlined in the pill's primary gold
   *  for a moment, then fades back. */
  highlighted?: boolean;
  onCombine: (hint: ShapeHint) => void;
  onDismiss: (hint: ShapeHint) => void;
  onOpenAlbum?: (albumId: number, title: string) => void;
  onOpenArtist?: (artistId: number, name: string) => void;
}) {
  const link = "rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  // The folder column only earns its space when it tells members apart; a
  // split folder's members all share one, and that one goes in the header.
  const folders = new Set(hint.members.map((m) => m.folder));
  const sharedFolder = folders.size === 1 ? hint.members[0]?.folder : null;
  return (
    <div
      data-hint-key={hint.key}
      className={`rounded-md border transition-colors duration-700 ${highlighted ? "border-primary/60" : ""}`}
    >
      <div className="flex items-start gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
            {KIND_LABEL[hint.kind] ?? hint.kind}
            <span
              className={`rounded-full border px-1.5 text-[10px] font-normal ${
                hint.confidence === "high"
                  ? "border-emerald-500/40 text-emerald-300"
                  : "border-primary/40 text-primary"
              }`}
            >
              {hint.confidence === "high" ? "likely" : "possible"}
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              {hint.mode === "merge" ? "one track list" : "separate releases"}
              {hint.title ? ` · titled “${hint.title}”` : ""}
              {hint.album_artist ? ` · as ${hint.album_artist}` : ""}
              {hint.disc_map && hint.disc_map.length > 0 ? " · discs renumbered" : ""}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {hint.reason}
            {sharedFolder && (
              <>
                {" · "}
                <span className="font-mono text-[11px]" title="Folder">
                  {sharedFolder}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={busy} onClick={() => onCombine(hint)}>
            <Layers size={12} />
            {hint.mode === "merge" ? "Merge…" : "Separate releases…"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" disabled={busy} onClick={() => onDismiss(hint)}>
            Dismiss
          </Button>
        </div>
      </div>
      {/* The list's inset reads as the rows' 12px side padding top and
          bottom: 6px here + the row's 4px + the text line's own leading
          lands the glyphs 12px from the border (user's call, 2026-10-18).
          The rows themselves stay tight. */}
      <ul className="border-t py-1.5">
        {hint.members.map((m) => (
          <li key={m.album_id} className="px-3 py-1 text-xs">
            {/* Line one: title · credits, track count, year. A differing
                folder — the one place the user finds folder names useful,
                a box's disc subfolders — gets a line of its own underneath
                rather than a column that fights the title (user's call,
                2026-10-18, after two rounds of the column cutting titles). */}
            <div className="flex items-baseline gap-2">
              {/* The title and each credited name open their pages (user's
                  call, 2026-10-18); a name without a page stays plain. */}
              <span className="min-w-0 flex-1 truncate" title={`${m.title}${m.credit ? ` · ${m.credit}` : ""}`}>
                {onOpenAlbum ? (
                  <InlineLink className={`text-foreground ${link}`} onClick={() => onOpenAlbum(m.album_id, m.title)}>
                    {m.title}
                  </InlineLink>
                ) : (
                  <span className="text-foreground">{m.title}</span>
                )}
                {m.credits.length > 0 ? (
                  <span className="text-muted-foreground">
                    {" · "}
                    {m.credits.map((c, i) => (
                      <span key={`${c.name}-${i}`}>
                        {i > 0 && " · "}
                        {c.artist_id != null && onOpenArtist ? (
                          <InlineLink className={link} onClick={() => onOpenArtist(c.artist_id!, c.name)}>
                            {c.name}
                          </InlineLink>
                        ) : (
                          c.name
                        )}
                      </span>
                    ))}
                  </span>
                ) : (
                  m.credit && <span className="text-muted-foreground"> · {m.credit}</span>
                )}
                <MbDot state={m.mb_state} className="ml-1.5 -translate-y-px" />
              </span>
              <span className="w-16 shrink-0 text-right text-muted-foreground">
                {m.track_count} {m.track_count === 1 ? "track" : "tracks"}
              </span>
              <span className="w-10 shrink-0 text-right text-muted-foreground">{m.year ?? ""}</span>
            </div>
            {!sharedFolder && (
              <div className="truncate font-mono text-[11px] leading-snug text-muted-foreground" title={m.folder}>
                {m.folder}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The review list: every open hint, likely ones first. Fetches the
 *  hydrated hints itself when opened (the grid payload only carries ids),
 *  and again after each of its own actions. */
export function ShapeHintsDialog({
  open,
  onOpenChange,
  libraryId,
  onCombine,
  onChanged,
  onOpenAlbum,
  onOpenArtist,
  focusKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  libraryId: string | null;
  /** Opens the combine dialog on the hint's group (on top of this list). */
  onCombine: (hint: ShapeHint) => void;
  /** The hint a card's pill was clicked for: the list opens scrolled to
   *  that card and outlines it for a moment (user's call, 2026-10-18 — the
   *  pill used to open the combine dialog straight away). */
  focusKey?: string | null;
  /** Hints changed (dismissed, restored, recomputed) — the host refreshes
   *  the grid payload the banner and pills read. */
  onChanged: () => void;
  /** A member's title / credited name was clicked: the host navigates
   *  (and closes this list). */
  onOpenAlbum?: (albumId: number, title: string) => void;
  onOpenArtist?: (artistId: number, name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<ShapeHints | null>(null);
  const load = async () => {
    if (!libraryId) return;
    try {
      setData(await fetchShapeHints(libraryId));
    } catch (e) {
      toast.error(String(e));
    }
  };
  useEffect(() => {
    if (!open) return;
    void load();
    // A combine landing underneath refreshes the library — reload the list
    // so the merged group is gone when the dialog comes back.
    const on = () => void load();
    window.addEventListener("waverunner:library-rescanned", on);
    return () => window.removeEventListener("waverunner:library-rescanned", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, libraryId]);
  const hints = data?.hints ?? [];
  // The pill's card: once the list has loaded, scroll the body so the card
  // sits at its top (clamped — a short list doesn't move) and outline it
  // briefly. Once per open: a reload after a dismiss must not jump back.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  useEffect(() => {
    if (open) return;
    focusedRef.current = null;
    setFlashKey(null);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !focusKey || data === null || focusedRef.current === focusKey) return;
    const body = bodyRef.current;
    if (!body) return;
    const go = () => {
      const card = body.querySelector<HTMLElement>(`[data-hint-key="${CSS.escape(focusKey)}"]`);
      if (!card) return;
      focusedRef.current = focusKey;
      body.scrollTop += card.getBoundingClientRect().top - body.getBoundingClientRect().top;
      setFlashKey(focusKey);
      if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashKey(null), 1500);
    };
    // With the list already loaded from an earlier open this runs in the
    // same commit that opens the dialog — when the shell still holds the
    // content in a detached node (its slot renders a tick later). A scroll
    // there is lost. Laid out: scroll now; else on the first size the body
    // gets. Marked done only once the scroll has happened, so a reload
    // landing in between re-arms it.
    if (body.offsetHeight > 0) {
      go();
      return;
    }
    const ro = new ResizeObserver(() => {
      if (body.offsetHeight === 0) return;
      ro.disconnect();
      go();
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, [open, focusKey, data]);
  const run = async (label: string, job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await job();
      if (label) toast(label);
      await load();
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  // No toast (user's call, 2026-10-18): the card leaving the list is the
  // confirmation.
  const dismiss = (hint: ShapeHint) =>
    run("", () => invoke("dismiss_album_shape_hint", { libraryId, key: hint.key }));
  const restore = () =>
    run("", () => invoke<number>("restore_album_shape_hints", { libraryId }));
  const recompute = () =>
    run("", () => invoke<number>("refresh_album_shape_hints", { libraryId }));

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      {/* Static (modal rule): a long list scrolls in the body. */}
      <DialogContent size="2xl" height="xl">
        <DialogHeader>
          <DialogTitle>Suggested combines</DialogTitle>
          <DialogDescription>
            Albums that look like one album, found from titles, credits and folders at the last
            scan. Nothing here is applied on its own: Merge or Separate releases opens the
            combine dialog with the group picked, and you choose which album keeps its info.
          </DialogDescription>
        </DialogHeader>
        {/* -mr-4 / pr-4: the scroll region runs to the dialog's right edge
            so the bar rides it; the gutter is reserved either way, so a
            list that stops needing the bar doesn't shift sideways. */}
        <DialogBody
          ref={bodyRef}
          className="-ml-1 -mr-4 flex flex-col gap-3 overflow-x-hidden pl-1 pr-4 [scrollbar-gutter:stable]"
        >
          {data === null ? null : hints.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing looks split right now.
              {data.dismissed > 0 ? ` ${data.dismissed} dismissed.` : ""}
            </p>
          ) : (
            hints.map((h) => (
              <HintCard
                key={h.key}
                hint={h}
                busy={busy}
                highlighted={flashKey === h.key}
                onCombine={onCombine}
                onDismiss={dismiss}
                onOpenAlbum={onOpenAlbum}
                onOpenArtist={onOpenArtist}
              />
            ))
          )}
        </DialogBody>
        <DialogFooter>
          {(data?.dismissed ?? 0) > 0 && (
            <Button variant="ghost" className="mr-auto text-xs text-muted-foreground" disabled={busy} onClick={restore}>
              Restore {data!.dismissed} dismissed
            </Button>
          )}
          <Button variant="ghost" className="gap-1.5" disabled={busy} onClick={recompute} title="Run the detector again now">
            {busy ? <Spinner className="size-3" /> : <RefreshCw size={13} />}
            Recompute
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
