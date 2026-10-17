import { describe, expect, it } from "vitest";
import * as time from "./time";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(time.rule, sentence);

describe("time", () => {
  it("finds times not written as 7 p.m.", () => {
    expect(found("at eleven AM, at 7 pm and at 504 p.m.")).toEqual([
      "eleven AM,",
      "7 pm",
      "504 p.m.",
    ]);
    expect(found("I am here at 10 a m sharp.")).toEqual(["10 a m"]);
  });

  it("accepts times written the house way", () => {
    expect(found("We meet at 7 p.m. or 11:30 a.m. tomorrow.")).toEqual([]);
  });
  it("writes the time as 7 p.m.", () => {
    const fix = (s: string) => fixWith(time, s);
    expect(fix("at eleven AM, at 7 pm and at 504 p.m.")).toBe(
      "at 11 a.m., at 7 p.m. and at 5:04 p.m.",
    );
    expect(fix("at seven thirty PM.")).toBe("at 7:30 p.m.");
    expect(fix("at eleven oh five A.M. sharp")).toBe("at 11:05 a.m. sharp");
    expect(fix("I am here at 10 a m sharp.")).toBe(
      "I am here at 10 a.m. sharp.",
    );
    expect(fix("two seven PM meetings and 1375 PM")).toBe(
      "two seven PM meetings and 1375 PM",
    );
  });
});
