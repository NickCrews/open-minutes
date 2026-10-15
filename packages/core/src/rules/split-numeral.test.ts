import { describe, expect, it } from "vitest";
import * as splitNumeral from "./split-numeral";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(splitNumeral.rule, sentence);

describe("split-numeral", () => {
  it("finds two numerals said as one", () => {
    expect(found("AR 2026 48 at 11 15 for 100 000")).toEqual([
      "2026 48",
      "11 15",
      "100 000",
    ]);
  });

  it("leaves numerals a comma or word apart alone", () => {
    expect(found("February 17, 2026 and 72, 84, 96 hours")).toEqual([]);
  });
  it("joins numerals when the words say how", () => {
    expect(fixWith(splitNumeral, "for 100 000, at 11 15 AM, AR 2026 48")).toBe(
      "for 100,000, at 11:15 AM, AR 2026 48",
    );
  });
});
