import { describe, expect, it } from "vitest";
import * as money from "./money";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(money.rule, sentence);

describe("money", () => {
  it("finds money said in words", () => {
    expect(
      found("ten dollars and 5,000 dollar and a million dollars, six cents"),
    ).toEqual([
      "ten dollars",
      "5,000 dollar",
      "a million dollars,",
      "six cents",
    ]);
  });

  it("accepts money written the house way", () => {
    expect(
      found("It costs $10, or $36,000, or $1.5 million, or 6 cents."),
    ).toEqual([]);
  });
  it("writes the sum as $10", () => {
    const fix = (s: string) => fixWith(money, s);
    expect(
      fix(
        "ten dollars and a 5,000 dollar grant and a million dollars, six cents",
      ),
    ).toBe("$10 and a $5,000 grant and $1 million, 6 cents");
    expect(fix("thirty six thousand dollars and 1.2 million dollars.")).toBe(
      "$36,000 and $1.2 million.",
    );
    expect(fix("twenty five cents and a hundred dollars")).toBe(
      "25 cents and $100",
    );
    expect(fix("two ten dollars bills")).toBe("two ten dollars bills");
  });
});
