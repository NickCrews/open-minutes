// A meeting's chapters, as the web page navigates them. The rules chapters
// must follow are in ./rules, with the rest of the meeting rules.

/** The part of a chapter the rules look at, with times in seconds. */
export interface ChapterSpan {
  start: number;
  end: number;
  title: string;
  summary?: string;
  bullets: readonly string[];
}

/** A stretch of audio, in seconds, eg a segment or a gap. */
export interface Span {
  start: number;
  end: number;
}

/**
 * A `?t=` link landing this close before a chapter start resolves to that
 * chapter, so a link to a chapter survives its start being nudged later.
 */
export const SNAP_SECS = 10;

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
