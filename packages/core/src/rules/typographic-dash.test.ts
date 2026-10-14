import { describe, expect, test } from "vitest";
import { chapter, chapterProblems, fixWith } from "./testing";
import * as typographicDash from "./typographic-dash";

describe("typographic-dash in words", () => {
  const run = (s: string) => fixWith(typographicDash, s);

  test("turns en and em dashes into plain hyphens", () => {
    expect(run("from 2019–2022 we")).toBe("from 2019-2022 we");
    expect(run("the board— and staff")).toBe("the board- and staff");
    expect(run("AO 2026-23 passed")).toBe("AO 2026-23 passed");
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
    expect(chapterProblems(typographicDash.rule, chapters)).toEqual([
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
