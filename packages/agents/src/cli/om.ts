#!/usr/bin/env tsx
// The `om` CLI: the agent tools (pipeline steps, data and audio) and model
// downloads. A thin wrapper over ../tools and @open-minutes/audio: commands
// only parse arguments and wire stdio. Machine-readable results go to stdout,
// human progress and logs to stderr.
import { defineCommand, runMain } from "citty";
import { loadRootDotEnv } from "@open-minutes/core/dotenv";

// Settings like OBJECT_STORE_PUBLIC_URL (which the audio tools use to
// download a meeting's audio) come from the repo's .env.
loadRootDotEnv();

// A downstream pipe closing early (eg `om tools | head -3`) raises EPIPE
// on stdout; that's normal pipeline behavior, not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
import { runTools } from "./tools";

// The model downloads are heavy, so they're imported only by `om models`.
const audioModels = () => import("@open-minutes/audio/models");

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
    const { ALL_MODEL_SPECS, ensureAllModels } = await audioModels();
    if (args.list) {
      for (const spec of ALL_MODEL_SPECS) {
        console.log(JSON.stringify(spec));
      }
      return;
    }
    ensureAllModels();
  },
});

const toolsCommand = defineCommand({
  meta: {
    name: "tools",
    description:
      "The agent tools (pipeline steps, data and audio) as a JSON CLI: no arguments lists them, " +
      "`<tool> --schema` prints a tool's input, `<tool> '<json>'` calls it " +
      "(input may also come on stdin), and --describe prints every tool " +
      "with its schema. --db <name> picks the database.",
  },
  async run({ rawArgs }) {
    await runTools(rawArgs);
  },
});

const main = defineCommand({
  meta: {
    name: "om",
    description: "Manage the open-minutes meeting database",
  },
  subCommands: { models, tools: toolsCommand },
});

await runMain(main);
