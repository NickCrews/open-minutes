#!/usr/bin/env vpx
// The root `pnpm changeset` script: `check` and `apply` from @open-minutes/edit,
// and `view`, which shows what a changeset does as a page. See this package's
// README.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { defineCommand, runMain } from "citty";
import type { DB } from "@open-minutes/db";
import { findMeetingId } from "@open-minutes/edit";
import {
  applyCmd,
  checkCmd,
  HELP,
} from "@open-minutes/edit/changeset-commands";
import { callerPath, dbArg, withDb } from "@open-minutes/edit/cli";
import { buildChangesetDiff } from "./build";
import { describeRows, renderPage } from "./render";
import { loadSource } from "./source";
import type { ChangesetDiff } from "./types";

const CLIENT_SCRIPT = readFileSync(
  new URL("./client.js", import.meta.url),
  "utf8",
);

/**
 * The database a target names, to show on the page: its name, or a URL's
 * host and database, never its password.
 */
function baseLabel(target: string | undefined): string {
  const t = target ?? (process.env.DB || process.env.DATABASE_URL || "local");
  if (!t.includes("://")) return t;
  const url = new URL(t);
  return `${url.hostname}${url.pathname}`;
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

function summarize(diff: ChangesetDiff): string {
  if (diff.error) return `fails: ${diff.error.message}`;
  return `would change ${describeRows(diff.rows)}; resolves ${diff.resolved.length} violation(s), introduces ${diff.introduced.length}`;
}

const viewCmd = defineCommand({
  meta: {
    name: "view",
    description:
      "Run a changeset and roll it back, like `check`, a statement at a time, and show what each statement does as a page to review",
  },
  args: {
    source: {
      type: "positional",
      required: true,
      description:
        "The changeset: a SQL file; Markdown, or the URL of a GitHub issue or comment, with a ```sql block; any other URL; or - for stdin",
    },
    meeting: {
      type: "string",
      description:
        "The meeting it changes, by slug or id. Default: the --meeting in the source",
    },
    ...dbArg,
    out: {
      type: "string",
      description:
        "Write the page here. Default: changeset-<meeting>.html in the temp directory",
    },
    json: {
      type: "string",
      description: "Also write the diff as JSON here",
    },
    serve: {
      type: "boolean",
      description:
        "Serve the page instead, rerunning the changeset from its source on every reload",
    },
    port: {
      type: "string",
      default: "4400",
      description: "The port to serve on",
    },
    open: {
      type: "boolean",
      default: true,
      description: "Open the page in a browser (--no-open not to)",
    },
    context: {
      type: "string",
      default: "8",
      description: "Words of transcript to show either side of each change",
    },
  },
  run: ({ args }) =>
    withDb(args.db, async (db) => {
      const cwd = callerPath(".");
      const build = async (): Promise<ChangesetDiff> => {
        const source = await loadSource(args.source, { cwd });
        const meeting = args.meeting ?? source.meeting;
        if (!meeting)
          throw new Error(
            `${source.label} names no meeting with --meeting; pass --meeting`,
          );
        return buildChangesetDiff({
          db: db as DB,
          meetingId: await findMeetingId(db, meeting),
          sql: source.sql,
          base: baseLabel(args.db),
          source: source.label,
          context: Number(args.context),
        });
      };

      if (args.serve) return serve(build, Number(args.port), args.open);

      const diff = await build();
      const out = callerPath(
        args.out ??
          join(
            tmpdir(),
            `changeset-${diff.meeting.slug ?? diff.meeting.id}.html`,
          ),
      );
      writeFileSync(out, renderPage(diff, CLIENT_SCRIPT));
      if (args.json)
        writeFileSync(
          callerPath(args.json),
          JSON.stringify(diff, null, 2) + "\n",
        );
      console.log(`${out}: ${summarize(diff)}`);
      if (args.open) openInBrowser(out);
      if (diff.error) process.exitCode = 1;
    }),
});

/** Serve the page at /, and the diff at /diff.json, rebuilding on every request, until interrupted. */
async function serve(
  build: () => Promise<ChangesetDiff>,
  port: number,
  open: boolean,
): Promise<void> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/" && path !== "/diff.json") {
      res.writeHead(404).end();
      return;
    }
    try {
      const diff = await build();
      console.log(`${new Date().toLocaleTimeString()} ${summarize(diff)}`);
      if (path === "/diff.json")
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(diff));
      else
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(renderPage(diff, CLIENT_SCRIPT));
    } catch (err) {
      console.error(err);
      res
        .writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        .end(err instanceof Error ? err.message : String(err));
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const url = `http://127.0.0.1:${port}/`;
  console.log(`serving ${url}; reload to rerun the changeset, ctrl-c to stop`);
  if (open) openInBrowser(url);
  await new Promise<void>((resolve) =>
    process.once("SIGINT", () => server.close(() => resolve())),
  );
}

const main = defineCommand({
  meta: {
    name: "changeset",
    description: `Check, apply and view changesets.\n\n${HELP}`,
  },
  subCommands: { check: checkCmd, apply: applyCmd, view: viewCmd },
});

await runMain(main);
