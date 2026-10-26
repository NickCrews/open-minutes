import { describe, expect, it } from "vite-plus/test";
import * as percent from "./percent";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(percent.rule, sentence);

describe("percent", () => {
  it("finds percentages said in words", () => {
    expect(found("up one percent, 50 percent")).toEqual([
      "one percent,",
      "50 percent",
    ]);
  });

  it("accepts percentages written the house way", () => {
    expect(found("An increase of 1% or 3.79% a year.")).toEqual([]);
  });
  it("writes the percentage as 1%", () => {
    const fix = (s: string) => fixWith(percent, s);
    expect(fix("one percent, then one hundred percent and 3.79 percent.")).toBe(
      "1%, then 100% and 3.79%.",
    );
  });
});
