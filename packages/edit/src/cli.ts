// What the `pnpm transcript` and `pnpm changeset` CLIs share.
import process from "node:process";
import { getDb } from "@open-minutes/db";
import type { EditResult, RowCounts } from "./edit";
import { formatIssue } from "./view";

export const dbArg = {
  db: {
    type: "string",
    description:
      'Database: a name ("local", "prod", ...) or a postgres:// URL. Default: $DB, else "local".',
  },
} as const;

/** Run `fn` with a connection, and close it after. */
export async function withDb<T>(
  target: string | undefined,
  fn: (db: ReturnType<typeof getDb>["db"]) => Promise<T>,
): Promise<T> {
  const { db, client } = getDb(target);
  try {
    return await fn(db);
  } finally {
    await client.end();
  }
}

/** "segments 2 updated, 1 inserted, 0 deleted; people 1 updated, ..." */
export function formatRows(rows: RowCounts): string {
  const tables = Object.entries(rows);
  if (!tables.length) return "no rows";
  return tables
    .map(
      ([table, { updated, inserted, deleted }]) =>
        `${table} ${updated} updated, ${inserted} inserted, ${deleted} deleted`,
    )
    .join("; ");
}

/** What `pnpm transcript fix` did. Sets the exit code when it saved nothing because of errors. */
export function reportFix(result: EditResult): void {
  for (const note of result.notes) console.log(note);
  for (const issue of result.added)
    console.log(`added ${formatIssue(issue, result.meeting)}`);
  const rows = formatRows(result.rows);
  if (result.saved) {
    console.log(
      `saved: ${rows}; the meeting has ${result.meeting.segments.length} segments`,
    );
  } else if (result.added.some((i) => i.severity === "error")) {
    console.log(
      `not saved (would change ${rows}): the fixes add errors. Fix them, or pass --allow-errors.`,
    );
    process.exitCode = 1;
  } else console.log(`dry run, nothing saved: would change ${rows}`);
}
