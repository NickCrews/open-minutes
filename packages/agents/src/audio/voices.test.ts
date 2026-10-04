import { describe, expect, it } from "vitest";
import {
  centroid,
  changePoints,
  continuity,
  HOP_SEC,
  normalize,
  similarity,
  twoMeans,
  type VoiceWindow,
} from "./voices";

/** A unit vector near one axis: a stand-in for one person's voiceprint. */
function voice(axis: number, jitter = 0, dims = 8): Float32Array {
  const v = new Float32Array(dims);
  v[axis] = 1;
  v[(axis + 1) % dims] = jitter;
  return normalize(v);
}

/** Back-to-back windows, one per voice given (null for quiet). */
function windows(voices: (Float32Array | null)[]): VoiceWindow[] {
  return voices.map((embedding, k) => ({
    start: k * HOP_SEC,
    end: k * HOP_SEC + 2,
    embedding,
  }));
}

describe("voice math", () => {
  it("averages normalized vectors", () => {
    const c = centroid([voice(0), voice(1)])!;
    expect(similarity(c, voice(0))).toBeCloseTo(Math.SQRT1_2);
    expect(centroid([])).toBeNull();
  });

  it("splits two voices into two groups, heavier first", () => {
    const items = [
      { voiceprint: voice(0, 0.1), weight: 10 },
      { voiceprint: voice(3, 0.1), weight: 2 },
      { voiceprint: voice(0, 0.2), weight: 8 },
      { voiceprint: voice(3, 0.2), weight: 3 },
    ];
    const split = twoMeans(items)!;
    expect(split.groups).toEqual([0, 1, 0, 1]);
    expect(similarity(split.centroids[0], split.centroids[1])).toBeLessThan(
      0.3,
    );
  });

  it("finds no meaningful split in one voice", () => {
    const split = twoMeans([
      { voiceprint: voice(0, 0.1), weight: 5 },
      { voiceprint: voice(0, 0.15), weight: 5 },
      { voiceprint: voice(0, 0.2), weight: 5 },
    ])!;
    expect(similarity(split.centroids[0], split.centroids[1])).toBeGreaterThan(
      0.9,
    );
  });
});

describe("changePoints", () => {
  it("marks where one voice hands over to another", () => {
    const a = voice(0);
    const b = voice(4);
    // 8 windows of a, then 8 of b: the 2 s windows either side of t = 4 s
    // are wholly different voices.
    const ws = windows([...Array(8).fill(a), ...Array(8).fill(b)]);
    const points = changePoints(ws, 0.4);
    expect(points.map((p) => p.at)).toEqual([4]);
    expect(points[0]!.similarity).toBeCloseTo(0);
  });

  it("skips quiet windows and steady voices", () => {
    const a = voice(0);
    const ws = windows([...Array(6).fill(a), null, null, ...Array(6).fill(a)]);
    expect(changePoints(ws, 0.4)).toEqual([]);
    expect(continuity(ws).some((c) => c.similarity === null)).toBe(true);
  });
});
