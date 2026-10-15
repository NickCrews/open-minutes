import { describe, expect, it } from "vitest";
import * as spelledNumber from "./spelled-number";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(spelledNumber.rule, sentence);

describe("spelled-number", () => {
  it("finds numbers of 10 or more, and runs of number words", () => {
    expect(
      found(
        "AO twenty twenty six dash twenty passed on a vote of eleven to zero, five zero.",
      ),
    ).toEqual(["twenty twenty six", "twenty", "eleven", "five zero."]);
    expect(found("on the twenty fourth, room one fifty five.")).toEqual([
      "twenty fourth,",
      "one fifty five.",
    ]);
  });

  it("leaves small numbers, sentence starts and plain words alone", () => {
    expect(
      found(
        "Twenty is a lot. The first three hours, one second, one third, a few hundred people, the second one.",
      ),
    ).toEqual([]);
    expect(found("We need a second, one more time.")).toEqual([]);
  });
  it("writes numbers in numerals when their words have one reading", () => {
    const fix = (s: string) => fixWith(spelledNumber, s);
    expect(
      fix("in twenty twenty six, eleven members, thirty-six thousand people,"),
    ).toBe("in 2026, 11 members, 36,000 people,");
    expect(fix("on the twenty fourth, five million, two hundred fifty.")).toBe(
      "on the 24th, 5 million, 250.",
    );
    expect(fix("in nineteen ninety and twenty oh five")).toBe(
      "in 1990 and 2005",
    );
    expect(
      fix("passes five zero, room one fifty five, two thousand twenty six"),
    ).toBe("passes five zero, room one fifty five, two thousand twenty six");
  });
});
