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
        name: "slow",
        description:
          "Slow diarization/transcription tests over full meetings (~10-20 min each on CPU). Skipped unless SLOW=1; run via `pnpm test:slow` or `pnpm test:all`.",
        // WARNING: the timeout might not actually have an effect for the ML-heavy tests:
        // Vitest cannot interrupt synchronous native code (like in sherpa-onnx), it only can abort within the JS event loop.
        timeout: 25 * 60 * 1000, // a full 166-min meeting diarizes in ~8-10 min; headroom for CI/background
        skip: process.env.SLOW !== "1",
      },
      {
        name: "ytdlp",
        description:
          "Tests that run yt-dlp against YouTube. Skipped unless YTDLP=1; run via `pnpm test:ytdlp` or `pnpm test:all`, which install yt-dlp into .cache/bin if it isn't on PATH. YouTube blocks datacenter IPs, so from CI or a server they need YOUTUBE_PROXY.",
        timeout: 5 * 60 * 1000, // listing a big channel takes about a minute
        skip: process.env.YTDLP !== "1",
      },
    ],
  },
});
