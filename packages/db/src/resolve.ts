// Answers "which database?" for every entrypoint: app code, drizzle-kit, the
// db harness CLI, and tests.
//
// A target is either a name ("local", "prod", ...) that resolves to
// DATABASE_URL_<NAME> in the workspace-root .env.local, or a full postgres://
// URL used verbatim. The `DB` env var selects the target when code doesn't:
//
//   DB=prod pnpm db migrate
//   DB=postgres://... pnpm db status
//
// "local" is per git branch: on branch `feat/x` it is the database
// `open_minutes__feat_x` on docker-compose's postgres, so a branch's migrations
// never leak into another branch's database; main and master share
// `open_minutes__main`. A rebase in progress uses the branch being rebased; any other
// detached HEAD (bisect, an old commit, a tag) gets a database of its own,
// `open_minutes__detached_<commit>`, so old code never resets main's.
// To use one database on every branch, point DB at its URL.
import console from "node:console";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { loadRootDotEnv } from "@open-minutes/core/dotenv";

// The zero-config default for "local", minus the database name. The single
// source of truth for this server; it must match the postgres service in
// docker-compose.yml. Setting DATABASE_URL_LOCAL overrides it (including the
// per-branch naming) like any other named database.
const DEFAULT_LOCAL_SERVER = "postgres://postgres:postgres@localhost:5432";

/** The stem of every local per-branch database, main's included. */
export const LOCAL_DATABASE_PREFIX = "open_minutes__";
/** main's local database, and the fallback when there's no usable branch. */
export const LOCAL_MAIN_DATABASE = `${LOCAL_DATABASE_PREFIX}main`;
const MAIN_BRANCHES = new Set(["main", "master"]);
// Postgres truncates identifiers beyond 63 bytes.
const MAX_DATABASE_NAME = 63;

/** Databases already announced this process, so repeat resolutions stay quiet. */
const logged = new Set<string>();

/**
 * Resolves a database target to a postgres connection URL.
 *
 * Logs which database was chosen (password redacted, once per process) —
 * except for URLs passed as an explicit argument, where the caller already
 * knows exactly what it's connecting to.
 *
 * @param target A name ("local", "prod", ...) resolved via
 *   DATABASE_URL_<NAME>, or a full postgres:// URL. Defaults to $DB, then
 *   $DATABASE_URL, then "local".
 */
export function resolveDatabaseUrl(target?: string): string {
  loadRootDotEnv();
  const explicitUrl = target?.includes("://") ?? false;
  target ??= process.env.DB || process.env.DATABASE_URL || "local";
  const url = resolve(target);
  if (!explicitUrl && !logged.has(url)) {
    logged.add(url);
    const name = target.includes("://") ? "" : ` ${target}`;
    console.error(`Using database${name}: ${redactUrl(url)}`);
  }
  return url;
}

function resolve(target: string): string {
  if (target.includes("://")) return target;
  const key = `DATABASE_URL_${target.toUpperCase().replaceAll("-", "_")}`;
  const url = process.env[key];
  if (url) return url;
  // "local" works with zero configuration: docker-compose's postgres.
  if (target === "local") return defaultLocalUrl();
  const known = new Set(
    Object.keys(process.env)
      .filter((k) => k.startsWith("DATABASE_URL_"))
      .map((k) => k.slice("DATABASE_URL_".length).toLowerCase()),
  );
  known.add("local");
  throw new Error(
    `Unknown database "${target}": set ${key} in .env.local, or use one of: ${[...known].sort().join(", ")}`,
  );
}

/** The URL with its password masked, safe for logging. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return url;
  }
}

/** The zero-config "local" URL: this git branch's database. */
function defaultLocalUrl(): string {
  return `${DEFAULT_LOCAL_SERVER}/${localDatabaseName()}`;
}

/** What HEAD points at: a branch, or (detached, not mid-rebase) a commit. */
export type GitHead = { branch: string } | { commit: string };

/**
 * The local database name for a git branch name or HEAD (default: the current
 * HEAD). Null, meaning not in a git checkout, uses main's database.
 */
export function localDatabaseName(
  head: GitHead | string | null = currentGitHead(),
): string {
  if (head === null) return LOCAL_MAIN_DATABASE;
  if (typeof head !== "string" && "commit" in head) {
    return `${LOCAL_DATABASE_PREFIX}detached_${head.commit.slice(0, 12).toLowerCase()}`;
  }
  const branch = typeof head === "string" ? head : head.branch;
  if (MAIN_BRANCHES.has(branch)) return LOCAL_MAIN_DATABASE;
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return LOCAL_MAIN_DATABASE;
  const name = LOCAL_DATABASE_PREFIX + slug;
  if (name.length <= MAX_DATABASE_NAME) return name;
  // Too long: keep a readable prefix plus a hash of the full branch name, so
  // two long branches sharing a prefix still get distinct databases.
  const suffix = `_${fnv1a(branch)}`;
  return name.slice(0, MAX_DATABASE_NAME - suffix.length) + suffix;
}

/**
 * What this checkout's HEAD points at, or null when not in a git checkout
 * (e.g. in a deployed Worker). A rebase detaches HEAD, so mid-rebase this is
 * the branch being rebased. Reads .git directly rather than spawning git, so
 * it's cheap enough to run on every resolution.
 */
export function currentGitHead(
  start: string = dirname(fileURLToPath(import.meta.url)),
): GitHead | null {
  try {
    const gitDir = findGitDir(start);
    if (!gitDir) return null;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
    if (branch) return { branch };
    const rebasing = rebaseBranch(gitDir);
    if (rebasing) return { branch: rebasing };
    return /^[0-9a-f]{40,64}$/i.test(head) ? { commit: head } : null;
  } catch {
    return null;
  }
}

/** The checked-out (or mid-rebase) branch, or null when detached or not in git. */
export function currentGitBranch(): string | null {
  const head = currentGitHead();
  return head && "branch" in head ? head.branch : null;
}

/** The branch a rebase in progress will update, from git's rebase state. */
function rebaseBranch(gitDir: string): string | null {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      const ref = readFileSync(join(gitDir, dir, "head-name"), "utf8").trim();
      const branch = /^refs\/heads\/(.+)$/.exec(ref)?.[1];
      if (branch) return branch;
    } catch {
      // No rebase of this kind in progress.
    }
  }
  return null;
}

function findGitDir(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, ".git");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
      // Worktrees and submodules: .git is a file pointing at the real dir.
      const pointer = /^gitdir: (.+)$/m.exec(readFileSync(candidate, "utf8"));
      if (pointer?.[1]) return resolvePath(dir, pointer[1].trim());
    } catch {
      // No .git here; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Short, stable, dependency-free string hash (FNV-1a, 32-bit, base 36). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
