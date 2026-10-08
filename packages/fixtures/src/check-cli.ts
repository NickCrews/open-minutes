#!/usr/bin/env -S npx tsx
// Check the fixture data, printing problems as `file:line: severity: message`.
//
//   pnpm fixtures:check                    every meeting
//   pnpm fixtures:check path/to/file ...   just the meetings those files are in
//   … --hook                               as a Claude Code PostToolUse hook:
//                                          reads the edited file from the hook
//                                          payload on stdin, stays quiet for
//                                          files outside the fixture data, and
//                                          exits 2 so the agent sees problems.
//
// Exits 1 if there are errors (warnings alone exit 0), outside --hook.

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { checkFixtures, formatIssue, meetingDirs } from "./check";
import { TEST_DATA_ROOT } from "./test-data";

// pnpm runs this from the package directory; paths are the caller's.
const CWD = process.env.INIT_CWD ?? process.cwd();
const ROOTS = [resolve(TEST_DATA_ROOT)];

/** The meeting directories a file belongs to; all of them for shared files. */
function dirsFor(file: string): string[] {
  const path = resolve(CWD, file);
  const root = ROOTS.find((r) => path.startsWith(r + sep));
  if (!root) return [];
  const meetings = resolve(root, "meetings") + sep;
  if (!path.startsWith(meetings)) return meetingDirs(); // people.jsonl etc.
  const name = path.slice(meetings.length).split(sep)[0]!;
  return [resolve(meetings, name)];
}

const args = process.argv.slice(2);
const hook = args.includes("--hook");
let files = args.filter((a) => a !== "--hook");
if (hook) {
  const payload = JSON.parse(readFileSync(0, "utf8") || "{}") as {
    tool_input?: { file_path?: string };
  };
  files = payload.tool_input?.file_path ? [payload.tool_input.file_path] : [];
}

const dirs = files.length
  ? [...new Set(files.flatMap(dirsFor))]
  : hook
    ? []
    : meetingDirs();
const issues = await checkFixtures(dirs);
const lines = issues.map((i) => formatIssue(i, CWD));

if (hook) {
  if (lines.length) {
    console.error(
      [
        `Fixture check found ${lines.length} problem(s) in ${dirs.map((d) => d.split(sep).at(-1)).join(", ")}:`,
        ...lines,
        "Fix the errors before moving on. Look at each warning: it is usually a real mistake, but may be right as it is.",
      ].join("\n"),
    );
    process.exit(2);
  }
} else {
  for (const line of lines) console.log(line);
  const errors = issues.filter((i) => i.severity === "error").length;
  console.log(
    `${dirs.length} meeting(s) checked: ${errors} error(s), ${issues.length - errors} warning(s).`,
  );
  process.exit(errors ? 1 : 0);
}
