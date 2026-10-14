import { describe, expect, it } from "vitest";
import * as spelledNumber from "./spelled-number";
import { foundTexts } from "./testing";

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
});
