import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "./packages/audio/vitest.config.ts",
      "./packages/core/vitest.config.ts",
      "./packages/db/vitest.config.ts",
      "./packages/fixtures/vitest.config.ts",
      "./packages/pipeline/vitest.config.ts",
      "./packages/tools/vitest.config.ts",
      "./packages/youtube/vitest.config.ts",
      "./packages/web/vitest.config.ts",
    ],
  },
});
