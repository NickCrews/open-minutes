#!/usr/bin/env tsx
// The `om` CLI: composable meeting-ingestion commands, model downloads, and the
// meeting-cleanup tools. A thin wrapper over the exported APIs of
// @open-minutes/ingest/om, @open-minutes/audio and ../tools — commands only
// parse arguments and wire stdio.
// Unix conventions: machine-readable results on stdout, human progress/logs on
// stderr, so pipes like `om available | head -5 | om ingest` stay clean.
//
// Database selection follows the named-database convention: defaults to
// `local`, overridable per-invocation with `DB=prod om <cmd>`. Every command
// first readies the database via prepareDatabase(), like `pnpm dev` does.
import { defineCommand, runMain } from "citty";
import { loadRootDotEnv } from "@open-minutes/core/dotenv";

// Settings like OBJECT_STORE_PUBLIC_URL (which the audio tools use to
// download a meeting's audio) come from the repo's .env.
loadRootDotEnv();

// A downstream pipe closing early (eg `om available | head -3`) raises EPIPE
// on stdout; that's normal pipeline behavior, not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
import { getDb, resolveDatabaseUrl, type DB } from "@open-minutes/db";
import { prepareDatabase } from "@open-minutes/db/ensure";
import type { IngestedMeeting, MeetingToIngest } from "@open-minutes/ingest/om";
import { runTools } from "./tools";

// Ingestion and the model downloads are heavy, so they are imported only by
// the commands that need them.
const ingestApi = () => import("@open-minutes/ingest/om");
const audioModels = () => import("@open-minutes/audio/models");

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
      "List the meetings ingested in the current database. " +
      "Pass meetings' IDs on their sites (YouTube video IDs, akleg.gov " +
      "meeting IDs) to filter to just those.",
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
    const { listIngested } = await ingestApi();
    await withDb(async (db) => {
      const meetings = await listIngested(db, ids.length > 0 ? ids : undefined);
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

function printStatusTable(meetings: IngestedMeeting[]): void {
  const rows = meetings.map((m) => [
    m.siteKind,
    m.siteId,
    m.body,
    m.date ?? "",
    String(m.segmentCount),
    m.title,
  ]);
  const header = ["SITE", "ID", "BODY", "DATE", "SEGMENTS", "TITLE"];
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
}

const available = defineCommand({
  meta: {
    name: "available",
    description:
      "Print the meetings on bodies' meeting sources that are not yet in " +
      "the database, one per line as `<id>\t<body slug>`, each body's " +
      "newest first. `om ingest` reads this.",
  },
  args: {
    body: {
      type: "string",
      description: 'Restrict the scrape to one body slug (eg "gbos")',
    },
  },
  async run({ args }) {
    const { listAvailable } = await ingestApi();
    await withDb(async (db) => {
      const meetings = await listAvailable(db, { body: args.body });
      for (const { siteId, body } of meetings) {
        console.log(`${siteId}\t${body}`);
      }
    });
  },
});

const ingest = defineCommand({
  meta: {
    name: "ingest",
    description:
      "Run the full pipeline (download → transcribe → clean → diarize → " +
      "align → identify) for each meeting, and commit it to the database. " +
      "Meetings are YouTube video IDs or URLs, or akleg.gov meeting IDs or " +
      "URLs, as arguments, or on stdin one per line as `om available` " +
      "prints them: `<id>[\t<body slug>]`.",
  },
  args: {
    body: {
      type: "string",
      description:
        "The slug of the body the meetings belong to. Needed when it's not " +
        "the body whose meeting source is the meeting's YouTube channel or " +
        "akleg.gov committee, eg when the source is a playlist",
    },
  },
  async run({ args }) {
    let meetings: MeetingToIngest[] = args._.map((ref) => ({
      ref,
      body: args.body,
    }));
    if (meetings.length === 0) {
      const { parseMeetingLines } = await ingestApi();
      meetings = parseMeetingLines(await readStdin(), args.body);
    }
    if (meetings.length === 0) {
      throw new Error(
        "No meetings given. Pass them as arguments or pipe them to stdin " +
          "(eg `om available | head -5 | om ingest`).",
      );
    }
    const { ingestMeetings } = await ingestApi();
    await withDb(async (db) => {
      const { results, failures } = await ingestMeetings(db, meetings);
      for (const result of results) {
        if (result.status === "ingested") console.log(result.siteId);
      }
      const ingested = results.filter((r) => r.status === "ingested").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      console.error(
        `Ingested ${ingested}, skipped ${skipped}, failed ${failures.length} of ${meetings.length} meeting(s)`,
      );
      if (failures.length > 0) {
        process.exitCode = 1;
      }
    });
  },
});

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
  async run({ args }) {
    const { ALL_MODEL_SPECS, ensureAllModels } = await audioModels();
    if (args.list) {
      for (const spec of ALL_MODEL_SPECS) {
        console.log(JSON.stringify(spec));
      }
      return;
    }
    ensureAllModels();
  },
});

const toolsCommand = defineCommand({
  meta: {
    name: "tools",
    description:
      "The meeting-cleanup tools (data and audio) as a JSON CLI: no arguments lists them, " +
      "`<tool> --schema` prints a tool's input, `<tool> '<json>'` calls it " +
      "(input may also come on stdin), and --describe prints every tool " +
      "with its schema. --db <name> picks the database.",
  },
  async run({ rawArgs }) {
    await runTools(rawArgs);
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
  subCommands: { status, available, ingest, models, tools: toolsCommand },
});

await runMain(main);
