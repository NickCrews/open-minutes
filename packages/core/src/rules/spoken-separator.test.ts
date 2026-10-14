import { describe, expect, it } from "vitest";
import * as spokenSeparator from "./spoken-separator";
import { foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(spokenSeparator.rule, sentence);

describe("spoken-separator", () => {
  it("finds a number with a separator said in words", () => {
    expect(found("section three dot seventy and six dash two")).toEqual([
      "three dot seventy",
      "six dash two",
    ]);
  });
});
