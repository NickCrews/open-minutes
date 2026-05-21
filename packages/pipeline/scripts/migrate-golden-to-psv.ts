/**
 * One-off migration: port golden transcripts from the old per-segment JSONL
 * format (`{"words": [{text, start, end}, ...]}` per line) to the git-diffable
 * pipe-separated format (golden.psv).
 *
 * The old format carries no speaker information, so each JSONL line becomes one
 * `unlabeled` segment (preserving the original segment boundaries). Word data is
 * preserved exactly. Run `git diff` afterwards to review, then delete the .jsonl.
 *
 * Usage:
 *   tsx scripts/migrate-golden-to-psv.ts            # convert every golden.jsonl
 *   tsx scripts/migrate-golden-to-psv.ts <path>     # convert one golden.jsonl
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptSegment } from "../src/types.ts";
import { serializePsv } from "../src/test-utils/psv";

const FIXTURES_ROOT = resolve(fileURLToPath(import.meta.url), "../../test-fixtures");

function findGoldenJsonl(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findGoldenJsonl(full));
    else if (entry.name === "golden.jsonl") found.push(full);
  }
  return found;
}

function readJsonlSegments(path: string): TranscriptSegment[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      speaker: { type: "unlabeled" as const },
      words: (JSON.parse(line) as { words: TranscriptSegment["words"] }).words,
    }));
}

function migrate(jsonlPath: string): void {
  const segments = readJsonlSegments(jsonlPath);
  const nWords = segments.reduce((n, s) => n + s.words.length, 0);
  const psvPath = join(dirname(jsonlPath), "golden.psv");
  serializePsv(segments, { path: psvPath });
  console.log(`  ${jsonlPath}\n  -> ${psvPath} (${segments.length} segments, ${nWords} words)`);
}

function main(): void {
  const arg = process.argv[2];
  const targets = arg ? [resolve(arg)] : findGoldenJsonl(FIXTURES_ROOT);

  if (targets.length === 0) {
    console.log("No golden.jsonl files found under", FIXTURES_ROOT);
    return;
  }

  for (const target of targets) {
    if (!existsSync(target)) {
      console.error(`Not found: ${target}`);
      process.exitCode = 1;
      continue;
    }
    migrate(target);
  }

  console.log("\nDone. Review with `git diff`, then `git rm` the migrated golden.jsonl file(s).");
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
