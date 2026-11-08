#!/usr/bin/env vpx
// Read and edit a meeting's transcript in a database, behind the root
// `pnpm transcript` script. See this package's README.
import { readFileSync } from "node:fs";
import process from "node:process";
import { defineCommand, runMain } from "citty";
import { parseClock } from "@open-minutes/core/clock";
import { getDb } from "@open-minutes/db";
import {
  ChangesetError,
  type EditResult,
  fixRules,
  type RowCounts,
  runChangeset,
} from "./edit";
import { findMeetingId, loadMeeting } from "./meeting";
import { formatIssue, meetingIssues, render, stats, wordList } from "./view";

/** "H:MM:SS.ss" as seconds; throws if malformed. */
function parseTime(text: string): number {
  const secs = parseClock(text);
  if (secs === null)
    throw new Error(`bad time ${JSON.stringify(text)} (want H:MM:SS.ss)`);
  return secs;
}

const common = {
  meeting: {
    type: "positional",
    description: "The meeting: its slug, or its id",
    required: true,
  },
  db: {
    type: "string",
    description:
      'Database: a name ("local", "prod", ...) or a postgres:// URL. Default: $DB, else "local".',
  },
} as const;

const editArgs = {
  "dry-run": {
    type: "boolean",
    description: "Report what would change, and save nothing",
  },
  "allow-errors": {
    type: "boolean",
    description: "Save even if the edit adds rule errors",
  },
} as const;

/** Run `fn` with a connection, and close it after. */
async function withDb<T>(
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

async function loadRef(db: ReturnType<typeof getDb>["db"], ref: string) {
  return loadMeeting(db, await findMeetingId(db, ref));
}

/** "segments 2 updated, 1 inserted, 0 deleted; people 1 updated, ..." */
function formatRows(rows: RowCounts): string {
  const tables = Object.entries(rows);
  if (!tables.length) return "no rows";
  return tables
    .map(
      ([table, { updated, inserted, deleted }]) =>
        `${table} ${updated} updated, ${inserted} inserted, ${deleted} deleted`,
    )
    .join("; ");
}

function report(result: EditResult): void {
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
      `not saved (would change ${rows}): the edit adds errors. Fix them, or pass --allow-errors.`,
    );
    process.exitCode = 1;
  } else console.log(`dry run, nothing saved: would change ${rows}`);
}

const renderCmd = defineCommand({
  meta: {
    name: "render",
    description:
      "The transcript a segment at a time, each sentence prefixed with its first word's onset",
  },
  args: {
    ...common,
    from: { type: "string", description: "From this time (H:MM:SS.ss)" },
    to: { type: "string", description: "To this time (H:MM:SS.ss)" },
    seg: { type: "string", description: "Just this segment, by index" },
  },
  run: ({ args }) =>
    withDb(args.db, async (db) => {
      const meeting = await loadRef(db, args.meeting);
      console.log(
        render(meeting, {
          from: args.from === undefined ? undefined : parseTime(args.from),
          to: args.to === undefined ? undefined : parseTime(args.to),
          seg: args.seg === undefined ? undefined : Number(args.seg),
        }),
      );
    }),
});

const wordsCmd = defineCommand({
  meta: {
    name: "words",
    description: "Every word between two times with its onset",
  },
  args: {
    ...common,
    from: { type: "positional", required: true, description: "H:MM:SS.ss" },
    to: { type: "positional", required: true, description: "H:MM:SS.ss" },
  },
  run: ({ args }) =>
    withDb(args.db, async (db) => {
      const meeting = await loadRef(db, args.meeting);
      console.log(wordList(meeting, parseTime(args.from), parseTime(args.to)));
    }),
});

const statsCmd = defineCommand({
  meta: {
    name: "stats",
    description: "Segments and words per speaker, and the longest segments",
  },
  args: common,
  run: ({ args }) =>
    withDb(args.db, async (db) => {
      console.log(stats(await loadRef(db, args.meeting)));
    }),
});

const checkCmd = defineCommand({
  meta: {
    name: "check",
    description: "What the meeting rules find. Exits 1 on an error.",
  },
  args: common,
  run: ({ args }) =>
    withDb(args.db, async (db) => {
      const meeting = await loadRef(db, args.meeting);
      const issues = await meetingIssues(meeting);
      for (const issue of issues) console.log(formatIssue(issue, meeting));
      const errors = issues.filter((i) => i.severity === "error").length;
      console.log(`${errors} error(s), ${issues.length - errors} warning(s).`);
      if (errors) process.exitCode = 1;
    }),
});

const fixCmd = defineCommand({
  meta: {
    name: "fix",
    description:
      "Apply the meeting rules' fixes: drop fillers and stutters, write numbers the house way, and so on",
  },
  args: { ...common, ...editArgs },
  run: ({ args }) =>
    withDb(args.db, async (db) => {
      const id = await findMeetingId(db, args.meeting);
      report(
        await fixRules(db, id, {
          dryRun: args["dry-run"],
          allowErrors: args["allow-errors"],
        }),
      );
    }),
});

const CHANGESET_HELP = `"run" runs a changeset: a SQL file of changes and assertions, in one
transaction holding the meeting's lock, as the changeset role. It saves it only
if it changes no other meeting and adds no rule error.

The role reads every table, inserts, updates and deletes segments, and updates
people (slug, name, bio) and meetings (slug, title). M is the meeting's slug or
id, T an onset "H:MM:SS.ss" as render and words print it, L a speaker label:
  SELECT om.split_segment(M, T, W, L);
      The word W (or any word, if null) at T starts a new segment spoken by L,
      running to the end of its segment. To give the turn back, split again
      where the previous speaker resumes. If W already starts a segment, the
      whole segment is relabelled, so to move only W, first split at the word
      after it under the old label. Splitting in descending time order avoids
      both.
  SELECT om.relabel(M, T, L);
      Relabel the whole segment holding the word at T.
  SELECT om.replace_words(M, T, 'good wood', 'Girdwood');
      Replace the words starting at T, which must read the old words exactly.
      The new ones may be more or fewer; '' deletes.
  SELECT om.insert_words(M, ARRAY['0:01:57.24 Are', '0:01:57.52 we'], L);
      Add missing words, each at its onset. With L, they are their own segment
      and the words after them go back to whoever was speaking; without, they
      join the segment of the word before them.
  SELECT om.replace_all_words(M, 'Gridwood', 'Girdwood');
      Replace every occurrence, ignoring case and trailing punctuation, keeping
      the last old word's trailing punctuation. Returns the count.
  SELECT om.assert(condition, 'message');
      Stop the changeset, saving nothing, unless the condition is true.
After each om edit, no two neighbouring segments have the same speaker.
Labels: unlabeled, segmented:spk-<n>, identified:<slug>, person:<id>. A label
sets the speaker to exactly that: a person and no speaker number, or the
reverse.`;

const runCmd = defineCommand({
  meta: {
    name: "run",
    description:
      "Run a changeset, a SQL file of changes and assertions, and save it if it adds no rule error. `pnpm transcript --help` lists the om functions.",
  },
  args: {
    ...common,
    file: {
      type: "positional",
      required: true,
      description: "The changeset's SQL file",
    },
    ...editArgs,
  },
  run: ({ args }) =>
    withDb(args.db, async (db) => {
      const id = await findMeetingId(db, args.meeting);
      try {
        report(
          await runChangeset(db, id, readFileSync(args.file, "utf8"), {
            dryRun: args["dry-run"],
            allowErrors: args["allow-errors"],
          }),
        );
      } catch (err) {
        if (!(err instanceof ChangesetError)) throw err;
        console.log(`not saved: ${err.message}`);
        process.exitCode = 1;
      }
    }),
});

const main = defineCommand({
  meta: {
    name: "transcript",
    description: `Read and edit a meeting's transcript in a database.\n\n${CHANGESET_HELP}`,
  },
  subCommands: {
    render: renderCmd,
    words: wordsCmd,
    stats: statsCmd,
    check: checkCmd,
    fix: fixCmd,
    run: runCmd,
  },
});

await runMain(main);
