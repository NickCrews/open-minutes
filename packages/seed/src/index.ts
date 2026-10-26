import { loadDataset } from "@open-minutes/datasets";
import type { DataState } from "@open-minutes/db/ensure";
import { datasetFingerprint } from "./fingerprint";
import { seedDataset } from "./seed";

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
        fingerprint ??= datasetFingerprint(dataset);
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
