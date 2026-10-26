import { describe, expect, it } from "vite-plus/test";
import { clip, gaps, mergeSpans, subtract, totalSecs } from "./span";

describe("clip", () => {
  it("trims spans that cross the range's edges", () => {
    expect(
      clip(
        [
          { start: 0, end: 3 },
          { start: 4, end: 5 },
          { start: 6, end: 12 },
        ],
        2,
        10,
      ),
    ).toEqual([
      { start: 2, end: 3 },
      { start: 4, end: 5 },
      { start: 6, end: 10 },
    ]);
  });

  it("drops spans outside the range, and ones that only touch its edges", () => {
    expect(
      clip(
        [
          { start: 0, end: 1 },
          { start: 1, end: 2 },
          { start: 5, end: 6 },
          { start: 8, end: 9 },
        ],
        2,
        5,
      ),
    ).toEqual([]);
  });

  it("trims a span that covers the whole range to the range", () => {
    expect(clip([{ start: 0, end: 100 }], 10, 20)).toEqual([
      { start: 10, end: 20 },
    ]);
  });

  it("leaves its input alone", () => {
    const spans = [{ start: 0, end: 10 }];
    clip(spans, 2, 5);
    expect(spans).toEqual([{ start: 0, end: 10 }]);
  });
});

describe("gaps", () => {
  it("finds the gaps between spans, including at the range edges", () => {
    const runs = [
      { start: 1, end: 3 },
      { start: 3.2, end: 5 },
      { start: 7, end: 8 },
    ];
    expect(gaps(runs, 0, 10, 0.5)).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 7 },
      { start: 8, end: 10 },
    ]);
  });

  it("keeps a gap exactly minSecs long", () => {
    const runs = [
      { start: 0, end: 1 },
      { start: 1.5, end: 2 },
    ];
    expect(gaps(runs, 0, 2, 0.5)).toEqual([{ start: 1, end: 1.5 }]);
  });

  it("is the whole range when no span is in it", () => {
    expect(gaps([{ start: 20, end: 30 }], 0, 10, 0.5)).toEqual([
      { start: 0, end: 10 },
    ]);
  });

  it("is empty when spans cover the whole range", () => {
    const runs = [
      { start: 0, end: 4 },
      { start: 4, end: 12 },
    ];
    expect(gaps(runs, 2, 10, 0.1)).toEqual([]);
  });

  it("measures from the furthest end so far, not the last span's", () => {
    // [2, 3] sits inside [1, 6], so the gap starts at 6, not 3.
    const runs = [
      { start: 1, end: 6 },
      { start: 2, end: 3 },
      { start: 7, end: 8 },
    ];
    expect(gaps(runs, 1, 8, 0.5)).toEqual([{ start: 6, end: 7 }]);
  });
});

describe("totalSecs", () => {
  it("sums the spans' lengths", () => {
    expect(
      totalSecs([
        { start: 0, end: 1.5 },
        { start: 10, end: 12 },
      ]),
    ).toBe(3.5);
  });

  it("is 0 for no spans", () => {
    expect(totalSecs([])).toBe(0);
  });
});

describe("subtract", () => {
  it("subtracts one span list from another", () => {
    expect(
      subtract(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 },
        ],
        [
          { start: 2, end: 3 },
          { start: 8, end: 22 },
          { start: 25, end: 26 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 8 },
      { start: 22, end: 25 },
      { start: 26, end: 30 },
    ]);
  });

  it("leaves `a` whole when `b` is empty or only touches it", () => {
    const a = [{ start: 5, end: 10 }];
    expect(subtract(a, [])).toEqual(a);
    expect(
      subtract(a, [
        { start: 0, end: 5 },
        { start: 10, end: 15 },
      ]),
    ).toEqual(a);
  });

  it("is empty when `b` covers `a`", () => {
    expect(
      subtract(
        [
          { start: 1, end: 2 },
          { start: 3, end: 4 },
        ],
        [{ start: 0, end: 5 }],
      ),
    ).toEqual([]);
    expect(subtract([{ start: 1, end: 2 }], [{ start: 1, end: 2 }])).toEqual(
      [],
    );
  });

  it("takes a `b` whose spans overlap", () => {
    expect(
      subtract(
        [{ start: 0, end: 20 }],
        [
          { start: 2, end: 10 },
          { start: 4, end: 6 },
          { start: 8, end: 12 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 12, end: 20 },
    ]);
  });

  it("is empty when `a` is empty", () => {
    expect(subtract([], [{ start: 0, end: 5 }])).toEqual([]);
  });
});

describe("mergeSpans", () => {
  it("merges spans closer than the gap", () => {
    expect(
      mergeSpans(
        [
          { start: 5, end: 6 },
          { start: 0, end: 1 },
          { start: 1.2, end: 2 },
        ],
        0.5,
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 6 },
    ]);
  });

  it("with a gap of 0, joins only spans that touch or overlap", () => {
    expect(
      mergeSpans(
        [
          { start: 0, end: 1 },
          { start: 1, end: 2 },
          { start: 1.5, end: 3 },
          { start: 3.1, end: 4 },
        ],
        0,
      ),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 3.1, end: 4 },
    ]);
  });

  it("keeps the outer end when a span sits inside another", () => {
    expect(
      mergeSpans(
        [
          { start: 0, end: 10 },
          { start: 2, end: 3 },
        ],
        0,
      ),
    ).toEqual([{ start: 0, end: 10 }]);
  });

  it("leaves its input alone", () => {
    const spans = [
      { start: 1, end: 2 },
      { start: 0, end: 1 },
    ];
    mergeSpans(spans, 0);
    expect(spans).toEqual([
      { start: 1, end: 2 },
      { start: 0, end: 1 },
    ]);
  });

  it("is empty for no spans", () => {
    expect(mergeSpans([], 1)).toEqual([]);
  });
});
