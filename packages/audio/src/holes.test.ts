import { describe, expect, it } from "vitest";
import { findHoles, splitHole, wordSecs } from "./holes";

const w = (start: number, text = "word") => ({ start, text });

describe("findHoles", () => {
  it("finds speech with no words in it", () => {
    // Words every 0.4 s, then 5 s of speech with none.
    const words = [w(10), w(10.4), w(10.8), w(16), w(16.4)];
    expect(findHoles(words, [{ start: 10, end: 17 }])).toEqual([
      { start: 11.4, end: 16 },
    ]);
  });

  it("finds a span with no words at all", () => {
    expect(findHoles([], [{ start: 3, end: 8 }])).toEqual([
      { start: 3, end: 8 },
    ]);
  });

  it("finds nothing in steady speech or short spans", () => {
    const steady = Array.from({ length: 20 }, (_, i) => w(i * 0.5));
    expect(findHoles(steady, [{ start: 0, end: 10 }])).toEqual([]);
    expect(findHoles([], [{ start: 0, end: 1 }])).toEqual([]);
  });

  it("gives a number in digits time to be read out", () => {
    // "2026-0064" is one token but eight spoken words.
    const words = [w(5, "case"), w(5.4, "2026-0064"), w(9, "to")];
    expect(findHoles(words, [{ start: 5, end: 9.5 }])).toEqual([]);
    expect(wordSecs("2026-0064")).toBeCloseTo(3.2);
    expect(wordSecs("hydrant")).toBe(0.6);
  });
});

describe("splitHole", () => {
  it("leaves a short hole whole", () => {
    expect(splitHole({ start: 0, end: 7 }, [], 8)).toEqual([
      { start: 0, end: 7 },
    ]);
  });

  it("cuts a long hole at the widest pause near each even split", () => {
    const speech = [
      { start: 0, end: 5 },
      { start: 5.2, end: 6.4 },
      { start: 6.8, end: 13 },
      { start: 13.8, end: 20 },
    ];
    // Even cuts would fall at 6.67 and 13.33.
    const pieces = splitHole({ start: 0, end: 20 }, speech, 8);
    expect(pieces.map((p) => [p.start, p.end])).toEqual([
      [0, 6.6],
      [6.6, 13.4],
      [13.4, 20],
    ]);
  });
});
