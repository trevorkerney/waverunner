/** Recognising a pasted MusicBrainz reference — a bare MBID or an entity
 *  URL. Shared by the match dialog and the browsers it hosts: every search
 *  path on the backend parses these, and the browse UIs use the test to
 *  offer a direct lookup the moment one lands in a filter box. */

export const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Does this look like a pasted MusicBrainz URL or bare MBID? */
export function looksLikeMbRef(text: string): boolean {
  const t = text.trim();
  return /musicbrainz\.org\/(release-group|release|artist|recording)\//.test(t) || MBID_RE.test(t);
}
