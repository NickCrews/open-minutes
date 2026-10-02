import { describe, expect, test } from "vitest";
import {
  chapterErrors,
  chapterIndexAt,
  chapterWarnings,
  resolveLinkTime,
  uncoveredSpeech,
} from "./chapters";

const chapter = (start: number, end: number, bullets = 0) => ({
  start,
  end,
  title: `${start}-${end}`,
  bullets: Array.from({ length: bullets }, (_, i) => `bullet ${i}`),
});

describe("chapterErrors", () => {
  test("accepts ordered chapters with gaps", () => {
    expect(chapterErrors([chapter(0, 10), chapter(20, 30)], 30)).toEqual([]);
  });

  test("refuses blank bullets", () => {
    expect(
      chapterErrors([{ ...chapter(0, 10), bullets: ["ok", " "] }]),
    ).toEqual([{ chapter: 0, message: "has a blank bullet" }]);
  });

  test("refuses en and em dashes in the title, summary or bullets", () => {
    const message = "has an en or em dash; write a plain hyphen (-)";
    expect(
      chapterErrors([
        { ...chapter(0, 10), title: "Vote passes 3–2" },
        { ...chapter(10, 20), summary: "The board — briefly — met." },
        { ...chapter(20, 30, 3), bullets: ["a", "b", "2019–2022"] },
        { ...chapter(30, 40), summary: "Passes 3-2." },
      ]),
    ).toEqual([
      { chapter: 0, message },
      { chapter: 1, message },
      { chapter: 2, message },
    ]);
  });

  test("names each broken chapter", () => {
    const errors = chapterErrors(
      [chapter(0, 10), chapter(5, 20), chapter(30, 30), chapter(40, 99)],
      60,
    );
    expect(errors).toEqual([
      { chapter: 1, message: "starts before the previous chapter ends" },
      { chapter: 2, message: "doesn't end after it starts" },
      { chapter: 3, message: "ends after the meeting does" },
    ]);
  });
});

describe("chapterWarnings", () => {
  test("lets procedural chapters be any length", () => {
    expect(chapterWarnings([chapter(0, 6), chapter(6, 2000, 1)])).toEqual([]);
  });

  test("holds substantive chapters to 1–15 minutes and 3–7 bullets", () => {
    expect(chapterWarnings([chapter(0, 300, 3)])).toEqual([]);
    expect(chapterWarnings([chapter(0, 30, 3)])).toHaveLength(1);
    expect(chapterWarnings([chapter(0, 1000, 4)])).toHaveLength(1);
    expect(chapterWarnings([chapter(0, 300, 2)])).toHaveLength(1);
    expect(chapterWarnings([chapter(0, 300, 8)])).toHaveLength(1);
  });
});

describe("uncoveredSpeech", () => {
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
    expect(uncoveredSpeech(speech, chapters)).toEqual([]);
  });

  test("merges uncovered pieces across segments", () => {
    const speech = [
      { start: 0, end: 50 },
      { start: 50, end: 120 },
    ];
    expect(uncoveredSpeech(speech, [{ start: 0, end: 40 }])).toEqual([
      { start: 40, end: 120 },
    ]);
  });

  test("finds speech before the first chapter and inside a gap", () => {
    const speech = [{ start: 0, end: 300 }];
    const chapters = [
      { start: 40, end: 100 },
      { start: 200, end: 300 },
    ];
    expect(uncoveredSpeech(speech, chapters)).toEqual([
      { start: 0, end: 40 },
      { start: 100, end: 200 },
    ]);
  });
});

describe("chapterIndexAt", () => {
  const chapters = [chapter(10, 20), chapter(20, 30), chapter(40, 50)];
  test.each([
    [0, -1],
    [10, 0],
    [19.9, 0],
    [20, 1],
    [35, -1],
    [49, 2],
    [50, -1],
  ])("at %d → %d", (t, index) => {
    expect(chapterIndexAt(chapters, t)).toBe(index);
  });
});

describe("resolveLinkTime", () => {
  const chapters = [chapter(0, 100), chapter(100, 200), chapter(260, 300)];
  test("keeps a moment inside a chapter", () => {
    expect(resolveLinkTime(chapters, 50)).toEqual({ secs: 50, chapter: 0 });
  });

  test("snaps to a chapter whose start moved a little later", () => {
    expect(resolveLinkTime(chapters, 95)).toEqual({ secs: 100, chapter: 1 });
    expect(resolveLinkTime(chapters, 252)).toEqual({ secs: 260, chapter: 2 });
  });

  test("leaves a link deep in a gap alone", () => {
    expect(resolveLinkTime(chapters, 220)).toEqual({ secs: 220, chapter: -1 });
  });
});
