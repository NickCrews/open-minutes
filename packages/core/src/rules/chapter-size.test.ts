import { describe, expect, test } from "vite-plus/test";
import { chapter, chapterProblems } from "./testing";
import type { Chapter } from "../chapters";
import * as chapterSize from "./chapter-size";

describe("chapter-size", () => {
  test("lets procedural chapters be any length", () => {
    expect(
      chapterProblems(chapterSize.rule, [chapter(0, 6), chapter(6, 2000, 1)]),
    ).toEqual([]);
  });

  test("holds substantive chapters to 1–15 minutes and 3–7 bullets", () => {
    const count = (c: Chapter) => chapterProblems(chapterSize.rule, [c]).length;
    expect(count(chapter(0, 300, 3))).toBe(0);
    expect(count(chapter(0, 30, 3))).toBe(1);
    expect(count(chapter(0, 1000, 4))).toBe(1);
    expect(count(chapter(0, 300, 2))).toBe(1);
    expect(count(chapter(0, 300, 8))).toBe(1);
  });
});
