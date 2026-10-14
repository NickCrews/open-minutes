import { describe, expect, test } from "vitest";
import type { ChapterSpan } from "../chapters";
import * as chapterSize from "./chapter-size";
import type { RuleSegment } from "./common";
import * as invalidChapter from "./invalid-chapter";
import * as typographicDash from "./typographic-dash";
import { uncoveredSpans } from "./uncovered-speech";

const chapter = (start: number, end: number, bullets = 0): ChapterSpan => ({
  start,
  end,
  title: `${start}-${end}`,
  bullets: Array.from({ length: bullets }, (_, i) => `bullet ${i}`),
});

/** What a chapter rule says of each chapter, by index. */
const problems = (
  rule: typeof invalidChapter.rule,
  chapters: ChapterSpan[],
  more: { durationSecs?: number; segments?: RuleSegment[] } = {},
) =>
  rule({ segments: [], durationSecs: 1000, ...more, chapters }).map((v) => [
    v.chapterIndex,
    v.message.replace(/^chapter \d+ \(".*?"\) /, ""),
  ]);

describe("invalid-chapter", () => {
  test("accepts ordered chapters with gaps", () => {
    expect(
      problems(invalidChapter.rule, [chapter(0, 10), chapter(20, 30)], {
        durationSecs: 30,
      }),
    ).toEqual([]);
  });

  test("refuses a missing title and blank bullets", () => {
    expect(
      problems(invalidChapter.rule, [
        { ...chapter(0, 10), title: " " },
        { ...chapter(10, 20), bullets: ["ok", " "] },
      ]),
    ).toEqual([
      [0, "has no title"],
      [1, "has a blank bullet"],
    ]);
  });

  test("names each broken chapter", () => {
    expect(
      problems(
        invalidChapter.rule,
        [chapter(0, 10), chapter(5, 20), chapter(30, 30), chapter(40, 99)],
        { durationSecs: 60 },
      ),
    ).toEqual([
      [1, "starts before the previous chapter ends"],
      [2, "doesn't end after it starts"],
      [3, "ends after the meeting does"],
    ]);
  });

  test("ends the meeting at its last word when that is later", () => {
    const segments = [{ speaker: null, words: [{ start: 98, text: "End." }] }];
    expect(
      problems(invalidChapter.rule, [chapter(0, 98.5)], {
        durationSecs: 60,
        segments,
      }),
    ).toEqual([]);
  });
});

describe("typographic-dash in chapters", () => {
  test("finds en and em dashes in the title, summary or bullets", () => {
    const message = "has an en or em dash; write a plain hyphen (-)";
    const chapters = [
      { ...chapter(0, 10), title: "Vote passes 3–2" },
      { ...chapter(10, 20), summary: "The board — briefly — met." },
      { ...chapter(20, 30, 3), bullets: ["a", "b", "2019–2022"] },
      { ...chapter(30, 40), summary: "Passes 3-2." },
    ];
    expect(problems(typographicDash.rule as never, chapters)).toEqual([
      [0, message],
      [1, message],
      [2, message],
    ]);
  });

  test("fixes them, and the meeting's title and description", () => {
    const meeting = {
      title: "Budget – first reading",
      description: "Items 1—3",
      segments: [],
      chapters: [{ ...chapter(0, 10), title: "Items 1—3", summary: "A–B" }],
    };
    const { meeting: fixed, fixed: violations } = typographicDash.fix(
      meeting,
      typographicDash.rule(meeting),
    );
    expect(fixed).toEqual({
      title: "Budget - first reading",
      description: "Items 1-3",
      segments: [],
      chapters: [{ ...chapter(0, 10), title: "Items 1-3", summary: "A-B" }],
    });
    expect(violations.map((v) => v.message)).toEqual([
      "the meeting's title has an en or em dash; write a plain hyphen (-)",
      "the meeting's description has an en or em dash; write a plain hyphen (-)",
      'chapter 1 ("Items 1—3") has an en or em dash; write a plain hyphen (-)',
    ]);
  });
});

describe("chapter-size", () => {
  test("lets procedural chapters be any length", () => {
    expect(
      problems(chapterSize.rule as never, [chapter(0, 6), chapter(6, 2000, 1)]),
    ).toEqual([]);
  });

  test("holds substantive chapters to 1–15 minutes and 3–7 bullets", () => {
    const count = (c: ChapterSpan) =>
      problems(chapterSize.rule as never, [c]).length;
    expect(count(chapter(0, 300, 3))).toBe(0);
    expect(count(chapter(0, 30, 3))).toBe(1);
    expect(count(chapter(0, 1000, 4))).toBe(1);
    expect(count(chapter(0, 300, 2))).toBe(1);
    expect(count(chapter(0, 300, 8))).toBe(1);
  });
});

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
