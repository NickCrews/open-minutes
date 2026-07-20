// The one place that knows where the workspace-root .env.local lives.
// Everything that wants values from it — database resolution, CLIs needing
// bucket credentials, test setup — calls loadRootEnv() explicitly rather than
// relying on some other module having loaded it first as a side effect.
//
// Plain JavaScript so bare `node` scripts can import it without a TS runner.
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;

/**
 * Loads the workspace-root .env.local into process.env (once per process).
 * Real environment variables win over file values, and a missing file is a
 * no-op — deployed environments inject env vars directly.
 */
export function loadRootDotEnv() {
  if (loaded) return;
  loaded = true;
  try {
    config({
      path: join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../.env.local",
      ),
      quiet: true,
    });
  } catch {
    // Bundled non-Node runtimes (e.g. Cloudflare Workers) have no workspace
    // filesystem — env vars arrive directly, so a failed load is a no-op,
    // matching the missing-file behavior on Node.
  }
}
