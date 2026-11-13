#!/usr/bin/env vpx
// Check and apply changesets, behind the root `pnpm changeset` script. See
// this package's README.
import { readFileSync } from "node:fs";
import process from "node:process";
import { defineCommand, runMain } from "citty";
import { dbArg, formatRows, withDb } from "./cli";
import {
  applyChangeset,
  type Changeset,
  ChangesetError,
  checkChangeset,
  type EditResult,
} from "./edit";
import { findMeetingId } from "./meeting";
import { formatIssue } from "./view";

const HELP = `A changeset is a SQL file of changes and assertions to one meeting. It runs in
one transaction holding the meeting's lock, as the changeset role, and fails,
saving nothing, if a statement or assertion fails, or if it changes another
meeting. "check" runs it, reports what it would change and the meeting rule
violations it would resolve and introduce, and rolls it back. "apply" runs it
and saves it, without running the rules.

The role reads every table, inserts, updates and deletes segments, and updates
people (slug, name, bio) and meetings (slug, title). M is the meeting's slug or
id, T an onset "H:MM:SS.ss" as "pnpm transcript render" and "words" print it,
L a speaker label:
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

const args = {
  file: {
    type: "positional",
    required: true,
    description: "The changeset's SQL file",
  },
  meeting: {
    type: "string",
    required: true,
    description: "The meeting it changes: its slug, or its id",
  },
  ...dbArg,
} as const;

/**
 * Run `run` on the changeset the arguments name, and report what it did, or
 * why it failed.
 */
function runCommand(
  { file, meeting, db: target }: { file: string; meeting: string; db?: string },
  run: (changeset: Changeset) => Promise<EditResult>,
  report: (result: EditResult) => void,
): Promise<void> {
  return withDb(target, async (db) => {
    const changeset = {
      db,
      meetingId: await findMeetingId(db, meeting),
      sql: readFileSync(file, "utf8"),
    };
    try {
      report(await run(changeset));
    } catch (err) {
      if (!(err instanceof ChangesetError)) throw err;
      console.log(`failed, nothing saved: ${err.message}`);
      process.exitCode = 1;
    }
  });
}

const checkCmd = defineCommand({
  meta: {
    name: "check",
    description:
      "Run a changeset and roll it back: report the rows it would change and the meeting rule violations it would resolve and introduce",
  },
  args,
  run: ({ args }) =>
    runCommand(args, checkChangeset, (result) => {
      for (const issue of result.resolved)
        console.log(`resolves ${formatIssue(issue, result.before)}`);
      for (const issue of result.added)
        console.log(`introduces ${formatIssue(issue, result.meeting)}`);
      console.log(
        `would change ${formatRows(result.rows)}; resolves ${result.resolved.length} violation(s), introduces ${result.added.length}`,
      );
    }),
});

const applyCmd = defineCommand({
  meta: {
    name: "apply",
    description:
      "Run a changeset and save it. It doesn't run the meeting rules: `check` does, and so does `pnpm transcript check`.",
  },
  args,
  run: ({ args }) =>
    runCommand(args, applyChangeset, (result) => {
      console.log(
        `saved: ${formatRows(result.rows)}; the meeting has ${result.meeting.segments.length} segments`,
      );
    }),
});

const main = defineCommand({
  meta: {
    name: "changeset",
    description: `Check and apply changesets.\n\n${HELP}`,
  },
  subCommands: { check: checkCmd, apply: applyCmd },
});

await runMain(main);
