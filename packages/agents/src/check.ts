import { eq } from "drizzle-orm";
import { meetingsTable } from "@open-minutes/db";
import {
  BODY_RULE_SPECS,
  checkMeeting as checkMeetingData,
  type MeetingIssue,
  RULE_SPECS,
} from "@open-minutes/core/rules";
import { glossaryFor } from "@open-minutes/glossary";
import { glossaryBodies } from "./glossary";
import { type Db, ToolError } from "./tool";
import { intervalSecs, loadChapters, loadSegments } from "./load";

/**
 * Something wrong, or probably wrong, with a meeting's data: a result from
 * @open-minutes/core/rules with its severity, and with the segment
 * and chapter it names given by row id.
 */
export type Issue = Located<MeetingIssue>;

type Located<I> = I extends unknown
  ? Omit<I, "segmentIndex" | "chapterIndex" | "interleaves"> &
      (I extends { segmentIndex: number } ? { segmentId: number } : unknown) &
      (I extends { chapterIndex: number } ? { chapterId: number } : unknown) &
      (I extends { interleaves: unknown }
        ? {
            interleaves: {
              segmentId: number;
              fromSecs: number;
              toSecs: number;
            }[];
          }
        : unknown)
  : never;

/**
 * Check a meeting's bodies, transcript and chapters against the rules in
 * @open-minutes/core/rules, and the body-specific rules of its bodies'
 * glossaries: the same ones the golden fixtures follow.
 */
export async function checkMeeting(
  db: Db,
  meetingId: number,
): Promise<Issue[]> {
  const [meeting] = await db
    .select({
      title: meetingsTable.title,
      description: meetingsTable.description,
      duration: meetingsTable.duration_secs,
    })
    .from(meetingsTable)
    .where(eq(meetingsTable.id, meetingId));
  if (!meeting) throw new ToolError(`No meeting ${meetingId}`);
  const segments = await loadSegments(db, meetingId);
  const chapters = await loadChapters(db, meetingId);
  const bodies = await glossaryBodies(db, meetingId);
  const { rules } = await glossaryFor(bodies);

  const issues = await checkMeetingData(
    {
      title: meeting.title,
      description: meeting.description,
      bodyCount: bodies.length,
      durationSecs: meeting.duration ? intervalSecs(meeting.duration) : null,
      segments: segments.map((s) => ({
        speaker:
          s.person_id != null
            ? `person:${s.person_id}`
            : s.speaker_number != null
              ? `speaker:${s.speaker_number}`
              : null,
        words: s.words,
      })),
      chapters,
    },
    [
      ...RULE_SPECS,
      ...BODY_RULE_SPECS.filter((spec) => rules.includes(spec.code)),
    ],
  );
  return issues.map((issue) => {
    const { segmentIndex, chapterIndex, ...rest } = issue as MeetingIssue & {
      segmentIndex?: number;
      chapterIndex?: number;
    };
    return {
      ...rest,
      ...(issue.code === "segment-out-of-order" && {
        interleaves: issue.interleaves.map(({ segmentIndex: i, ...at }) => ({
          segmentId: segments[i]!.id,
          ...at,
        })),
      }),
      ...(segmentIndex !== undefined && {
        segmentId: segments[segmentIndex]!.id,
      }),
      ...(chapterIndex !== undefined && {
        chapterId: chapters[chapterIndex]!.id,
      }),
    } as Issue;
  });
}
