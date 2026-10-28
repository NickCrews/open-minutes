// Configures the `pnpm db` CLI (@open-minutes/db): the datasets `pnpm db up
// --data <name>` can name, one per packages/datasets/datasets/<name>.json. See
// docs/contributing/db.md.
import { defineConfig } from "@open-minutes/db/config";
import { datasetStates } from "@open-minutes/seed";

export default defineConfig({
  datasets: datasetStates(),
  // What `pnpm db up` (and so `pnpm dev`) seeds into an empty database.
  defaultDataset: "all",
});
