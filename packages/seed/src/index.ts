import { createHash } from "node:crypto";
import { EMBEDDING_MODEL_SPEC } from "@open-minutes/audio/embed-model";
import {
  type Dataset,
  datasetHash,
  datasetNames,
  loadDataset,
} from "@open-minutes/datasets";
import type { DataState } from "@open-minutes/db/ensure";
import { SEED_VERSION, seedDataset } from "./seed";

// A dataset as the database harness takes it, seeding the rows it names:
//
//   const test = dbTest({ data: datasetState("bodies") });
//
// Seed one through the harness (dbTest, or `pnpm db up --data <name>`), not by
// calling `apply` directly, or the recorded fingerprint no longer describes the
// database.

export { placeholderVoiceprint } from "./voiceprints";

const cache = new Map<string, DataState>();

/**
 * The DataState for the dataset @open-minutes/datasets names `name`. Throws on
 * an unknown name.
 */
export function datasetState(name: string): DataState {
  let data = cache.get(name);
  if (!data) {
    const dataset = loadDataset(name);
    let fingerprint: string | undefined;
    data = {
      name,
      get fingerprint() {
        fingerprint ??= seedFingerprint(dataset);
        return fingerprint;
      },
      apply: async (db) => {
        await seedDataset(db, dataset);
      },
    };
    cache.set(name, data);
  }
  return data;
}

/** The DataState for every dataset, by name. */
export function datasetStates(): Record<string, DataState> {
  return Object.fromEntries(datasetNames().map((n) => [n, datasetState(n)]));
}

/**
 * A hash of everything seeding `dataset` reads: the dataset's contents, the
 * seeder's version and, for real voiceprints, the embedding model that
 * computes them.
 */
function seedFingerprint(dataset: Dataset): string {
  const hash = createHash("sha256").update(
    `v${SEED_VERSION}\n${datasetHash(dataset)}\n`,
  );
  if (dataset.voiceprints === "audio") hash.update(EMBEDDING_MODEL_SPEC.url);
  return hash.digest("hex").slice(0, 12);
}
