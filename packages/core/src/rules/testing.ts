// Helpers for the rules' tests.

import type { Chapter } from "../chapters";
import type { Segment, Word } from "../transcript";
import type { RuleMeeting, Violation } from "./common";

/** A segment from `[onset, word]` pairs, spoken by `person` or unattributed. */
export function seg(
  person: string | null,
  ...words: [number, string][]
): Segment<string> {
  return {
    speakerNumber: null,
    person,
    words: words.map(([start, text]) => ({ start, text })),
  };
}

/** Words from a sentence, `step` seconds apart. */
export function words(sentence: string, step = 0.3): Word[] {
  return sentence.split(" ").map((text, i) => ({ text, start: i * step }));
}

export function text(ws: readonly Word[]): string {
  return ws.map((w) => w.text).join(" ");
}

/** A rule's fix, on its own, over one segment of a sentence's words. */
export function fixWith(
  spec: {
    rule: (meeting: RuleMeeting) => Violation[];
    fix: <M extends RuleMeeting>(
      meeting: M,
      violations: never,
    ) => { meeting: M };
  },
  sentence: string,
  step?: number,
): string {
  const meeting = {
    segments: [
      { speakerNumber: null, person: null, words: words(sentence, step) },
    ],
  };
  const fixed = spec.fix(meeting, spec.rule(meeting) as never);
  return text(fixed.meeting.segments[0]!.words);
}

/** A chapter from `start` to `end` with `bullets` bullets. */
export function chapter(start: number, end: number, bullets = 0): Chapter {
  return {
    start,
    end,
    title: `${start}-${end}`,
    summary: "Summary.",
    bullets: Array.from({ length: bullets }, (_, i) => `bullet ${i}`),
  };
}

/**
 * What a chapter rule says of each chapter, by index, without the chapter's
 * name. The meeting runs 1000s unless `more` says otherwise.
 */
export function chapterProblems(
  rule: (meeting: RuleMeeting) => (Violation & { chapterIndex?: number })[],
  chapters: Chapter[],
  more: { durationSecs?: number; segments?: Segment<string>[] } = {},
): [number | undefined, string][] {
  return rule({ segments: [], durationSecs: 1000, ...more, chapters }).map(
    (v) => [v.chapterIndex, v.message.replace(/^chapter \d+ \(".*?"\) /, "")],
  );
}

/** The words each violation of a word rule is at, in a sentence as one segment. */
export function foundTexts(
  rule: (meeting: RuleMeeting) => (Violation & { text: string })[],
  sentence: string,
): string[] {
  return rule({
    segments: [{ speakerNumber: null, person: null, words: words(sentence) }],
  }).map((v) => v.text);
}
