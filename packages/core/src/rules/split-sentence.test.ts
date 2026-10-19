import { describe, expect, it } from "vitest";
import * as splitSentence from "./split-sentence";
import { seg } from "./testing";

// When a boundary splits a sentence is turn-edges.ts's to say, and tested
// there; this rule reports those between different speakers.
describe("split-sentence", () => {
  const segments = [
    seg("a", [1, "Allegiance?"], [4.68, "I"]),
    seg("b", [4.84, "pledge"], [5.32, "allegiance."]),
  ];

  it("reports a speaker change inside a sentence", () => {
    expect(splitSentence.rule({ segments })).toEqual([
      expect.objectContaining({
        code: "split-sentence",
        segmentIndex: 1,
        atSecs: 4.84,
        edgeStartSecs: 4.68,
        misplaced: ["I"],
      }),
    ]);
  });

  it("says nothing when the same speaker is either side", () => {
    expect(
      splitSentence.rule({
        segments: segments.map((s) => ({ ...s, speaker: "a" })),
      }),
    ).toEqual([]);
  });
});
