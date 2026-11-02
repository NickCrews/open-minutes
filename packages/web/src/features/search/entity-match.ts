// Kept free of the database layer so it can be tested on its own.

/** How well a query names something; higher is better. */
export enum MatchStrength {
  /** Every query word starts a word of the names, eg "kel" for "Kyle Kelley". */
  WordPrefixes = 1,
  /** A name starts with the whole query, eg "girdwood b" for "Girdwood Board…". */
  Prefix = 2,
  /** A name is the whole query, eg "gbos" for the body named "GBOS". */
  Exact = 3,
}

/** Most people, meetings and bodies shown above the query suggestions. */
export const ENTITY_LIMIT = 5;

function normalize(text: string): string {
  // NFD splits "é" into "e" plus a combining accent, which is then dropped.
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * How strongly `query` names something called `names` (eg a body's full and
 * short name), or null if it doesn't. A query word found in the middle of a
 * word ("elley" in "Kelley") is too weak to count.
 */
export function matchStrength(
  names: readonly string[],
  query: string,
): MatchStrength | null {
  const q = normalize(query);
  const terms = q.match(WORD);
  if (!terms) return null;
  const normalized = names.map(normalize).filter(Boolean);
  if (normalized.includes(q)) return MatchStrength.Exact;
  if (normalized.some((name) => name.startsWith(q)))
    return MatchStrength.Prefix;
  const words = normalized.flatMap((name) => name.match(WORD) ?? []);
  return terms.every((term) => words.some((word) => word.startsWith(term)))
    ? MatchStrength.WordPrefixes
    : null;
}

export type Ranked<T> = { item: T; strength: MatchStrength };

/**
 * The best `limit` matches across kinds, strongest first. Ties keep the order
 * of `groups`, then each group's own order, so pass the kind that should win a
 * tie first.
 */
export function rankMatches<T>(
  groups: readonly (readonly Ranked<T>[])[],
  limit = ENTITY_LIMIT,
): T[] {
  return groups
    .flatMap((group, g) => group.map((match, i) => ({ ...match, g, i })))
    .sort((a, b) => b.strength - a.strength || a.g - b.g || a.i - b.i)
    .slice(0, limit)
    .map(({ item }) => item);
}
