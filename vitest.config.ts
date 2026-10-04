import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "./packages/audio/vitest.config.ts",
      "./packages/core/vitest.config.ts",
      "./packages/db/vitest.config.ts",
      "./packages/fixtures/vitest.config.ts",
      "./packages/ingest/vitest.config.ts",
      "./packages/agents/vitest.config.ts",
      "./packages/youtube/vitest.config.ts",
      "./packages/akleg/vitest.config.ts",
      "./packages/web/vitest.config.ts",
    ],
  },
});
