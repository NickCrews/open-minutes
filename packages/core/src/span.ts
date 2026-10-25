// Spans such as [start, end) in seconds, and arithmetic on lists of them.
//
// A list of spans is "sorted" when its starts never decrease, and "disjoint"
// when no two spans overlap (spans that only share an endpoint don't). Each
// function says which of these it needs and which its result has.

/**
 * A span from [start, end) in seconds. Spans that share an endpoint are
 * adjacent: they neither overlap nor leave a gap between them.
 */
export interface Span {
  start: number;
  end: number;
}

/**
 * The parts of `spans` inside [from, to), clipped to it, in `spans`' order.
 * Spans that only touch the range are dropped. Takes spans in any order,
 * overlapping or not, and keeps whichever they are.
 */
export function clip(spans: readonly Span[], from: number, to: number): Span[] {
  return spans
    .filter((s) => s.end > from && s.start < to)
    .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }));
}

/**
 * The stretches of [from, to) that no span in `spans` covers, at least
 * `minSecs` long: between speech runs, the pauses. `spans` must be sorted;
 * they may overlap. The result is sorted and disjoint.
 */
export function gaps(
  spans: readonly Span[],
  from: number,
  to: number,
  minSecs: number,
): Span[] {
  const inside = clip(spans, from, to);
  const out: Span[] = [];
  let cursor = from;
  for (const r of inside) {
    if (r.start - cursor >= minSecs) out.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (to - cursor >= minSecs) out.push({ start: cursor, end: to });
  return out;
}

/**
 * Total length of `spans`, in any order. They must be disjoint, or the
 * overlaps are counted twice.
 */
export function totalSecs(spans: readonly Span[]): number {
  return spans.reduce((n, s) => n + (s.end - s.start), 0);
}

/**
 * The parts of `a` that no span in `b` covers. Both must be sorted; either
 * may overlap. When `a` is disjoint, so is the result, and it is sorted.
 */
export function subtract(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  let j = 0;
  for (const span of a) {
    let start = span.start;
    while (j < b.length && b[j]!.end <= start) j++;
    let k = j;
    while (k < b.length && b[k]!.start < span.end) {
      if (b[k]!.start > start) out.push({ start, end: b[k]!.start });
      start = Math.max(start, b[k]!.end);
      k++;
    }
    if (start < span.end) out.push({ start, end: span.end });
  }
  return out;
}

/**
 * Sort `spans` and join those that overlap, touch, or have a gap of at most
 * `maxGap` between them. Takes spans in any order, overlapping or not. The
 * result is sorted and disjoint.
 */
export function mergeSpans(spans: readonly Span[], maxGap: number): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start - last.end <= maxGap) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}
