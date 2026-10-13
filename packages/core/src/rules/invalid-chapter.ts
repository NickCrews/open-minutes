import { chapterErrors } from "../chapters";
import {
  chapterName,
  type InChapter,
  type RuleMeeting,
  speechSpans,
  type Violation,
} from "./common";

export type InvalidChapter = Violation<"invalid-chapter"> & InChapter;

/**
 * A chapter that is out of order, overlapping, empty or outside the meeting,
 * by the rules in ../chapters.ts. The meeting ends at `durationSecs` or its
 * last word, whichever is later.
 */
export function invalidChapter(meeting: RuleMeeting): InvalidChapter[] {
  const chapters = meeting.chapters ?? [];
  const end = Math.max(
    meeting.durationSecs ?? 0,
    ...speechSpans(meeting).map((s) => s.end),
  );
  return chapterErrors(chapters, end).map((e) => ({
    code: "invalid-chapter",
    message: `${chapterName(chapters, e.chapter)} ${e.message}`,
    chapter: e.chapter,
    at: chapters[e.chapter]!.start,
  }));
}
