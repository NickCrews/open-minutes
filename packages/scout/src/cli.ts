#!/usr/bin/env vpx
// The `pnpm scout` CLI. Progress goes to stdout and errors to stderr; in
// GitHub Actions, errors become annotations.
import process from "node:process";
import { format } from "node:util";
import { defineCommand, runMain } from "citty";
import { getDb } from "@open-minutes/db";
import { blobStore, blobStoreWriterFromEnv } from "@open-minutes/blobstore";
import { type ScoutLog, scout } from "./scout";
import { listerFor, siteAdapters } from "./sites";

/** `console`, with errors as GitHub Actions annotations when in Actions. */
function logFor(env = process.env): ScoutLog {
  if (env.GITHUB_ACTIONS !== "true") return console;
  return {
    info: console.info,
    warn: (...data: unknown[]) =>
      console.log(`::warning::${escapeAnnotation(format(...data))}`),
    error: (...data: unknown[]) =>
      console.log(`::error::${escapeAnnotation(format(...data))}`),
  };
}

/** `message`, escaped as a workflow command's data. */
function escapeAnnotation(message: string): string {
  return message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

const run = defineCommand({
  meta: {
    name: "run",
    description:
      "Scan every body's meeting source for recordings, store new recordings' metadata, then store audio for recordings not ruled out as meetings. See docs/contributing/recordings.md.",
  },
  args: {
    body: {
      type: "string",
      description: "Scan only this body's meeting source, by slug",
    },
    "dry-run": {
      type: "boolean",
      description:
        "List what the run would do. Fetches new recordings' metadata, but writes nothing to the database or the blob store.",
      default: false,
    },
    "max-audio": {
      type: "string",
      description: "Store at most this many recordings' audio",
      default: "20",
    },
    debs: {
      type: "string",
      description:
        "Install WARP and Tor if YouTube refuses a direct request, keeping their .deb files here so they can be cached",
    },
    db: {
      type: "string",
      description:
        'Target database: a name ("local", "prod", ...) or a postgres:// URL. Default: $DB, else "local".',
    },
  },
  async run({ args }) {
    const maxAudio = Number(args["max-audio"]);
    if (!Number.isInteger(maxAudio) || maxAudio < 0) {
      throw new Error(
        `--max-audio must be a whole number: ${args["max-audio"]}`,
      );
    }
    const { db, client } = getDb(args.db);
    try {
      const report = await scout({
        db,
        sites: siteAdapters({ debs: args.debs }),
        listerFor,
        store: blobStore(),
        writer: blobStoreWriterFromEnv(process.env),
        body: args.body,
        dryRun: args["dry-run"],
        maxAudio,
        log: logFor(),
      });
      const verb = args["dry-run"] ? "Would find" : "Found";
      console.info(
        `${verb} ${report.found.length} recordings, add ${report.bodiesAdded.length} recording bodies, ` +
          (args["dry-run"]
            ? "and store audio as listed above."
            : `and stored ${report.audioStored.length} recordings' audio.`) +
          (report.errors ? ` ${report.errors} errors.` : ""),
      );
      process.exitCode = report.exitCode;
    } finally {
      await client.end();
    }
  },
});

void runMain(
  defineCommand({
    meta: {
      name: "scout",
      description:
        "Find recordings on the sites that publish them, and store their metadata and audio",
    },
    subCommands: { run },
  }),
);
