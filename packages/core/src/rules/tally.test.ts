import { describe, expect, it } from "vite-plus/test";
import * as tally from "./tally";
import { fixWith, foundTexts } from "./testing";

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
  it("writes the tally as 5-0", () => {
    expect(
      fixWith(
        tally,
        "Motion passes three, two. It fails four to one. It carries five zero.",
      ),
    ).toBe("Motion passes 3-2. It fails 4-1. It carries 5-0.");
  });
});
