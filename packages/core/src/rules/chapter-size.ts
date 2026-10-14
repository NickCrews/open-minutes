import { chapterWarnings } from "../chapters";
import {
  chapterName,
  type InChapter,
  type RuleMeeting,
  type Severity,
  type Violation,
} from "./common";

export const code = "chapter-size";

export type ChapterSize = Violation<typeof code> & InChapter;

export const defaultSeverity = "warning" satisfies Severity;

/** A chapter outside the size conventions in ../chapters.ts. */
export function rule(meeting: RuleMeeting): ChapterSize[] {
  const chapters = meeting.chapters ?? [];
  return chapterWarnings(chapters).map((w) => ({
    code,
    message: `${chapterName(chapters, w.chapter)} ${w.message}`,
    chapterIndex: w.chapter,
    atSecs: chapters[w.chapter]!.start,
  }));
}
