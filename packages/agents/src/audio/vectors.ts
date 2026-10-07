// Arithmetic on voiceprints. Every voiceprint here is L2-normalized, so
// cosine similarity is a dot product, and a centroid is the normalized mean.

export type Vector = Float32Array;

/** `v` scaled to unit length (a zero vector stays zero). */
export function normalize(v: Vector): Vector {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n === 0 ? new Float32Array(v.length) : v.map((x) => x / n);
}

/** Cosine similarity of two unit vectors. */
export function similarity(a: Vector, b: Vector): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * The direction of the weighted mean of `vectors`, normalized; null for none.
 * Weights default to 1.
 */
export function centroid(
  vectors: readonly Vector[],
  weights?: readonly number[],
): Vector | null {
  if (vectors.length === 0) return null;
  const sum = new Float32Array(vectors[0]!.length);
  vectors.forEach((v, k) => {
    const w = weights?.[k] ?? 1;
    for (let i = 0; i < v.length; i++) sum[i]! += v[i]! * w;
  });
  return normalize(sum);
}

export interface TwoGroups {
  /** Each item's group: 0 (the heavier) or 1. */
  groups: (0 | 1)[];
  centroids: [Vector, Vector];
}

/**
 * Split `items` into the two groups whose voices differ most: weighted
 * 2-means on cosine similarity. Seeded with the heaviest item and the item
 * least like it, so the result is deterministic. Null with fewer than two
 * items, or when every item is the same voiceprint.
 */
export function twoMeans(
  items: readonly { voiceprint: Vector; weight: number }[],
): TwoGroups | null {
  if (items.length < 2) return null;
  const heaviest = items.reduce((a, b) => (b.weight > a.weight ? b : a));
  const farthest = items.reduce((a, b) =>
    similarity(b.voiceprint, heaviest.voiceprint) <
    similarity(a.voiceprint, heaviest.voiceprint)
      ? b
      : a,
  );
  if (farthest === heaviest) return null;

  let centroids: [Vector, Vector] = [heaviest.voiceprint, farthest.voiceprint];
  let groups: (0 | 1)[] = [];
  for (let iteration = 0; iteration < 50; iteration++) {
    const next = items.map((it) =>
      similarity(it.voiceprint, centroids[0]) >=
      similarity(it.voiceprint, centroids[1])
        ? 0
        : 1,
    );
    if (next.every((g, i) => g === groups[i])) break;
    groups = next;
    const mean = (g: 0 | 1) => {
      const members = items.filter((_, i) => groups[i] === g);
      return centroid(
        members.map((m) => m.voiceprint),
        members.map((m) => m.weight),
      );
    };
    const [a, b] = [mean(0), mean(1)];
    // An emptied group keeps its old centre; the next pass refills it or ends.
    centroids = [a ?? centroids[0], b ?? centroids[1]];
  }

  if (!groups.includes(0) || !groups.includes(1)) return null;
  const weightOf = (g: 0 | 1) =>
    items.reduce((n, it, i) => n + (groups[i] === g ? it.weight : 0), 0);
  if (weightOf(1) > weightOf(0)) {
    groups = groups.map((g) => (g === 0 ? 1 : 0));
    centroids = [centroids[1], centroids[0]];
  }
  return { groups, centroids };
}
