// Computing a changeset's diff from a database: run it as `pnpm changeset
// check` does, a statement at a time, diff each meeting a statement changes
// before and after it, and roll it all back.

import type { DB } from "@open-minutes/db";
import type { MeetingIssue } from "@open-minutes/core/rules";
import {
  type AppliedChangeset,
  applyChangeset,
  ChangesetError,
  ChangesetRefused,
  type ChangesetTrace,
  checkChangeset,
  type DbMeeting,
  type DbPerson,
  formatIssue,
  labelOf,
  meetingIssues,
  newIssues,
} from "@open-minutes/edit";
import { effectHash, sqlHash } from "./hash";
import { splitStatements } from "./statements";
import type {
  ChangesetDiff,
  FieldChange,
  IssueView,
  MeetingInfo,
  StatementDiff,
  Transcript,
  VersionRef,
} from "./types";
import { diffTranscripts } from "./words";

export interface BuildOptions {
  db: DB;
  /** The changeset's SQL. */
  sql: string;
  /** The database's name, or its host and database name, to show. Never a URL with a password. */
  base: string;
  /** Where the SQL came from, to show. */
  source?: string | null;
  /** The issue version it is, if it came from one. */
  version?: VersionRef | null;
  /** Words of transcript to show either side of each change. */
  context?: number;
}

export { effectHash, sqlHash, statementEffects } from "./hash";

/**
 * Run a changeset a statement at a time, in one transaction that is rolled
 * back, and report what each statement did to each meeting it changed. A
 * changeset that fails gives a diff up to the statement that failed, and the
 * error; other errors are thrown.
 */
export async function buildChangesetDiff({
  db,
  sql,
  base,
  source = null,
  version = null,
  context,
}: BuildOptions): Promise<ChangesetDiff> {
  const tracer = diffTracer(sql, { context, rules: true });
  const diff: ChangesetDiff = {
    meetings: [],
    base: { db: base, ranAt: new Date().toISOString() },
    source,
    version,
    sql,
    sha256: sqlHash(sql),
    effect: "",
    error: null,
    statements: tracer.statements,
    rows: {},
    outcomes: [],
  };
  try {
    const result = await checkChangeset({ db, sql }, { trace: tracer.trace });
    diff.rows = result.rows;
    diff.outcomes = result.meetings.map((m) => {
      tracer.note(m.after);
      return {
        meeting: m.after.id,
        resolved: m.resolved.map((i) => issueView(i, m.before)),
        introduced: m.added.map((i) => issueView(i, m.after)),
      };
    });
  } catch (err) {
    if (!(err instanceof ChangesetError)) throw err;
    diff.error = tracer.failed(err);
  }
  diff.meetings = tracer.meetings();
  diff.effect = effectHash(diff);
  return diff;
}

/**
 * Apply a changeset only if it does what `effect` (a diff's
 * {@link ChangesetDiff.effect}) says it did: run it a statement at a time,
 * holding the edit lock, and save it only if its effect is the same. Throws
 * a {@link ChangesetError} where applyChangeset would.
 */
export async function applyIfUnchanged({
  db,
  sql,
  effect,
}: {
  db: DB;
  sql: string;
  effect: string;
}): Promise<{ applied: AppliedChangeset } | { changed: true }> {
  const tracer = diffTracer(sql, { rules: false });
  try {
    const applied = await applyChangeset(
      { db, sql },
      {
        trace: tracer.trace,
        accept: () =>
          effectHash({ statements: tracer.statements, error: null }) === effect,
      },
    );
    return { applied };
  } catch (err) {
    if (err instanceof ChangesetRefused) return { changed: true };
    throw err;
  }
}

/**
 * The trace that fills in a diff's statements as a changeset runs, the
 * meetings it changed, and the error it failed with. Without `rules`, it
 * doesn't run the meeting rules on each statement.
 */
function diffTracer(
  sql: string,
  { context, rules }: { context?: number; rules: boolean },
) {
  const statements: StatementDiff[] = splitStatements(sql).map((s, index) => ({
    index,
    ...s,
    status: "not-run",
    rows: {},
    meetings: [],
    people: [],
  }));
  const issues = new WeakMap<DbMeeting, Promise<MeetingIssue[]>>();
  const issuesOf = (m: DbMeeting) => {
    let found = issues.get(m);
    if (!found) issues.set(m, (found = meetingIssues(m)));
    return found;
  };
  const meetings = new Map<number, MeetingInfo>();
  const note = (m: DbMeeting) =>
    meetings.set(m.id, {
      id: m.id,
      slug: m.slug,
      title: m.title,
      date: m.date,
    });
  const trace: ChangesetTrace = {
    statements: statements.map((s) => s.sql),
    onStatement: async (step) => {
      const view = statements[step.index]!;
      view.status = "ok";
      view.rows = step.rows;
      for (const { before, after } of step.meetings) {
        note(after);
        const { changes, hunks, relabelled } = diffTranscripts(
          transcript(before),
          transcript(after),
          { context },
        );
        const [issuesBefore, issuesAfter] = rules
          ? await Promise.all([issuesOf(before), issuesOf(after)])
          : [[], []];
        view.meetings.push({
          meeting: after.id,
          changes,
          hunks,
          fields: meetingFields(before, after),
          relabelled: sqlHash(JSON.stringify(relabelled)),
          resolved: newIssues(issuesAfter, issuesBefore).map((i) =>
            issueView(i, before),
          ),
          introduced: newIssues(issuesBefore, issuesAfter).map((i) =>
            issueView(i, after),
          ),
        });
      }
      view.people = step.people.flatMap(({ before, after }) =>
        personFields(before, after),
      );
    },
  };
  return {
    statements,
    trace,
    note,
    meetings: () => [...meetings.values()].sort((a, b) => a.id - b.id),
    /** The diff's error for `err`, marking the statement that failed. */
    failed: (err: ChangesetError): NonNullable<ChangesetDiff["error"]> => {
      const failed = err.statement ?? null;
      if (failed !== null) statements[failed]!.status = "failed";
      return {
        statement: failed,
        message: err.message,
        assertion: err.assertion,
      };
    },
  };
}

/** A meeting's transcript, as the diff compares it. */
export function transcript(meeting: DbMeeting): Transcript {
  return {
    segments: meeting.segments.map((s) => ({
      speaker: {
        label: labelOf(s, meeting.people),
        name:
          s.person === null
            ? null
            : (meeting.people.get(s.person)?.name ?? null),
      },
      words: s.words.map((w) => ({ text: w.text, start: w.start })),
    })),
  };
}

/** The meeting's slug and title, where they changed. */
function meetingFields(before: DbMeeting, after: DbMeeting): FieldChange[] {
  return (["slug", "title"] as const)
    .filter((field) => before[field] !== after[field])
    .map((field) => ({
      row: "meeting",
      field,
      old: before[field],
      new: after[field],
    }));
}

/** A person's slug, name and bio, where they changed. */
function personFields(before: DbPerson, after: DbPerson): FieldChange[] {
  return (["slug", "name", "bio"] as const)
    .filter((field) => before[field] !== after[field])
    .map((field) => ({
      row: `person ${after.id}`,
      field,
      old: before[field],
      new: after[field],
    }));
}

function issueView(issue: MeetingIssue, meeting: DbMeeting): IssueView {
  let start: number | null = null;
  if ("segmentIndex" in issue) {
    const seg = meeting.segments[issue.segmentIndex];
    const word =
      "wordIndex" in issue && issue.wordIndex >= 0
        ? seg?.words[issue.wordIndex]
        : seg?.words[0];
    start = word?.start ?? null;
  }
  const where = formatIssue(issue, meeting);
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    where: where.slice(0, where.indexOf(": ")),
    start,
  };
}
