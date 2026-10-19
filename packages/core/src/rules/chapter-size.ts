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

/** Shortest and longest a substantive chapter should run, in seconds. */
export const SUBSTANTIVE_MIN_SECS = 60;
export const SUBSTANTIVE_MAX_SECS = 15 * 60;
/** Bullet counts: substantive chapters get 3–7, short procedural ones 0–1. */
export const SUBSTANTIVE_BULLETS = { min: 3, max: 7 } as const;
export const PROCEDURAL_MAX_BULLETS = 1;

/**
 * A chapter that breaks the size conventions: a chapter with 0–1 bullets is a
 * short procedural one and may be any length; one with more is substantive,
 * gets 3–7 bullets, and runs 1 to 15 minutes. These are prompt guidance more
 * than invariants, so they're warnings.
 */
export function rule(meeting: RuleMeeting): ChapterSize[] {
  const chapters = meeting.chapters ?? [];
  return chapters.flatMap((c, i) => {
    const n = c.bullets.length;
    if (n <= PROCEDURAL_MAX_BULLETS) return [];
    const problems: string[] = [];
    if (n < SUBSTANTIVE_BULLETS.min || n > SUBSTANTIVE_BULLETS.max)
      problems.push(
        `has ${n} bullets; want ${SUBSTANTIVE_BULLETS.min}–${SUBSTANTIVE_BULLETS.max}, or 0–${PROCEDURAL_MAX_BULLETS} for a procedural chapter`,
      );
    const secs = c.end - c.start;
    if (secs < SUBSTANTIVE_MIN_SECS || secs > SUBSTANTIVE_MAX_SECS)
      problems.push(
        `runs ${Math.round(secs)}s; a substantive chapter (2+ bullets) should run ${SUBSTANTIVE_MIN_SECS}–${SUBSTANTIVE_MAX_SECS}s`,
      );
    return problems.map((problem) => ({
      code,
      message: `${chapterName(chapters, i)} ${problem}`,
      chapterIndex: i,
      atSecs: c.start,
    }));
  });
}
