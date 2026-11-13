// Computing a changeset's diff from a database: run it as `pnpm changeset
// check` does, a statement at a time, diff the meeting before and after each
// statement, and roll it all back.

import type { DB } from "@open-minutes/db";
import type { MeetingIssue } from "@open-minutes/core/rules";
import {
  ChangesetError,
  checkChangeset,
  type DbMeeting,
  formatIssue,
  labelOf,
  loadMeeting,
  meetingIssues,
  newIssues,
} from "@open-minutes/edit";
import { splitStatements } from "./statements";
import type {
  ChangesetDiff,
  FieldChange,
  IssueView,
  StatementDiff,
  Transcript,
} from "./types";
import { diffTranscripts } from "./words";

export interface BuildOptions {
  db: DB;
  meetingId: number;
  /** The changeset's SQL. */
  sql: string;
  /** The database's name, or its host and database name, to show. Never a URL with a password. */
  base: string;
  /** Where the SQL came from, to show. */
  source?: string | null;
  /** Words of transcript to show either side of each change. */
  context?: number;
}

/**
 * Run a changeset against a meeting a statement at a time, in one
 * transaction that is rolled back, and report what each statement did. A
 * changeset that fails gives a diff up to the statement that failed, and the
 * error; other errors, such as no such meeting, are thrown.
 */
export async function buildChangesetDiff({
  db,
  meetingId,
  sql,
  base,
  source = null,
  context,
}: BuildOptions): Promise<ChangesetDiff> {
  const meeting = await loadMeeting(db, meetingId);
  const statements: StatementDiff[] = splitStatements(sql).map((s, index) => ({
    index,
    ...s,
    status: "not-run",
    rows: {},
    changes: [],
    hunks: [],
    fields: [],
    resolved: [],
    introduced: [],
  }));

  const issues = new WeakMap<DbMeeting, Promise<MeetingIssue[]>>();
  const issuesOf = (m: DbMeeting) => {
    let found = issues.get(m);
    if (!found) issues.set(m, (found = meetingIssues(m)));
    return found;
  };

  const diff: ChangesetDiff = {
    meeting: {
      id: meeting.id,
      slug: meeting.slug,
      title: meeting.title,
      date: meeting.date,
    },
    base: { db: base, ranAt: new Date().toISOString() },
    source,
    sql,
    error: null,
    statements,
    rows: {},
    resolved: [],
    introduced: [],
  };

  try {
    const result = await checkChangeset(
      { db, meetingId, sql },
      {
        trace: {
          statements: statements.map((s) => s.sql),
          onStatement: async ({ index, before, after, rows }) => {
            const view = statements[index]!;
            const { changes, hunks } = diffTranscripts(
              transcript(before),
              transcript(after),
              { context },
            );
            const [issuesBefore, issuesAfter] = await Promise.all([
              issuesOf(before),
              issuesOf(after),
            ]);
            Object.assign(view, {
              status: "ok",
              rows,
              changes,
              hunks,
              fields: fieldChanges(before, after),
              resolved: newIssues(issuesAfter, issuesBefore).map((i) =>
                issueView(i, before),
              ),
              introduced: newIssues(issuesBefore, issuesAfter).map((i) =>
                issueView(i, after),
              ),
            });
          },
        },
      },
    );
    diff.rows = result.rows;
    diff.resolved = result.resolved.map((i) => issueView(i, result.before));
    diff.introduced = result.added.map((i) => issueView(i, result.meeting));
  } catch (err) {
    if (!(err instanceof ChangesetError)) throw err;
    const failed = err.statement === undefined ? null : err.statement;
    diff.error = {
      statement: failed,
      message: err.message,
      assertion: err.assertion,
    };
    if (failed !== null) statements[failed]!.status = "failed";
  }
  return diff;
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

/** The meeting's slug and title, and its people's slug, name and bio, that changed. */
function fieldChanges(before: DbMeeting, after: DbMeeting): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of ["slug", "title"] as const)
    if (before[field] !== after[field])
      out.push({
        row: "meeting",
        field,
        old: before[field],
        new: after[field],
      });
  const ids = new Set([...before.people.keys(), ...after.people.keys()]);
  for (const id of [...ids].sort((a, b) => a - b)) {
    const old = before.people.get(id);
    const now = after.people.get(id);
    // A person who only starts or stops speaking here hasn't changed.
    if (!old || !now) continue;
    for (const field of ["slug", "name", "bio"] as const)
      if (old[field] !== now[field])
        out.push({
          row: `person ${id}`,
          field,
          old: old[field],
          new: now[field],
        });
  }
  return out;
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
