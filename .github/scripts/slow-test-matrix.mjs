// Reads `vp test list --json` output on stdin and prints a GitHub Actions
// matrix with one entry per test: its project, file (relative to the repo),
// a short name for the job, and a -t pattern that matches only that test.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import process from "node:process";

const tests = JSON.parse(readFileSync(0, "utf8"));
if (tests.length === 0) throw new Error("No slow tests listed.");

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const include = tests.map((t) => {
  const leaf = t.name.split(" > ").at(-1);
  return {
    name: leaf,
    project: t.projectName,
    file: relative(process.cwd(), t.file),
    pattern: `${escapeRegExp(leaf)}$`,
  };
});

const patterns = new Set(include.map((e) => `${e.file} ${e.pattern}`));
if (patterns.size !== include.length)
  throw new Error("Two slow tests in one file share a name.");

process.stdout.write(`${JSON.stringify({ include })}\n`);
