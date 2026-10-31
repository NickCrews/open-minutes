import { describe, expect, it } from "vite-plus/test";
import * as monthCapital from "./month-capital";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(monthCapital.rule, sentence);

describe("month-capital", () => {
  it("finds a month in lower case", () => {
    expect(found("later in july or august, not may.")).toEqual([
      "july",
      "august,",
    ]);
  });

  it("leaves a lower-case month before a day to the date rule", () => {
    expect(found("born july fourth, and march 24 or later.")).toEqual([]);
  });
  it("capitalizes the month", () => {
    expect(fixWith(monthCapital, "in july, or (august)")).toBe(
      "in July, or (August)",
    );
  });
});
