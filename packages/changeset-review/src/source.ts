// Where a changeset comes from: a SQL file, stdin, or a version of it in a
// GitHub issue.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sqlHash } from "./build";
import { currentRepo, GitHub, parseIssueRef } from "./github";
import { extractSql, pickVersion, readThread } from "./issue";
import type { VersionRef } from "./types";

export interface Source {
  sql: string;
  /** Where it came from: the path given, "stdin", or the version's comment. */
  label: string;
  /** The issue version it is, if it came from one. */
  version: VersionRef | null;
}

/**
 * Read a changeset from `ref`: "-" for stdin, a path, or an issue ("123",
 * "#123", "owner/name#123" or its URL), whose latest version it takes, or
 * `version`. A file of Markdown gives its first ```sql block.
 */
export async function loadSource(
  ref: string,
  { cwd, version }: { cwd: string; version?: number },
): Promise<Source> {
  if (ref === "-") return fromText(readFileSync(0, "utf8"), "stdin");
  const path = resolve(cwd, ref);
  if (existsSync(path)) return fromText(readFileSync(path, "utf8"), ref);
  const issue = parseIssueRef(ref, currentRepo(cwd));
  if (!issue) throw new Error(`${ref}: no such file, and not an issue`);
  const thread = readThread(await new GitHub().comments(issue), sqlHash);
  const v = pickVersion(thread, version);
  if (!v)
    throw new Error(
      version === undefined
        ? `${issue.repo}#${issue.issue} has no changeset version`
        : `${issue.repo}#${issue.issue} has no v${version}`,
    );
  return {
    sql: v.sql,
    label: v.url,
    version: { ...issue, version: v.version, url: v.url },
  };
}

function fromText(text: string, label: string): Source {
  const sql = extractSql(text);
  if (sql === null && text.includes("```"))
    throw new Error(`${label} has Markdown but no \`\`\`sql block`);
  return { sql: sql ?? text, label, version: null };
}
