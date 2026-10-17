import { describe, expect, it } from "vitest";
import {
  amount,
  cardinal,
  core,
  digits,
  isNumeral,
  isOrdinalWord,
  rewrite,
  wordRule,
  wordValue,
  year,
} from "./numbers";
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

describe("reading spoken numbers", () => {
  const read = (s: string) => cardinal(s.split(" "));
  it("reads a number said the usual way", () => {
    expect(read("thirty-six thousand")).toEqual({
      value: 36000,
      ordinal: false,
    });
    expect(read("two hundred fifty")?.value).toBe(250);
    expect(read("one million two hundred thousand")?.value).toBe(1_200_000);
    expect(read("1.2 million")?.value).toBe(1_200_000);
    expect(read("twenty fourth")).toEqual({ value: 24, ordinal: true });
    for (const s of [
      "twenty twenty six",
      "one fifty five",
      "five zero",
      "fourth twenty",
      "thousand thousand",
    ])
      expect(read(s), s).toBeUndefined();
  });

  it("reads digits and years", () => {
    expect(digits("one ninety".split(" "))).toBe("190");
    expect(digits("oh six oh".split(" "))).toBe("060");
    expect(digits("twenty twenty six".split(" "))).toBe("2026");
    expect(digits(["hundred"])).toBeUndefined();
    expect(year("twenty twenty six".split(" "))).toBe(2026);
    expect(year("twenty oh five".split(" "))).toBe(2005);
    expect(year("nineteen hundred".split(" "))).toBe(1900);
    expect(year("twenty five".split(" "))).toBeUndefined();
    expect(year("ten fifteen".split(" "))).toBeUndefined();
  });

  it("writes an amount with commas, or in millions", () => {
    expect(amount(36000)).toEqual(["36,000"]);
    expect(amount(1_500_000)).toEqual(["1.5", "million"]);
    expect(amount(1_250_300)).toEqual(["1,250,300"]);
  });
});

describe("rewrite", () => {
  it("writes the replacement, keeping punctuation, onsets and other properties", () => {
    const segments = [
      {
        speaker: "x",
        words: [
          { start: 1, text: "(ten" },
          { start: 2, text: "PM)." },
          { start: 3, text: "AO2026-1", id: 7 },
        ],
      },
    ];
    const violations = [
      {
        code: "t",
        message: "",
        segmentIndex: 0,
        wordIndex: 0,
        atSecs: 1,
        text: "(ten PM).",
        replacement: ["10", "p.m."],
      },
      {
        code: "t",
        message: "",
        segmentIndex: 0,
        wordIndex: 2,
        atSecs: 3,
        text: "AO2026-1",
        replacement: ["AO", "2026-1", "x"],
      },
    ];
    const { meeting, fixed } = rewrite({ segments }, violations);
    expect(fixed).toEqual(violations);
    expect(meeting.segments[0]!.words).toEqual([
      { start: 1, text: "(10" },
      { start: 2, text: "p.m.)." },
      { start: 3, text: "AO", id: 7 },
      { start: 3, text: "2026-1", id: 7 },
      { start: 3, text: "x", id: 7 },
    ]);
  });

  it("leaves violations without a replacement, or whose words have changed", () => {
    const segments = [{ speaker: null, words: [{ start: 1, text: "ten" }] }];
    const at = {
      code: "t",
      message: "",
      segmentIndex: 0,
      wordIndex: 0,
      atSecs: 1,
    };
    const meeting = { segments };
    expect(rewrite(meeting, [{ ...at, text: "ten" }]).meeting).toBe(meeting);
    expect(
      rewrite(meeting, [{ ...at, text: "eleven", replacement: ["11"] }])
        .meeting,
    ).toBe(meeting);
  });
});
