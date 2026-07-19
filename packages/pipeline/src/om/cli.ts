#!/usr/bin/env tsx
// The `om` CLI: composable meeting-ingestion commands. A thin wrapper over the
// exported API in ./index.ts — commands only parse arguments and wire stdio.
// Unix conventions: machine-readable results on stdout, human progress/logs on
// stderr, so pipes like `om available | head -5 | om ingest` stay clean.
//
// Database selection follows the named-database convention: defaults to
// `local`, overridable per-invocation with `DB=prod om <cmd>`.
import { defineCommand, runMain } from "citty";

// A downstream pipe closing early (eg `om available | head -3`) raises EPIPE
// on stdout; that's normal pipeline behavior, not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
import { getDb, type DB } from "@open-minutes/core/db";
import { listIngested, type IngestedMeeting } from "./ingested";
import { listAvailable } from "./available";
import { ingestVideos } from "./ingest";

async function withDb<T>(fn: (db: DB) => Promise<T>): Promise<T> {
  const { db, client } = getDb();
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
      "Pass YouTube video IDs to filter to just those.",
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
    m.youtubeId,
    m.body,
    m.startTime?.toISOString().slice(0, 10) ?? "",
    String(m.segmentCount),
    m.title,
  ]);
  const header = ["VIDEO", "BODY", "DATE", "SEGMENTS", "TITLE"];
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
      "Print the YouTube video IDs on bodies' video sources that are not yet " +
      "in the database, one per line, newest first",
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

const ingest = defineCommand({
  meta: {
    name: "ingest",
    description:
      "Run the full pipeline (download → transcribe → diarize → align → " +
      "identify) for each video ID from args and/or stdin, and commit each " +
      "meeting to the database",
  },
  args: {},
  async run({ args }) {
    let ids = args._;
    if (ids.length === 0) {
      ids = (await readStdin()).split(/\s+/).filter(Boolean);
    }
    if (ids.length === 0) {
      throw new Error(
        "No video IDs given. Pass them as arguments or pipe them to stdin " +
          "(eg `om available | head -5 | om ingest`).",
      );
    }
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
  subCommands: { status, available, ingest },
});

await runMain(main);
