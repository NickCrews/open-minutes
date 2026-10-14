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
import { CLEANING_RULES } from "@open-minutes/core/transcription";
import { meetingDirs } from "./check";
import { cleanTranscriptFile, type TranscriptFix } from "./clean";
import { formatClock } from "@open-minutes/core/clock";

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
  const { changed, fixed } = await cleanTranscriptFile(file);
  if (!changed) continue;
  cleaned++;
  console.log(`${relative(CWD, file)}: fixed ${summarize(fixed)}`);
  if (verbose) {
    for (const v of fixed) {
      const at = "atSecs" in v ? formatClock(v.atSecs) : "";
      console.log(`  ${at.padEnd(10)}  ${v.code.padEnd(14)} ${v.message}`);
    }
  }
}
console.log(`Cleaned ${cleaned} of ${files.length} transcript(s).`);

function summarize(fixed: readonly TranscriptFix[]): string {
  if (fixed.length === 0) return "formatting";
  const counts = new Map<string, number>();
  for (const v of fixed) {
    const what = v.code === "unclean-word" ? v.rule : v.code;
    counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  return [...counts].map(([what, n]) => `${n} ${what}`).join(", ");
}
