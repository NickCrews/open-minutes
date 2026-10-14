import { describe, expect, it } from "vitest";
import { core, isNumeral, isOrdinalWord, wordRule, wordValue } from "./numbers";
import { seg } from "./testing";

describe("wordValue", () => {
  it("reads one number word, hyphenated compounds included", () => {
    expect(wordValue("eleven,")).toBe(11);
    expect(wordValue("Twenty-five")).toBe(25);
    expect(wordValue("forty-ninth.")).toBe(49);
    expect(wordValue("thousand")).toBe(1000);
    expect(wordValue("twenty-five-six")).toBeUndefined();
    expect(wordValue("tenant")).toBeUndefined();
  });

  it("tells ordinals from cardinals", () => {
    expect(isOrdinalWord("twenty-fourth")).toBe(true);
    expect(isOrdinalWord("twenty")).toBe(false);
  });
});

describe("isNumeral", () => {
  it("takes digits with separators, and $ or %", () => {
    for (const w of ["12", "3.5", "$36,000,", "3.79%", "11:30"])
      expect(isNumeral(w), w).toBe(true);
    for (const w of ["R4", "10A1", "2026-23", "$"])
      expect(isNumeral(w), w).toBe(false);
    expect(core('"$10."')).toBe("$10");
  });
});

describe("wordRule", () => {
  it("reports each finding at the word it starts at", () => {
    const rule = wordRule("test", (words) =>
      words.flatMap((w, index) =>
        w === "b" ? [{ index, text: w, message: "no b" }] : [],
      ),
    );
    expect(
      rule({ segments: [seg("x", [1, "a"]), seg("y", [2, "a"], [3, "b"])] }),
    ).toEqual([
      {
        code: "test",
        message: '"b": no b',
        segmentIndex: 1,
        wordIndex: 1,
        atSecs: 3,
        text: "b",
      },
    ]);
  });
});
