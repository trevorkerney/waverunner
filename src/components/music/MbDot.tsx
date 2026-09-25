/** The MusicBrainz match-state dot for grids and lists: a solid dot in the
 *  colour the entity's own page chip uses. `state` comes from the backend
 *  (`mb_state`): matched · partial · unmatched · ignored. Callers hide it
 *  under "Show MusicBrainz outside this page" off (pass null). */
const DOT: Record<string, { className: string; title: string }> = {
  matched: { className: "bg-emerald-400", title: "Matched to MusicBrainz" },
  partial: { className: "bg-amber-400", title: "Partly matched — something still unresolved" },
  unmatched: { className: "bg-red-400", title: "Not matched to MusicBrainz" },
  ignored: { className: "bg-muted-foreground/50", title: "Ignored — not counted" },
};

export function MbDot({ state, className = "" }: { state: string | null | undefined; className?: string }) {
  const d = state ? DOT[state] : undefined;
  if (!d) return null;
  return (
    <span
      title={d.title}
      className={`inline-block size-2 shrink-0 rounded-full align-middle ${d.className} ${className}`}
    />
  );
}
