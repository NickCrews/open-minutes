import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import type { getMeetingById } from "./index";
import {
  assignSpeakers,
  type Segment,
  type SpeakerIdentity,
  speakerKey,
} from "./speaker-identity";

export {
  chapterIndexAt,
  resolveLinkTime,
  type Span,
} from "@open-minutes/core/chapters";

type Meeting = Awaited<ReturnType<typeof getMeetingById>>;
export type Chapter = Meeting["chapters"][number];

/** A speaker and how long they talked within one chapter. */
export type ChapterSpeaker = SpeakerIdentity & { secs: number };

/** Where a segment sits on the timeline, from its word onsets. */
export function segmentSpan(segment: Segment): { start: number; end: number } {
  const words = segment.words;
  const start = words[0]?.start ?? 0;
  const end = (words.at(-1)?.start ?? start) + LAST_WORD_DURATION_SEC;
  return { start, end };
}

/**
 * Who spoke in each chapter, longest first: the segments overlapping the
 * chapter, clipped to it. The same arithmetic as the `chapter_speakers` view,
 * but over the segments the page already has, so names and colors match the
 * transcript's. `identities` comes from assignSpeakers over the whole meeting.
 */
export function chapterSpeakers(
  chapters: readonly { start: number; end: number }[],
  segments: readonly Segment[],
  identities: ReadonlyMap<string, SpeakerIdentity> = assignSpeakers([
    ...segments,
  ]),
): ChapterSpeaker[][] {
  const spans = segments.map(segmentSpan);
  return chapters.map((chapter) => {
    const secsByKey = new Map<string, number>();
    segments.forEach((segment, i) => {
      const span = spans[i]!;
      const overlap =
        Math.min(span.end, chapter.end) - Math.max(span.start, chapter.start);
      if (overlap <= 0) return;
      const key = speakerKey(segment);
      secsByKey.set(key, (secsByKey.get(key) ?? 0) + overlap);
    });
    return [...secsByKey]
      .flatMap(([key, secs]) => {
        const identity = identities.get(key);
        return identity ? [{ ...identity, secs }] : [];
      })
      .sort((a, b) => b.secs - a.secs);
  });
}

/** Where a chapter heading goes in the transcript: before this word. */
export type ChapterAnchor = { chapter: number; word: number };

/**
 * For each segment index, the chapter headings to draw in it. A chapter's
 * heading goes before the first word spoken at or after its start, so a
 * chapter that begins partway through someone's turn splits that segment
 * rather than landing a whole turn early or late. A chapter with no words
 * after its start gets no heading.
 */
export function chapterAnchors(
  chapters: readonly { start: number }[],
  segments: readonly Segment[],
): Map<number, ChapterAnchor[]> {
  const anchors = new Map<number, ChapterAnchor[]>();
  let s = 0;
  let w = 0;
  chapters.forEach((chapter, c) => {
    // Chapters are sorted, so the word pointer only moves forward.
    while (s < segments.length) {
      const words = segments[s]!.words;
      while (w < words.length && words[w]!.start < chapter.start) w++;
      if (w < words.length) break;
      s++;
      w = 0;
    }
    if (s >= segments.length) return;
    const list = anchors.get(s) ?? [];
    list.push({ chapter: c, word: w });
    anchors.set(s, list);
  });
  return anchors;
}

/** One piece of the scrubber: a chapter, or uncovered time between them. */
export type ScrubberPart =
  | { kind: "chapter"; chapter: number; start: number; end: number }
  | { kind: "gap"; start: number; end: number };

/**
 * The scrubber's pieces, in order, spanning 0 to `duration`: each chapter,
 * and a gap wherever no chapter covers the time. With no chapters it is a
 * single gap, which the scrubber draws as a plain bar.
 */
export function scrubberParts(
  chapters: readonly { start: number; end: number }[],
  duration: number,
): ScrubberPart[] {
  const parts: ScrubberPart[] = [];
  let at = 0;
  chapters.forEach((c, i) => {
    const start = Math.max(c.start, at);
    const end = Math.min(c.end, duration);
    if (end <= start) return;
    if (start > at) parts.push({ kind: "gap", start: at, end: start });
    parts.push({ kind: "chapter", chapter: i, start, end });
    at = end;
  });
  if (duration > at) parts.push({ kind: "gap", start: at, end: duration });
  return parts;
}

/** A shareable link to a moment in a meeting. */
export function meetingLink(origin: string, meetingId: number, secs: number) {
  return `${origin}/meetings/${meetingId}?t=${Math.floor(secs)}`;
}
