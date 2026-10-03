import { execFileSync } from "node:child_process";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  type DB,
  HUMAN_VERSION,
  type ProcessingRunStatus,
  type ProcessingStep,
  processingRunsTable,
} from "@open-minutes/db";

// The state of a meeting's processing steps, derived from its rows in
// `processing_runs` (the audit trail; see ADR 0005), and the helpers that
// record a run. The derivation is pure, so its rules are tested without a
// database.

export { HUMAN_VERSION, UNTRACKED_VERSION } from "@open-minutes/db";

/**
 * A run still `running` after this long is taken to have died (a runner
 * killed at its timeout never records its failure), so the step can be picked
 * up again. Longer than any processing job's timeout.
 */
export const ABANDONED_AFTER_MS = 6 * 60 * 60_000;

/**
 * After this many failed runs at the current version, a step is left alone by
 * the scheduled sweep (a private or audio-less video would otherwise be
 * retried forever). Processing the meeting by hand still retries it, and a new
 * version starts the count again.
 */
export const MAX_ATTEMPTS = 3;

/** The fields of a `processing_runs` row the state is derived from. */
export interface RunRecord {
  step: ProcessingStep;
  version: string;
  status: ProcessingRunStatus;
  started_at: Date;
  finished_at: Date | null;
  error: string | null;
}

/** What a step needs to have its state derived. */
export interface StepSpec {
  name: ProcessingStep;
  /** The step's version in this code. */
  version: string;
  /** Steps whose output this one is made from. */
  after: readonly ProcessingStep[];
}

/**
 * Where one step stands for one meeting:
 * - `pending`: never succeeded; due. `failures` counts failed runs at the
 *   current version so far.
 * - `running`: a run started less than {@link ABANDONED_AFTER_MS} ago.
 * - `blocked`: a step it is made from hasn't succeeded yet.
 * - `failed`: never succeeded, and failed {@link MAX_ATTEMPTS} times at the
 *   current version. Not retried by the sweep.
 * - `done`: succeeded at the current version (or by a human), after
 *   everything it is made from.
 * - `stale`: succeeded, but at an older version, or before a step it is made
 *   from was redone. Its output stands until it is reprocessed.
 */
export type StepState =
  | { kind: "pending"; failures: number }
  | { kind: "running"; since: Date }
  | { kind: "blocked"; on: ProcessingStep }
  | { kind: "failed"; failures: number; error: string | null }
  | { kind: "done"; version: string; at: Date }
  | {
      kind: "stale";
      version: string;
      at: Date;
      /** Why: an older version, or which step was redone since. */
      because: "version" | ProcessingStep;
    };

/** The latest successful run of `step`, if any. */
function lastSuccess(
  runs: readonly RunRecord[],
  step: ProcessingStep,
): RunRecord | undefined {
  let latest: RunRecord | undefined;
  for (const run of runs) {
    if (run.step !== step || run.status !== "succeeded") continue;
    if (!latest || run.finished_at! >= latest.finished_at!) latest = run;
  }
  return latest;
}

/**
 * The state of `step` for one meeting, from all of that meeting's runs (in any
 * order) at time `now`.
 */
export function stepState(
  runs: readonly RunRecord[],
  step: StepSpec,
  now: Date = new Date(),
): StepState {
  const own = runs.filter((r) => r.step === step.name);
  const latest = own.reduce<RunRecord | undefined>(
    (a, r) => (!a || r.started_at >= a.started_at ? r : a),
    undefined,
  );
  if (
    latest?.status === "running" &&
    now.getTime() - latest.started_at.getTime() < ABANDONED_AFTER_MS
  ) {
    return { kind: "running", since: latest.started_at };
  }

  const upstream = step.after.map((name) => ({
    name,
    success: lastSuccess(runs, name),
  }));
  const missing = upstream.find((u) => !u.success);
  if (missing) return { kind: "blocked", on: missing.name };

  const success = lastSuccess(runs, step.name);
  if (success) {
    const at = success.finished_at!;
    const { version } = success;
    if (version === HUMAN_VERSION) return { kind: "done", version, at };
    if (version !== step.version) {
      return { kind: "stale", version, at, because: "version" };
    }
    const redone = upstream.find((u) => u.success!.finished_at! > at);
    if (redone) return { kind: "stale", version, at, because: redone.name };
    return { kind: "done", version, at };
  }

  const failed = own.filter(
    (r) => r.status === "failed" && r.version === step.version,
  );
  if (failed.length >= MAX_ATTEMPTS) {
    const last = failed.reduce((a, r) => (r.started_at > a.started_at ? r : a));
    return { kind: "failed", failures: failed.length, error: last.error };
  }
  return { kind: "pending", failures: failed.length };
}

/** Which states to run a step from. */
export interface DueOptions {
  /** Also redo `stale` steps. */
  stale?: boolean;
  /** Also retry `failed` steps (past {@link MAX_ATTEMPTS}). */
  retry?: boolean;
}

/** Whether a step in `state` should be run now. */
export function isDue(state: StepState, options: DueOptions = {}): boolean {
  switch (state.kind) {
    case "pending":
      return true;
    case "stale":
      return options.stale ?? false;
    case "failed":
      return options.retry ?? false;
    default:
      return false;
  }
}

/** One line for a person: "done (v1, 2026-10-03)", "failed 3×: ...". */
export function describeState(state: StepState): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  switch (state.kind) {
    case "pending":
      return state.failures > 0
        ? `pending (failed ${state.failures}×)`
        : "pending";
    case "running":
      return `running since ${state.since.toISOString()}`;
    case "blocked":
      return `waiting on ${state.on}`;
    case "failed":
      return `failed ${state.failures}×: ${state.error ?? "unknown error"}`;
    case "done":
      return `done (${state.version}, ${day(state.at)})`;
    case "stale":
      return state.because === "version"
        ? `stale (${state.version}, ${day(state.at)})`
        : `stale (${state.because} redone since ${day(state.at)})`;
  }
}

/** Every run of each of `meetingIds`, keyed by meeting id. */
export async function loadRuns(
  db: DB,
  meetingIds: readonly number[],
): Promise<Map<number, RunRecord[]>> {
  const byMeeting = new Map<number, RunRecord[]>(
    meetingIds.map((id) => [id, []]),
  );
  if (meetingIds.length === 0) return byMeeting;
  const rows = await db
    .select({
      meeting_id: processingRunsTable.meeting_id,
      step: processingRunsTable.step,
      version: processingRunsTable.version,
      status: processingRunsTable.status,
      started_at: processingRunsTable.started_at,
      finished_at: processingRunsTable.finished_at,
      error: processingRunsTable.error,
    })
    .from(processingRunsTable)
    .where(inArray(processingRunsTable.meeting_id, [...meetingIds]))
    .orderBy(asc(processingRunsTable.id));
  for (const { meeting_id, ...run } of rows)
    byMeeting.get(meeting_id)!.push(run);
  return byMeeting;
}

/**
 * Where this process runs, for a run's `run_url` and `details`: the GitHub
 * Actions run when on a runner, and the commit checked out. (Not GITHUB_SHA:
 * the processing workflows check out `production`, not the commit that
 * triggered them.)
 */
export function runEnvironment(env = process.env): {
  runUrl: string | null;
  commit: string | null;
} {
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  return { runUrl, commit: localCommit() };
}

let cachedCommit: string | null | undefined;
function localCommit(): string | null {
  if (cachedCommit === undefined) {
    try {
      cachedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      cachedCommit = null;
    }
  }
  return cachedCommit;
}

/** Record that `step` has started for a meeting. Returns the run's id. */
export async function startRun(
  db: DB,
  meetingId: number,
  step: StepSpec,
): Promise<number> {
  const { runUrl, commit } = runEnvironment();
  const [run] = await db
    .insert(processingRunsTable)
    .values({
      meeting_id: meetingId,
      step: step.name,
      version: step.version,
      run_url: runUrl,
      details: { commit },
    })
    .returning({ id: processingRunsTable.id });
  return run!.id;
}

/** Anything with `update`: the database, or a transaction on it. */
type Updatable = Pick<DB, "update">;

/**
 * Record that a run succeeded. Call it inside the transaction that writes the
 * step's output, so the output and its record commit together.
 */
export async function succeedRun(
  db: Updatable,
  runId: number,
  details: Record<string, unknown>,
): Promise<void> {
  const { commit } = runEnvironment();
  await db
    .update(processingRunsTable)
    .set({
      status: "succeeded",
      // The database's clock, like started_at's default.
      finished_at: sql`now()`,
      details: { commit, ...details },
    })
    .where(eq(processingRunsTable.id, runId));
}

/** Record that a run failed with `error`. */
export async function failRun(
  db: Updatable,
  runId: number,
  error: unknown,
): Promise<void> {
  await db
    .update(processingRunsTable)
    .set({
      status: "failed",
      finished_at: sql`now()`,
      error: describeError(error),
    })
    .where(eq(processingRunsTable.id, runId));
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
