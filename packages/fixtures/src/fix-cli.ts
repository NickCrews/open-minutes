#!/usr/bin/env -S npx tsx
// Apply the meeting rules' fixes to the fixture data, rewriting files in place.
//
//   pnpm fixtures:fix                    every meeting
//   pnpm fixtures:fix path/to/file ...   just the meetings those files are in;
//                                        a PSV file outside the fixture data
//                                        gets the transcript rules' fixes
//   … --verbose                          list every violation fixed
//
// `pnpm fixtures:check` reports what this can't fix.

import { relative, resolve } from "node:path";
import { formatClock } from "@open-minutes/core/clock";
import { RULE_SPECS_BY_CODE } from "@open-minutes/core/rules";
import { CLEANING_RULES } from "@open-minutes/core/transcription";
import { meetingDirs, meetingDirsFor } from "./check";
import { type FileFix, fixMeetingDir, fixTranscriptFile } from "./fix";

// pnpm runs this from the package directory; paths are the caller's.
const CWD = process.env.INIT_CWD ?? process.cwd();

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  const fixes = Object.values(RULE_SPECS_BY_CODE)
    .filter((spec) => "fix" in spec)
    .flatMap((spec) => [
      `  ${spec.code}`,
      ...(spec.code === "unclean-word"
        ? CLEANING_RULES.map((r) => `    ${r.name.padEnd(12)} ${r.description}`)
        : []),
    ]);
  console.log(
    [
      "Usage: pnpm fixtures:fix [--verbose] [files...]",
      "",
      "Fixes:",
      ...fixes,
    ].join("\n"),
  );
  process.exit(0);
}
const verbose = args.includes("--verbose") || args.includes("-v");
const paths = args
  .filter((a) => !a.startsWith("-"))
  .map((p) => resolve(CWD, p));

const dirs = paths.length
  ? [...new Set(paths.flatMap((p) => meetingDirsFor(p)))]
  : meetingDirs();
const loneTranscripts = paths.filter(
  (p) => p.endsWith(".psv") && meetingDirsFor(p).length === 0,
);

let failed = false;
const rewritten: FileFix[] = [];
for (const dir of dirs) {
  try {
    rewritten.push(...(await fixMeetingDir(dir)));
  } catch (err) {
    failed = true;
    console.error(`${relative(CWD, dir)}: ${(err as Error).message}`);
  }
}
for (const file of loneTranscripts)
  rewritten.push(...(await fixTranscriptFile(file)));

for (const { file, fixed } of rewritten) {
  console.log(`${relative(CWD, file)}: fixed ${summarize(fixed)}`);
  if (verbose)
    for (const v of fixed) {
      const at = "atSecs" in v ? formatClock(v.atSecs) : "";
      console.log(`  ${at.padEnd(10)}  ${v.code.padEnd(20)} ${v.message}`);
    }
}
console.log(`Rewrote ${rewritten.length} file(s).`);
process.exit(failed ? 1 : 0);

/** Counts by rule code, and for unclean words by cleaning rule. */
function summarize(fixed: FileFix["fixed"]): string {
  // A rewrite with no violations fixed, eg an en dash in a word.
  if (fixed.length === 0) return "formatting";
  const counts = new Map<string, number>();
  for (const v of fixed) {
    const what = v.code === "unclean-word" ? v.rule : v.code;
    counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  return [...counts].map(([what, n]) => `${n} ${what}`).join(", ");
}
