import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Music2, Plus, Search } from "lucide-react";

/** One artist field in the split dialog: a combobox over the library's existing
 *  artists, with an explicit "create new" escape hatch.
 *
 *  Two states. Empty, it's a select-shaped control that opens a menu; typing
 *  turns the menu into search results drawn as little profiles. Chosen, it
 *  collapses into that profile — the value is a decision, not free text, so it
 *  shouldn't keep looking editable. The X beside it (owned by the caller) is
 *  what returns it to empty. */

export interface ArtistChoice {
  id: number;
  name: string;
  image: string | null;
  release_count: number;
}

/** What a field holds once decided: an existing artist, or a name the user
 *  typed that doesn't exist yet. Nothing is created until the split runs. */
export interface PickedArtist {
  name: string;
  /** Absent for a not-yet-created artist. */
  id?: number;
  image?: string | null;
  releaseCount?: number;
  isNew?: boolean;
}

/** All three states of the field — empty, typing, chosen — share this so the
 *  row doesn't change height when an artist is picked. The height comes from
 *  the 28px avatar plus padding and border; the other states have no avatar
 *  and would otherwise sit shorter. */
const FIELD_BOX = "min-h-[38px] w-full rounded border border-input px-2 py-1 text-sm";

function Avatar({ image, size = 28 }: { image?: string | null; size?: number }) {
  return image ? (
    <img
      src={convertFileSrc(image)}
      alt=""
      draggable={false}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-full object-cover"
    />
  ) : (
    <span
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
    >
      <Music2 size={size * 0.5} />
    </span>
  );
}

export function ArtistPicker({
  value,
  onChange,
  contextArtistId,
  exclude,
  placeholder = "Select an artist…",
  autoFocus,
}: {
  value: PickedArtist | null;
  onChange: (v: PickedArtist | null) => void;
  /** Scopes the search to this artist's library, and excludes it. */
  contextArtistId: number | null;
  /** Names already chosen in sibling fields — never offered twice. */
  exclude: string[];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ArtistChoice[] | null>(null);
  const [creating, setCreating] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  // Close on any click outside, so the menu can't outlive its field.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // The menu is portalled to <body>, so it isn't inside the field — both
      // have to count as "inside" or clicking the menu would dismiss it.
      const t = e.target as Node;
      if (!boxRef.current?.contains(t) && !menuRef.current?.contains(t)) {
        commitIfCreating();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // The menu renders in a portal at fixed coordinates rather than inside the
  // field. The member list it sits in scrolls, and an absolutely-positioned
  // menu there gets clipped by that box AND counts toward its scroll height —
  // which put a scrollbar on a two-row list. Anchored here, it escapes both.
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const place = () => {
      const r = boxRef.current?.getBoundingClientRect();
      if (r) setAnchor({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    place();
    // Capture phase: the scroll happens on an ancestor, not on window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const search = (q: string) => {
    window.clearTimeout(timer.current);
    const trimmed = q.trim();
    // One character is enough. Artists really are named "M", "K", "!!!" — a
    // two-character floor makes those unreachable, and the query is a local
    // indexed LIKE returning at most 8 rows, so there's nothing to protect.
    if (trimmed.length < 1 || contextArtistId == null) {
      setResults(null);
      return;
    }
    const mine = ++seq.current;
    timer.current = window.setTimeout(async () => {
      try {
        const rows = await invoke<ArtistChoice[]>("search_artist_choices", {
          artistId: contextArtistId,
          query: trimmed,
          limit: 8,
        });
        if (seq.current === mine) setResults(rows);
      } catch {
        if (seq.current === mine) setResults([]);
      }
    }, 150);
  };

  const taken = new Set(exclude.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const options = (results ?? []).filter((r) => !taken.has(r.name.toLowerCase()));

  const choose = (c: ArtistChoice) => {
    onChange({ name: c.name, id: c.id, image: c.image, releaseCount: c.release_count });
    setOpen(false);
    setQuery("");
    setResults(null);
    setCreating(false);
  };

  /** A typed name becomes the value on Enter or on clicking away — the artist
   *  itself is only created when the split is applied. */
  const commitIfCreating = () => {
    if (!creating) return;
    const name = query.trim();
    if (name) onChange({ name, isNew: true });
    setCreating(false);
    setQuery("");
    setResults(null);
  };

  if (value) {
    // min-w-0: without it a flex item's min-width resolves to its content, so
    // a long artist name makes this row wider than its neighbours instead of
    // truncating.
    return (
      <div className={`flex min-w-0 flex-1 items-center gap-2 ${FIELD_BOX}`}>
        <Avatar image={value.image} />
        {/* leading-none on both: a 14px and an 11px line box centre at
            different heights otherwise, so the count rides above the name. */}
        <span className="min-w-0 truncate text-sm leading-none">{value.name}</span>
        {value.releaseCount != null && (
          <span className="shrink-0 text-[11px] leading-none text-muted-foreground">
            {value.releaseCount} {value.releaseCount === 1 ? "release" : "releases"}
          </span>
        )}
        <span className="flex-1" />
        {value.isNew && (
          // "matched on next pass": a new page isn't a dead-end stub — the
          // matching pass looks up every MBID-less artist and fetches an
          // image, so a famous name identifies itself minutes later.
          <span className="shrink-0 text-[11px] leading-none text-muted-foreground">
            new artist · matched on next pass
          </span>
        )}
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      {open ? (
        <input
          ref={inputRef}
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!creating) search(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (creating) commitIfCreating();
              else if (options.length === 1) choose(options[0]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setCreating(false);
              setOpen(false);
            }
          }}
          placeholder={creating ? "New artist name…" : "Type to search…"}
          className={`${FIELD_BOX} bg-transparent outline-none`}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${FIELD_BOX} flex items-center bg-transparent text-left text-muted-foreground hover:text-foreground`}
        >
          {placeholder}
        </button>
      )}

      {open && !creating && anchor && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", left: anchor.left, top: anchor.top, width: anchor.width }}
          className="z-[60] overflow-hidden rounded-md border border-border bg-popover shadow-md"
        >
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              setCreating(true);
              setResults(null);
            }}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <Plus size={14} className="text-muted-foreground" />
            Create new artist
          </button>

          {options.length > 0 && (
            <div className="max-h-64 overflow-y-auto border-t">
              {options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(o);
                  }}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent"
                >
                  <Avatar image={o.image} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{o.name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {o.release_count} {o.release_count === 1 ? "release" : "releases"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* The footer states what the empty menu is waiting for, rather than
              leaving a lone "create" option looking like the only choice. */}
          {options.length === 0 && (
            <p className="flex items-center gap-1.5 border-t px-2 py-1.5 text-[11px] text-muted-foreground">
              <Search size={12} />
              {query.trim().length < 1
                ? "Type to search existing artists"
                : results === null
                  ? "Searching…"
                  : "No matching artists"}
            </p>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
