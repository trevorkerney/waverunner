import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { FadeIn, SkeletonRows, useSkeletonDelay } from "../ui/skeleton";
import { WindowedGrid } from "../WindowedGrid";

/** The match dialog's release picker: every release of the matched group,
 *  pick the one your files are. Same shape as the discography browser and
 *  for the same reason (see DiscographyBrowser): the backend lists up to
 *  400 releases for a group, each row is a dozen elements, and the filter
 *  box on top used to re-render the whole dialog per keystroke. Filters
 *  and the per-row country expansion live here; the parent keys this on
 *  the group id so another group starts unfiltered. */

/** One release inside a matched group — what the release picker lists. */
export interface GroupRelease {
  release_id: string;
  title: string;
  artist: string;
  date: string | null;
  track_count: number | null;
  country: string | null;
  /** Every release event's country — multi-region pressings carry several. */
  countries: string[];
  format: string | null;
  label: string | null;
  status: string | null;
  disambiguation: string | null;
}

/** Title, the date · flags · format line, and the id line. */
const ROW_ESTIMATE = 68;

/** MB joins a multi-medium format with "+", repeating the medium name each
 *  time — "Hybrid SACD (CD layer)+Hybrid SACD (SACD layer, 2 channels)+…"
 *  runs past the dialog. When every part shares the same base name, say it
 *  once and list the parentheticals: "Hybrid SACD (CD layer + SACD layer,
 *  2 channels + …)". Mixed formats ("CD+DVD") just get spaced. */
export function compactFormat(format: string): string {
  const parts = format.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return format;
  const split = parts.map((p) => {
    const m = /^(.*?)\s*\((.*)\)$/.exec(p);
    return m ? { base: m[1], detail: m[2] } : { base: p, detail: null };
  });
  const base = split[0].base;
  if (split.every((s) => s.base === base && s.detail)) {
    return `${base} (${split.map((s) => s.detail).join(" + ")})`;
  }
  return parts.join(" + ");
}

/** ISO country code → flag emoji, MusicBrainz-style. MB's special codes:
 *  XW = worldwide (globe), XE = Europe (EU flag). Rendering on Windows works
 *  through the country-flag polyfill font loaded at startup. */
function countryFlag(code: string): string {
  if (code === "XW") return "🌐";
  if (code === "XE") return "🇪🇺";
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** "US" → "🇺🇸 US" (flag-prefixed when one exists). */
function countryLabel(code: string | null): string | null {
  if (!code) return null;
  const flag = countryFlag(code);
  return flag ? `${flag} ${code}` : code;
}

/** Release year: the first four characters of MB's date (a bare "1984",
 *  "2006-03" and "2006-03-16" all yield one year). Undated releases have
 *  no year to filter on and drop out under any year pick. */
const yearOf = (r: { date: string | null }) => r.date?.slice(0, 4) ?? null;
const condense = (s: string) => s.toLowerCase().replace(/[\s-]/g, "");

const ReleaseRow = memo(function ReleaseRow({
  r,
  current,
  hasCurrent,
  expanded,
  held,
  applying,
  onApply,
  onToggleCountries,
}: {
  r: GroupRelease;
  /** This is the matched release. */
  current: boolean;
  /** SOME release is matched: a matched release must be explicitly let go
   *  of before another can take its place — switching is Unmatch release,
   *  then Apply. */
  hasCurrent: boolean;
  expanded: boolean;
  held: boolean;
  applying: boolean;
  onApply: (releaseId: string) => void;
  onToggleCountries: (releaseId: string) => void;
}) {
  const tail = [
    r.format ? compactFormat(r.format) : null,
    r.track_count != null ? `${r.track_count} tracks` : null,
    r.label,
    r.status && r.status !== "Official" ? r.status : null,
    r.disambiguation,
  ].filter(Boolean);
  const hasHead = !!r.date || r.countries.length > 0;
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-accent/50">
      <span className="min-w-0">
        <span className="block break-words text-sm">
          {r.title}
          {current && <span className="ml-1.5 text-[11px] text-emerald-400">current</span>}
        </span>
        <span className="block break-words text-xs text-muted-foreground">
          {r.date}
          {/* 3 flags, then "N more…" — a digital release can carry 100+
              release events, and past a few the flags stop being a signal.
              Expanding shows the full wall (per row). */}
          {r.countries.length > 0 && (
            <>
              {r.date ? " · " : ""}
              {(expanded ? r.countries : r.countries.slice(0, 3))
                .map((c) => countryLabel(c))
                .join(" ")}
              {r.countries.length > 3 && (
                <button
                  type="button"
                  onClick={() => onToggleCountries(r.release_id)}
                  className="ml-1 underline underline-offset-2 hover:text-foreground"
                >
                  {expanded ? "collapse" : `+ ${r.countries.length - 3} more…`}
                </button>
              )}
            </>
          )}
          {tail.map((p, j) => (hasHead || j > 0 ? ` · ${p}` : `${p}`)).join("")}
        </span>
        <span className="block break-all font-mono text-[10px] text-muted-foreground/70">
          {r.release_id}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void openUrl(`https://musicbrainz.org/release/${r.release_id}`)}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          view
        </button>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={held || hasCurrent}
          title={hasCurrent ? "Unmatch the release first" : undefined}
          onClick={() => onApply(r.release_id)}
        >
          {applying && <Spinner className="size-3" />}
          Apply
        </Button>
      </span>
    </div>
  );
});

export const GroupReleaseBrowser = memo(function GroupReleaseBrowser({
  releases,
  loading,
  mbBusy,
  currentId,
  held,
  applyingId,
  onApply,
}: {
  /** The group's releases, current one first; null until a list lands. */
  releases: GroupRelease[] | null;
  loading: boolean;
  mbBusy: boolean;
  /** The matched release, if any. */
  currentId: string | null;
  held: boolean;
  applyingId: string | null;
  onApply: (releaseId: string) => void;
}) {
  // Free text plus country/format/track-count/year dropdowns built from the
  // fetched list — a 77-release group (Brothers in Arms) is unfindable
  // without them. The text filter reaches the list one step behind, at
  // transition priority (see DiscographyBrowser); the dropdowns are clicks
  // and apply at once.
  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter);
  const [country, setCountry] = useState("all");
  const [format, setFormat] = useState("all");
  const [tracks, setTracks] = useState("all");
  const [year, setYear] = useState("all");
  // Rows whose full country list is expanded (same collapse MusicBrainz
  // itself uses).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleCountries = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const options = useMemo(() => {
    const rows = releases ?? [];
    return {
      countries: Array.from(
        new Set(rows.flatMap((r) => (r.countries.length > 0 ? r.countries : r.country ? [r.country] : []))),
      ).sort(),
      formats: Array.from(new Set(rows.flatMap((r) => (r.format ? [r.format] : [])))).sort(),
      tracks: Array.from(new Set(rows.flatMap((r) => (r.track_count != null ? [r.track_count] : [])))).sort(
        (a, b) => a - b,
      ),
      years: Array.from(new Set(rows.flatMap((r) => (yearOf(r) ? [yearOf(r)!] : [])))).sort(),
    };
  }, [releases]);

  // Free-text matching is spacing/dash-insensitive on both sides so a
  // catalog number typed “510130 2” finds “510 130 2”.
  const q = deferredFilter.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (releases ?? []).filter((r) => {
        if (country !== "all" && !(r.countries.includes(country) || r.country === country)) return false;
        if (format !== "all" && r.format !== format) return false;
        if (tracks !== "all" && String(r.track_count ?? "") !== tracks) return false;
        if (year !== "all" && yearOf(r) !== year) return false;
        if (!q) return true;
        const hay = [
          r.title,
          r.artist,
          r.date,
          r.label,
          r.format,
          r.status,
          r.disambiguation,
          r.country,
          r.countries.join(" "),
          r.track_count?.toString(),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const hayC = condense(hay);
        return q.split(/\s+/).every((tok) => hay.includes(tok) || hayC.includes(condense(tok)));
      }),
    [releases, country, format, tracks, year, q],
  );

  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  const applyStable = useCallback((id: string) => onApplyRef.current(id), []);
  const hasCurrent = !!currentId;
  const renderRow = useCallback(
    (r: GroupRelease) => (
      <ReleaseRow
        key={r.release_id}
        r={r}
        current={r.release_id === currentId}
        hasCurrent={hasCurrent}
        expanded={expanded.has(r.release_id)}
        held={held}
        applying={applyingId === r.release_id}
        onApply={applyStable}
        onToggleCountries={toggleCountries}
      />
    ),
    [currentId, hasCurrent, expanded, held, applyingId, applyStable, toggleCountries],
  );

  const showSkeleton = useSkeletonDelay(loading);
  const releasesKey = releases ? `${releases.length}:${releases[0]?.release_id ?? ""}` : "none";
  const filterKey = `${deferredFilter}|${country}|${format}|${tracks}|${year}`;

  return (
    <>
      {(releases?.length ?? 0) > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 min-w-40 flex-1 text-sm"
            placeholder="Filter — title, label, catalog number…"
          />
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="all">Any country</option>
            {options.countries.map((c) => (
              <option key={c} value={c}>
                {countryLabel(c) ?? c}
              </option>
            ))}
          </select>
          {/* Capped and ellipsized: a native select sizes to its widest
              option, and multi-medium formats can be a sentence long. The
              popup list still shows full text. */}
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            title={format === "all" ? undefined : compactFormat(format)}
            className="h-8 max-w-48 truncate rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="all">Any format</option>
            {options.formats.map((f) => (
              <option key={f} value={f}>
                {compactFormat(f)}
              </option>
            ))}
          </select>
          <select
            value={tracks}
            onChange={(e) => setTracks(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="all">Any track count</option>
            {options.tracks.map((n) => (
              <option key={n} value={String(n)}>
                {n} tracks
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="all">Any year</option>
            {options.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      )}
      {loading ? (
        showSkeleton ? (
          <div className="rounded-md border">
            <SkeletonRows rows={6} />
            {/* Nothing cached for this group: this is the wait the map's
                Prefetch releases step exists to remove. */}
            <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
              {mbBusy
                ? "MusicBrainz is busy — retrying…"
                : "Fetching this album's releases from MusicBrainz — Prefetch releases on the library map avoids this wait."}
            </p>
          </div>
        ) : null
      ) : (
        releases && (
          <FadeIn key={releasesKey} className="rounded-md border">
            {releases.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                MusicBrainz lists no releases in this group.
              </p>
            )}
            {releases.length > 0 && filtered.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">No releases match the filter.</p>
            )}
            <WindowedGrid
              items={filtered}
              renderItem={renderRow}
              estimateRowHeight={ROW_ESTIMATE}
              overscan={4}
              resetKey={`${releasesKey}|${filterKey}`}
              className="divide-y"
            />
          </FadeIn>
        )
      )}
    </>
  );
});
