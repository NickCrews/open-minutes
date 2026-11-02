import { describe, expect, it } from "vite-plus/test";
import * as date from "./date";
import { fixWith, foundTexts } from "./testing";

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
  it("writes the date as March 19", () => {
    const fix = (s: string) => fixWith(date, s);
    expect(fix("on March 24th and February nineteenth.")).toBe(
      "on March 24 and February 19.",
    );
    expect(fix("born july fourth, and march 24 or June twenty first.")).toBe(
      "born July 4, and March 24 or June 21.",
    );
  });
});
