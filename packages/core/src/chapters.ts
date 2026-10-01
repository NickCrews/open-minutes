// Rules for a meeting's chapters, shared by whatever writes them (fixtures,
// later the generator) and whatever reads them (the web page). See
// docs/chapters.md for why the rules are what they are.

/** The part of a chapter these rules look at, with times in seconds. */
export interface ChapterSpan {
  start: number;
  end: number;
  title: string;
  bullets: readonly string[];
}

/** A problem with one chapter, by its index in the list. */
export interface ChapterIssue {
  chapter: number;
  message: string;
}

/** A stretch of audio, in seconds, eg a segment or a gap. */
export interface Span {
  start: number;
  end: number;
}

/** Shortest and longest a substantive chapter should run, in seconds. */
export const SUBSTANTIVE_MIN_SECS = 60;
export const SUBSTANTIVE_MAX_SECS = 15 * 60;
/** Bullet counts: substantive chapters get 3–7, short procedural ones 0–1. */
export const SUBSTANTIVE_BULLETS = { min: 3, max: 7 } as const;
export const PROCEDURAL_MAX_BULLETS = 1;
/**
 * Uncovered speech longer than this is a candidate missed topic. Anything
 * shorter is boundary slop between neighbouring chapters.
 */
export const MAX_UNCOVERED_SPEECH_SECS = 30;
/**
 * A `?t=` link landing this close before a chapter start resolves to that
 * chapter, so a link to a chapter survives its start being nudged later.
 */
export const SNAP_SECS = 10;

/**
 * Problems that make a set of chapters wrong: out of order, overlapping,
 * empty, or outside the meeting. The database refuses most of these too; this
 * says which chapter is at fault. Empty when the chapters are valid.
 */
export function chapterErrors(
  chapters: readonly ChapterSpan[],
  durationSecs?: number,
): ChapterIssue[] {
  const errors: ChapterIssue[] = [];
  chapters.forEach((c, i) => {
    const error = (message: string) => errors.push({ chapter: i, message });
    if (!c.title.trim()) error("has no title");
    if (c.bullets.some((b) => !b.trim())) error("has a blank bullet");
    if (c.start < 0) error("starts before the meeting");
    if (c.end <= c.start) error("doesn't end after it starts");
    if (durationSecs !== undefined && c.end > durationSecs)
      error("ends after the meeting does");
    const prev = chapters[i - 1];
    if (prev && c.start < prev.end)
      error("starts before the previous chapter ends");
  });
  return errors;
}

/**
 * Chapters that break the size conventions: a chapter with 0–1 bullets is a
 * short procedural one and may be any length; one with more is substantive,
 * gets 3–7 bullets, and runs 1 to 15 minutes. These are prompt guidance more
 * than invariants, so they're warnings, not errors.
 */
export function chapterWarnings(
  chapters: readonly ChapterSpan[],
): ChapterIssue[] {
  const warnings: ChapterIssue[] = [];
  chapters.forEach((c, i) => {
    const n = c.bullets.length;
    if (n <= PROCEDURAL_MAX_BULLETS) return;
    if (n < SUBSTANTIVE_BULLETS.min || n > SUBSTANTIVE_BULLETS.max)
      warnings.push({
        chapter: i,
        message: `has ${n} bullets; want ${SUBSTANTIVE_BULLETS.min}–${SUBSTANTIVE_BULLETS.max}, or 0–${PROCEDURAL_MAX_BULLETS} for a procedural chapter`,
      });
    const secs = c.end - c.start;
    if (secs < SUBSTANTIVE_MIN_SECS || secs > SUBSTANTIVE_MAX_SECS)
      warnings.push({
        chapter: i,
        message: `runs ${Math.round(secs)}s; a substantive chapter (2+ bullets) should run ${SUBSTANTIVE_MIN_SECS}–${SUBSTANTIVE_MAX_SECS}s`,
      });
  });
  return warnings;
}

/**
 * Stretches of speech that no chapter covers, merged and longer than
 * `minSecs`. Chapters should cover every stretch of speech; anything returned
 * is a candidate missed topic. `speech` and `chapters` needn't be sorted.
 */
export function uncoveredSpeech(
  speech: readonly Span[],
  chapters: readonly Span[],
  minSecs = MAX_UNCOVERED_SPEECH_SECS,
): Span[] {
  const covers = [...chapters].sort((a, b) => a.start - b.start);
  const uncovered: Span[] = [];
  for (const s of [...speech].sort((a, b) => a.start - b.start)) {
    let at = s.start;
    for (const c of covers) {
      if (c.end <= at) continue;
      if (c.start >= s.end) break;
      if (c.start > at) uncovered.push({ start: at, end: c.start });
      at = Math.max(at, c.end);
      if (at >= s.end) break;
    }
    if (at < s.end) uncovered.push({ start: at, end: s.end });
  }
  // Merge pieces that touch, so a gap spanning several segments counts once.
  const merged: Span[] = [];
  for (const u of uncovered) {
    const last = merged.at(-1);
    if (last && u.start <= last.end) last.end = Math.max(last.end, u.end);
    else merged.push({ ...u });
  }
  return merged.filter((u) => u.end - u.start > minSecs);
}

/**
 * Index of the chapter playing at `t`, or -1 when `t` is in a gap, before the
 * first chapter, or after the last. `chapters` must be sorted and
 * non-overlapping.
 */
export function chapterIndexAt(chapters: readonly Span[], t: number): number {
  let lo = 0;
  let hi = chapters.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = chapters[mid]!;
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Where a `?t=` link should land: the chapter containing `t`, or, when `t`
 * falls within {@link SNAP_SECS} before a chapter start, that chapter, seeking
 * to its current start. Inside a chapter, `t` is kept as is, since the link
 * may point at a moment rather than at the chapter.
 */
export function resolveLinkTime(
  chapters: readonly Span[],
  t: number,
): { secs: number; chapter: number } {
  const containing = chapterIndexAt(chapters, t);
  const next = chapters.findIndex((c) => c.start > t);
  const nextChapter = chapters[next];
  if (nextChapter && nextChapter.start - t <= SNAP_SECS) {
    // A link made at the old start of a chapter whose start moved later lands
    // in the tail of the previous chapter or in a gap; either way it meant
    // this one.
    return { secs: nextChapter.start, chapter: next };
  }
  return { secs: t, chapter: containing };
}
