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
 * A chapter with no title or a blank bullet, or that is out of order,
 * overlapping, empty or outside the meeting. The meeting ends at
 * `durationSecs` or its last word, whichever is later. The database refuses
 * most of these too; this says which chapter is at fault.
 */
export function rule(meeting: RuleMeeting): InvalidChapter[] {
  const chapters = meeting.chapters ?? [];
  const end = Math.max(
    meeting.durationSecs ?? 0,
    ...speechSpans(meeting).map((s) => s.end),
  );
  return chapters.flatMap((c, i) => {
    const problems: string[] = [];
    if (!c.title.trim()) problems.push("has no title");
    if (c.bullets.some((b) => !b.trim())) problems.push("has a blank bullet");
    if (c.start < 0) problems.push("starts before the meeting");
    if (c.end <= c.start) problems.push("doesn't end after it starts");
    if (c.end > end) problems.push("ends after the meeting does");
    const prev = chapters[i - 1];
    if (prev && c.start < prev.end)
      problems.push("starts before the previous chapter ends");
    return problems.map((problem) => ({
      code,
      message: `${chapterName(chapters, i)} ${problem}`,
      chapterIndex: i,
      atSecs: c.start,
    }));
  });
}
