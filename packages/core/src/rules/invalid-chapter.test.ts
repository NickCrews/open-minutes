import { describe, expect, test } from "vitest";
import { chapter, chapterProblems } from "./testing";
import * as invalidChapter from "./invalid-chapter";

describe("invalid-chapter", () => {
  test("accepts ordered chapters with gaps", () => {
    expect(
      chapterProblems(invalidChapter.rule, [chapter(0, 10), chapter(20, 30)], {
        durationSecs: 30,
      }),
    ).toEqual([]);
  });

  test("refuses a missing title and blank bullets", () => {
    expect(
      chapterProblems(invalidChapter.rule, [
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
      chapterProblems(
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
      chapterProblems(invalidChapter.rule, [chapter(0, 98.5)], {
        durationSecs: 60,
        segments,
      }),
    ).toEqual([]);
  });
});
