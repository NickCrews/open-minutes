import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "../transcription";
import * as splitSentence from "./split-sentence";
import { seg, text } from "./testing";

/** Words at the given onsets: "word@onset" pairs separated by spaces. */
function onsets(spec: string): TranscriptWord[] {
  return spec.split(" ").map((pair) => {
    const [text, start] = pair.split("@");
    return { text: text!, start: Number(start) };
  });
}

// splitSentences finds boundaries inside a sentence; the rule reports those
// between different speakers.
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

describe("splitSentences", () => {
  it("finds a sentence's first word left on the previous speaker", () => {
    const [found, ...rest] = splitSentence.splitSentences([
      { words: onsets("of@5.49 Allegiance?@5.65 I@9.33") },
      { words: onsets("pledge@9.49 allegiance@9.97 to@10.61") },
    ]);
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      segment: 1,
      start: 9.49,
      pause: 0.16,
      edgeStart: 9.33,
      edgePause: 3.68,
    });
    expect(text(found!.misplaced)).toBe("I");
  });

  it("finds a sentence's last word given to the next speaker", () => {
    const [found] = splitSentence.splitSentences([
      { words: onsets("Thank@1.0") },
      { words: onsets("you.@1.4 I@6.28 have@6.5 a@6.6 question.@6.8") },
    ]);
    expect(found).toMatchObject({ segment: 1, edgeStart: 6.28 });
    expect(text(found!.misplaced)).toBe("you.");
  });

  it("accepts a boundary at a sentence edge", () => {
    expect(
      splitSentence.splitSentences([
        { words: onsets("Thank@1.0 you.@1.2") },
        { words: onsets("Sure.@1.3") },
      ]),
    ).toEqual([]);
  });

  it("accepts a boundary already at a long pause", () => {
    expect(
      splitSentence.splitSentences([
        { words: onsets("call@1.0 the@1.2 roll@1.4") },
        { words: onsets("and@2.5 Myers.@2.8 Member@7.2 Johnson.@7.5") },
      ]),
    ).toEqual([]);
  });

  it("accepts a boundary where recognition started a new sentence", () => {
    expect(
      splitSentence.splitSentences([
        { words: onsets("want@1.0 to@1.2 do@1.4 in@1.6 the@1.8") },
        { words: onsets("Thanks.@1.9 Yeah,@2.5 just@2.7") },
      ]),
    ).toEqual([]);
  });

  it("still checks a boundary before I", () => {
    expect(
      splitSentence.splitSentences([
        { words: onsets("authority.@1.0 So@2.3") },
        { words: onsets("I'm@2.4 calling@2.6") },
      ]),
    ).toHaveLength(1);
  });

  it("never moves a question across a boundary", () => {
    expect(
      splitSentence.splitSentences([
        { words: onsets("call@1.0 the@1.2 roll@1.4") },
        { words: onsets("member@1.6 Myers?@1.9 Member@6.3 Johnson?@6.6") },
      ]),
    ).toEqual([]);
  });

  it("ignores a pause that is only slightly longer", () => {
    expect(
      splitSentence.splitSentences([
        { words: onsets("done.@1.0 So@1.4") },
        { words: onsets("I@1.6 think@1.8") },
      ]),
    ).toEqual([]);
  });
});
