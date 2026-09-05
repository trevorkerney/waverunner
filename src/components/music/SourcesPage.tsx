import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Disc3, Music2, Users, Layers } from "lucide-react";
import { Spinner } from "../ui/spinner";
import { Input } from "../ui/input";

/** Where each value came from. Every album and loose track, grouped by
 *  artist, against the three tiers the library resolves from: what the
 *  files' tags say, what MusicBrainz said when matched, and what the user
 *  changed by hand. The column furthest right with a value is the one the
 *  library shows. Read-only — a picture of the tiered store, nothing more. */

interface TierValue {
  tag: string | null;
  mb: string | null;
  user: string | null;
}
interface TierRelease {
  id: number;
  label: string | null;
  folder: string;
  is_default: boolean;
  declared_none: boolean;
  fields: Record<string, TierValue>;
}
interface TierRow {
  id: number;
  kind: "album" | "track";
  title: string;
  matched: boolean;
  pinned_releases: number;
  fields: Record<string, TierValue>;
  releases: TierRelease[];
}
interface TierGroup {
  artist_id: number | null;
  artist_title: string | null;
  artist_fields: Record<string, TierValue>;
  albums: TierRow[];
  loose_tracks: TierRow[];
}
interface TierMatrix {
  mb_enabled: boolean;
  groups: TierGroup[];
}

type Tier = "tag" | "mb" | "user";

const FIELD_ORDER = [
  "title",
  "artist_credits",
  "credits",
  "release_date",
  "album_type",
  "genres",
  "track_number",
  "disc_number",
  "mb_release_id",
  "label",
];
const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  artist_credits: "Artists",
  credits: "Artists",
  release_date: "Date",
  album_type: "Type",
  genres: "Genres",
  track_number: "Track",
  disc_number: "Disc",
  mb_release_id: "Release",
  label: "Label",
};

/** Stored text → display. Lists (credits, genres) are JSON arrays; MBIDs
 *  shorten to their first block (the full id sits in the hover title). */
function fmt(raw: string): string {
  if (raw === "") return "—";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw.slice(0, 8) + "…";
  }
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.length === 0 ? "—" : arr.join(" · ");
    } catch {
      /* not a list after all */
    }
  }
  return raw;
}

/** The tier the library shows for this field: user, else a non-empty MB
 *  value (an empty one is MB's "has none" marker), else tags. */
function winner(v: TierValue): Tier | null {
  if (v.user != null) return "user";
  if (v.mb != null && v.mb !== "") return "mb";
  if (v.tag != null) return "tag";
  return null;
}

/** Tiers hold different answers for this field — the rows worth a look. */
function disagrees(v: TierValue): boolean {
  const vals = [v.tag, v.mb, v.user].filter((x): x is string => x != null && x !== "");
  return new Set(vals).size > 1;
}

function rowDisagrees(fields: Record<string, TierValue>): boolean {
  return Object.values(fields).some(disagrees);
}

function fieldsInOrder(fields: Record<string, TierValue>): [string, TierValue][] {
  return FIELD_ORDER.filter((f) => f in fields).map((f) => [f, fields[f]]);
}

/** One tier's column for one row. Every column walks the SAME field list
 *  (the row's union, in FIELD_ORDER) so a field sits on one horizontal line
 *  across the tiers; a tier without that field leaves the line blank. The
 *  winning tier's value is bright, the others muted. */
function TierCell({
  entries,
  tier,
}: {
  entries: [string, TierValue][];
  tier: Tier;
}) {
  if (entries.length === 0) {
    return <div className="px-3 py-2 text-xs text-muted-foreground/40">—</div>;
  }
  const hasAny = entries.some(([, v]) => v[tier] != null);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
      {entries.map(([field, v]) => {
        const raw = v[tier];
        if (raw == null) {
          // Blank line: keeps the next field level with its siblings. The
          // first line of an empty column carries a dash so the column
          // doesn't read as unrendered.
          return (
            <div key={field} className="text-xs text-muted-foreground/40" aria-hidden>
              {hasAny ? " " : field === entries[0][0] ? "—" : " "}
            </div>
          );
        }
        const wins = winner(v) === tier;
        return (
          <div key={field} className="flex min-w-0 items-baseline gap-1.5 text-xs">
            <span className="w-11 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
              {FIELD_LABEL[field] ?? field}
            </span>
            <span
              className={`min-w-0 truncate ${wins ? "font-medium text-foreground" : "text-muted-foreground"}`}
              title={fmt(raw)}
            >
              {fmt(raw)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The row's field lines: every field any tier holds, in display order,
 *  narrowed to disagreements when that filter is on. */
function rowEntries(fields: Record<string, TierValue>, onlyDisagreeing: boolean): [string, TierValue][] {
  return fieldsInOrder(fields).filter(([, v]) => !onlyDisagreeing || disagrees(v));
}

export function SourcesPage({ libraryId }: { libraryId: string }) {
  const [matrix, setMatrix] = useState<TierMatrix | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState("");
  const [onlyDisagreeing, setOnlyDisagreeing] = useState(false);
  const [onlyEdited, setOnlyEdited] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (reloadKey === 0) setMatrix(null);
    invoke<TierMatrix>("get_tier_matrix", { libraryId })
      .then((m) => {
        if (!cancelled) setMatrix(m);
      })
      .catch((e) => {
        console.error("Failed to load sources:", e);
        if (!cancelled) setMatrix({ mb_enabled: false, groups: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, reloadKey]);

  // Scans and matches rewrite the tiers this page shows.
  useEffect(() => {
    const bump = () => setReloadKey((k) => k + 1);
    window.addEventListener("waverunner:library-rescanned", bump);
    return () => window.removeEventListener("waverunner:library-rescanned", bump);
  }, []);

  const groups = useMemo(() => {
    if (!matrix) return [];
    const q = filter.trim().toLowerCase();
    const keep = (r: TierRow) =>
      (!q || r.title.toLowerCase().includes(q)) &&
      (!onlyDisagreeing || rowDisagrees(r.fields)) &&
      (!onlyEdited || Object.values(r.fields).some((v) => v.user != null));
    return matrix.groups
      .map((g) => {
        const artistHit = !!q && (g.artist_title ?? "").toLowerCase().includes(q);
        return {
          ...g,
          albums: artistHit && !onlyDisagreeing && !onlyEdited ? g.albums : g.albums.filter(keep),
          loose_tracks:
            artistHit && !onlyDisagreeing && !onlyEdited ? g.loose_tracks : g.loose_tracks.filter(keep),
        };
      })
      .filter((g) => g.albums.length > 0 || g.loose_tracks.length > 0);
  }, [matrix, filter, onlyDisagreeing, onlyEdited]);

  if (matrix === null) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  const tiers: { key: Tier; label: string; hint: string }[] = [
    { key: "tag", label: "Tags", hint: "What the files say" },
    ...(matrix.mb_enabled
      ? [{ key: "mb" as Tier, label: "MusicBrainz", hint: "What the match said" }]
      : []),
    { key: "user", label: "Edits", hint: "What you changed" },
  ];
  const cols = `minmax(16rem,1.1fr) repeat(${tiers.length}, minmax(0,1fr))`;
  const total = matrix.groups.reduce((n, g) => n + g.albums.length + g.loose_tracks.length, 0);

  const renderRow = (r: TierRow) => (
    <div
      key={`${r.kind}-${r.id}`}
      className="grid items-start border-t border-border/60 hover:bg-accent/30"
      style={{ gridTemplateColumns: cols }}
    >
      <div className="flex min-w-0 items-start gap-2 px-3 py-2">
        {r.kind === "album" ? (
          <Disc3 size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
        ) : (
          <Music2 size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm" title={r.title}>
            {r.title}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {r.kind === "album" ? "album" : "loose track"}
            {r.matched && " · matched"}
            {r.pinned_releases > 0 &&
              ` · ${r.pinned_releases} release${r.pinned_releases === 1 ? "" : "s"} pinned`}
          </p>
        </div>
      </div>
      {(() => {
        const entries = rowEntries(r.fields, onlyDisagreeing);
        return tiers.map((t) => <TierCell key={t.key} entries={entries} tier={t.key} />);
      })()}
    </div>
  );

  // A multi-release album lists each release beneath it: the version's own
  // tag title and date, the release id its files carry vs. the pressing
  // pinned, and the label rename. Single-release albums say it all in the
  // album row already.
  const renderRelease = (rel: TierRelease, album: TierRow) => {
    const entries = rowEntries(rel.fields, onlyDisagreeing);
    return (
      <div
        key={`rel-${rel.id}`}
        className="grid items-start border-t border-border/40 bg-muted/10 hover:bg-accent/30"
        style={{ gridTemplateColumns: cols }}
      >
        <div className="flex min-w-0 items-start gap-2 py-1.5 pl-9 pr-3">
          <div className="min-w-0">
            <p className="truncate text-xs" title={rel.folder}>
              {rel.label ?? album.title}
              {rel.is_default && <span className="ml-1.5 text-[10px] text-muted-foreground">default</span>}
            </p>
            <p className="text-[10px] text-muted-foreground">
              release · {rel.folder}
              {rel.declared_none && " · no MB release"}
            </p>
          </div>
        </div>
        {tiers.map((t) => (
          <TierCell key={t.key} entries={entries} tier={t.key} />
        ))}
      </div>
    );
  };

  const renderAlbum = (r: TierRow) => (
    <div key={`album-${r.id}`}>
      {renderRow(r)}
      {r.releases.length > 1 && r.releases.map((rel) => renderRelease(rel, r))}
    </div>
  );

  return (
    <div className="px-6 pb-8">
      <div className="flex flex-wrap items-center gap-3 py-5">
        <Layers size={18} className="text-muted-foreground" />
        <h1 className="font-heading text-xl font-bold">Sources</h1>
        <span className="text-xs text-muted-foreground">
          {total} {total === 1 ? "item" : "items"} · the column furthest right with a value is what
          the library shows
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={onlyDisagreeing}
              onChange={(e) => setOnlyDisagreeing(e.target.checked)}
            />
            Only where tiers disagree
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlyEdited} onChange={(e) => setOnlyEdited(e.target.checked)} />
            Only edited
          </label>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by artist or title…"
            className="h-8 w-56 text-sm"
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {total === 0
            ? "Nothing stored yet — the tiers fill in on the next rescan and matching pass."
            : "Nothing matches the filter."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          {/* Column headings */}
          <div
            className="sticky top-0 z-10 grid border-b bg-background"
            style={{ gridTemplateColumns: cols }}
          >
            <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Item
            </div>
            {tiers.map((t) => (
              <div key={t.key} className="px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t.label}
                </p>
                <p className="text-[10px] text-muted-foreground/70">{t.hint}</p>
              </div>
            ))}
          </div>

          {groups.map((g) => (
            <div key={g.artist_id ?? "none"}>
              {/* Artist header — its own name across the tiers when stored */}
              <div
                className="grid items-start border-t bg-muted/30"
                style={{ gridTemplateColumns: cols }}
              >
                <div className="flex min-w-0 items-center gap-2 px-3 py-2">
                  <Users size={14} className="shrink-0 text-muted-foreground" />
                  <p className="truncate text-sm font-semibold">
                    {g.artist_title ?? "No artist"}
                  </p>
                  <span className="text-[10px] text-muted-foreground">
                    {g.loose_tracks.length > 0 &&
                      `${g.loose_tracks.length} loose track${g.loose_tracks.length === 1 ? "" : "s"}`}
                    {g.albums.length > 0 && g.loose_tracks.length > 0 && " · "}
                    {g.albums.length > 0 &&
                      `${g.albums.length} album${g.albums.length === 1 ? "" : "s"}`}
                  </span>
                </div>
                {(() => {
                  const entries = rowEntries(g.artist_fields, onlyDisagreeing);
                  return tiers.map((t) =>
                    entries.length > 0 ? (
                      <TierCell key={t.key} entries={entries} tier={t.key} />
                    ) : (
                      <div key={t.key} />
                    ),
                  );
                })()}
              </div>
              {g.loose_tracks.map(renderRow)}
              {g.albums.map(renderAlbum)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
