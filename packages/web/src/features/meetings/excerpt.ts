/**
 * Layout of an excerpt of one meeting's transcript: a few pinned segments
 * always shown, and the segments between them folded into gaps that the reader
 * can open a few at a time, from either edge. What gets pinned is up to the
 * page: a person's segments on /people/:id, or a search hit to read around.
 */

/** How many segments one click on "previous"/"next" reveals. */
export const REVEAL_STEP = 5;

/** Where a gap sits relative to the pinned segments. */
export type GapPosition = "before" | "between" | "after";

/**
 * How much of one gap is open: `head` segments right after the segment above
 * it, and `tail` segments right before the segment below it.
 */
export type Reveal = { head: number; tail: number };

export type Gap = {
  /** Index of the gap's first segment; stable, so it keys the gap's `Reveal`. */
  key: number;
  position: GapPosition;
  /** Segments in the gap, open or not. */
  size: number;
  /** Segments still folded away. */
  hidden: number;
  /** Segments opened so far. */
  revealed: number;
};

export type ExcerptItem =
  | { kind: "segment"; index: number; pinned: boolean }
  | { kind: "gap"; gap: Gap };

/**
 * The excerpt in reading order. `pinned` are indices (into a transcript of
 * `total` segments, in any order) of the segments always shown; `reveals` maps a
 * gap's key to how much of it is open. Each gap's control sits where its
 * folded segments would be, so opened segments grow outward from it toward
 * the pinned segments on either side. A fully opened gap keeps its control,
 * to fold it again.
 */
export function excerptItems(
  total: number,
  pinned: number[],
  reveals: ReadonlyMap<number, Reveal>,
): ExcerptItem[] {
  const sorted = [...new Set(pinned)].sort((a, b) => a - b);
  const items: ExcerptItem[] = [];
  if (sorted.length === 0) return items;

  const pushGap = (from: number, to: number, position: GapPosition) => {
    const size = to - from;
    if (size <= 0) return;
    const reveal = reveals.get(from) ?? { head: 0, tail: 0 };
    // A gap before the first segment has nothing above it to grow from, and
    // one after the last has nothing below.
    let head = position === "before" ? 0 : Math.max(0, reveal.head);
    let tail = position === "after" ? 0 : Math.max(0, reveal.tail);
    if (head + tail >= size) {
      head = position === "before" ? 0 : size;
      tail = size - head;
    }
    for (let i = from; i < from + head; i++) {
      items.push({ kind: "segment", index: i, pinned: false });
    }
    items.push({
      kind: "gap",
      gap: {
        key: from,
        position,
        size,
        hidden: size - head - tail,
        revealed: head + tail,
      },
    });
    for (let i = to - tail; i < to; i++) {
      items.push({ kind: "segment", index: i, pinned: false });
    }
  };

  pushGap(0, sorted[0]!, "before");
  sorted.forEach((index, i) => {
    items.push({ kind: "segment", index, pinned: true });
    const next = sorted[i + 1];
    if (next != null) pushGap(index + 1, next, "between");
  });
  pushGap(sorted[sorted.length - 1]! + 1, total, "after");
  return items;
}

/** Indices of the segments an excerpt shows. */
export function visibleIndices(items: ExcerptItem[]): Set<number> {
  const visible = new Set<number>();
  for (const item of items) {
    if (item.kind === "segment") visible.add(item.index);
  }
  return visible;
}

/** Characters of lead-in a preview keeps before a query's first hit. */
export const PREVIEW_LEAD = 80;

/**
 * `text` cut to start a little before the first case-insensitive occurrence of
 * `query`, at a word boundary and marked with "…", so a clamped preview shows
 * the hit even when it's deep in a long segment. Unchanged when the hit is
 * already near the start, or there is none.
 */
export function previewText(text: string, query: string | undefined): string {
  const q = query?.trim().toLowerCase();
  if (!q) return text;
  const at = text.toLowerCase().indexOf(q);
  if (at <= PREVIEW_LEAD) return text;
  const space = text.indexOf(" ", at - PREVIEW_LEAD);
  const from = space === -1 || space >= at ? at : space + 1;
  return `…${text.slice(from)}`;
}
