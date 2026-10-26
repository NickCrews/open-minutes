// Configures the `pnpm db` CLI (@open-minutes/db): the datasets `pnpm db up
// --data <name>` can name, one per packages/datasets/specs/<name>.json. See
// docs/contributing/db.md.
import { defineConfig } from "@open-minutes/db/config";
import { allDatasets } from "@open-minutes/seed";

export default defineConfig({
  datasets: allDatasets(),
  // What `pnpm db up` (and so `pnpm dev`) seeds into an empty database.
  defaultDataset: "all",
});
