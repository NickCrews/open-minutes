/** Most suggestions offered for one query. */
export const SUGGESTION_LIMIT = 8;

/** Words a suggestion may extend past the one the query ends in. */
const MAX_EXTRA_WORDS = 2;

/** Words that make a suggestion read as cut off when they come last. */
const TRAILING_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "i",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "to",
  "uh",
  "um",
  "was",
  "we",
  "with",
  "you",
]);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/**
 * Search queries that complete `query`, drawn from transcript text: the word
 * the query ends in, finished, plus up to two words that follow it within the
 * same clause. Phrases spoken more often rank first, then shorter ones.
 */
export function suggestCompletions(
  texts: Iterable<string>,
  query: string,
  limit = SUGGESTION_LIMIT,
): string[] {
  const queryWords = words(query);
  if (queryWords.length === 0) return [];
  const head = queryWords.slice(0, -1);
  const last = queryWords[queryWords.length - 1]!;
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const clause of text.split(/[.!?;:,()"“”]+/)) {
      const ws = words(clause);
      for (let i = 0; i + queryWords.length <= ws.length; i++) {
        const end = i + head.length;
        if (!head.every((w, j) => ws[i + j] === w)) continue;
        if (!ws[end]!.startsWith(last)) continue;
        for (let extra = 0; extra <= MAX_EXTRA_WORDS; extra++) {
          const stop = end + 1 + extra;
          if (stop > ws.length) break;
          if (extra > 0 && TRAILING_STOPWORDS.has(ws[stop - 1]!)) continue;
          const phrase = ws.slice(i, stop).join(" ");
          counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
        }
      }
    }
  }
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.length - b.length || (a < b ? -1 : 1))
    .slice(0, limit)
    .map(([phrase]) => phrase);
}
