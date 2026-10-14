import { type ChapterSpan, chapterErrors } from "../chapters";
import { hasTypographicDash, plainDashes } from "../text";
import {
  chapterName,
  type Fix,
  type InChapter,
  type RuleMeeting,
  type Severity,
  speechSpans,
  type Violation,
} from "./common";

export const code = "invalid-chapter";

export type InvalidChapter = Violation<typeof code> & InChapter;

export const defaultSeverity = "error" satisfies Severity;

/**
 * A chapter that is out of order, overlapping, empty or outside the meeting,
 * by the rules in ../chapters.ts. The meeting ends at `durationSecs` or its
 * last word, whichever is later.
 */
export function rule(meeting: RuleMeeting): InvalidChapter[] {
  const chapters = meeting.chapters ?? [];
  const end = Math.max(
    meeting.durationSecs ?? 0,
    ...speechSpans(meeting).map((s) => s.end),
  );
  return chapterErrors(chapters, end).map((e) => ({
    code,
    message: `${chapterName(chapters, e.chapter)} ${e.message}`,
    chapterIndex: e.chapter,
    atSecs: chapters[e.chapter]!.start,
  }));
}

/**
 * Writes a plain hyphen for every en or em dash in a chapter's text. The rest
 * of what the rule finds takes judgment.
 */
export const fix: Fix = (meeting) => {
  const { chapters } = meeting;
  const dashed = (c: ChapterSpan) =>
    [c.title, c.summary ?? "", ...c.bullets].some(hasTypographicDash);
  if (!chapters?.some(dashed)) return meeting;
  return {
    ...meeting,
    chapters: chapters.map((c) =>
      dashed(c)
        ? {
            ...c,
            title: plainDashes(c.title),
            ...(c.summary !== undefined && { summary: plainDashes(c.summary) }),
            bullets: c.bullets.map(plainDashes),
          }
        : c,
    ),
  };
};
