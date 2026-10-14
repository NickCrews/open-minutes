import { describe, expect, test } from "vitest";
import { uncoveredSpans } from "./uncovered-speech";

describe("uncoveredSpans", () => {
  test("ignores silence and short slop between chapters", () => {
    const speech = [
      { start: 0, end: 100 },
      { start: 500, end: 600 },
    ];
    const chapters = [
      { start: 0, end: 90 },
      { start: 100, end: 200 },
      { start: 500, end: 600 },
    ];
    expect(uncoveredSpans(speech, chapters)).toEqual([]);
  });

  test("merges uncovered pieces across segments", () => {
    const speech = [
      { start: 0, end: 50 },
      { start: 50, end: 120 },
    ];
    expect(uncoveredSpans(speech, [{ start: 0, end: 40 }])).toEqual([
      { start: 40, end: 120 },
    ]);
  });

  test("finds speech before the first chapter and inside a gap", () => {
    const speech = [{ start: 0, end: 300 }];
    const chapters = [
      { start: 40, end: 100 },
      { start: 200, end: 300 },
    ];
    expect(uncoveredSpans(speech, chapters)).toEqual([
      { start: 0, end: 40 },
      { start: 100, end: 200 },
    ]);
  });
});
