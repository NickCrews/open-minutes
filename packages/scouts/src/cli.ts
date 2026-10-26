#!/usr/bin/env vpx
// The scout CLI, behind the root `pnpm scout` script. See
// docs/contributing/recordings.md.
import process from "node:process";
import { defineCommand, runMain } from "citty";
import { getDb, resolveDatabaseUrl } from "@open-minutes/db";
import { prepareDatabase } from "@open-minutes/db/ensure";
import { assertCanUpload, realAudioTools } from "./audio-tools";
import { availableRecordings, failedRecordings } from "./harness";
import { runLogger } from "./logger";
import { DEFAULT_AUDIO_CAP, runScouts } from "./run";
import { SCOUTS } from "./scouts";

const dbArg = {
  db: {
    type: "string",
    description:
      'Target database: a name ("local", "prod", ...) or a postgres:// URL. Default: $DB, else "local".',
  },
} as const;

async function withDb<T>(
  target: string | undefined,
  fn: (db: ReturnType<typeof getDb>["db"]) => Promise<T>,
): Promise<T> {
  // Migrates a local database; only checks a remote one.
  const url = resolveDatabaseUrl(target);
  await prepareDatabase(url);
  const { db, client } = getDb(url);
  try {
    return await fn(db);
  } finally {
    await client.end();
  }
}

const run = defineCommand({
  meta: {
    name: "run",
    description:
      "Run the scouts whose cron fell in the past hour (or --scout), then fetch and store audio",
  },
  args: {
    ...dbArg,
    scout: { type: "string", description: "Run only this scout, now" },
    "dry-run": {
      type: "boolean",
      description: "Log what would be written and fetched, and write nothing",
    },
    "audio-cap": {
      type: "string",
      description: `Recordings whose audio to fetch, at most (default ${DEFAULT_AUDIO_CAP})`,
    },
  },
  async run({ args }) {
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => controller.abort());
    }
    const audioCap =
      args["audio-cap"] === undefined
        ? DEFAULT_AUDIO_CAP
        : Number(args["audio-cap"]);
    if (!Number.isInteger(audioCap) || audioCap < 0) {
      throw new Error(
        `--audio-cap must be a whole number: ${args["audio-cap"]}`,
      );
    }
    if (audioCap > 0 && !args["dry-run"]) await assertCanUpload();
    const logger = runLogger();
    const result = await withDb(args.db, (db) =>
      runScouts({
        db,
        scouts: SCOUTS,
        scoutId: args.scout,
        logger,
        tools: realAudioTools(),
        audioCap,
        signal: controller.signal,
        dryRun: args["dry-run"],
      }),
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  },
});

const available = defineCommand({
  meta: {
    name: "available",
    description:
      "List recordings ready to become meetings: not ruled out, audio stored, no meeting yet",
  },
  args: dbArg,
  async run({ args }) {
    const rows = await withDb(args.db, (db) => availableRecordings(db));
    for (const r of rows) console.log(JSON.stringify(r));
  },
});

const failed = defineCommand({
  meta: {
    name: "failed",
    description:
      "List recordings whose audio was given up on, with the last error. Set audio_failures to 0 to retry one.",
  },
  args: dbArg,
  async run({ args }) {
    const rows = await withDb(args.db, (db) => failedRecordings(db));
    for (const r of rows) console.log(JSON.stringify(r));
  },
});

await runMain(
  defineCommand({
    meta: {
      name: "scout",
      description: "Find recordings on the sites that publish meetings",
    },
    subCommands: { run, available, failed },
  }),
);
