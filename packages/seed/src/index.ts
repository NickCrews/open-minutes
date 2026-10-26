import type { DataState } from "@open-minutes/db/ensure";
import { datasetFingerprint } from "./fingerprint";
import { seedDataset } from "./seed";
import { datasetNames, loadSpec } from "@open-minutes/datasets/spec";

// Datasets by name, as the database harness takes them:
//
//   const test = dbTest({ data: dataset("bodies") });
//
// Each is declared by a spec in @open-minutes/datasets (specs/<name>.json). Seed one through the
// harness (dbTest, or `pnpm db up --data <name>`), not by calling `apply`
// directly, or the recorded fingerprint no longer describes the database.

export { placeholderVoiceprint } from "./voiceprints";

const cache = new Map<string, DataState>();

/** The dataset specs/<name>.json declares. Throws on an unknown name. */
export function dataset(name: string): DataState {
  let data = cache.get(name);
  if (!data) {
    const spec = loadSpec(name);
    let fingerprint: string | undefined;
    data = {
      name,
      get fingerprint() {
        fingerprint ??= datasetFingerprint(spec);
        return fingerprint;
      },
      apply: async (db) => {
        await seedDataset(db, spec);
      },
    };
    cache.set(name, data);
  }
  return data;
}

/** Every dataset in specs/, by name. */
export function allDatasets(): Record<string, DataState> {
  return Object.fromEntries(datasetNames().map((n) => [n, dataset(n)]));
}
