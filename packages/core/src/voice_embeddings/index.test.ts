import { describe, expect, it } from "vite-plus/test";
import { centroid, type SpanWithEmbedding } from "./index";

const at = (start: number, end: number, ...v: number[]): SpanWithEmbedding => ({
  start,
  end,
  vector: Float32Array.from(v),
});

describe("centroid", () => {
  const embedded = [
    at(0, 1.5, 1, 0),
    at(0.75, 2.25, 3, 2),
    at(1.5, 3, 5, 4),
    at(4, 5.5, 100, 100),
  ];

  it("averages the windows inside the span", () => {
    expect(centroid(embedded, { start: 0, end: 3 })).toEqual(
      Float32Array.from([3, 2]),
    );
  });

  it("leaves out windows that cross the span's edge", () => {
    expect(centroid(embedded, { start: 0.5, end: 5 })).toEqual(
      Float32Array.from([4, 3]),
    );
  });

  it("is null when no window is inside the span", () => {
    expect(centroid(embedded, { start: 3, end: 4 })).toBeNull();
  });
});
