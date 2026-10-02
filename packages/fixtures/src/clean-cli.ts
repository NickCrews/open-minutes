#!/usr/bin/env -S npx tsx
// Clean disfluencies out of fixture transcripts, rewriting them in place.
//
//   pnpm fixtures:clean                    every meeting's transcript
//   pnpm fixtures:clean path/to/file ...   just those PSV files
//   … --verbose                            list every word changed
//
// `pnpm fixtures:check` reports what this would fix, as errors.

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  CLEANING_RULES,
  type CleanChange,
} from "@open-minutes/core/transcription";
import { meetingDirs } from "./check";
import { cleanTranscriptFile } from "./clean";
import { formatTimestamp } from "./psv";

// pnpm runs this from the package directory; paths are the caller's.
const CWD = process.env.INIT_CWD ?? process.cwd();

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: pnpm fixtures:clean [--verbose] [files...]",
      "",
      "Rules:",
      ...CLEANING_RULES.map((r) => `  ${r.name.padEnd(12)} ${r.description}`),
    ].join("\n"),
  );
  process.exit(0);
}
const verbose = args.includes("--verbose") || args.includes("-v");
const paths = args.filter((a) => !a.startsWith("-"));

const files = paths.length
  ? paths.map((p) => resolve(CWD, p))
  : meetingDirs()
      .flatMap((dir) =>
        ["golden.psv", "transcript.psv"].map((f) => join(dir, f)),
      )
      .filter((p) => existsSync(p));

let cleaned = 0;
for (const file of files) {
  const changes = cleanTranscriptFile(file);
  if (changes.length === 0) continue;
  cleaned++;
  console.log(`${relative(CWD, file)}: removed ${summarize(changes)}`);
  if (verbose) {
    for (const c of changes) {
      const edit =
        c.after === null ? "removed" : `→ ${JSON.stringify(c.after)}`;
      console.log(
        `  ${formatTimestamp(c.start)}  ${c.rule.padEnd(12)} ${JSON.stringify(c.before)} ${edit}`,
      );
    }
  }
}
console.log(`Cleaned ${cleaned} of ${files.length} transcript(s).`);

function summarize(changes: readonly CleanChange[]): string {
  const counts = new Map<string, number>();
  for (const c of changes) {
    if (c.after === null) counts.set(c.rule, (counts.get(c.rule) ?? 0) + 1);
  }
  return [...counts].map(([rule, n]) => `${n} ${rule}`).join(", ");
}
