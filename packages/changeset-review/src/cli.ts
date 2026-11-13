#!/usr/bin/env vpx
// The root `pnpm changeset` script: check, apply and view changesets, and
// propose, revise, review and apply them through GitHub issues. See this
// package's README.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { defineCommand, runMain } from "citty";
import type { DB } from "@open-minutes/db";
import {
  applyChangeset,
  type Changeset,
  ChangesetError,
  checkChangeset,
  formatIssue,
  type MeetingRef,
} from "@open-minutes/edit";
import { dbArg, formatRows, withDb } from "@open-minutes/edit/cli";
import { applyIfUnchanged, buildChangesetDiff, sqlHash } from "./build";
import { appliedComment, checkComment, type PageLink } from "./comments";
import { currentRepo, GitHub, type IssueRef, parseIssueRef } from "./github";
import {
  approvedVersion,
  checkOf,
  LABELS,
  normalizeReview,
  pickVersion,
  readThread,
  summarize,
  type Check,
  type Version,
  versionComment,
} from "./issue";
import { describeRows, renderPage } from "./render";
import { loadSource, type Source } from "./source";
import { splitStatements } from "./statements";
import type { ChangesetDiff, VersionRef } from "./types";

const CLIENT_SCRIPT = readFileSync(
  new URL("./client.js", import.meta.url),
  "utf8",
);

/** client.js's reviewComment, run without a document. */
const reviewComment = new Function(
  `${CLIENT_SCRIPT}\nreturn reviewComment;`,
)() as (
  diff: unknown,
  statements: unknown[],
  review: {
    verdicts: Record<string, string>;
    notes: Record<string, string>;
    overall: string;
  },
) => string;

const HELP = `A changeset is a SQL file of changes and assertions. It runs in one
transaction, as the changeset role, and fails, saving nothing, if a statement
or assertion fails. "check" runs it, reports the rows it would change and, in
each meeting it would change, the meeting rule violations it would resolve and
introduce, and rolls it back. "view" does the same a statement at a time, and
writes a page showing what each statement does. "apply" runs it and saves it,
without running the rules.

To change production, propose the changeset in a GitHub issue instead of
applying it: "propose" opens the issue with v1, "revise" posts the next
version, "review" posts a review, and "status" shows where it stands. CI checks
each version, and applies the latest one when a maintainer labels the issue
${LABELS.approved}.

A source is a SQL file, - for stdin, or an issue ("123", "owner/name#123" or
its URL), whose latest version, or --version, it takes.

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

/**
 * The directory the caller ran the root script from: `pnpm --filter` runs a
 * package's script in the package's directory, and sets INIT_CWD to the
 * caller's.
 */
const CWD = process.env.INIT_CWD ?? process.cwd();
const callerPath = (path: string) => resolve(CWD, path);

const sourceArgs = {
  source: {
    type: "positional",
    required: true,
    description:
      "The changeset: a SQL file, - for stdin, or an issue (123, owner/name#123, or its URL)",
  },
  version: {
    type: "string",
    description: "With an issue, the version to take. Default: the latest",
  },
} as const;

const versionNumber = (v: string | undefined) =>
  v === undefined ? undefined : Number(v.replace(/^v/, ""));

function load(args: { source: string; version?: string }): Promise<Source> {
  return loadSource(args.source, {
    cwd: CWD,
    version: versionNumber(args.version),
  });
}

function issueArg(ref: string): IssueRef {
  const issue = parseIssueRef(ref, currentRepo(CWD));
  if (!issue)
    throw new Error(
      `${ref} isn't an issue: give 123, owner/name#123, or the issue's URL`,
    );
  return issue;
}

/**
 * Run `run` on the changeset the arguments name, and report what it did, or
 * why it failed.
 */
function runCommand<T>(
  args: { source: string; version?: string; db?: string },
  run: (changeset: Changeset) => Promise<T>,
  report: (result: T) => void,
): Promise<void> {
  return withDb(args.db, async (db) => {
    const { sql } = await load(args);
    try {
      report(await run({ db, sql }));
    } catch (err) {
      if (!(err instanceof ChangesetError)) throw err;
      console.log(`failed, nothing saved: ${err.message}`);
      process.exitCode = 1;
    }
  });
}

const ref = (m: MeetingRef) => m.slug ?? String(m.id);

const checkCmd = defineCommand({
  meta: {
    name: "check",
    description:
      "Run a changeset and roll it back: report the rows it would change and, in each meeting it would change, the rule violations it would resolve and introduce",
  },
  args: { ...sourceArgs, ...dbArg },
  run: ({ args }) =>
    runCommand(args, checkChangeset, ({ rows, meetings }) => {
      let resolved = 0;
      let added = 0;
      for (const m of meetings) {
        console.log(
          `${ref(m.after)}:${m.resolved.length || m.added.length ? "" : " no change in violations"}`,
        );
        for (const issue of m.resolved)
          console.log(`  resolves ${formatIssue(issue, m.before)}`);
        for (const issue of m.added)
          console.log(`  introduces ${formatIssue(issue, m.after)}`);
        resolved += m.resolved.length;
        added += m.added.length;
      }
      console.log(
        `would change ${formatRows(rows)}; in ${meetings.length} meeting(s), resolves ${resolved} violation(s) and introduces ${added}`,
      );
    }),
});

const applyCmd = defineCommand({
  meta: {
    name: "apply",
    description:
      "Run a changeset and save it. It doesn't run the meeting rules: `check` does, and so does `pnpm transcript check`. For production, propose it instead.",
  },
  args: { ...sourceArgs, ...dbArg },
  run: ({ args }) =>
    runCommand(args, applyChangeset, ({ rows, meetings }) => {
      console.log(
        `saved: ${formatRows(rows)}${meetings.length ? `; meetings changed: ${meetings.map(ref).join(", ")}` : ""}`,
      );
    }),
});

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
  spawn(cmd, [url], { stdio: "ignore", detached: true })
    .on("error", () => console.log(`open ${url} in a browser`))
    .unref();
}

function describeDiff(diff: ChangesetDiff): string {
  if (diff.error) return `fails: ${diff.error.message}`;
  const resolved = diff.outcomes.reduce((n, o) => n + o.resolved.length, 0);
  const introduced = diff.outcomes.reduce((n, o) => n + o.introduced.length, 0);
  return `would change ${describeRows(diff.rows)}; in ${diff.outcomes.length} meeting(s), resolves ${resolved} violation(s), introduces ${introduced}`;
}

/** The name of the page for a diff: `changeset-<issue>-v<n>-<sha>.html`, or `changeset-<sha>.html`. */
function pageName(diff: ChangesetDiff): string {
  const sha = diff.sha256.slice(0, 12);
  const v = diff.version;
  return v
    ? `changeset-${v.issue}-v${v.version}-${sha}.html`
    : `changeset-${sha}.html`;
}

const viewCmd = defineCommand({
  meta: {
    name: "view",
    description:
      "Run a changeset and roll it back, like `check`, a statement at a time, and write a page showing what each statement does, to review",
  },
  args: {
    ...sourceArgs,
    ...dbArg,
    out: {
      type: "string",
      description:
        "Write the page here. Default: changeset-<...>.html in the temp directory",
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
      const build = async (): Promise<ChangesetDiff> => {
        const source = await load(args);
        return buildChangesetDiff({
          db: db as DB,
          sql: source.sql,
          base: baseLabel(args.db),
          source: source.label,
          version: source.version,
          context: Number(args.context),
        });
      };

      if (args.serve) return serve(build, Number(args.port), args.open);

      const diff = await build();
      const out = callerPath(args.out ?? join(tmpdir(), pageName(diff)));
      writeFileSync(out, renderPage(diff, CLIENT_SCRIPT));
      if (args.json)
        writeFileSync(
          callerPath(args.json),
          JSON.stringify(diff, null, 2) + "\n",
        );
      console.log(`${out}: ${describeDiff(diff)}`);
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
      console.log(`${new Date().toLocaleTimeString()} ${describeDiff(diff)}`);
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

/** A file's text, or stdin's for "-". */
const readText = (path: string) =>
  readFileSync(path === "-" ? 0 : callerPath(path), "utf8");

/** The SQL in a file: its first ```sql block if it is Markdown. */
async function readSql(path: string): Promise<string> {
  const { sql } = await loadSource(path === "-" ? "-" : callerPath(path), {
    cwd: CWD,
  });
  if (!splitStatements(sql).length) throw new Error(`${path} has no SQL`);
  return sql;
}

const proposeCmd = defineCommand({
  meta: {
    name: "propose",
    description: `Open an issue labelled ${LABELS.proposal} proposing a changeset, and post it as v1. CI checks it and comments with a review page.`,
  },
  args: {
    file: {
      type: "positional",
      required: true,
      description: "The changeset's SQL file, or - for stdin",
    },
    title: {
      type: "string",
      required: true,
      description: "The issue's title",
    },
    body: {
      type: "string",
      description:
        "The issue's description: what the changeset changes and why",
    },
    "body-file": {
      type: "string",
      description: "Read the description from this file",
    },
    repo: {
      type: "string",
      description: "owner/name. Default: this checkout's origin",
    },
  },
  run: async ({ args }) => {
    const sql = await readSql(args.file);
    const repo = args.repo ?? currentRepo(CWD);
    if (!repo) throw new Error("No repository: pass --repo owner/name");
    const description = args["body-file"]
      ? readText(args["body-file"])
      : (args.body ?? "");
    const comment = versionComment(1, sql);
    const gh = new GitHub();
    const issue = await gh.createIssue(repo, {
      title: args.title,
      body: `${description.trim()}\n\n_The changeset's versions, CI's checks of them and reviews are in the comments. See [the changeset flow](https://github.com/${repo}/blob/main/packages/changeset-review/README.md)._\n`,
      labels: [LABELS.proposal],
    });
    const posted = await gh.comment({ repo, issue: issue.number }, comment);
    console.log(`${issue.html_url}: v1 at ${posted.html_url}`);
  },
});

const reviseCmd = defineCommand({
  meta: {
    name: "revise",
    description:
      "Post the next version of a changeset on its issue. CI checks it, and approving the issue applies the latest version.",
  },
  args: {
    issue: {
      type: "positional",
      required: true,
      description: "The issue: 123, owner/name#123, or its URL",
    },
    file: {
      type: "positional",
      required: true,
      description: "The new version's SQL file, or - for stdin",
    },
    note: {
      type: "string",
      description:
        "What changed since the last version, and which review it answers",
    },
    "note-file": {
      type: "string",
      description: "Read the note from this file",
    },
  },
  run: async ({ args }) => {
    const issue = issueArg(args.issue);
    const sql = await readSql(args.file);
    const gh = new GitHub();
    const info = await gh.issue(issue);
    if (!info.labels.includes(LABELS.proposal))
      throw new Error(`${info.html_url} isn't labelled ${LABELS.proposal}`);
    if (info.state !== "open") throw new Error(`${info.html_url} is closed`);
    const thread = readThread(await gh.comments(issue), sqlHash);
    const latest = thread.versions.at(-1);
    if (latest?.sha256 === sqlHash(sql))
      throw new Error(`the SQL is the same as v${latest.version}'s`);
    const next = (latest?.version ?? 0) + 1;
    const note = args["note-file"]
      ? readText(args["note-file"])
      : (args.note ?? "");
    const posted = await gh.comment(issue, versionComment(next, sql, note));
    console.log(`v${next}: ${posted.html_url}`);
  },
});

const reviewCmd = defineCommand({
  meta: {
    name: "review",
    description:
      'Post a review of a version of a changeset on its issue, from JSON: {"overall": "...", "statements": [{"statement": 3, "verdict": "accept" | "reject" | "question", "note": "..."}]}, numbering statements from 1 as the review page does. The review page\'s "Copy review comment" gives the same comment.',
  },
  args: {
    issue: {
      type: "positional",
      required: true,
      description: "The issue: 123, owner/name#123, or its URL",
    },
    file: {
      type: "positional",
      required: true,
      description: "The review as JSON, or - for stdin",
    },
    version: {
      type: "string",
      description: "The version reviewed. Default: the latest",
    },
  },
  run: async ({ args }) => {
    const issue = issueArg(args.issue);
    const review = normalizeReview(JSON.parse(readText(args.file)));
    if (!review)
      throw new Error(
        `${args.file} isn't a review: see \`pnpm changeset review --help\``,
      );
    const gh = new GitHub();
    const thread = readThread(await gh.comments(issue), sqlHash);
    const v = pickVersion(thread, versionNumber(args.version));
    if (!v) throw new Error(`${args.issue} has no such version`);
    const statements = splitStatements(v.sql);
    const state = {
      verdicts: {} as Record<string, string>,
      notes: {} as Record<string, string>,
      overall: review.overall,
    };
    for (const s of review.statements) {
      const statement = statements[s.statement - 1];
      if (!statement)
        throw new Error(
          `v${v.version} has ${statements.length} statements, not #${s.statement}`,
        );
      if (s.verdict) state.verdicts[statement.sql] = s.verdict;
      if (s.note) state.notes[statement.sql] = s.note;
    }
    const version: VersionRef = { ...issue, version: v.version, url: v.url };
    // The review covers what CI's latest check of the version says it does.
    const effect = checkOf(thread, v)?.effect ?? null;
    const body = reviewComment(
      {
        version,
        sha256: v.sha256,
        effect,
        base: null,
        source: v.url,
        error: null,
      },
      statements.map((s, index) => ({
        index,
        line: s.line,
        kind: s.kind,
        at: "",
        summary: "",
        sql: s.sql,
      })),
      state,
    );
    const posted = await gh.comment(issue, body);
    console.log(`review of v${v.version}: ${posted.html_url}`);
  },
});

const statusCmd = defineCommand({
  meta: {
    name: "status",
    description:
      "Show a changeset issue's versions, CI's check of each, its reviews, and whether it is approved or applied",
  },
  args: {
    issue: {
      type: "positional",
      required: true,
      description: "The issue: 123, owner/name#123, or its URL",
    },
    json: { type: "boolean", description: "Print it as JSON" },
    sql: {
      type: "boolean",
      description: "Print only the SQL of the latest version, or --version",
    },
    version: {
      type: "string",
      description: "With --sql, the version. Default: the latest",
    },
  },
  run: async ({ args }) => {
    const issue = issueArg(args.issue);
    const gh = new GitHub();
    const [info, comments] = await Promise.all([
      gh.issue(issue),
      gh.comments(issue),
    ]);
    const thread = readThread(comments, sqlHash);
    if (args.sql) {
      const v = pickVersion(thread, versionNumber(args.version));
      if (!v) throw new Error(`${info.html_url} has no such version`);
      process.stdout.write(v.sql);
      return;
    }
    const status = summarize(info, thread);
    if (args.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    const state = status.applied
      ? `applied v${status.applied.version}`
      : status.approved
        ? "approved"
        : status.open
          ? "open"
          : "closed";
    console.log(`${status.url}: ${status.title} (${state})`);
    for (const v of status.versions) {
      const check = v.check
        ? v.check.ok
          ? "CI: would apply"
          : "CI: fails"
        : "CI: not checked";
      console.log(
        `v${v.version} by ${v.author} ${v.createdAt} sha256 ${v.sha256.slice(0, 12)}; ${check}${v.check ? ` ${v.check.url}` : ""}`,
      );
      if (v.note) console.log(v.note.replace(/^/gm, "    "));
      for (const r of v.reviews) {
        const counts = { accept: 0, reject: 0, question: 0 };
        for (const s of r.statements) if (s.verdict) counts[s.verdict]++;
        console.log(
          `  review by ${r.author}${r.trusted ? "" : " (no write access)"}${r.stale ? " (stale: CI's latest check found it does something different from what this review saw)" : ""}: ${counts.accept} accepted, ${counts.reject} rejected, ${counts.question} questioned ${r.url}`,
        );
        if (r.overall) console.log(r.overall.replace(/^/gm, "    "));
        for (const s of r.statements)
          if (s.verdict !== "accept" || s.note)
            console.log(
              `    #${s.statement} (line ${s.line}) ${s.verdict ?? "note"}${s.note ? `: ${s.note.replace(/\n/g, "\n      ")}` : ""}`,
            );
      }
    }
    for (const p of status.problems) console.log(`warning: ${p}`);
  },
});

const ciArgs = {
  issue: { type: "positional", required: true, description: "The issue" },
  ...dbArg,
  "out-dir": {
    type: "string",
    required: true,
    description:
      "Where to write a review page that can't be attached to the issue, for the workflow to upload",
  },
  "run-url": { type: "string", description: "The workflow run, to link to" },
} as const;

/**
 * Check version `v` of a changeset issue against `db` and comment with the
 * result: build its diff, put its review page on the issue as the artifact
 * "Changeset v<n>" (a new version of it on a re-check), or, if that fails,
 * write the page to `outDir` for the workflow to upload, and post the check.
 */
async function checkAndComment(
  gh: GitHub,
  db: DB,
  issue: IssueRef,
  v: Version,
  {
    outDir,
    runUrl,
    why,
    previous,
  }: { outDir: string; runUrl?: string; why?: string; previous?: Check },
): Promise<ChangesetDiff> {
  const version: VersionRef = { ...issue, version: v.version, url: v.url };
  const diff = await buildChangesetDiff({
    db,
    sql: v.sql,
    base: "production",
    source: v.url,
    version,
  });
  const html = renderPage(diff, CLIENT_SCRIPT);
  let page: PageLink;
  try {
    page = {
      url: (await gh.putHtmlArtifact(issue, `Changeset v${v.version}`, html))
        .html_url,
    };
  } catch (err) {
    console.log(`couldn't attach the review page to the issue: ${err}`);
    const file = join(callerPath(outDir), pageName(diff));
    writeFileSync(file, html);
    const status = /: (\d{3}) /.exec(String(err))?.[1];
    page = { unattached: status ? `GitHub said ${status}` : "an error" };
  }
  await gh.comment(
    issue,
    checkComment({ ...diff, version }, { page, runUrl, why, previous }),
  );
  console.log(`v${v.version}: ${describeDiff(diff)}`);
  return diff;
}

const ciCheckCmd = defineCommand({
  meta: {
    name: "check",
    description: `For CI: check the latest version of a changeset issue and comment with the result and a review page, unless CI already checked it as it stands. With --force, or when the issue is labelled ${LABELS.recheck} (which it removes), check it again: production may have changed.`,
  },
  args: {
    ...ciArgs,
    force: {
      type: "boolean",
      description: "Check it even if CI already checked it",
    },
  },
  run: async ({ args }) => {
    const issue = issueArg(args.issue);
    const gh = new GitHub();
    const info = await gh.issue(issue);
    const recheck = args.force || info.labels.includes(LABELS.recheck);
    if (info.labels.includes(LABELS.recheck))
      await gh.removeLabel(issue, LABELS.recheck);
    const thread = readThread(await gh.comments(issue), sqlHash);
    const v = thread.versions.at(-1);
    if (!v) return console.log("no version to check");
    const checked = checkOf(thread, v);
    if (checked && !recheck)
      return console.log(`v${v.version} is already checked`);
    await withDb(args.db, (db) =>
      checkAndComment(gh, db as DB, issue, v, {
        outDir: args["out-dir"],
        runUrl: args["run-url"],
        why: checked
          ? "Checked again, against production as it is now."
          : undefined,
        previous: checked,
      }),
    );
  },
});

/** Who may approve a changeset: the repository's admins and maintainers. */
const APPROVERS = new Set(["admin", "maintain"]);

const ciApplyCmd = defineCommand({
  meta: {
    name: "apply",
    description: `For CI: apply the version of a changeset issue that labelling it ${LABELS.approved} approved, if an admin or maintainer did and it still does what CI's check of it said, then comment, label it ${LABELS.applied} and close it. On any refusal or failure it comments why and removes ${LABELS.approved}, saving nothing; if production changed what the version does, it also checks it again.`,
  },
  args: ciArgs,
  run: async ({ args }) => {
    const issue = issueArg(args.issue);
    const gh = new GitHub();
    const info = await gh.issue(issue);
    if (!info.labels.includes(LABELS.proposal)) {
      console.log(`not labelled ${LABELS.proposal}; nothing to do`);
      return;
    }
    const refuse = async (why: string) => {
      console.log(`not applied: ${why}`);
      await gh.comment(issue, `Not applied: ${why}.`);
      await gh.removeLabel(issue, LABELS.approved);
      process.exitCode = 1;
    };
    const approval = (await gh.events(issue))
      .reverse()
      .find((e) => e.event === "labeled" && e.label?.name === LABELS.approved);
    if (!approval?.actor) return refuse("no approval found");
    const approver = approval.actor.login;
    const permission = await gh.permission(issue.repo, approver);
    if (!APPROVERS.has(permission))
      return refuse(
        `${approver} has ${permission} access, and only admins and maintainers can approve a changeset`,
      );
    const thread = readThread(await gh.comments(issue), sqlHash);
    const approved = approvedVersion(thread, approval.created_at);
    if ("refused" in approved) return refuse(approved.refused);
    const { version: v, check } = approved;
    const version: VersionRef = { ...issue, version: v.version, url: v.url };
    await withDb(args.db, async (db) => {
      let result;
      try {
        result = await applyIfUnchanged({
          db: db as DB,
          sql: v.sql,
          effect: check.effect,
        });
      } catch (err) {
        if (!(err instanceof ChangesetError)) throw err;
        await refuse(
          `v${v.version} failed, and nothing was saved: ${err.message}. CI checked it again below`,
        );
        await checkAndComment(gh, db as DB, issue, v, {
          outDir: args["out-dir"],
          runUrl: args["run-url"],
          why: "Checked again, because applying it failed.",
          previous: check,
        });
        return;
      }
      if ("changed" in result) {
        await refuse(
          `production changed since [CI's check](${check.url}), and v${v.version} no longer does what it said, so nothing was saved. CI checked it again below; review what it does now, and approve again`,
        );
        await checkAndComment(gh, db as DB, issue, v, {
          outDir: args["out-dir"],
          runUrl: args["run-url"],
          why: "Checked again, because production changed since the approved check.",
          previous: check,
        });
        return;
      }
      const rows = formatRows(result.applied.rows);
      console.log(`applied v${v.version}: ${rows}`);
      await gh.comment(
        issue,
        appliedComment(version, v.sha256, {
          rows,
          meetings: result.applied.meetings.map(ref),
          approver,
        }),
      );
      await gh.addLabels(issue, [LABELS.applied]);
      await gh.removeLabel(issue, LABELS.approved);
      await gh.close(issue);
    });
  },
});

const ciCmd = defineCommand({
  meta: {
    name: "ci",
    description:
      "What the changeset workflows run; see .github/workflows/changeset-*.yml",
  },
  subCommands: { check: ciCheckCmd, apply: ciApplyCmd },
});

const main = defineCommand({
  meta: {
    name: "changeset",
    description: `Check, apply, view and propose changesets.\n\n${HELP}`,
  },
  subCommands: {
    check: checkCmd,
    apply: applyCmd,
    view: viewCmd,
    propose: proposeCmd,
    revise: reviseCmd,
    review: reviewCmd,
    status: statusCmd,
    ci: ciCmd,
  },
});

await runMain(main);
