import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CHAPTER_RULE_SPECS,
  checkMeeting,
  fixMeeting,
  LOCAL_STYLE_RULE_SPECS,
  type MeetingIssue,
  type MeetingViolation,
  RULE_SPECS,
  RULE_SPECS_BY_CODE,
  STYLE_RULE_SPECS,
  styleRuleSpecs,
} from ".";
import type { RuleSpec, Violation } from "./common";
import { seg, words } from "./testing";
import * as splitSentence from "./split-sentence";
import type { SplitSentence } from "./split-sentence";

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

  it("checks the written style only when asked to", async () => {
    const segments = [
      seg("a", [1, "AR"], [1.3, "2026"], [1.6, "48"], [2, "passed"]),
      seg("b", [3, "on"], [3.2, "the"], [3.4, "twenty"], [3.6, "fourth."]),
    ];
    expect(await codes({ segments })).toEqual([]);
    expect(
      await codes({ segments }, [...RULE_SPECS, ...STYLE_RULE_SPECS]),
    ).toEqual(["warning spelled-number", "warning split-numeral"]);
    // Anchorage's bill numbers only when a jurisdiction opts in.
    expect(
      await codes({ segments }, [
        ...RULE_SPECS,
        ...styleRuleSpecs(LOCAL_STYLE_RULE_SPECS.anchorage),
      ]),
    ).toEqual([
      "error bill-number",
      "warning spelled-number",
      "warning split-numeral",
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

describe("the style rules", () => {
  const found = async (sentence: string, specs = STYLE_RULE_SPECS) =>
    (
      await checkMeeting(
        { segments: [{ speaker: null, words: words(sentence) }] },
        specs,
      )
    ).map((i) => `${i.code}: ${i.text}`);

  it("accept the house style", async () => {
    const all = styleRuleSpecs(LOCAL_STYLE_RULE_SPECS.anchorage);
    for (const s of [
      "Item 14.C is AO 2026-18, an ordinance amending AMC 3.70.190.",
      "AO 2025-144(S) and AO 2025-74(S-2) and AR 2026-7.",
      "AO 2026 unnumbered, an ordinance amending chapter 21.05.",
      "Assembly memorandum AM 142-2026 has passed.",
      "AMC 25.35.060C and 21.05.040G.2.b and AS 44.62.310.",
      "Rezone from R-4 SL to R-4, near B-3 and gR-1 and CE-R-10.",
      "We meet at 7 p.m. or 11:30 a.m. tomorrow.",
      "It costs $10, or $36,000, or $1.5 million, or 6 cents.",
      "An increase of 1% or 3.79% a year.",
      "On February 17, 2026, and again on the 27th.",
      "The February one isn't out. May one of you second?",
      "Passes 5-0 on a vote of 12 to 0.",
      "We need a second, one more time.",
    ])
      expect(await found(s, all), s).toEqual([]);
  });

  it("leave Anchorage's identifiers to the Anchorage rules", async () => {
    expect(await found("AR 2026 48, item 10 B1, section 2103050, R4.")).toEqual(
      ["split-numeral: 2026 48,"],
    );
    expect(await found("section three dot seventy at 7 pm")).toEqual([
      "spoken-separator: three dot seventy",
      "time: 7 pm",
      "spelled-number: seventy",
    ]);
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

  it("finds a written-form rule, local ones included", () => {
    expect(RULE_SPECS_BY_CODE["bill-number"].defaultSeverity).toBe("error");
    expectTypeOf<
      (typeof RULE_SPECS_BY_CODE)["split-numeral"]["defaultSeverity"]
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
      Exclude<MeetingIssue["code"], (typeof STYLE_RULE_SPECS)[number]["code"]>
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
});
