import { chapterErrors, TYPOGRAPHIC_DASH_ERROR } from "../chapters";
import {
  chapterName,
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
 * last word, whichever is later. A dash in a chapter's text is chapter-dash's.
 */
export function rule(meeting: RuleMeeting): InvalidChapter[] {
  const chapters = meeting.chapters ?? [];
  const end = Math.max(
    meeting.durationSecs ?? 0,
    ...speechSpans(meeting).map((s) => s.end),
  );
  return chapterErrors(chapters, end)
    .filter((e) => e.message !== TYPOGRAPHIC_DASH_ERROR)
    .map((e) => ({
      code,
      message: `${chapterName(chapters, e.chapter)} ${e.message}`,
      chapterIndex: e.chapter,
      atSecs: chapters[e.chapter]!.start,
    }));
}
