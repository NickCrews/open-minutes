// The hashes the changeset flow cites a version by: its SQL's, and its
// effect's. No database or Node beyond node:crypto, so the website can check
// a diff with them.

import { createHash } from "node:crypto";
import type { ChangesetDiff } from "./types";

/** The SHA-256 of a changeset's SQL, or any text, in hex. */
export function sqlHash(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * The SHA-256 of what a changeset does: each statement's effect
 * ({@link statementEffects}), and the error it fails with.
 */
export function effectHash(
  diff: Pick<ChangesetDiff, "statements" | "error">,
): string {
  return sqlHash(
    JSON.stringify({ error: diff.error, statements: statementEffects(diff) }),
  );
}

/**
 * The SHA-256 of what each statement does: whether it ran, its rows, and in
 * each meeting and person it changes, its changes to words, speakers (every
 * word a new speaker covers), segment boundaries and fields, with their old
 * values. Two runs of a statement have the same effect if they make the same
 * changes to the same data, whatever else in the meetings differs, so its
 * hunks and the rule violations aren't part of it.
 */
export function statementEffects(
  diff: Pick<ChangesetDiff, "statements">,
): string[] {
  return diff.statements.map((s) =>
    sqlHash(
      JSON.stringify({
        status: s.status,
        rows: s.rows,
        meetings: s.meetings.map((m) => ({
          meeting: m.meeting,
          changes: m.changes,
          relabelled: m.relabelled,
          fields: m.fields,
        })),
        people: s.people,
      }),
    ),
  );
}
