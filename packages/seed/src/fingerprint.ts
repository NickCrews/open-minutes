import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDING_MODEL_SPEC } from "@open-minutes/audio/embed-model";
import { DATUMS_ROOT, transcriptPath } from "@open-minutes/datasets/datums";
import { SEED_VERSION } from "./seed";
import type { Dataset } from "@open-minutes/datasets";

/**
 * A hash of everything seeding `dataset` reads: the seeder's version, the
 * dataset
 * (less its description), and the datums files it seeds from. For real
 * voiceprints, also the embedding model that computes them.
 */
export function datasetFingerprint(dataset: Dataset): string {
  const seeded = [dataset.meetings, dataset.people, dataset.voiceprints];
  const hash = createHash("sha256")
    .update(`v${SEED_VERSION}\n${JSON.stringify(seeded)}\n`)
    .update(readFileSync(join(DATUMS_ROOT, "jurisdictions.jsonl")))
    .update(readFileSync(join(DATUMS_ROOT, "bodies.jsonl")));
  if (dataset.meetings.length)
    hash.update(readFileSync(join(DATUMS_ROOT, "people.jsonl")));
  for (const slug of dataset.meetings) {
    const dir = join(DATUMS_ROOT, "meetings", slug);
    const chapters = join(dir, "chapters.json");
    hash
      .update(`${slug}\0`)
      .update(readFileSync(join(dir, "meeting.json")))
      .update(readFileSync(transcriptPath(dir)!))
      .update(existsSync(chapters) ? readFileSync(chapters) : "");
  }
  if (dataset.voiceprints === "audio") hash.update(EMBEDDING_MODEL_SPEC.url);
  return hash.digest("hex").slice(0, 12);
}
