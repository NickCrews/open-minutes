#!/usr/bin/env vpx
// Read a meeting's transcript in a database, check it against the meeting
// rules and apply their fixes, behind the root `pnpm transcript` script. See
// this package's README.
import process from "node:process";
import { defineCommand, runMain } from "citty";
import { parseClock } from "@open-minutes/core/clock";
import { type getDb } from "@open-minutes/db";
import { dbArg, reportFix, withDb } from "./cli";
import { fixRules } from "./edit";
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
  ...dbArg,
} as const;

const dryRunArg = {
  "dry-run": {
    type: "boolean",
    description: "Report what would change, and save nothing",
  },
} as const;

async function loadRef(db: ReturnType<typeof getDb>["db"], ref: string) {
  return loadMeeting(db, await findMeetingId(db, ref));
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
  args: {
    ...common,
    ...dryRunArg,
    "allow-errors": {
      type: "boolean",
      description: "Save even if the fixes add rule errors",
    },
  },
  run: ({ args }) =>
    withDb(args.db, async (db) => {
      const id = await findMeetingId(db, args.meeting);
      reportFix(
        await fixRules({
          db,
          meetingId: id,
          dryRun: args["dry-run"],
          allowErrors: args["allow-errors"],
        }),
      );
    }),
});

const main = defineCommand({
  meta: {
    name: "transcript",
    description:
      "Read a meeting's transcript in a database, check it against the meeting rules, and apply their fixes. `pnpm changeset` edits it.",
  },
  subCommands: {
    render: renderCmd,
    words: wordsCmd,
    stats: statsCmd,
    check: checkCmd,
    fix: fixCmd,
  },
});

await runMain(main);
