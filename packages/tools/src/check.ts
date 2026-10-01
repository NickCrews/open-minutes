import { eq, isNotNull } from "drizzle-orm";
import { meetingsTable, peopleTable } from "@open-minutes/db";
import {
  chapterErrors,
  chapterWarnings,
  uncoveredSpeech,
} from "@open-minutes/core/chapters";
import { selfIntroductions } from "@open-minutes/core/self-introductions";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import { type Db, ToolError } from "./tool";
import { intervalSecs, loadChapters, loadSegments, speakerOf } from "./load";

/** Something wrong, or probably wrong, with a meeting's data. */
export interface Issue {
  /** error: the data is wrong. warning: probably wrong, or a broken convention. */
  severity: "error" | "warning";
  message: string;
  segmentId?: number;
  chapterId?: number;
  /** Seconds into the meeting, where the problem is. */
  at?: number;
}

/**
 * Check a meeting's transcript and chapters against the rules in
 * @open-minutes/core: words in time order, segments not interleaved, chapters
 * valid, every stretch of speech in a chapter, and speakers labelled as
 * someone other than who they say they are.
 */
export async function checkMeeting(
  db: Db,
  meetingId: number,
): Promise<Issue[]> {
  const [meeting] = await db
    .select({ duration: meetingsTable.duration_secs })
    .from(meetingsTable)
    .where(eq(meetingsTable.id, meetingId));
  if (!meeting) throw new ToolError(`No meeting ${meetingId}`);
  const segments = await loadSegments(db, meetingId);
  const chapters = await loadChapters(db, meetingId);
  const known = (await db
    .select({
      id: peopleTable.id,
      slug: peopleTable.slug,
      name: peopleTable.name,
    })
    .from(peopleTable)
    .where(isNotNull(peopleTable.slug))) as {
    id: number;
    slug: string;
    name: string | null;
  }[];
  const issues: Issue[] = [];

  let prevLast = -Infinity;
  let prevId: number | undefined;
  for (const seg of segments) {
    const onsets = seg.words.map((w) => w.start);
    if (onsets.some((t, i) => i > 0 && t < onsets[i - 1]!))
      issues.push({
        severity: "error",
        message: "words are out of time order within the segment",
        segmentId: seg.id,
        at: onsets[0],
      });
    if (onsets[0]! < prevLast)
      issues.push({
        severity: "error",
        message: `starts before segment ${prevId} has finished speaking; the two interleave`,
        segmentId: seg.id,
        at: onsets[0],
      });
    prevLast = Math.max(prevLast, onsets.at(-1)!);
    prevId = seg.id;

    const speaker = speakerOf(seg);
    const people = known.map((p) => ({ ...p, name: p.name ?? p.slug }));
    for (const intro of selfIntroductions(seg.words, people)) {
      if (
        speaker &&
        "personId" in speaker &&
        speaker.personId === intro.person.id
      )
        continue;
      issues.push({
        severity: "warning",
        message: `speaker says "${intro.phrase}" but is labelled ${describe(speaker)}; should this be person ${intro.person.id} (${intro.person.slug})? If the speaker changes partway through, split the segment first.`,
        segmentId: seg.id,
        at: seg.words[intro.word]!.start,
      });
    }
  }

  const speech = segments.map((s) => ({
    start: s.words[0]!.start,
    end: s.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
  }));
  const duration = Math.max(
    meeting.duration ? (intervalSecs(meeting.duration) ?? 0) : 0,
    ...speech.map((s) => s.end),
  );
  const at = (i: number) => ({
    chapterId: chapters[i]!.id,
    at: chapters[i]!.start,
  });
  for (const e of chapterErrors(chapters, duration))
    issues.push({
      severity: "error",
      message: `chapter "${chapters[e.chapter]!.title}" ${e.message}`,
      ...at(e.chapter),
    });
  for (const w of chapterWarnings(chapters))
    issues.push({
      severity: "warning",
      message: `chapter "${chapters[w.chapter]!.title}" ${w.message}`,
      ...at(w.chapter),
    });
  if (chapters.length)
    for (const gap of uncoveredSpeech(speech, chapters))
      issues.push({
        severity: "warning",
        message: `speech from ${gap.start.toFixed(2)}s to ${gap.end.toFixed(2)}s is in no chapter`,
        at: gap.start,
      });
  return issues;
}

function describe(speaker: ReturnType<typeof speakerOf>): string {
  if (!speaker) return "unattributed";
  if ("speakerNumber" in speaker)
    return `speaker number ${speaker.speakerNumber}`;
  return `person ${speaker.personId}${speaker.slug ? ` (${speaker.slug})` : " (anonymous)"}`;
}
