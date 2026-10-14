import { describe, expect, it } from "vitest";
import * as percent from "./percent";
import { foundTexts } from "./testing";

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
});
