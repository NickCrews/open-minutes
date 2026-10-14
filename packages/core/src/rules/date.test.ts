import { describe, expect, it } from "vitest";
import * as date from "./date";
import { foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(date.rule, sentence);

describe("date", () => {
  it("finds dates not written as March 19", () => {
    expect(found("on March 24th and February nineteenth.")).toEqual([
      "March 24th",
      "February nineteenth.",
    ]);
    expect(found("born july fourth, and march 24 or later.")).toEqual([
      "july fourth,",
      "march 24",
    ]);
  });

  it("leaves a month that isn't a date alone", () => {
    expect(found("This march is a call. You may one day.")).toEqual([]);
    expect(found("The February one isn't out. May one of you second?")).toEqual(
      [],
    );
    expect(found("On February 17, 2026, and again on the 27th.")).toEqual([]);
  });
});
