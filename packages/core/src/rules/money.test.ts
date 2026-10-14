import { describe, expect, it } from "vitest";
import * as money from "./money";
import { foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(money.rule, sentence);

describe("money", () => {
  it("finds money said in words", () => {
    expect(
      found("ten dollars and 5,000 dollar and a million dollars, six cents"),
    ).toEqual(["ten dollars", "5,000 dollar", "million dollars,", "six cents"]);
  });

  it("accepts money written the house way", () => {
    expect(
      found("It costs $10, or $36,000, or $1.5 million, or 6 cents."),
    ).toEqual([]);
  });
});
