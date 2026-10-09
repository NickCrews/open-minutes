#!/usr/bin/env tsx
// The `om` CLI: model downloads. Machine-readable results go to stdout.
import { defineCommand, runMain } from "citty";

const models = defineCommand({
  meta: {
    name: "models",
    description:
      "Download every ML model the pipeline uses (~650MB), skipping any " +
      "already present. Otherwise each is downloaded on first use.",
  },
  args: {
    list: {
      type: "boolean",
      description:
        "Print each model's spec as one JSON object per line, without " +
        "downloading (CI hashes this into its model cache key)",
      default: false,
    },
  },
  async run({ args }) {
    const { ALL_MODEL_SPECS, ensureAllModels } =
      await import("@open-minutes/audio/models");
    if (args.list) {
      for (const spec of ALL_MODEL_SPECS) {
        console.log(JSON.stringify(spec));
      }
      return;
    }
    ensureAllModels();
  },
});

const main = defineCommand({
  meta: { name: "om", description: "Open Minutes pipeline commands" },
  subCommands: { models },
});

await runMain(main);
