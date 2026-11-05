#!/usr/bin/env vpx
// Read and edit a meeting's transcript in a database, behind the root
// `pnpm transcript` script. See this package's README.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { defineCommand, runMain } from "citty";
import { getDb } from "@open-minutes/db";
import { type EditResult, applyOps, fixRules } from "./edit";
import { findMeetingId, loadMeeting } from "./meeting";
import { OPS_HELP, parseOps, parseTime } from "./ops";
import { formatIssue, meetingIssues, render, stats, wordList } from "./view";

// pnpm runs this from the package directory; paths are the caller's.
const CWD = process.env.INIT_CWD ?? process.cwd();

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

function report(result: EditResult): void {
  for (const note of result.notes) console.log(note);
  for (const issue of result.added)
    console.log(`added ${formatIssue(issue, result.meeting)}`);
  const { updated, inserted, deleted } = result.rows;
  if (result.saved) {
    console.log(
      `saved: ${updated} segment(s) updated, ${inserted} inserted, ${deleted} deleted; ${result.meeting.segments.length} segments`,
    );
  } else if (result.added.some((i) => i.severity === "error")) {
    console.log(
      "not saved: the edit adds errors. Fix them, or pass --allow-errors.",
    );
    process.exitCode = 1;
  } else console.log("dry run: nothing saved");
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

const applyCmd = defineCommand({
  meta: {
    name: "apply",
    description: `Apply an ops file, then the rules check it; one that adds errors isn't saved.\n\n${OPS_HELP}`,
  },
  args: {
    ...common,
    ops: {
      type: "positional",
      required: true,
      description: "The ops file (JSONL)",
    },
    ...editArgs,
  },
  run: ({ args }) =>
    withDb(args.db, async (db) => {
      const id = await findMeetingId(db, args.meeting);
      const ops = parseOps(readFileSync(resolve(CWD, args.ops), "utf8"));
      report(
        await applyOps(db, id, ops, {
          dryRun: args["dry-run"],
          allowErrors: args["allow-errors"],
        }),
      );
    }),
});

const main = defineCommand({
  meta: {
    name: "transcript",
    description: "Read and edit a meeting's transcript in a database",
  },
  subCommands: {
    render: renderCmd,
    words: wordsCmd,
    stats: statsCmd,
    check: checkCmd,
    fix: fixCmd,
    apply: applyCmd,
  },
});

await runMain(main);
