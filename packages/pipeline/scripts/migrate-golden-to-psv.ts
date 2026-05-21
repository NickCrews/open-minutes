/**
 * One-off migration: port golden transcripts from the old per-segment JSONL
 * format (`{"words": [{text, start, end}, ...]}` per line) to the git-diffable
 * pipe-separated format (golden.psv).
 *
 * The old format carries no speaker information, so the migrated PSV contains
 * only `text` events (no `begin_speaker` meta markers). Word data is preserved
 * exactly. Run `git diff` afterwards to review, then delete the stale .jsonl.
 *
 * Usage:
 *   tsx scripts/migrate-golden-to-psv.ts            # convert every golden.jsonl
 *   tsx scripts/migrate-golden-to-psv.ts <path>     # convert one golden.jsonl
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptWord } from "../src/types.ts";
import { serializePsv, wordsToPsvEvents } from "../src/test-utils/psv";

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

function readJsonlWords(path: string): TranscriptWord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => (JSON.parse(line) as { words: TranscriptWord[] }).words);
}

function migrate(jsonlPath: string): void {
  const words = readJsonlWords(jsonlPath);
  const psvPath = join(dirname(jsonlPath), "golden.psv");
  writeFileSync(psvPath, serializePsv(wordsToPsvEvents(words)));
  console.log(`  ${jsonlPath}\n  -> ${psvPath} (${words.length} words)`);
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
