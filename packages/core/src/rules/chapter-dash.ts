import { chapterHasTypographicDash, TYPOGRAPHIC_DASH_ERROR } from "../chapters";
import { plainDashes } from "../text";
import {
  chapterName,
  type Fixed,
  type InChapter,
  type RuleMeeting,
  type Severity,
  type Violation,
} from "./common";

export const code = "chapter-dash";

export type ChapterDash = Violation<typeof code> & InChapter;

export const defaultSeverity = "error" satisfies Severity;

/**
 * An en or em dash in a chapter's title, summary or bullets. Stored text
 * writes a plain hyphen (see ../text.ts).
 */
export function rule(meeting: RuleMeeting): ChapterDash[] {
  const chapters = meeting.chapters ?? [];
  return chapters.flatMap((c, i) =>
    chapterHasTypographicDash(c)
      ? [
          {
            code,
            message: `${chapterName(chapters, i)} ${TYPOGRAPHIC_DASH_ERROR}`,
            chapterIndex: i,
            atSecs: c.start,
          },
        ]
      : [],
  );
}

/** Writes a plain hyphen for every en or em dash in a chapter's text. */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly ChapterDash[],
): Fixed<M, ChapterDash> {
  const { chapters } = meeting;
  if (!chapters || violations.length === 0) return { meeting, fixed: [] };
  return {
    meeting: {
      ...meeting,
      chapters: chapters.map((c) =>
        chapterHasTypographicDash(c)
          ? {
              ...c,
              title: plainDashes(c.title),
              ...(c.summary !== undefined && {
                summary: plainDashes(c.summary),
              }),
              bullets: c.bullets.map(plainDashes),
            }
          : c,
      ),
    },
    fixed: [...violations],
  };
}
