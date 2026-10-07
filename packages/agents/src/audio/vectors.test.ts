import { describe, expect, it } from "vitest";
import { sampledVoices } from "./testdata/voices";
import { centroid, normalize, similarity, twoMeans } from "./vectors";

const v = (...xs: number[]) => Float32Array.from(xs);

describe("normalize", () => {
  it("scales to unit length", () => {
    expect([...normalize(v(3, 4))]).toEqual([
      expect.closeTo(0.6),
      expect.closeTo(0.8),
    ]);
  });

  it("leaves a zero vector zero", () => {
    expect([...normalize(v(0, 0))]).toEqual([0, 0]);
  });
});

describe("similarity", () => {
  it("is 1 for the same direction, 0 for orthogonal, -1 for opposite", () => {
    expect(similarity(v(1, 0), v(1, 0))).toBe(1);
    expect(similarity(v(1, 0), v(0, 1))).toBe(0);
    expect(similarity(v(1, 0), v(-1, 0))).toBe(-1);
  });
});

describe("centroid", () => {
  it("is the normalized mean", () => {
    const c = centroid([v(1, 0), v(0, 1)])!;
    expect(c[0]).toBeCloseTo(Math.SQRT1_2);
    expect(c[1]).toBeCloseTo(Math.SQRT1_2);
  });

  it("weighs each vector by its weight", () => {
    const c = centroid([v(1, 0), v(0, 1)], [3, 1])!;
    expect(c[0]! / c[1]!).toBeCloseTo(3);
  });

  it("is null for no vectors", () => {
    expect(centroid([])).toBeNull();
  });
});

describe("twoMeans", () => {
  // Two real people's voices.
  const [aliceWindows, bobWindows] = sampledVoices().map((v) => v.windows);
  const alice = centroid(aliceWindows!)!;
  const bob = centroid(bobWindows!)!;
  /**
   * The voiceprint of a 6 s segment of `windows`, the nth: 4 windows spread
   * through it, as auditLabel takes them.
   */
  const segment = (windows: Float32Array[] | undefined, n: number) =>
    centroid([0, 3, 6, 9].map((k) => windows![n * 12 + k]!))!;

  it("separates two voices, the heavier one as group 0", () => {
    const items = [
      { voiceprint: segment(aliceWindows, 0), weight: 5 },
      { voiceprint: segment(bobWindows, 1), weight: 1 },
      { voiceprint: segment(aliceWindows, 2), weight: 4 },
      { voiceprint: segment(bobWindows, 3), weight: 2 },
      { voiceprint: segment(aliceWindows, 4), weight: 3 },
    ];
    const split = twoMeans(items)!;
    expect(split.groups).toEqual([0, 1, 0, 1, 0]);
    expect(similarity(split.centroids[0], alice)).toBeGreaterThan(0.8);
    expect(similarity(split.centroids[1], bob)).toBeGreaterThan(0.8);
  });

  it("puts the heavier group first even when it has fewer items", () => {
    const split = twoMeans([
      { voiceprint: segment(aliceWindows, 0), weight: 1 },
      { voiceprint: segment(aliceWindows, 1), weight: 1 },
      { voiceprint: segment(bobWindows, 2), weight: 10 },
    ])!;
    expect(split.groups).toEqual([1, 1, 0]);
  });

  it("splits one voice into two alike halves", () => {
    const split = twoMeans(
      [0, 1, 2, 3].map((n) => ({
        voiceprint: segment(aliceWindows, n),
        weight: 1,
      })),
    )!;
    expect(similarity(split.centroids[0], split.centroids[1])).toBeGreaterThan(
      0.8,
    );
  });

  it("can't split fewer than two items, or identical ones", () => {
    expect(twoMeans([])).toBeNull();
    expect(twoMeans([{ voiceprint: alice, weight: 1 }])).toBeNull();
    expect(
      twoMeans([
        { voiceprint: alice, weight: 1 },
        { voiceprint: alice, weight: 2 },
      ]),
    ).toBeNull();
  });
});
