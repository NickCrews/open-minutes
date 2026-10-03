import { count, desc, eq, inArray } from "drizzle-orm";
import {
  type DB,
  type ProcessingStep,
  bodiesTable,
  meetingsTable,
  segmentsTable,
} from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import { type StepState, loadRuns, stepState } from "./runs";
import { STEPS, type Step } from "./steps";

/** One meeting in the database, as listed by `om status`. */
export interface MeetingStatus {
  youtubeId: string;
  /** Body slug (eg "gbos"). */
  body: string;
  title: string;
  /** "YYYY-MM-DD" in the body's timezone, or null if unknown. */
  date: string | null;
  /** "HH:MM:SS" in the body's timezone, or null if unknown. */
  time: string | null;
  /** Postgres interval rendering (eg "01:23:45"), or null if unknown. */
  durationSecs: string | null;
  segmentCount: number;
  /** Where each processing step stands. */
  steps: Partial<Record<ProcessingStep, StepState>>;
}

/**
 * The meetings in the database, newest first, with where each processing step
 * stands: discovered meetings waiting for their transcript as well as
 * transcribed ones. Pass `ids` to filter to specific YouTube video IDs.
 */
export async function listMeetings(
  db: DB,
  ids?: string[],
  steps: readonly Step[] = STEPS,
): Promise<MeetingStatus[]> {
  const rows = await db
    .select({
      id: meetingsTable.id,
      youtubeId: meetingsTable.youtube_id,
      nameShort: bodiesTable.name_short,
      title: meetingsTable.title,
      date: meetingsTable.date,
      time: meetingsTable.time,
      durationSecs: meetingsTable.duration_secs,
      segmentCount: count(segmentsTable.id),
    })
    .from(meetingsTable)
    .innerJoin(bodiesTable, eq(meetingsTable.body_id, bodiesTable.id))
    .leftJoin(segmentsTable, eq(segmentsTable.meeting_id, meetingsTable.id))
    .where(
      ids && ids.length > 0
        ? inArray(meetingsTable.youtube_id, ids)
        : undefined,
    )
    .groupBy(meetingsTable.id, bodiesTable.id)
    .orderBy(
      desc(meetingsTable.date),
      desc(meetingsTable.time),
      desc(meetingsTable.id),
    );

  const runs = await loadRuns(
    db,
    rows.map((r) => r.id),
  );
  const now = new Date();
  return rows.map(({ id, nameShort, ...row }) => ({
    ...row,
    body: bodySlug({ name_short: nameShort }),
    steps: Object.fromEntries(
      steps.map((step) => [step.name, stepState(runs.get(id)!, step, now)]),
    ),
  }));
}
