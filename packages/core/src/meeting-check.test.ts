import { describe, expect, it } from "vitest";
import { type CheckedSegment, checkMeeting } from "./meeting-check";

/** A segment from `[onset, word]` pairs. */
const seg = (
  speaker: string | null,
  ...words: [number, string][]
): CheckedSegment => ({
  speaker,
  words: words.map(([start, text]) => ({ start, text })),
});

const codes = (...args: Parameters<typeof checkMeeting>) =>
  checkMeeting(...args).map((i) => `${i.severity} ${i.code}`);

describe("checkMeeting", () => {
  it("accepts a clean meeting", () => {
    expect(
      codes({
        bodyCount: 1,
        segments: [seg("a", [1, "Hello."]), seg("b", [2, "Hi."])],
        chapters: [{ start: 0, end: 2.5, title: "Greetings", bullets: [] }],
      }),
    ).toEqual([]);
  });

  it("reports the transcript's errors with where they are", () => {
    const issues = checkMeeting({
      bodyCount: 0,
      segments: [
        seg("a", [1, "Um,"], [1.2, "the"], [3, "vote."]),
        seg("b", [2.5, "late"], [2, "early."]),
        seg("a"),
      ],
    });
    expect(issues.map((i) => [i.code, i.segment, i.word])).toEqual([
      ["no-bodies", undefined, undefined],
      ["unclean-word", 0, 0],
      ["segment-order", 1, 0],
      ["word-order", 1, 1],
      ["empty-segment", 2, undefined],
    ]);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
  });

  it("warns about a speaker change inside a sentence", () => {
    const segments = [
      seg("a", [1, "Allegiance?"], [4.68, "I"]),
      seg("b", [4.84, "pledge"], [5.32, "allegiance."]),
    ];
    expect(codes({ segments })).toEqual(["warning split-sentence"]);
    // The same speaker either side is one turn, however it is split.
    expect(
      codes({ segments: segments.map((s) => ({ ...s, speaker: "a" })) }),
    ).toEqual([]);
  });

  it("checks chapters against the meeting's length", () => {
    const segments = [seg("a", [0, "Start."], [100, "End."])];
    const chapter = (start: number, end: number) => ({
      start,
      end,
      title: `${start}`,
      bullets: [],
    });
    expect(
      codes({ segments, durationSecs: 200, chapters: [chapter(0, 150)] }),
    ).toEqual([]);
    expect(codes({ segments, chapters: [chapter(0, 150)] })).toEqual([
      "error chapter",
    ]);
    expect(codes({ segments, chapters: [chapter(0, 50)] })).toEqual([
      "warning uncovered-speech",
    ]);
  });
});
