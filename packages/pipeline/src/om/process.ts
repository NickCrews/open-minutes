import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import {
  type DB,
  type ProcessingStep,
  bodiesTable,
  meetingsTable,
} from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import { type YouTube, youtubeFromEnv } from "../youtube";
import {
  type DueOptions,
  type StepState,
  describeError,
  describeState,
  failRun,
  isDue,
  loadRuns,
  startRun,
  stepState,
  succeedRun,
} from "./runs";
import { STEPS, type Step, type StepMeeting } from "./steps";

/**
 * Root of the per-meeting work directories (one `<body-slug>_<youtubeId>` dir
 * per meeting, holding each stage's artifact for inspection and resume).
 * Lives at packages/pipeline/data/meetings/, gitignored via the root `data/`
 * rule.
 */
export const DEFAULT_WORK_ROOT = fileURLToPath(
  new URL("../../data/meetings/", import.meta.url),
);

export interface ProcessOptions extends DueOptions {
  /** YouTube boundary, injectable for tests. Defaults to {@link youtubeFromEnv}. */
  yt?: YouTube;
  /** Where per-meeting work directories live. Defaults to {@link DEFAULT_WORK_ROOT}. */
  workRoot?: string;
  /** The steps to consider, in order. Defaults to {@link STEPS}. */
  steps?: readonly Step[];
}

/** What happened to one step of one meeting. */
export type StepOutcome =
  | { step: ProcessingStep; outcome: "succeeded"; summary: string }
  /** Not due: done already, running elsewhere, waiting on another step... */
  | { step: ProcessingStep; outcome: "skipped"; state: StepState };

export interface ProcessResult {
  youtubeId: string;
  meetingId: number;
  steps: StepOutcome[];
}

/** A meeting row by YouTube id, with its body's slug. */
async function findMeeting(
  db: DB,
  youtubeId: string,
): Promise<StepMeeting | undefined> {
  const [row] = await db
    .select({
      id: meetingsTable.id,
      youtubeId: meetingsTable.youtube_id,
      nameShort: bodiesTable.name_short,
    })
    .from(meetingsTable)
    .innerJoin(bodiesTable, eq(meetingsTable.body_id, bodiesTable.id))
    .where(eq(meetingsTable.youtube_id, youtubeId));
  return row && { ...row, body: bodySlug({ name_short: row.nameShort }) };
}

/**
 * Run each due step for one meeting, in order, recording every attempt in
 * `processing_runs`. A step is due when it has never succeeded (and hasn't
 * failed {@link MAX_ATTEMPTS} times, unless `retry`), or, with `stale`, when it
 * succeeded at an older version or before a step it is made from was redone.
 *
 * A step's output and its run's success commit in one transaction; a failure
 * records a failed run and stops, since later steps are made from earlier
 * ones. The meeting must already exist (see `discoverMeetings`).
 *
 * @throws if the meeting isn't in the database, or a step fails.
 */
export async function processMeeting(
  db: DB,
  youtubeId: string,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const meeting = await findMeeting(db, youtubeId);
  if (!meeting) {
    throw new Error(
      `No meeting for video ${youtubeId}. Discover it first (\`om discover\`), ` +
        `or ingest it (\`om ingest\`).`,
    );
  }
  const workDir = join(
    options.workRoot ?? DEFAULT_WORK_ROOT,
    `${meeting.body}_${youtubeId}`,
  );

  const outcomes: StepOutcome[] = [];
  for (const step of options.steps ?? STEPS) {
    // Re-read each time: the previous step may have just changed this one's
    // state (from blocked to pending, or done to stale).
    const runs = (await loadRuns(db, [meeting.id])).get(meeting.id)!;
    const state = stepState(runs, step);
    if (!isDue(state, options)) {
      console.error(`[${youtubeId}] ${step.name}: ${describeState(state)}`);
      outcomes.push({ step: step.name, outcome: "skipped", state });
      continue;
    }

    console.error(`[${youtubeId}] ${step.name} ${step.version}: starting`);
    const runId = await startRun(db, meeting.id, step);
    try {
      const output = await step.run({
        db,
        meeting,
        yt: options.yt ?? youtubeFromEnv(),
        workDir,
      });
      await db.transaction(async (tx) => {
        await output.write(tx);
        await succeedRun(tx, runId, output.details);
      });
      console.error(`[${youtubeId}] ${step.name}: done, ${output.summary}`);
      outcomes.push({
        step: step.name,
        outcome: "succeeded",
        summary: output.summary,
      });
    } catch (error) {
      try {
        await failRun(db, runId, error);
      } catch (recordError) {
        // The original error matters more; the run stays `running` until it
        // is taken as abandoned.
        console.error(
          `[${youtubeId}] couldn't record the failure: ${describeError(recordError)}`,
        );
      }
      throw error;
    }
  }
  return { youtubeId, meetingId: meeting.id, steps: outcomes };
}

export interface ProcessBatchSummary {
  results: ProcessResult[];
  failures: Array<{ youtubeId: string; error: unknown }>;
}

/**
 * Process a batch of meetings sequentially, continuing past individual
 * failures. Each failure is logged to stderr; the summary reports every
 * outcome so the caller can decide the exit status.
 */
export async function processMeetings(
  db: DB,
  youtubeIds: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessBatchSummary> {
  const results: ProcessResult[] = [];
  const failures: ProcessBatchSummary["failures"] = [];
  for (const youtubeId of youtubeIds) {
    try {
      results.push(await processMeeting(db, youtubeId, options));
    } catch (error) {
      console.error(`[${youtubeId}] FAILED: ${describeError(error)}`);
      failures.push({ youtubeId, error });
    }
  }
  return { results, failures };
}

/** A meeting with at least one step due. */
export interface PendingMeeting {
  youtubeId: string;
  meetingId: number;
  /** Body slug (eg "gbos"). */
  body: string;
  /** The steps due now, in order. */
  steps: ProcessingStep[];
}

export interface ListPendingOptions extends DueOptions {
  /** Only this body's meetings (by slug, eg "gbos"). */
  body?: string;
  /** At most this many meetings. */
  limit?: number;
  /** The steps to consider. Defaults to {@link STEPS}. */
  steps?: readonly Step[];
}

/**
 * The meetings with a step due (see {@link processMeeting}), newest first:
 * by meeting date where it's known, then most recently discovered. What the
 * scheduled sweep hands out, one processing job per meeting.
 */
export async function listPending(
  db: DB,
  options: ListPendingOptions = {},
): Promise<PendingMeeting[]> {
  const meetings = (
    await db
      .select({
        id: meetingsTable.id,
        youtubeId: meetingsTable.youtube_id,
        nameShort: bodiesTable.name_short,
      })
      .from(meetingsTable)
      .innerJoin(bodiesTable, eq(meetingsTable.body_id, bodiesTable.id))
      .orderBy(
        sql`${meetingsTable.date} DESC NULLS LAST`,
        desc(meetingsTable.created_at),
        desc(meetingsTable.id),
      )
  )
    .map(({ nameShort, ...m }) => ({
      ...m,
      body: bodySlug({ name_short: nameShort }),
    }))
    .filter(
      (m) =>
        options.body === undefined || m.body === options.body.toLowerCase(),
    );

  const runs = await loadRuns(
    db,
    meetings.map((m) => m.id),
  );
  const now = new Date();
  const pending: PendingMeeting[] = [];
  for (const meeting of meetings) {
    const steps = (options.steps ?? STEPS)
      .filter((step) =>
        isDue(stepState(runs.get(meeting.id)!, step, now), options),
      )
      .map((step) => step.name);
    if (steps.length === 0) continue;
    pending.push({
      youtubeId: meeting.youtubeId,
      meetingId: meeting.id,
      body: meeting.body,
      steps,
    });
    if (options.limit !== undefined && pending.length >= options.limit) break;
  }
  return pending;
}
