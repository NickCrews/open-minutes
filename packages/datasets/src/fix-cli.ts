#!/usr/bin/env -S npx vpx
// Apply the transcript rules' fixes to PSV files that aren't goldens, such as
// a pipeline run's output, rewriting them in place.
//
//   pnpm datasets:fix path/to/file.psv ...
//   … --verbose                          list every violation fixed
//
// Goldens are exported from the database, so fix them there with
// `pnpm transcript fix` (see @open-minutes/edit) and export them again.

import { relative, resolve } from "node:path";
import { formatClock } from "@open-minutes/core/clock";
import { TRANSCRIPT_RULE_SPECS } from "@open-minutes/core/rules";
import { meetingDirsFor } from "./check";
import { type FileFix, fixTranscriptFile } from "./fix";

// pnpm runs this from the package directory; paths are the caller's.
const CWD = process.env.INIT_CWD ?? process.cwd();

const args = process.argv.slice(2);
const paths = args
  .filter((a) => !a.startsWith("-"))
  .map((p) => resolve(CWD, p));
if (args.includes("--help") || args.includes("-h") || !paths.length) {
  const fixes = TRANSCRIPT_RULE_SPECS.filter((spec) => "fix" in spec).map(
    (spec) => `  ${spec.code}`,
  );
  console.log(
    [
      "Usage: pnpm datasets:fix [--verbose] file.psv ...",
      "",
      "For a golden, use `pnpm transcript fix <meeting>` and export it again.",
      "",
      "Fixes:",
      ...fixes,
    ].join("\n"),
  );
  process.exit(paths.length ? 0 : 1);
}
const verbose = args.includes("--verbose") || args.includes("-v");

const goldens = paths.filter((p) => meetingDirsFor(p).length);
if (goldens.length) {
  for (const p of goldens)
    console.error(
      `${relative(CWD, p)}: a golden; fix it in the database with \`pnpm transcript fix\` and export it again`,
    );
  process.exit(1);
}

const rewritten: FileFix[] = [];
for (const file of paths) rewritten.push(...(await fixTranscriptFile(file)));

for (const { file, fixed } of rewritten) {
  console.log(`${relative(CWD, file)}: fixed ${summarize(fixed)}`);
  if (verbose)
    for (const v of fixed) {
      const at = "atSecs" in v ? formatClock(v.atSecs) : "";
      console.log(`  ${at.padEnd(10)}  ${v.code.padEnd(20)} ${v.message}`);
    }
}
console.log(`Rewrote ${rewritten.length} file(s).`);

/** Counts by rule code. */
function summarize(fixed: FileFix["fixed"]): string {
  const counts = new Map<string, number>();
  for (const v of fixed) {
    counts.set(v.code, (counts.get(v.code) ?? 0) + 1);
  }
  return [...counts].map(([code, n]) => `${n} ${code}`).join(", ");
}
