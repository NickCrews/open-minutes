// The one place that knows where the workspace-root .env.local lives.
// Everything that wants values from it — database resolution, CLIs needing
// bucket credentials, test setup — calls loadRootEnv() explicitly rather than
// relying on some other module having loaded it first as a side effect.
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;

/** Absolute path of the workspace-root .env.local (which may not exist). */
export function rootDotEnvPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../../.env.local");
}

/**
 * Loads the workspace-root .env.local into process.env (once per process).
 * Real environment variables win over file values, and a missing file is a
 * no-op — deployed environments inject env vars directly.
 */
export function loadRootDotEnv(): void {
  if (loaded) return;
  loaded = true;
  try {
    config({
      path: rootDotEnvPath(),
      quiet: true,
    });
  } catch {
    // Bundled non-Node runtimes (e.g. Cloudflare Workers) have no workspace
    // filesystem — env vars arrive directly, so a failed load is a no-op,
    // matching the missing-file behavior on Node.
  }
}
