// Configures the `pnpm db` CLI (@open-minutes/db): the datasets `pnpm db up
// --data <name>` can name, one per packages/datasets/datasets/<name>.json. See
// docs/contributing/db.md.
import { datasetNames } from "@open-minutes/datasets";
import { defineConfig } from "@open-minutes/db/config";
import { datasetState } from "@open-minutes/seed";

export default defineConfig({
  datasets: Object.fromEntries(datasetNames().map((n) => [n, datasetState(n)])),
  // What `pnpm db up` (and so `pnpm dev`) seeds into an empty database.
  defaultDataset: "all",
});
