import { describe, expect, it } from "vitest";
import * as spokenSeparator from "./spoken-separator";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(spokenSeparator.rule, sentence);

describe("spoken-separator", () => {
  it("finds a number with a separator said in words", () => {
    expect(found("section three dot seventy and six dash two")).toEqual([
      "three dot seventy",
      "six dash two",
    ]);
  });
  it("writes the number in digits", () => {
    const fix = (s: string) => fixWith(spokenSeparator, s);
    expect(fix("AMC three dot seventy dot one ninety applies")).toBe(
      "AMC 3.70.190 applies",
    );
    expect(fix("AO twenty twenty six dash twenty, and four point three.")).toBe(
      "AO 2026-20, and 4.3.",
    );
    expect(fix("about five point two million")).toBe("about 5.2 million");
    expect(fix("one dot four twenty first")).toBe("one dot four twenty first");
  });
});
