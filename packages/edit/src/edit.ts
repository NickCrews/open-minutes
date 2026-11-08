// Editing a meeting in a database: apply the meeting rules' fixes, or run a
// changeset, in one transaction that holds the meeting's row lock, checked by
// the meeting rules before anything is saved.

import { eq, sql } from "drizzle-orm";
import { chaptersTable, type DB, meetingsTable } from "@open-minutes/db";
import { fixMeeting, type MeetingIssue } from "@open-minutes/core/rules";
import type { Segment } from "@open-minutes/core/transcript";
import {
  type Conn,
  type DbMeeting,
  loadMeeting,
  type Saved,
  saveSegments,
} from "./meeting";
import { meetingIssues, newIssues, ruleMeeting, ruleSpecs } from "./view";

export interface EditOptions {
  /** Report what would change, and save nothing. */
  dryRun?: boolean;
  /** Save even if the edit adds errors. */
  allowErrors?: boolean;
}

/** Rows an edit changed, by table. Tables it didn't change are left out. */
export type RowCounts = Record<string, Saved>;

export interface EditResult {
  /** What the edit did. */
  notes: string[];
  /** The meeting as edited. */
  meeting: DbMeeting;
  /** Issues the edit added, errors and warnings. */
  added: MeetingIssue[];
  /** Whether it was saved: not on a dry run, or when it added errors. */
  saved: boolean;
  /** Rows the edit changed, whether or not it was saved. */
  rows: RowCounts;
}

/**
 * A changeset that can't be applied: its SQL failed, failed an assertion
 * (`assertion`), or did something a changeset may not.
 */
export class ChangesetError extends Error {
  constructor(
    message: string,
    readonly assertion = false,
  ) {
    super(message);
  }
}

/** The SQLSTATE om.assert raises. */
const ASSERTION_FAILED = "OM001";

class Rollback extends Error {}

/**
 * Apply the fixes of every rule the meeting follows, to its title, transcript
 * and chapters.
 */
export function fixRules(
  db: DB,
  meetingId: number,
  options: EditOptions = {},
): Promise<EditResult> {
  return editMeeting(db, meetingId, options, async (tx, before) => {
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
          .set({ title: c.title, summary: c.summary, bullets: [...c.bullets] })
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
      fixed.segments.map((s) => ({ ...s, person: s.person as number | null })),
    );
    if (segments.updated || segments.inserted || segments.deleted)
      rows.segments = segments;
    return {
      notes: issues.map((i) => `fixed ${i.code}: ${i.message}`),
      rows,
    };
  });
}

/**
 * Run a changeset's SQL on the meeting, as the `changeset` role, inside
 * om.run. Throws a {@link ChangesetError}, saving nothing, if the SQL fails,
 * creates or alters a database object, or changes another meeting's
 * segments, chapters or row.
 */
export function runChangeset(
  db: DB,
  meetingId: number,
  changesetSql: string,
  options: EditOptions = {},
): Promise<EditResult> {
  return editMeeting(db, meetingId, options, async (tx) => {
    const objects = await changesetObjects(tx);
    await tx.execute(sql`SET LOCAL ROLE changeset`);
    try {
      await tx.execute(sql`SELECT om.run(${changesetSql})`);
    } catch (err) {
      const pg = postgresError(err);
      if (!pg) throw err;
      throw new ChangesetError(
        pg.code === ASSERTION_FAILED
          ? `assertion failed: ${pg.message}`
          : `the changeset failed: ${pg.message}`,
        pg.code === ASSERTION_FAILED,
      );
    }
    await tx.execute(sql`RESET ROLE`);
    if ((await changesetObjects(tx)) !== objects)
      throw new ChangesetError(
        "the changeset created or altered a database object; it may only change rows",
      );
    const rows = await loggedChanges(tx);
    const others = await tx.execute<{ ref: string }>(sql`
      SELECT coalesce(m.slug, x.id::text) AS ref
      FROM (SELECT DISTINCT unnest(meeting_ids) AS id FROM om.changes
            WHERE xact = pg_current_xact_id()) x
      LEFT JOIN meetings m ON m.id = x.id
      WHERE x.id <> ${meetingId}
      ORDER BY x.id`);
    await tx.execute(
      sql`DELETE FROM om.changes WHERE xact = pg_current_xact_id()`,
    );
    if (others.length)
      throw new ChangesetError(
        `the changeset changed other meetings: ${others.map((r) => r.ref).join(", ")}`,
      );
    return { notes: [], rows };
  });
}

async function editMeeting(
  db: DB,
  meetingId: number,
  { dryRun = false, allowErrors = false }: EditOptions,
  edit: (
    tx: Conn,
    before: DbMeeting,
  ) => Promise<{ notes: string[]; rows: RowCounts }>,
): Promise<EditResult> {
  let result: EditResult | undefined;
  try {
    await db.transaction(async (tx) => {
      const before = await loadMeeting(tx, meetingId, { lock: true });
      const { notes, rows } = await edit(tx, before);
      const meeting = await loadMeeting(tx, meetingId);
      const added = newIssues(
        await meetingIssues(before),
        await meetingIssues(meeting),
      );
      const blocked = !allowErrors && added.some((i) => i.severity === "error");
      result = { notes, meeting, added, saved: !dryRun && !blocked, rows };
      if (!result.saved) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result!;
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

/** The rows the `changeset` role changed in this transaction, net, by table. */
async function loggedChanges(tx: Conn): Promise<RowCounts> {
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
      FROM om.changes WHERE xact = pg_current_xact_id()
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
