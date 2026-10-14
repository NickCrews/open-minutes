import { describe, expect, it } from "vitest";
import * as time from "./time";
import { foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(time.rule, sentence);

describe("time", () => {
  it("finds times not written as 7 p.m.", () => {
    expect(found("at eleven AM, at 7 pm and at 504 p.m.")).toEqual([
      "eleven AM,",
      "7 pm",
      "504 p.m.",
    ]);
    expect(found("I am here at 10 a m sharp.")).toEqual(["10 a"]);
  });

  it("accepts times written the house way", () => {
    expect(found("We meet at 7 p.m. or 11:30 a.m. tomorrow.")).toEqual([]);
  });
});
