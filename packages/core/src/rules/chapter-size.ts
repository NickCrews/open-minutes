import { chapterWarnings } from "../chapters";
import {
  chapterName,
  type InChapter,
  type RuleMeeting,
  type Violation,
} from "./common";

export type ChapterSize = Violation<"chapter-size"> & InChapter;

/** A chapter outside the size conventions in ../chapters.ts. */
export function chapterSize(meeting: RuleMeeting): ChapterSize[] {
  const chapters = meeting.chapters ?? [];
  return chapterWarnings(chapters).map((w) => ({
    code: "chapter-size",
    message: `${chapterName(chapters, w.chapter)} ${w.message}`,
    chapterIndex: w.chapter,
    atSecs: chapters[w.chapter]!.start,
  }));
}
