// Where a changeset comes from: a SQL file, stdin, or a URL, such as a
// GitHub issue whose body has the changeset in a ```sql block.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

export interface Source {
  sql: string;
  /** The meeting the source names with `--meeting <slug-or-id>`, if any. */
  meeting: string | null;
  /** Where it came from: the path or URL given, or "stdin". */
  label: string;
}

/**
 * The SQL in Markdown's first ```sql block, or null if it has none. Text
 * with no such block is taken to be SQL already.
 */
export function extractSql(markdown: string): string | null {
  const block = /^[ \t]*```sql[^\n]*\n([\s\S]*?)^[ \t]*```/m.exec(
    markdown.replaceAll("\r\n", "\n"),
  );
  return block ? block[1]! : null;
}

/** The meeting named by the first `--meeting <ref>` in the text, if any. */
export function inferMeeting(text: string): string | null {
  return /--meeting[ =]+([\w-]+)/.exec(text)?.[1] ?? null;
}

/**
 * The GitHub API URL for an issue's, pull request's or issue comment's
 * Markdown, given its page's URL; null for any other URL.
 */
export function githubApiUrl(url: string): string | null {
  const m =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\/?(?:#issuecomment-(\d+))?$/.exec(
      url.trim(),
    );
  if (!m) return null;
  const [, owner, repo, number, comment] = m;
  return comment
    ? `https://api.github.com/repos/${owner}/${repo}/issues/comments/${comment}`
    : `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
}

/**
 * Read a changeset from `ref`: "-" for stdin, an http(s) URL, or a path. A
 * GitHub issue, pull request or comment URL is read through GitHub's API,
 * with $GITHUB_TOKEN or $GH_TOKEN if set. Markdown gives its first ```sql
 * block.
 */
export async function loadSource(
  ref: string,
  { cwd = process.cwd() }: { cwd?: string } = {},
): Promise<Source> {
  let text: string;
  let label = ref;
  if (ref === "-") {
    text = readFileSync(0, "utf8");
    label = "stdin";
  } else if (/^https?:\/\//.test(ref)) {
    const api = githubApiUrl(ref);
    if (api) {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const res = await fetch(api, {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) throw new Error(`${ref}: GitHub said ${res.status}`);
      text = ((await res.json()) as { body: string | null }).body ?? "";
    } else {
      const res = await fetch(ref);
      if (!res.ok) throw new Error(`${ref}: ${res.status}`);
      text = await res.text();
    }
  } else {
    text = readFileSync(resolve(cwd, ref), "utf8");
  }
  const sql = extractSql(text);
  if (sql === null && text.includes("```"))
    throw new Error(`${label} has Markdown but no \`\`\`sql block`);
  return { sql: sql ?? text, meeting: inferMeeting(text), label };
}
