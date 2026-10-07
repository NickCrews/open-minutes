/**
 * Short identifier for a body (eg "gbos"), used for `--body` CLI filters and
 * per-meeting work-directory names like `gbos-2026-03-23`.
 */
export function bodySlug(body: { name_short: string }): string {
  return body.name_short.toLowerCase();
}

/** The fields of a body {@link cohostsInTitle} reads. */
export interface NamedBody {
  id: number;
  name: string;
  name_short: string;
}

/**
 * The other bodies a joint meeting's title names, besides its host: for
 * "Girdwood Board of Supervisors and Girdwood Land Use Committee Joint
 * Meeting", hosted by the Board, the Land Use Committee.
 *
 * Only a title that says "joint" names co-hosts, since a regular meeting's
 * title can mention another body ("GBOS to hear Land Use Committee report"). A
 * body is named by its full name, in any case, or by its short name as a whole
 * word, in its own case ("GBOS/LUC Joint Meeting"). Longer names are matched
 * first and their text used up, so "Anchorage Assembly Community and Economic
 * Development Committee" doesn't also name the Anchorage Assembly.
 *
 * `candidates` should be the bodies that could plausibly meet with the host,
 * eg those in its jurisdiction; the host among them is ignored.
 */
export function cohostsInTitle<B extends NamedBody>(
  title: string,
  hostId: number,
  candidates: readonly B[],
): B[] {
  if (!/\bjoint\b/i.test(title)) return [];
  let rest = title.replace(/\s+/g, " ");
  const patterns = candidates.flatMap((body) => [
    ...(body.name.trim()
      ? [{ body, text: body.name.trim().replace(/\s+/g, " "), flags: "gi" }]
      : []),
    ...(body.name_short.trim().length >= 2
      ? [{ body, text: body.name_short.trim(), flags: "g" }]
      : []),
  ]);
  patterns.sort((a, b) => b.text.length - a.text.length);
  const named = new Set<B>();
  for (const { body, text, flags } of patterns) {
    const re = new RegExp(`(?<![\\w])${escapeRegExp(text)}(?![\\w])`, flags);
    if (!re.test(rest)) continue;
    named.add(body);
    rest = rest.replace(re, "\0");
  }
  return candidates.filter((b) => b.id !== hostId && named.has(b));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
