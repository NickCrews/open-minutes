import { describe, expect, it } from "vitest";
import {
  type CheckedSegment,
  type CheckResult,
  checkBodies,
  CHECKERS,
  checkMeeting,
  STYLE_CHECKERS,
} from "./meeting-check";

/** A segment from `[onset, word]` pairs. */
const seg = (
  speaker: string | null,
  ...words: [number, string][]
): CheckedSegment => ({
  speaker,
  words: words.map(([start, text]) => ({ start, text })),
});

const codes = async (...args: Parameters<typeof checkMeeting>) =>
  (await checkMeeting(...args)).map((i) => `${i.severity} ${i.code}`);

describe("checkMeeting", () => {
  it("accepts a clean meeting", async () => {
    expect(
      await codes({
        bodyCount: 1,
        segments: [seg("a", [1, "Hello."]), seg("b", [2, "Hi."])],
        chapters: [{ start: 0, end: 2.5, title: "Greetings", bullets: [] }],
      }),
    ).toEqual([]);
  });

  it("reports the transcript's errors with where they are", async () => {
    const issues = await checkMeeting({
      bodyCount: 0,
      segments: [
        seg("a", [1, "Um,"], [1.2, "the"], [3, "vote."]),
        seg("b", [2.5, "late"], [2, "early."]),
        seg("a"),
      ],
    });
    expect(
      issues.map((i) => [
        i.code,
        "segment" in i ? i.segment : undefined,
        "word" in i ? i.word : undefined,
      ]),
    ).toEqual([
      ["no-bodies", undefined, undefined],
      ["empty-segment", 2, undefined],
      ["segment-order", 1, 0],
      ["word-order", 1, 1],
      ["unclean-word", 0, 0],
    ]);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
    expect(issues.find((i) => i.code === "unclean-word")).toMatchObject({
      rule: "filler",
      text: "Um,",
      at: 1,
    });
  });

  it("warns about a speaker change inside a sentence", async () => {
    const segments = [
      seg("a", [1, "Allegiance?"], [4.68, "I"]),
      seg("b", [4.84, "pledge"], [5.32, "allegiance."]),
    ];
    expect(await codes({ segments })).toEqual(["warning split-sentence"]);
    // The same speaker either side is one turn, however it is split.
    expect(
      await codes({ segments: segments.map((s) => ({ ...s, speaker: "a" })) }),
    ).toEqual([]);
  });

  it("warns about an answer left in the asker's segment", async () => {
    const segments = [
      seg("clerk", [1, "Member"], [1.3, "Johnson."], [2, "Yes."]),
    ];
    expect(await codes({ segments })).toEqual(["warning folded-answer"]);
  });

  it("checks the written style only when asked to", async () => {
    const segments = [
      seg("a", [1, "AR"], [1.3, "2026"], [1.6, "48"], [2, "passed"]),
      seg("b", [3, "on"], [3.2, "the"], [3.4, "twenty"], [3.6, "fourth."]),
    ];
    expect(await codes({ segments })).toEqual([]);
    expect(await codes({ segments }, [...CHECKERS, ...STYLE_CHECKERS])).toEqual(
      [
        "error written-form",
        "warning spelled-number",
        "warning spelled-number",
      ],
    );
  });

  it("checks chapters against the meeting's length", async () => {
    const segments = [seg("a", [0, "Start."], [100, "End."])];
    const chapter = (start: number, end: number) => ({
      start,
      end,
      title: `${start}`,
      bullets: [],
    });
    expect(
      await codes({ segments, durationSecs: 200, chapters: [chapter(0, 150)] }),
    ).toEqual([]);
    expect(await codes({ segments, chapters: [chapter(0, 150)] })).toEqual([
      "error chapter",
    ]);
    expect(await codes({ segments, chapters: [chapter(0, 50)] })).toEqual([
      "warning uncovered-speech",
    ]);
  });

  it("runs the checkers it is given, sync or async", async () => {
    const checkers = [
      checkBodies,
      async (): Promise<CheckResult<"no-bodies">[]> => [
        { code: "no-bodies", message: "also" },
      ],
    ];
    expect(
      (await checkMeeting({ bodyCount: 0, segments: [] }, checkers)).map(
        (i) => `${i.severity} ${i.message}`,
      ),
    ).toEqual(["error the meeting has no bodies", "error also"]);
  });
});
