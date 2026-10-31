import { describe, expect, test } from "vite-plus/test";
import { chapterIndexAt, resolveLinkTime } from "./chapters";

const chapter = (start: number, end: number) => ({ start, end });

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
