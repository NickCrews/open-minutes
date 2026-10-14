import { hasTypographicDash, plainDashes } from "../text";
import type { ChapterSpan } from "../chapters";
import {
  type AtWord,
  chapterName,
  type Fixed,
  type InChapter,
  type RuleMeeting,
  type Severity,
  type Violation,
} from "./common";

export const code = "typographic-dash";

/** One of the meeting's own text fields. */
export interface InField {
  field: "title" | "description";
}

export type TypographicDash = Violation<typeof code> &
  (AtWord | InChapter | InField);

export const defaultSeverity = "error" satisfies Severity;

const PLAIN_HYPHEN = "has an en or em dash; write a plain hyphen (-)";

function chapterHasDash(c: ChapterSpan): boolean {
  return [c.title, c.summary ?? "", ...c.bullets].some(hasTypographicDash);
}

/**
 * An en or em dash anywhere in a meeting's text: its title and description,
 * its transcript's words, and its chapters' titles, summaries and bullets.
 * Stored text writes a plain hyphen (see ../text.ts).
 */
export function rule(meeting: RuleMeeting): TypographicDash[] {
  const fields = (["title", "description"] as const).flatMap(
    (field): TypographicDash[] =>
      hasTypographicDash(meeting[field] ?? "")
        ? [{ code, message: `the meeting's ${field} ${PLAIN_HYPHEN}`, field }]
        : [],
  );
  const words = meeting.segments.flatMap(({ words }, segmentIndex) =>
    words.flatMap((w, wordIndex): TypographicDash[] =>
      hasTypographicDash(w.text)
        ? [
            {
              code,
              message: `word ${JSON.stringify(w.text)} ${PLAIN_HYPHEN}`,
              segmentIndex,
              wordIndex,
              atSecs: w.start,
            },
          ]
        : [],
    ),
  );
  const chapters = meeting.chapters ?? [];
  const inChapters = chapters.flatMap((c, chapterIndex): TypographicDash[] =>
    chapterHasDash(c)
      ? [
          {
            code,
            message: `${chapterName(chapters, chapterIndex)} ${PLAIN_HYPHEN}`,
            chapterIndex,
            atSecs: c.start,
          },
        ]
      : [],
  );
  return [...fields, ...words, ...inChapters];
}

/** Writes a plain hyphen for every en and em dash. */
export function fix<M extends RuleMeeting>(
  meeting: M,
  violations: readonly TypographicDash[],
): Fixed<M, TypographicDash> {
  if (violations.length === 0) return { meeting, fixed: [] };
  return {
    meeting: {
      ...meeting,
      ...(meeting.title !== undefined && { title: plainDashes(meeting.title) }),
      ...(meeting.description !== undefined && {
        description: plainDashes(meeting.description),
      }),
      segments: meeting.segments.map((seg) =>
        seg.words.some((w) => hasTypographicDash(w.text))
          ? {
              ...seg,
              words: seg.words.map((w) =>
                hasTypographicDash(w.text)
                  ? { ...w, text: plainDashes(w.text) }
                  : w,
              ),
            }
          : seg,
      ),
      ...(meeting.chapters && {
        chapters: meeting.chapters.map((c) =>
          chapterHasDash(c)
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
      }),
    },
    fixed: [...violations],
  };
}
