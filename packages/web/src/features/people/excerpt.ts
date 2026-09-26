/**
 * Layout of a person's excerpt of one meeting: their own segments always
 * shown, and the other speakers' segments between them folded into gaps that
 * the reader can open a few at a time, from either edge.
 */

/** How many segments one click on "previous"/"next" reveals. */
export const REVEAL_STEP = 5;

/** Where a gap sits relative to the person's segments. */
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
  | { kind: "segment"; index: number; own: boolean }
  | { kind: "gap"; gap: Gap };

/**
 * The excerpt in reading order. `own` are indices (into a transcript of
 * `total` segments, in any order) of the person's segments; `reveals` maps a
 * gap's key to how much of it is open. Each gap's control sits where its
 * folded segments would be, so opened segments grow outward from it toward
 * the person's segments on either side. A fully opened gap keeps its control,
 * to fold it again.
 */
export function excerptItems(
  total: number,
  own: number[],
  reveals: ReadonlyMap<number, Reveal>,
): ExcerptItem[] {
  const owned = [...new Set(own)].sort((a, b) => a - b);
  const items: ExcerptItem[] = [];
  if (owned.length === 0) return items;

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
      items.push({ kind: "segment", index: i, own: false });
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
      items.push({ kind: "segment", index: i, own: false });
    }
  };

  pushGap(0, owned[0]!, "before");
  owned.forEach((index, i) => {
    items.push({ kind: "segment", index, own: true });
    const next = owned[i + 1];
    if (next != null) pushGap(index + 1, next, "between");
  });
  pushGap(owned[owned.length - 1]! + 1, total, "after");
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
