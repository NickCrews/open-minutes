// Kept apart from ./index, which pulls in the database layer: this runs in the
// browser as the /people search box filters on each keystroke.

/**
 * Whether `name` matches a search `query`: every whitespace-separated term of
 * the query must appear somewhere in the name, ignoring case and diacritics.
 * So "jane doe" finds "Jane Q. Doe" and "jose" finds "José". A blank query
 * matches everyone, while an anonymous person (null name) matches no real query.
 */
export function matchesName(name: string | null, query: string): boolean {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  if (!name) return false;
  const haystack = normalize(name);
  return terms.every((term) => haystack.includes(term));
}

function normalize(text: string): string {
  // NFD splits "é" into "e" plus a combining accent, which is then dropped.
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
