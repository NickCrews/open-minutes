#!/usr/bin/env vpx
// Move golden meetings between a database and the datums, behind the root
// `pnpm goldens` script. See this package's README.
import { relative } from "node:path";
import process from "node:process";
import { defineCommand, runMain } from "citty";
import { getDb } from "@open-minutes/db";
import { toGolden, writeGolden } from "./export";
import { findMeetingId, loadMeeting } from "./meeting";
import { publishGolden } from "./publish";

const CWD = process.env.INIT_CWD ?? process.cwd();

const dbArg = {
  db: {
    type: "string",
    description:
      'Database: a name ("local", "prod", ...) or a postgres:// URL. Default: $DB, else "local".',
  },
} as const;

const exportCmd = defineCommand({
  meta: {
    name: "export",
    description:
      "Write meetings from the database as golden meetings: their directories under packages/datasets/datums/meetings/ and their people's lines in people.jsonl",
  },
  args: {
    ...dbArg,
    meetings: {
      type: "positional",
      required: true,
      description: "Meetings, by slug or id",
    },
  },
  run: async ({ args }) => {
    const refs = [args.meetings, ...args._.slice(1)];
    const { db, client } = getDb(args.db);
    try {
      for (const ref of refs) {
        const meeting = await loadMeeting(db, await findMeetingId(db, ref));
        const files = await writeGolden(toGolden(meeting));
        console.log(
          `${meeting.slug}: wrote ${files.map((f) => relative(CWD, f)).join(", ")}`,
        );
      }
    } finally {
      await client.end();
    }
  },
});

const publishCmd = defineCommand({
  meta: {
    name: "publish",
    description:
      "Make the database's copy of golden meetings match their files: the meeting, its segments and chapters, and its people. People the database doesn't have get voiceprints from the meeting's audio.",
  },
  args: {
    ...dbArg,
    meetings: {
      type: "positional",
      required: true,
      description: "Golden meetings, by slug",
    },
    yes: {
      type: "boolean",
      description: "Save the changes; without it, only report them",
    },
  },
  run: async ({ args }) => {
    const slugs = [args.meetings, ...args._.slice(1)];
    const { db, client } = getDb(args.db);
    try {
      for (const slug of slugs) {
        const notes = await publishGolden(db, slug, { dryRun: !args.yes });
        console.log(`${slug}:`);
        for (const note of notes) console.log(`  ${note}`);
      }
      if (!args.yes) console.log("Nothing saved. Pass --yes to save.");
    } finally {
      await client.end();
    }
  },
});

const main = defineCommand({
  meta: {
    name: "goldens",
    description: "Move golden meetings between a database and the datums",
  },
  subCommands: { export: exportCmd, publish: publishCmd },
});

await runMain(main);
