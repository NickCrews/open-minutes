// Configures the `pnpm db` CLI (@open-minutes/db): the datasets `pnpm db up
// --data <name>` can name. See adrs/0003-declarative-database-harness.md.
import { defineConfig } from "@open-minutes/db/config";
import { devData } from "@open-minutes/fixtures/dev-data";
import { goldenData } from "@open-minutes/fixtures/golden-data";

export default defineConfig({
  datasets: {
    // The playground: golden, plus its meetings, plus fixtures/dev-data/ extras.
    dev: devData,
    // Just the verified golden rows, as evals and benchmarks see them.
    golden: goldenData,
  },
  // What `pnpm db up` (and so `pnpm dev`) seeds into an empty database.
  defaultDataset: "dev",
});
