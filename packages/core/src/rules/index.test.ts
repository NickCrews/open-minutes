import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CHAPTER_RULE_SPECS,
  checkMeeting,
  fixMeeting,
  type MeetingIssue,
  type MeetingViolation,
  RULE_SPECS_BY_CODE,
} from ".";
import type { RuleSegment, RuleSpec, Violation } from "./common";
import * as splitSentence from "./split-sentence";
import type { SplitSentence } from "./split-sentence";

/** A segment from `[onset, word]` pairs. */
const seg = (
  speaker: string | null,
  ...words: [number, string][]
): RuleSegment => ({
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
        "segmentIndex" in i ? i.segmentIndex : undefined,
        "wordIndex" in i ? i.wordIndex : undefined,
      ]),
    ).toEqual([
      ["no-bodies", undefined, undefined],
      ["empty-segment", 2, undefined],
      ["segment-out-of-order", 1, 0],
      ["word-out-of-order", 1, 1],
      ["filler-word", 0, 0],
    ]);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
    expect(issues.find((i) => i.code === "filler-word")).toMatchObject({
      text: "Um,",
      atSecs: 1,
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
      "error invalid-chapter",
    ]);
    expect(await codes({ segments, chapters: [chapter(0, 50)] })).toEqual([
      "warning uncovered-speech",
    ]);
  });

  it("runs the rules it is given, sync or async, at their severity", async () => {
    const specs = [
      RULE_SPECS_BY_CODE["no-bodies"],
      {
        rule: async (): Promise<Violation<"no-bodies">[]> => [
          { code: "no-bodies", message: "also" },
        ],
        code: "no-bodies",
        defaultSeverity: "warning",
      } satisfies RuleSpec<Violation<"no-bodies">>,
    ];
    expect(
      (await checkMeeting({ bodyCount: 0, segments: [] }, specs)).map(
        (i) => `${i.severity} ${i.message}`,
      ),
    ).toEqual(["error the meeting has no bodies", "warning also"]);
  });
});

describe("MeetingViolation", () => {
  it("is any rule's violation, or one rule's given its code", () => {
    expectTypeOf<SplitSentence>().toExtend<MeetingViolation>();
    expectTypeOf<
      MeetingViolation<"split-sentence">
    >().toEqualTypeOf<SplitSentence>();
  });
});

describe("RULE_SPECS_BY_CODE", () => {
  it("finds each rule by its code", () => {
    expect(RULE_SPECS_BY_CODE["split-sentence"]).toBe(splitSentence);
    expectTypeOf<
      (typeof RULE_SPECS_BY_CODE)["split-sentence"]["defaultSeverity"]
    >().toEqualTypeOf<"warning">();
  });
});

describe("checkMeeting's result type", () => {
  it("holds only what the given specs can find", async () => {
    const meeting = { segments: [] };
    const chapterIssues = await checkMeeting(meeting, CHAPTER_RULE_SPECS);
    const allIssues = await checkMeeting(meeting);
    expect([chapterIssues, allIssues]).toEqual([[], []]);
    expectTypeOf<(typeof chapterIssues)[number]["code"]>().toEqualTypeOf<
      | "invalid-chapter"
      | "typographic-dash"
      | "chapter-size"
      | "uncovered-speech"
    >();
    expectTypeOf<(typeof allIssues)[number]["code"]>().toEqualTypeOf<
      MeetingIssue["code"]
    >();
  });
});

describe("fixMeeting", () => {
  it("applies fixes until they settle, and reports what they fixed", async () => {
    const { meeting, fixed } = await fixMeeting({
      segments: [
        seg("a", [1, "Um."]),
        seg("b", [2, "The"], [2.2, "the"], [2.4, "vote."]),
      ],
    });
    expect(meeting.segments).toEqual([seg("b", [2.2, "The"], [2.4, "vote."])]);
    expect(fixed.map((v) => [v.code, v.message])).toEqual([
      ["filler-word", 'filler "Um." should not be in a transcript'],
      ["stutter", 'stutter "The" should not be in a transcript'],
      // Left by the filler's removal, and dropped on the next pass.
      ["empty-segment", "a segment with no words"],
    ]);
    expect(await checkMeeting(meeting)).toEqual([]);
  });

  it("keeps what the rules don't look at", async () => {
    const segments = [
      { ...seg("a"), id: 1 },
      { ...seg("b", [1, "Uh,"], [2, "yes."]), id: 2 },
    ];
    const { meeting } = await fixMeeting({ segments, extra: true });
    expect(meeting).toEqual({
      segments: [{ ...seg("b", [2, "Yes."]), id: 2 }],
      extra: true,
    });
  });

  it("returns the meeting given when there is nothing to fix", async () => {
    const meeting = { bodyCount: 0, segments: [seg("a", [1, "Hello."])] };
    expect(await fixMeeting(meeting)).toEqual({ meeting, fixed: [] });
    expect((await fixMeeting(meeting)).meeting).toBe(meeting);
  });

  it("runs only the fixes of the rules it is given", async () => {
    const meeting = { segments: [seg("a"), seg("b", [1, "Um,"], [2, "no."])] };
    const { meeting: fixed } = await fixMeeting(meeting, [
      RULE_SPECS_BY_CODE["empty-segment"],
    ]);
    expect(fixed.segments).toEqual([seg("b", [1, "Um,"], [2, "no."])]);
  });

  it("puts misordered segments in order, but leaves interleaved ones", async () => {
    const late = seg("a", [5, "Later."]);
    const early = seg("b", [1, "First."]);
    expect((await fixMeeting({ segments: [late, early] })).meeting).toEqual({
      segments: [early, late],
    });
    const interleaved = {
      segments: [seg("a", [1, "One"], [3, "three."]), seg("b", [2, "Two."])],
    };
    const { meeting, fixed } = await fixMeeting(interleaved);
    expect(meeting).toBe(interleaved);
    expect(fixed).toEqual([]);
  });

  it("writes a plain hyphen for a dash in a chapter", async () => {
    const chapter = {
      start: 0,
      end: 2,
      title: "Budget – first reading",
      summary: "Items 1—3.",
      bullets: ["2019–2022"],
    };
    const { meeting, fixed } = await fixMeeting({
      segments: [seg("a", [1, "Hello."])],
      chapters: [chapter],
    });
    expect(meeting.chapters).toEqual([
      {
        ...chapter,
        title: "Budget - first reading",
        summary: "Items 1-3.",
        bullets: ["2019-2022"],
      },
    ]);
    expect(fixed.map((v) => [v.code, v.message])).toEqual([
      [
        "typographic-dash",
        'chapter 1 ("Budget – first reading") has an en or em dash; write a plain hyphen (-)',
      ],
    ]);
    // Ending after the meeting has no one right fix.
    expect((await checkMeeting(meeting)).map((i) => i.code)).toEqual([
      "invalid-chapter",
    ]);
  });
});
