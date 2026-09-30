import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  LOCAL_MAIN_DATABASE,
  currentGitBranch,
  currentGitHead,
  localDatabaseName,
} from "./resolve";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("localDatabaseName", () => {
  test("main, master, and no git checkout share the main database", () => {
    expect(LOCAL_MAIN_DATABASE).toBe("open_minutes__main");
    expect(localDatabaseName("main")).toBe(LOCAL_MAIN_DATABASE);
    expect(localDatabaseName("master")).toBe(LOCAL_MAIN_DATABASE);
    expect(localDatabaseName(null)).toBe(LOCAL_MAIN_DATABASE);
  });

  test("feature branches get their own, identifier-safe database", () => {
    expect(localDatabaseName("feat/Speaker-IDs")).toBe(
      "open_minutes__feat_speaker_ids",
    );
    expect(localDatabaseName({ branch: "claude/zen-wright-ywykx8" })).toBe(
      "open_minutes__claude_zen_wright_ywykx8",
    );
  });

  test("a detached HEAD gets a database for its commit, not main's", () => {
    expect(localDatabaseName({ commit: COMMIT })).toBe(
      "open_minutes__detached_0123456789ab",
    );
  });

  test("long branch names are truncated but stay distinct", () => {
    const a = localDatabaseName(`feat/${"x".repeat(80)}-a`);
    const b = localDatabaseName(`feat/${"x".repeat(80)}-b`);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(a).toMatch(/^[a-z0-9_]+$/);
    expect(a).not.toBe(b);
  });
});

describe("currentGitHead", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  /** A checkout whose .git holds `files` (paths relative to .git). */
  function checkout(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "om-git-"));
    dirs.push(root);
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, ".git", path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, `${content}\n`);
    }
    return root;
  }

  test("reads the checked-out branch", () => {
    const root = checkout({ HEAD: "ref: refs/heads/feat/x" });
    expect(currentGitHead(root)).toEqual({ branch: "feat/x" });
  });

  test("mid-rebase, reads the branch being rebased", () => {
    const root = checkout({
      HEAD: COMMIT,
      "rebase-merge/head-name": "refs/heads/feat/x",
    });
    expect(currentGitHead(root)).toEqual({ branch: "feat/x" });
  });

  test("otherwise a detached HEAD is its commit", () => {
    const root = checkout({ HEAD: COMMIT });
    expect(currentGitHead(root)).toEqual({ commit: COMMIT });
  });

  test("this checkout has a HEAD", () => {
    const branch = currentGitBranch();
    expect(branch === null || typeof branch === "string").toBe(true);
    expect(currentGitHead()).not.toBeNull();
  });
});
