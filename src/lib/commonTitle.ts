/** What a set of album titles share, and what each adds on top.
 *
 *  For the combine dialog: the shared head is the suggested title of the
 *  combined album, and each title's remainder is the suggested name of the
 *  disc that album brings — "Mellon Collie and the Infinite Sadness: Dawn to
 *  Dusk" + "…: Twilight to Starlight" gives the set's title and two disc
 *  names. Nothing here is ever applied on its own: the caller offers the
 *  result in editable fields.
 *
 *  Prefix vote. Every word-boundary prefix of every title is a candidate,
 *  scored (titles sharing it)² × (words in it): coverage wins hard, length
 *  breaks ties. Four of five box-set discs sharing a long name beat all five
 *  sharing a short one; a 3/2 split goes to the three unless the two share
 *  more than twice as much. Only a real head counts — trailing connectives,
 *  separators and "Vol."-style lead-ins are trimmed off a candidate, and a
 *  lone word covering under half of the shortest title that has it ("Live",
 *  from "Live at …" + "Live in …") is no title at all.
 */

/** A per-disc suffix on a title — "(Disc 1: …)", "[CD 2]", " - Disc 3",
 *  ", Vol. 2" — the sign that the album is one disc of a set. */
const DISC_SUFFIX =
  /\s*(?:[-–—:,]\s*)?[(\[]?\s*(?:disc|disk|cd|vol\.?|volume|part|pt\.?)\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|[ivx]+)\b[^)\]]*[)\]]?\s*$/i;

/** The title with its disc suffix cut, or null when it has none. */
export function stripDiscSuffix(title: string): string | null {
  if (!DISC_SUFFIX.test(title)) return null;
  const stripped = title.replace(DISC_SUFFIX, "").trim();
  return stripped && stripped !== title ? stripped : null;
}

/** A leading disc number on a remainder — "Disc 1: Dawn to Dusk", "CD2 -",
 *  "2." — the part a disc's own name never needs. A number word or a roman
 *  numeral only counts with a disc word in front ("One" can open a real
 *  name; "I" opens "I Am…"); a bare one- or two-digit number counts on its
 *  own, a longer one is a year ("2017 Stereo Mix"). */
const LEADING_DISC =
  /^(?:(?:disc|disk|cd|vol\.?|volume|part|pt\.?|no\.?|side)\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|[ivx]+)|\d{1,2})\b[\s:.\-–—,]*/i;

/** Tokens a title can't END on: articles, connectives, and the lead-ins
 *  that only introduce a number ("…, Vol." / "… - Disc"). */
const TAIL = new Set([
  "the", "a", "an", "and", "of", "for", "in", "on", "at", "to", "with", "from", "by",
  "vs", "feat", "featuring",
  "vol", "volume", "disc", "disk", "cd", "part", "pt", "no", "side", "chapter", "book", "tape",
]);

interface Tok {
  /** Lowercased, punctuation stripped — what two titles are compared on. */
  key: string;
  /** Where the token ends in the source string, so a prefix of k tokens
   *  maps back to the title's own spelling. */
  end: number;
}

function tokenize(title: string): Tok[] {
  const out: Tok[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title))) {
    const key = m[0].toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    // Pure punctuation ("-", "–", "/") isn't a word: skipped, so "Foo - Bar"
    // and "Foo: Bar" line up token for token.
    if (key) out.push({ key, end: m.index + m[0].length });
  }
  return out;
}

/** How many leading tokens survive once the tail is trimmed of what a
 *  title can't end on. */
function trimTail(toks: Tok[], k: number): number {
  while (k > 0 && TAIL.has(toks[k - 1].key)) k -= 1;
  return k;
}

function sharesHead(t: Tok[], head: Tok[], k: number): boolean {
  if (t.length < k) return false;
  for (let i = 0; i < k; i += 1) if (t[i].key !== head[i].key) return false;
  return true;
}

/** Trailing separators a cut leaves behind: "Sadness:" → "Sadness". */
const TRAILING_SEP = /[\s:;,\-–—/([]+$/;
const LEADING_SEP = /^[\s:;,\-–—/]+/;

/** A remainder, cleaned into a disc's own name: separators off both ends,
 *  wrapping brackets removed, a leading disc number dropped. */
function cleanRemainder(rest: string): string {
  let s = rest.replace(LEADING_SEP, "").replace(TRAILING_SEP, "").trim();
  if ((s.startsWith("(") && s.endsWith(")")) || (s.startsWith("[") && s.endsWith("]"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(LEADING_DISC, "").trim();
  return s.replace(TRAILING_SEP, "").trim();
}

export interface CommonTitle {
  /** The shared head, in the reference title's spelling when the reference
   *  shares it (else the first title that does); null when nothing
   *  qualifies. */
  common: string | null;
  /** Per input title, in order: what it adds beyond the shared head — a
   *  disc-name suggestion. A title that doesn't share the head keeps its
   *  whole (suffix-stripped) self; one that adds nothing gives "". */
  remainders: string[];
}

/** `reference`: the index of the keeper — its spelling is preferred for
 *  the shared head, and its suffix-stripped title is the fallback the
 *  caller wants when nothing is shared. */
export function commonTitle(titles: string[], reference = 0): CommonTitle {
  const base = titles.map((t) => stripDiscSuffix(t) ?? t);
  const toks = base.map(tokenize);
  const n = titles.length;

  let best: { i: number; k: number; count: number; words: number; score: number } | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < n; i += 1) {
    for (let k = toks[i].length; k >= 1; k -= 1) {
      const kk = trimTail(toks[i], k);
      if (kk === 0) break; // shorter prefixes trim to nothing too
      const key = toks[i].slice(0, kk).map((t) => t.key).join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      const sharing = toks.map((t) => sharesHead(t, toks[i], kk));
      const count = sharing.filter(Boolean).length;
      if (count < 2) continue;
      const words = kk;
      if (words === 1) {
        // A lone word is a title only when it IS most of the shortest title
        // that has it — "Requiem" + "Requiem (Disc 2)" yes, "Live" no.
        const shortest = Math.min(...toks.filter((_, j) => sharing[j]).map((t) => t.length));
        if (shortest > 2) continue;
      }
      const score = count * count * words;
      if (
        !best ||
        score > best.score ||
        (score === best.score && (count > best.count || (count === best.count && words > best.words)))
      ) {
        best = { i, k: kk, count, words, score };
      }
    }
  }

  if (!best) {
    return { common: null, remainders: base.map((t) => cleanRemainder(t)) };
  }
  const head = toks[best.i];
  const k = best.k;
  const sharing = toks.map((t) => sharesHead(t, head, k));
  const ref = sharing[reference] ? reference : sharing.indexOf(true);
  const common = base[ref].slice(0, toks[ref][k - 1].end).replace(TRAILING_SEP, "").trim();
  const remainders = base.map((t, j) => {
    if (!sharing[j]) return cleanRemainder(t);
    // Cut from the ORIGINAL title: the suffix stripper takes "- Disc 1:
    // Dawn" whole, and the "Dawn" is exactly the disc's name.
    const cut = t.slice(0, toks[j][k - 1].end);
    const src = titles[j].startsWith(cut) ? titles[j] : t;
    return cleanRemainder(src.slice(cut.length));
  });
  return { common: common || null, remainders };
}
