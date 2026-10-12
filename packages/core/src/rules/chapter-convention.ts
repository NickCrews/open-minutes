import { chapterWarnings } from "../chapters";
import {
  chapterName,
  type InChapter,
  type RuleMeeting,
  type Violation,
} from "./common";

export type ChapterConvention = Violation<"chapter-convention"> & InChapter;

/** A chapter outside the size conventions in ../chapters.ts. */
export function chapterConvention(meeting: RuleMeeting): ChapterConvention[] {
  const chapters = meeting.chapters ?? [];
  return chapterWarnings(chapters).map((w) => ({
    code: "chapter-convention",
    message: `${chapterName(chapters, w.chapter)} ${w.message}`,
    chapter: w.chapter,
    at: chapters[w.chapter]!.start,
  }));
}
