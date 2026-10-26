import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDING_MODEL_SPEC } from "@open-minutes/audio/embed-model";
import {
  TEST_DATA_ROOT,
  transcriptPath,
} from "@open-minutes/datasets/test-data";
import { SEED_VERSION } from "./seed";
import type { DatasetSpec } from "@open-minutes/datasets/spec";

/**
 * A hash of everything seeding `spec` reads: the seeder's version, the spec
 * (less its description), and the test-data files it seeds from. For real
 * voiceprints, also the embedding model that computes them.
 */
export function datasetFingerprint(spec: DatasetSpec): string {
  const seeded = [spec.meetings, spec.people, spec.voiceprints];
  const hash = createHash("sha256")
    .update(`v${SEED_VERSION}\n${JSON.stringify(seeded)}\n`)
    .update(readFileSync(join(TEST_DATA_ROOT, "jurisdictions.jsonl")))
    .update(readFileSync(join(TEST_DATA_ROOT, "bodies.jsonl")));
  if (spec.meetings.length)
    hash.update(readFileSync(join(TEST_DATA_ROOT, "people.jsonl")));
  for (const slug of spec.meetings) {
    const dir = join(TEST_DATA_ROOT, "meetings", slug);
    const chapters = join(dir, "chapters.json");
    hash
      .update(`${slug}\0`)
      .update(readFileSync(join(dir, "meeting.json")))
      .update(readFileSync(transcriptPath(dir)!))
      .update(existsSync(chapters) ? readFileSync(chapters) : "");
  }
  if (spec.voiceprints === "audio") hash.update(EMBEDDING_MODEL_SPEC.url);
  return hash.digest("hex").slice(0, 12);
}
