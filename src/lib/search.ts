/**
 * Shared search scoring utilities.
 *
 * Used by dictionary search and notes search.
 */

/** Normalize a string for comparison: lowercase + trim. */
export function normalize(text: string): string {
  return text.toLowerCase().trim();
}

/**
 * Score a single field against a normalized query.
 * Returns: exact=1.0, startsWith=0.75, includes=0.5, none=0.
 */
export function scoreField(field: string, query: string): number {
  const normalized = normalize(field);
  if (normalized === query) return 1.0;
  if (normalized.startsWith(query)) return 0.75;
  if (normalized.includes(query)) return 0.5;
  return 0;
}

/** Score an array of strings, returning the best match. */
export function scoreArray(fields: string[], query: string): number {
  let best = 0;
  for (const f of fields) {
    const s = scoreField(f, query);
    if (s > best) best = s;
    if (best === 1.0) break;
  }
  return best;
}
