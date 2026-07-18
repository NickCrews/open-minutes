import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));

// Shared config for every workspace package's vitest.config.ts.
// Keeps "node" environment + the workspace-root test-setup.ts in one place.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: [join(ROOT, "test-setup.ts")],
    tags: [
      {
        name: "slow5min",
        description:
          "Slow diarization/transcription tests over full meetings (~10 min each on CPU)",
        // WARNING: the timeout might not actually have an effect for the ML-heavy tests:
        // Vitest cannot interrupt synchronous native code (like in sherpa-onnx), it only can abort within the JS event loop.
        timeout: 25 * 60 * 1000, // a full 166-min meeting diarizes in ~8-10 min; headroom for CI/background
        skip: process.env.SKIP_SLOW === "1",
      },
    ],
  },
});
