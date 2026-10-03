#!/usr/bin/env tsx
// The `om` CLI: composable meeting-ingestion commands. A thin wrapper over the
// exported API in ./index.ts — commands only parse arguments and wire stdio.
// Unix conventions: machine-readable results on stdout, human progress/logs on
// stderr, so pipes like `om available | head -5 | om ingest` stay clean.
//
// Database selection follows the named-database convention: defaults to
// `local`, overridable per-invocation with `DB=prod om <cmd>`. Every command
// first readies the database via prepareDatabase(), like `pnpm dev` does.
import { defineCommand, runMain } from "citty";

// A downstream pipe closing early (eg `om available | head -3`) raises EPIPE
// on stdout; that's normal pipeline behavior, not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
import { getDb, resolveDatabaseUrl, type DB } from "@open-minutes/db";
import { prepareDatabase } from "@open-minutes/db/ensure";
import { listMeetings, type MeetingStatus } from "./meetings";
import { listAvailable } from "./available";
import { discoverMeetings } from "./discover";
import { listPending, processMeetings } from "./process";
import { ingestVideos } from "./ingest";
import { describeState } from "./runs";
import { STEPS } from "./steps";
import { ALL_MODEL_SPECS, ensureAllModels } from "../all-models";

async function withDb<T>(fn: (db: DB) => Promise<T>): Promise<T> {
  // Same readiness rule as `pnpm dev`: local is migrated (and created, on a
  // new branch) as needed; a remote target must already have the schema.
  const url = resolveDatabaseUrl();
  await prepareDatabase(url);
  const { db, client } = getDb(url);
  try {
    return await fn(db);
  } finally {
    await client.end();
  }
}

const status = defineCommand({
  meta: {
    name: "status",
    description:
      "List the meetings in the current database and where each processing " +
      "step stands. Pass YouTube video IDs to filter to just those.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Emit one JSON object per meeting instead of a table",
      default: false,
    },
  },
  async run({ args }) {
    const ids = args._;
    await withDb(async (db) => {
      const meetings = await listMeetings(db, ids.length > 0 ? ids : undefined);
      if (args.json) {
        for (const meeting of meetings) {
          console.log(JSON.stringify(meeting));
        }
        return;
      }
      printStatusTable(meetings);
    });
  },
});

function printStatusTable(meetings: MeetingStatus[]): void {
  const rows = meetings.map((m) => [
    m.youtubeId,
    m.body,
    m.date ?? "",
    String(m.segmentCount),
    ...STEPS.map((step) => describeState(m.steps[step.name]!)),
    m.title,
  ]);
  const header = [
    "VIDEO",
    "BODY",
    "DATE",
    "SEGMENTS",
    ...STEPS.map((step) => step.name.toUpperCase()),
    "TITLE",
  ];
  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => r[col]!.length)),
  );
  for (const row of [header, ...rows]) {
    console.log(row.map((cell, col) => cell.padEnd(widths[col]!)).join("  "));
  }

  const totalSegments = meetings.reduce((n, m) => n + m.segmentCount, 0);
  const bodies = new Set(meetings.map((m) => m.body));
  console.log(
    `\n${meetings.length} meeting(s), ${totalSegments} segment(s), ${bodies.size} body(ies)`,
  );
  for (const step of STEPS) {
    const counts = new Map<string, number>();
    for (const m of meetings) {
      const kind = m.steps[step.name]!.kind;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const summary = [...counts].map(([k, n]) => `${n} ${k}`).join(", ");
    console.log(`${step.name} ${step.version}: ${summary || "nothing"}`);
  }
}

const available = defineCommand({
  meta: {
    name: "available",
    description:
      "Print the YouTube video IDs on bodies' video sources that are not yet " +
      "meetings in the database, one per line, newest first",
  },
  args: {
    body: {
      type: "string",
      description: 'Restrict the scrape to one body slug (eg "gbos")',
    },
  },
  async run({ args }) {
    await withDb(async (db) => {
      const ids = await listAvailable(db, { body: args.body });
      for (const id of ids) {
        console.log(id);
      }
    });
  },
});

const discover = defineCommand({
  meta: {
    name: "discover",
    description:
      "Record each video on bodies' video sources that isn't a meeting yet " +
      "as a meeting waiting to be processed, and print its ID, newest first",
  },
  args: {
    body: {
      type: "string",
      description: 'Restrict the scrape to one body slug (eg "gbos")',
    },
  },
  async run({ args }) {
    await withDb(async (db) => {
      const discovered = await discoverMeetings(db, { body: args.body });
      for (const meeting of discovered) {
        console.log(meeting.youtubeId);
      }
      console.error(`Discovered ${discovered.length} meeting(s)`);
    });
  },
});

const dueArgs = {
  stale: {
    type: "boolean",
    description:
      "Also redo steps that succeeded at an older version, or before a step " +
      "they're made from was redone",
    default: false,
  },
} as const;

const pending = defineCommand({
  meta: {
    name: "pending",
    description:
      "Print the IDs of meetings with a processing step due, one per line, " +
      "newest first. Steps that failed too often are left out; `om status` " +
      "shows them",
  },
  args: {
    ...dueArgs,
    body: {
      type: "string",
      description: 'Only one body\'s meetings, by slug (eg "gbos")',
    },
    limit: {
      type: "string",
      description: "At most this many meetings",
    },
    json: {
      type: "boolean",
      description: "Emit one JSON object per meeting, with its due steps",
      default: false,
    },
  },
  async run({ args }) {
    const limit = args.limit === undefined ? undefined : Number(args.limit);
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
      throw new Error(`--limit must be a whole number, not "${args.limit}"`);
    }
    await withDb(async (db) => {
      const meetings = await listPending(db, {
        body: args.body,
        limit,
        stale: args.stale,
      });
      for (const meeting of meetings) {
        console.log(args.json ? JSON.stringify(meeting) : meeting.youtubeId);
      }
    });
  },
});

const process_ = defineCommand({
  meta: {
    name: "process",
    description:
      "Run each due processing step (transcript, ...) for each meeting, by " +
      "video ID from args and/or stdin, recording every run in the database. " +
      "Meetings must already be recorded (`om discover`)",
  },
  args: {
    ...dueArgs,
  },
  async run({ args }) {
    const ids = await idsFromArgsOrStdin(
      args._,
      "`om pending --limit 5 | om process`",
    );
    await withDb(async (db) => {
      // Named one by one, so steps that failed too often are retried too.
      const { results, failures } = await processMeetings(db, ids, {
        stale: args.stale,
        retry: true,
      });
      for (const result of results) {
        if (result.steps.some((s) => s.outcome === "succeeded")) {
          console.log(result.youtubeId);
        }
      }
      console.error(
        `Processed ${results.length}, failed ${failures.length} of ${ids.length} meeting(s)`,
      );
      if (failures.length > 0) {
        process.exitCode = 1;
      }
    });
  },
});

const ingest = defineCommand({
  meta: {
    name: "ingest",
    description:
      "Record each video ID from args and/or stdin as a meeting if it isn't " +
      "one, then process it (download → transcribe → clean → diarize → " +
      "align → identify), committing it to the database",
  },
  args: {},
  async run({ args }) {
    const ids = await idsFromArgsOrStdin(
      args._,
      "`om available | head -5 | om ingest`",
    );
    await withDb(async (db) => {
      const { results, failures } = await ingestVideos(db, ids);
      for (const result of results) {
        if (result.status === "ingested") console.log(result.youtubeId);
      }
      const ingested = results.filter((r) => r.status === "ingested").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      console.error(
        `Ingested ${ingested}, skipped ${skipped}, failed ${failures.length} of ${ids.length} video(s)`,
      );
      if (failures.length > 0) {
        process.exitCode = 1;
      }
    });
  },
});

/** Video IDs from the arguments, else whitespace-separated on stdin. */
async function idsFromArgsOrStdin(
  args: string[],
  example: string,
): Promise<string[]> {
  const ids =
    args.length > 0 ? args : (await readStdin()).split(/\s+/).filter(Boolean);
  if (ids.length === 0) {
    throw new Error(
      `No video IDs given. Pass them as arguments or pipe them to stdin (eg ${example}).`,
    );
  }
  return ids;
}

const models = defineCommand({
  meta: {
    name: "models",
    description:
      "Download every ML model the pipeline uses (~650MB), skipping any " +
      "already present. Otherwise each is downloaded on first use.",
  },
  args: {
    list: {
      type: "boolean",
      description:
        "Print each model's spec as one JSON object per line, without " +
        "downloading (CI hashes this into its model cache key)",
      default: false,
    },
  },
  run({ args }) {
    if (args.list) {
      for (const spec of ALL_MODEL_SPECS) {
        console.log(JSON.stringify(spec));
      }
      return;
    }
    ensureAllModels();
  },
});

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

const main = defineCommand({
  meta: {
    name: "om",
    description: "Manage the open-minutes meeting database",
  },
  subCommands: {
    status,
    available,
    discover,
    pending,
    process: process_,
    ingest,
    models,
  },
});

await runMain(main);
