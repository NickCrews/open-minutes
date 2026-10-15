import { describe, expect, it } from "vitest";
import * as codeSection from "./code-section";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(codeSection.rule, sentence);

describe("code-section", () => {
  it("finds code sections with a dot missing or extra", () => {
    expect(found("sections 21.09050, 3.3.144 and section 2103050.")).toEqual([
      "21.09050,",
      "3.3.144",
      "2103050.",
    ]);
  });

  it("accepts code sections written the house way", () => {
    expect(
      found("AMC 25.35.060C and 21.05.040G.2.b and AS 44.62.310."),
    ).toEqual([]);
    expect(
      found("Item 14.C is AO 2026-18, an ordinance amending AMC 3.70.190."),
    ).toEqual([]);
  });
  it("puts the dots where the digits say", () => {
    expect(
      fixWith(codeSection, "sections 21.09050, 3.3.144 and section 2103050."),
    ).toBe("sections 21.09.050, 3.3.144 and section 21.03.050.");
  });
});
