import { describe, expect, it } from "vitest";
import * as tally from "./tally";
import { foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(tally.rule, sentence);

describe("tally", () => {
  it("finds tallies said in words", () => {
    expect(
      found(
        "Motion passes three, two. It fails four to one. It carries five zero.",
      ),
    ).toEqual(["three, two.", "four to one.", "five zero."]);
  });

  it("accepts tallies written the house way", () => {
    expect(found("Passes 5-0 on a vote of 12 to 0.")).toEqual([]);
  });
});
