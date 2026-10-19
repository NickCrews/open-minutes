import { describe, expect, test } from "vitest";
import { seg } from "./testing";
import * as uncoveredSpeech from "./uncovered-speech";
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

describe("uncovered-speech", () => {
  const segments = [seg("a", [0, "Start."], [100, "End."])];
  const chapter = (start: number, end: number) => ({
    start,
    end,
    title: `${start}`,
    bullets: [],
  });

  test("reports a long stretch of speech in no chapter", () => {
    expect(
      uncoveredSpeech.rule({ segments, chapters: [chapter(0, 50)] }),
    ).toEqual([
      {
        code: "uncovered-speech",
        message:
          "speech from 0:00:50.00 to 0:01:40.50 is in no chapter; extend a neighbouring chapter or add one",
        atSecs: 50,
        endSecs: 100.5,
      },
    ]);
  });

  test("says nothing when the meeting has no chapters", () => {
    expect(uncoveredSpeech.rule({ segments })).toEqual([]);
    expect(uncoveredSpeech.rule({ segments, chapters: [] })).toEqual([]);
  });
});
