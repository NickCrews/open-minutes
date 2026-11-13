// Editing a database: apply the meeting rules' fixes to a meeting, or check
// or apply a changeset. Every edit that saves takes the edit lock
// (lockEdits), so two can't interleave. Fixes are checked by the meeting
// rules before they are saved. Checking a changeset reports the violations it
// resolves and introduces in each meeting it changes, and saves nothing;
// applying one doesn't run the rules.

import { eq, inArray, sql } from "drizzle-orm";
import { chaptersTable, type DB, meetingsTable } from "@open-minutes/db";
import { fixMeeting, type MeetingIssue } from "@open-minutes/core/rules";
import type { Segment } from "@open-minutes/core/transcript";
import {
  type Conn,
  type DbMeeting,
  type DbPerson,
  loadMeeting,
  loadPeople,
  lockEdits,
  type Saved,
  saveSegments,
} from "./meeting";
import { meetingIssues, newIssues, ruleMeeting, ruleSpecs } from "./view";

/** Rows an edit changed, by table. Tables it didn't change are left out. */
export type RowCounts = Record<string, Saved>;

export interface Fix {
  db: DB;
  meetingId: number;
  /** Report what would change, and save nothing. */
  dryRun?: boolean;
  /** Save even if the fixes add rule errors. */
  allowErrors?: boolean;
}

export interface FixResult {
  /** The fixes it made. */
  notes: string[];
  /** The meeting as it was, which `resolved` indexes into. */
  before: DbMeeting;
  /** The meeting as fixed, which `added` indexes into. */
  meeting: DbMeeting;
  /** Violations the fixes introduced. */
  added: MeetingIssue[];
  /** Violations the fixes resolved. */
  resolved: MeetingIssue[];
  /** Whether it was saved: not on a dry run, or when fixes added errors. */
  saved: boolean;
  /** Rows the fixes changed, whether or not they were saved. */
  rows: RowCounts;
}

/** A changeset's SQL, and the database it runs in. */
export interface Changeset {
  db: DB;
  sql: string;
}

/** A meeting by id, and its slug if it has one. */
export interface MeetingRef {
  id: number;
  slug: string | null;
}

export interface AppliedChangeset {
  /** Rows the changeset changed. */
  rows: RowCounts;
  /** The meetings whose row, segments or chapters it changed, by id. */
  meetings: MeetingRef[];
}

/** How a changeset changed one meeting, by the meeting rules. */
export interface MeetingCheck {
  /** The meeting as it was, which `resolved` indexes into. */
  before: DbMeeting;
  /** The meeting as changed, which `added` indexes into. */
  after: DbMeeting;
  /** Violations the changeset introduced. */
  added: MeetingIssue[];
  /** Violations the changeset resolved. */
  resolved: MeetingIssue[];
}

export interface CheckedChangeset {
  /** Rows the changeset would change. */
  rows: RowCounts;
  /** Each meeting whose row, segments or chapters it would change, by id. */
  meetings: MeetingCheck[];
}

/** What one statement of a traced changeset did. */
export interface TracedStatement {
  index: number;
  /** The rows it changed, net, by table. */
  rows: RowCounts;
  /** Each meeting whose row, segments or chapters it changed, before and after it, by id. */
  meetings: { before: DbMeeting; after: DbMeeting }[];
  /** Each person it changed, before and after it, by id. */
  people: { before: DbPerson; after: DbPerson }[];
}

/**
 * Runs a changeset a statement at a time, to see what each one does. The
 * statements, in order, are the changeset's SQL. They run in the same
 * transaction and role as the SQL would whole.
 */
export interface ChangesetTrace {
  statements: readonly string[];
  /** Called after each statement that succeeds. */
  onStatement: (step: TracedStatement) => Promise<void> | void;
}

/**
 * A changeset that can't be applied: its SQL failed, failed an assertion
 * (`assertion`), or did something a changeset may not. When it ran traced,
 * `statement` is the index of the statement that failed.
 */
export class ChangesetError extends Error {
  constructor(
    message: string,
    readonly assertion = false,
    readonly statement?: number,
  ) {
    super(message);
  }
}

/** {@link applyChangeset}'s `accept` refused the changeset, so nothing was saved. */
export class ChangesetRefused extends Error {
  constructor() {
    super("refused, so nothing was saved");
  }
}

/** The SQLSTATE om.assert raises. */
const ASSERTION_FAILED = "OM001";

class Rollback extends Error {}

/**
 * Apply the fixes of every rule the meeting follows, to its title, transcript
 * and chapters, unless they add a rule error (and not `allowErrors`).
 */
export async function fixRules({
  db,
  meetingId,
  dryRun = false,
  allowErrors = false,
}: Fix): Promise<FixResult> {
  let result: FixResult | undefined;
  try {
    await db.transaction(async (tx) => {
      await lockEdits(tx);
      const before = await loadMeeting(tx, meetingId);
      const { meeting: fixed, fixed: issues } = await fixMeeting(
        { ...ruleMeeting(before), segments: stripIds(before.segments) },
        ruleSpecs(before),
      );
      const rows: RowCounts = {};
      if (fixed.title !== before.title) {
        await tx
          .update(meetingsTable)
          .set({ title: fixed.title })
          .where(eq(meetingsTable.id, meetingId));
        rows.meetings = { updated: 1, inserted: 0, deleted: 0 };
      }
      let chapters = 0;
      for (const [i, c] of (fixed.chapters ?? []).entries()) {
        const old = before.chapters[i]!;
        if (
          c.title !== old.title ||
          c.summary !== old.summary ||
          JSON.stringify(c.bullets) !== JSON.stringify(old.bullets)
        ) {
          await tx
            .update(chaptersTable)
            .set({
              title: c.title,
              summary: c.summary,
              bullets: [...c.bullets],
            })
            .where(eq(chaptersTable.id, old.id));
          chapters++;
        }
      }
      if (chapters)
        rows.chapters = { updated: chapters, inserted: 0, deleted: 0 };
      const segments = await saveSegments(
        tx,
        meetingId,
        before.segments,
        fixed.segments.map((s) => ({
          ...s,
          person: s.person as number | null,
        })),
      );
      if (segments.updated || segments.inserted || segments.deleted)
        rows.segments = segments;

      const meeting = await loadMeeting(tx, meetingId);
      const issuesBefore = await meetingIssues(before);
      const issuesAfter = await meetingIssues(meeting);
      const added = newIssues(issuesBefore, issuesAfter);
      const blocked = !allowErrors && added.some((i) => i.severity === "error");
      result = {
        notes: issues.map((i) => `fixed ${i.code}: ${i.message}`),
        before,
        meeting,
        added,
        resolved: newIssues(issuesAfter, issuesBefore),
        saved: !dryRun && !blocked,
        rows,
      };
      if (!result.saved) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result!;
}

/**
 * Run a changeset and roll it back, reporting the rows it would change and,
 * for each meeting it would change, the rule violations it would resolve and
 * introduce. Throws a {@link ChangesetError} where {@link applyChangeset}
 * would. With `trace`, it runs the changeset a statement at a time and
 * reports each one.
 */
export async function checkChangeset(
  { db, sql: changesetSql }: Changeset,
  { trace }: { trace?: ChangesetTrace } = {},
): Promise<CheckedChangeset> {
  let result: CheckedChangeset | undefined;
  try {
    // One snapshot throughout, so each meeting's before is what the
    // changeset ran on.
    await db.transaction(
      async (tx) => {
        await tx.execute(sql`SAVEPOINT changeset`);
        const { rows, meetingIds } = await runAsChangeset(
          tx,
          changesetSql,
          trace,
        );
        const after: DbMeeting[] = [];
        for (const id of meetingIds) after.push(await loadMeeting(tx, id));
        await tx.execute(sql`ROLLBACK TO SAVEPOINT changeset`);
        const meetings: MeetingCheck[] = [];
        for (const a of after) {
          const before = await loadMeeting(tx, a.id);
          const issuesBefore = await meetingIssues(before);
          const issuesAfter = await meetingIssues(a);
          meetings.push({
            before,
            after: a,
            added: newIssues(issuesBefore, issuesAfter),
            resolved: newIssues(issuesAfter, issuesBefore),
          });
        }
        result = { rows, meetings };
        throw new Rollback();
      },
      { isolationLevel: "repeatable read" },
    );
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result!;
}

/**
 * Run a changeset and save it, holding the edit lock. It doesn't run the
 * meeting rules. Throws a {@link ChangesetError}, saving nothing, if the SQL
 * fails or creates or alters a database object. With `trace`, it runs the
 * changeset a statement at a time and reports each one; then, if `accept`
 * returns false, it saves nothing and throws a {@link ChangesetRefused}.
 */
export async function applyChangeset(
  { db, sql: changesetSql }: Changeset,
  {
    trace,
    accept,
  }: { trace?: ChangesetTrace; accept?: () => boolean | Promise<boolean> } = {},
): Promise<AppliedChangeset> {
  return db.transaction(async (tx) => {
    await lockEdits(tx);
    const { rows, meetingIds } = await runAsChangeset(tx, changesetSql, trace);
    if (accept && !(await accept())) throw new ChangesetRefused();
    const meetings = meetingIds.length
      ? await tx
          .select({ id: meetingsTable.id, slug: meetingsTable.slug })
          .from(meetingsTable)
          .where(inArray(meetingsTable.id, meetingIds))
          .orderBy(meetingsTable.id)
      : [];
    return { rows, meetings };
  });
}

/**
 * Run a changeset's SQL as the `changeset` role, inside om.run, whole or, with
 * `trace`, a statement at a time, and read the rows it changed and the
 * meetings they belong to from om.changes.
 */
async function runAsChangeset(
  tx: Conn,
  changesetSql: string,
  trace?: ChangesetTrace,
): Promise<{ rows: RowCounts; meetingIds: number[] }> {
  const objects = await changesetObjects(tx);
  if (trace) await runTraced(tx, trace);
  else await runStatement(tx, changesetSql);
  if ((await changesetObjects(tx)) !== objects)
    throw new ChangesetError(
      "the changeset created or altered a database object; it may only change rows",
    );
  const rows = await loggedChanges(tx);
  const { meetingIds } = await touched(tx);
  await tx.execute(
    sql`DELETE FROM om.changes WHERE xact = pg_current_xact_id()`,
  );
  return { rows, meetingIds };
}

/** Run SQL as the `changeset` role, inside om.run. */
async function runStatement(
  tx: Conn,
  statement: string,
  index?: number,
): Promise<void> {
  await tx.execute(sql`SET LOCAL ROLE changeset`);
  try {
    await tx.execute(sql`SELECT om.run(${statement})`);
  } catch (err) {
    const pg = postgresError(err);
    if (!pg) throw err;
    throw new ChangesetError(
      pg.code === ASSERTION_FAILED
        ? `assertion failed: ${pg.message}`
        : `the changeset failed: ${pg.message}`,
      pg.code === ASSERTION_FAILED,
      index,
    );
  }
  await tx.execute(sql`RESET ROLE`);
}

/**
 * Run each statement in turn, reporting what it changed. The meetings and
 * people a statement changes are loaded as they were before it: from an
 * earlier statement's report, or, the first time something changes them, by
 * rolling the statement back to a savepoint, loading them, and running it
 * again.
 */
async function runTraced(
  tx: Conn,
  { statements, onStatement }: ChangesetTrace,
): Promise<void> {
  const meetings = new Map<number, DbMeeting>();
  const people = new Map<number, DbPerson>();
  for (const [index, statement] of statements.entries()) {
    const seq = await lastLoggedChange(tx);
    await tx.execute(sql`SAVEPOINT statement`);
    await runStatement(tx, statement, index);
    const changed = await touched(tx, seq);
    const newMeetings = changed.meetingIds.filter((id) => !meetings.has(id));
    const newPeople = changed.personIds.filter((id) => !people.has(id));
    if (newMeetings.length || newPeople.length) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT statement`);
      for (const id of newMeetings) meetings.set(id, await loadMeeting(tx, id));
      for (const [id, p] of await loadPeople(tx, newPeople)) people.set(id, p);
      await runStatement(tx, statement, index);
    }
    await tx.execute(sql`RELEASE SAVEPOINT statement`);
    const step: TracedStatement = {
      index,
      rows: await loggedChanges(tx, seq),
      meetings: [],
      people: [],
    };
    for (const id of changed.meetingIds) {
      const after = await loadMeeting(tx, id);
      step.meetings.push({ before: meetings.get(id)!, after });
      meetings.set(id, after);
    }
    const afterPeople = await loadPeople(tx, changed.personIds);
    for (const id of changed.personIds) {
      const after = afterPeople.get(id)!;
      step.people.push({ before: people.get(id)!, after });
      people.set(id, after);
    }
    await onStatement(step);
  }
}

/**
 * The meetings and people the `changeset` role changed in this transaction,
 * all of them or those logged after the change numbered `afterSeq`, by id.
 */
async function touched(
  tx: Conn,
  afterSeq = 0,
): Promise<{ meetingIds: number[]; personIds: number[] }> {
  const [row] = await tx.execute<{
    meeting_ids: number[] | null;
    person_ids: number[] | null;
  }>(sql`
    SELECT
      (SELECT array_agg(DISTINCT id ORDER BY id) FROM om.changes, unnest(meeting_ids) id
       WHERE xact = pg_current_xact_id() AND seq > ${afterSeq}) AS meeting_ids,
      (SELECT array_agg(DISTINCT row_id ORDER BY row_id) FROM om.changes
       WHERE xact = pg_current_xact_id() AND seq > ${afterSeq} AND tbl = 'people') AS person_ids`);
  return {
    meetingIds: row!.meeting_ids ?? [],
    personIds: row!.person_ids ?? [],
  };
}

/** The `seq` of the last change om.changes logged in this transaction, or 0. */
async function lastLoggedChange(tx: Conn): Promise<number> {
  const [row] = await tx.execute<{ seq: string }>(sql`
    SELECT coalesce(max(seq), 0)::text AS seq FROM om.changes
    WHERE xact = pg_current_xact_id()`);
  return Number(row!.seq);
}

/**
 * Everything the `changeset` role owns in this database, and om.run's
 * definition, as one string, so a change to either shows.
 */
async function changesetObjects(tx: Conn): Promise<string> {
  const [row] = await tx.execute<{ objects: string }>(sql`
    SELECT concat(
      (SELECT string_agg(classid::regclass || ' ' || objid, ',' ORDER BY classid, objid)
       FROM pg_shdepend
       WHERE refclassid = 'pg_authid'::regclass AND refobjid = 'changeset'::regrole
         AND deptype = 'o'
         AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())),
      '|',
      (SELECT concat_ws(' ', p.oid, p.proowner, p.prosecdef, p.prosrc, p.proconfig, p.proacl)
       FROM pg_proc p WHERE p.oid = to_regprocedure('om.run(text)'))
    ) AS objects`);
  return row!.objects;
}

/**
 * The rows the `changeset` role changed in this transaction, net, by table:
 * all of them, or those logged after the change numbered `afterSeq`.
 */
async function loggedChanges(tx: Conn, afterSeq = 0): Promise<RowCounts> {
  const rows = await tx.execute<{
    tbl: string;
    updated: number;
    inserted: number;
    deleted: number;
  }>(sql`
    SELECT tbl,
      count(*) FILTER (WHERE first_op <> 'INSERT' AND last_op <> 'DELETE')::int AS updated,
      count(*) FILTER (WHERE first_op = 'INSERT' AND last_op <> 'DELETE')::int AS inserted,
      count(*) FILTER (WHERE first_op <> 'INSERT' AND last_op = 'DELETE')::int AS deleted
    FROM (
      SELECT tbl, row_id,
        (array_agg(op ORDER BY seq))[1] AS first_op,
        (array_agg(op ORDER BY seq DESC))[1] AS last_op
      FROM om.changes WHERE xact = pg_current_xact_id() AND seq > ${afterSeq}
      GROUP BY tbl, row_id
    ) x
    GROUP BY tbl ORDER BY tbl`);
  const counts: RowCounts = {};
  for (const { tbl, updated, inserted, deleted } of rows)
    if (updated || inserted || deleted)
      counts[tbl] = { updated, inserted, deleted };
  return counts;
}

/** The Postgres error behind `err`, which drizzle may wrap. */
function postgresError(
  err: unknown,
): { code: string; message: string } | undefined {
  for (let e = err; e instanceof Error; e = e.cause)
    if (e.name === "PostgresError") return e as Error & { code: string };
  return undefined;
}

function stripIds(segments: DbMeeting["segments"]): Segment<number>[] {
  return segments.map((s) => ({
    speakerNumber: s.speakerNumber,
    person: s.person,
    words: s.words,
  }));
}
