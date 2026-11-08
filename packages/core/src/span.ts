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

/**
 * Windows of `windowSecs` every `hopSecs` inside each span, in `spans`' order.
 * Windows stay inside their span: the last one in a span is aligned to its
 * end, so it may start less than `hopSecs` after the one before. A span no
 * longer than `windowSecs` gets one window covering all of it.
 */
export function slidingWindows(
  spans: readonly Span[],
  {
    windowSecs = 1.5,
    hopSecs = 0.75,
  }: { windowSecs?: number; hopSecs?: number } = {},
): Span[] {
  if (!(windowSecs > 0) || !(hopSecs > 0)) {
    throw new RangeError(
      `windowSecs (${windowSecs}) and hopSecs (${hopSecs}) must be positive.`,
    );
  }
  // Absorbs rounding in start + i * hop, so a window that ends at the span's
  // end isn't followed by an end-aligned copy of itself.
  const eps = 1e-9;
  const out: Span[] = [];
  for (const span of spans) {
    if (span.end - span.start <= windowSecs + eps) {
      out.push({ start: span.start, end: span.end });
      continue;
    }
    for (let i = 0; ; i++) {
      const start = span.start + i * hopSecs;
      if (start + windowSecs >= span.end - eps) {
        out.push({ start: span.end - windowSecs, end: span.end });
        break;
      }
      out.push({ start, end: start + windowSecs });
    }
  }
  return out;
}
