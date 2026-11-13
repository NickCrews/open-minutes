// A changeset's GitHub issue, read and written as data. The issue proposes a
// changeset; its comments carry each version of it, the checks CI ran on
// them, reviews, and the result of applying the approved one. Each kind of
// comment starts with a marker, an HTML comment GitHub doesn't show:
//
//   <!-- changeset:version 2 -->                   a version, in a ```sql block
//   <!-- changeset:check v2 sha256=<hex> effect=<hex> ok -->
//                                                  CI checked it (ok or fails)
//   <!-- changeset:review v2 sha256=<hex> -->      a review, with JSON
//   <!-- changeset:applied v2 sha256=<hex> -->     CI applied it
//
// Pure: github.ts reads and writes the issue. See this package's README.

import type { Review, Verdict } from "./types";

/** The labels of the flow. */
export const LABELS = {
  /** Every changeset issue. */
  proposal: "changeset",
  /** A maintainer approved the latest version; CI applies it. */
  approved: "changeset:approved",
  /** Anyone asked CI to check the latest version again. */
  recheck: "changeset:recheck",
  /** CI applied it. */
  applied: "changeset:applied",
} as const;

/** The login CI comments as. */
export const CI_LOGIN = "github-actions[bot]";

/** A comment's author has write access to the repository. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** An issue comment, as GitHub's REST API gives it. */
export interface IssueComment {
  id: number;
  html_url: string;
  body?: string | null;
  user: { login: string } | null;
  author_association: string;
  created_at: string;
  updated_at: string;
}

export interface Version {
  version: number;
  sql: string;
  sha256: string;
  /** What the comment says around the SQL, such as what changed since the last version. */
  note: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface Check {
  version: number;
  sha256: string;
  /** What the version did when CI checked it (build.ts's effectHash). */
  effect: string | null;
  /** The first 12 hex digits of what each statement did (build.ts's statementEffects). */
  statements: string[] | null;
  ok: boolean;
  url: string;
  createdAt: string;
}

export interface PostedReview {
  review: Review;
  /** The effect of the check the reviewer's page showed, if the comment says. */
  effect: string | null;
  author: string;
  /** Whether the reviewer has write access to the repository. */
  trusted: boolean;
  url: string;
  createdAt: string;
}

export interface Applied {
  version: number;
  sha256: string;
  url: string;
  createdAt: string;
}

/** A changeset issue's comments, as the flow reads them. */
export interface Thread {
  /** By number. Only those by people with write access count. */
  versions: Version[];
  checks: Check[];
  reviews: PostedReview[];
  applied: Applied[];
  /** Comments that look like part of the flow but can't be read, and why. */
  problems: string[];
}

/** The line of a check comment giving each statement's effect. */
export const EFFECTS =
  /^<!-- changeset:effects ((?:[0-9a-f]{12}\s*)*?)\s*-->$/m;

const MARKER =
  /^\s*<!--\s*changeset:(version|check|review|applied)\s+([^>]*?)\s*-->/;

/**
 * Read a changeset issue's comments. `hash` is the SHA-256 the flow cites a
 * version's SQL by (build.ts's sqlHash).
 */
export function readThread(
  comments: readonly IssueComment[],
  hash: (sql: string) => string,
): Thread {
  const thread: Thread = {
    versions: [],
    checks: [],
    reviews: [],
    applied: [],
    problems: [],
  };
  for (const c of comments) {
    const body = (c.body ?? "").replaceAll("\r\n", "\n");
    const m = MARKER.exec(body);
    if (!m) continue;
    const [, kind, args] = m as unknown as [string, string, string];
    const author = c.user?.login ?? "ghost";
    const fromCi = author === CI_LOGIN;
    const problem = (why: string) =>
      thread.problems.push(`${c.html_url}: ${why}`);
    if (kind === "version") {
      if (!TRUSTED.has(c.author_association)) {
        problem(`${author} has no write access, so it isn't a version`);
        continue;
      }
      const version = Number(/^(\d+)$/.exec(args)?.[1]);
      const sql = extractSql(body);
      if (!version || sql === null) {
        problem("a version needs a number and a ```sql block");
        continue;
      }
      if (thread.versions.some((v) => v.version === version)) {
        problem(`a second v${version}; the first one counts`);
        continue;
      }
      thread.versions.push({
        version,
        sql,
        sha256: hash(sql),
        note: versionNote(body),
        author,
        url: c.html_url,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      });
      continue;
    }
    const ref =
      /^v(\d+)\s+sha256=([0-9a-f]{64})(?:\s+effect=([0-9a-f]{64}))?(?:\s+(ok|fails))?$/.exec(
        args,
      );
    if (!ref) {
      problem(`can't read the ${kind} marker`);
      continue;
    }
    const version = Number(ref[1]);
    const sha256 = ref[2]!;
    if (kind === "check" || kind === "applied") {
      if (!fromCi) continue;
      if (kind === "check")
        thread.checks.push({
          version,
          sha256,
          effect: ref[3] ?? null,
          statements:
            EFFECTS.exec(body)?.[1]?.split(/\s+/).filter(Boolean) ?? null,
          ok: ref[4] === "ok",
          url: c.html_url,
          createdAt: c.created_at,
        });
      else
        thread.applied.push({
          version,
          sha256,
          url: c.html_url,
          createdAt: c.created_at,
        });
      continue;
    }
    const review = parseReviewJson(body);
    if (!review) {
      problem("a review needs its ```json block");
      continue;
    }
    thread.reviews.push({
      review: { ...review, version, sha256 },
      effect: ref[3] ?? null,
      author,
      trusted: TRUSTED.has(c.author_association),
      url: c.html_url,
      createdAt: c.created_at,
    });
  }
  thread.versions.sort((a, b) => a.version - b.version);
  return thread;
}

/** The latest version, or the one numbered `version`. */
export function pickVersion(
  thread: Thread,
  version?: number,
): Version | undefined {
  return version === undefined
    ? thread.versions.at(-1)
    : thread.versions.find((v) => v.version === version);
}

/** The latest check of exactly this version, by number and SQL. */
export function checkOf(thread: Thread, v: Version): Check | undefined {
  return [...thread.checks]
    .reverse()
    .find((c) => c.version === v.version && c.sha256 === v.sha256);
}

/**
 * The version an approval at `approvedAt` covers, and the check of it the
 * approver saw: the latest version, as it stood then, and CI's latest check
 * of it before then, which found it would apply. Returns why not otherwise.
 */
export function approvedVersion(
  thread: Thread,
  approvedAt: string,
):
  | { version: Version; check: Check & { effect: string } }
  | { refused: string } {
  const latest = thread.versions.at(-1);
  if (!latest) return { refused: "the issue has no changeset version" };
  if (latest.createdAt > approvedAt)
    return {
      refused: `v${latest.version} was posted after the approval; review it and approve again`,
    };
  if (latest.updatedAt > approvedAt)
    return {
      refused: `v${latest.version} was edited after the approval; review it and approve again`,
    };
  const check = [...thread.checks]
    .reverse()
    .find(
      (c) =>
        c.version === latest.version &&
        c.sha256 === latest.sha256 &&
        c.createdAt <= approvedAt,
    );
  if (!check?.effect)
    return {
      refused: `CI hadn't checked v${latest.version} as it stands when it was approved; wait for the check, then approve again`,
    };
  if (!check.ok)
    return {
      refused: `CI's check of v${latest.version} found it fails; post a version that applies`,
    };
  if (thread.applied.some((a) => a.sha256 === latest.sha256))
    return { refused: `v${latest.version} was already applied` };
  return { version: latest, check: { ...check, effect: check.effect } };
}

/**
 * The SQL in Markdown's first ```sql block, or null if it has none. The
 * block may be fenced with more backticks, or tildes, and ends at a fence of
 * the same kind at least as long.
 */
export function extractSql(markdown: string): string | null {
  const text = markdown.replaceAll("\r\n", "\n");
  const open = /^[ \t]*(`{3,}|~{3,})[ \t]*sql\b[^\n]*\n/m.exec(text);
  if (!open) return null;
  const fence = open[1]!;
  const rest = text.slice(open.index + open[0].length);
  const close = new RegExp(
    `^[ \\t]*${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`,
    "m",
  ).exec(rest);
  return close ? rest.slice(0, close.index) : rest;
}

/** A fence for `text`: three backticks, or more than any run of them in it. */
function fenceFor(text: string): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
  );
  return "`".repeat(longest + 1);
}

/** GitHub refuses a comment longer than this. */
export const MAX_COMMENT = 65536;

/** A version comment: the marker, a heading, an optional note and the SQL. */
export function versionComment(
  version: number,
  sql: string,
  note = "",
): string {
  const body = sql.endsWith("\n") ? sql : `${sql}\n`;
  const fence = fenceFor(body);
  const text = [
    `<!-- changeset:version ${version} -->`,
    `## Changeset v${version}`,
    ...(note.trim() ? ["", note.trim()] : []),
    "",
    `${fence}sql`,
    body + fence,
    "",
  ].join("\n");
  if (text.length > MAX_COMMENT)
    throw new Error(
      `v${version} is ${text.length} characters as a comment, and GitHub takes at most ${MAX_COMMENT}; split the changeset`,
    );
  return text;
}

/** What a version comment says besides its marker, heading and SQL. */
function versionNote(body: string): string {
  return body
    .replace(MARKER, "")
    .replace(
      /^[ \t]*(`{3,}|~{3,})[ \t]*sql\b[\s\S]*?^[ \t]*\1[`~]*[ \t]*$/m,
      "",
    )
    .replace(/^#+ Changeset v\d+[ \t]*$/m, "")
    .trim();
}

const VERDICTS: readonly Verdict[] = ["accept", "reject", "question"];

/** The review in a review comment's first ```json block, or null. */
export function parseReviewJson(
  body: string,
): Omit<Review, "version" | "sha256"> | null {
  const block = /^[ \t]*```json[^\n]*\n([\s\S]*?)^[ \t]*```/m.exec(body);
  if (!block) return null;
  let data: unknown;
  try {
    data = JSON.parse(block[1]!);
  } catch {
    return null;
  }
  return normalizeReview(data);
}

/**
 * A review from JSON, as a reviewer writes it for `pnpm changeset review`:
 * `{ "overall": "...", "statements": [{ "statement": 3, "verdict":
 * "reject", "note": "..." }] }`. Null if it isn't one.
 */
export function normalizeReview(
  data: unknown,
): Omit<Review, "version" | "sha256"> | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.statements)) return null;
  const statements: Review["statements"] = [];
  for (const raw of d.statements as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.statement !== "number" || s.statement < 1) return null;
    const verdict =
      typeof s.verdict === "string" &&
      (VERDICTS as readonly string[]).includes(s.verdict)
        ? (s.verdict as Verdict)
        : null;
    if (s.verdict != null && verdict === null) return null;
    statements.push({
      statement: s.statement,
      line: typeof s.line === "number" ? s.line : 0,
      kind: typeof s.kind === "string" ? s.kind : "",
      verdict,
      note: typeof s.note === "string" ? s.note : "",
    });
  }
  return {
    overall: typeof d.overall === "string" ? d.overall : "",
    statements,
  };
}

/** The labels a changeset issue's state is read from. */
export interface IssueInfo {
  number: number;
  title: string;
  state: string;
  html_url: string;
  labels: string[];
}

/** A changeset issue's state, for `pnpm changeset status`. */
export function summarize(issue: IssueInfo, thread: Thread) {
  return {
    issue: issue.number,
    title: issue.title,
    url: issue.html_url,
    open: issue.state === "open",
    approved: issue.labels.includes(LABELS.approved),
    applied: thread.applied.at(-1) ?? null,
    versions: thread.versions.map((v) => ({
      version: v.version,
      sha256: v.sha256,
      author: v.author,
      url: v.url,
      createdAt: v.createdAt,
      note: v.note,
      check: checkOf(thread, v) ?? null,
      reviews: thread.reviews
        .filter((r) => r.review.sha256 === v.sha256)
        .map((r) => ({
          author: r.author,
          trusted: r.trusted,
          url: r.url,
          // CI's latest check found the version does something other than
          // what the reviewer saw.
          stale:
            r.effect !== null &&
            checkOf(thread, v)?.effect != null &&
            checkOf(thread, v)!.effect !== r.effect,
          overall: r.review.overall,
          statements: r.review.statements,
        })),
    })),
    problems: thread.problems,
  };
}
