import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { DataState } from "./ensure";

// The `pnpm db` CLI's project configuration: which datasets `--data` can name.
// It lives in a dbranch.config.ts at the repository root, like
// drizzle.config.ts or vitest.config.ts, so the app wires its datasets into the
// harness there. This package never imports them, and nothing depends on the
// repository root, so the config can import from any package.

export const CONFIG_FILE = "dbranch.config.ts";

export interface DbConfig {
  /** The datasets `pnpm db up --data <name>` can name. */
  datasets: Record<string, DataState>;
  /**
   * The dataset `pnpm db up` declares when `--data` isn't given. Must be a
   * key of `datasets`. Default: no data.
   */
  defaultDataset?: string;
}

/** Identity function that type-checks a dbranch.config.ts's default export. */
export function defineConfig(config: DbConfig): DbConfig {
  return config;
}

/**
 * The nearest dbranch.config.ts at or above `from`: by default the directory
 * the command was run from (pnpm's INIT_CWD, since `pnpm db` runs from this
 * package's directory).
 */
export function findConfig(
  from: string = process.env.INIT_CWD ?? process.cwd(),
): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Loads the config at `path`, else $DBRANCH_CONFIG, else the nearest
 * dbranch.config.ts. The file is TypeScript, so this needs a TypeScript-aware
 * runtime (tsx, vitest, vite).
 */
export async function loadConfig(path?: string): Promise<DbConfig> {
  const file = path ?? process.env.DBRANCH_CONFIG ?? findConfig();
  if (!file) {
    throw new Error(
      `No ${CONFIG_FILE} found in ${process.env.INIT_CWD ?? process.cwd()} ` +
        `or any directory above it. Create one at the repository root, or ` +
        `point DBRANCH_CONFIG at one.`,
    );
  }
  const module = (await import(pathToFileURL(resolve(file)).href)) as {
    default?: DbConfig;
  };
  const config = module.default;
  if (!config?.datasets) {
    throw new Error(
      `${file} must \`export default defineConfig({ datasets: ... })\`.`,
    );
  }
  if (
    config.defaultDataset !== undefined &&
    !(config.defaultDataset in config.datasets)
  ) {
    throw new Error(
      `${file}: defaultDataset "${config.defaultDataset}" is not one of its ` +
        `datasets (${Object.keys(config.datasets).join(", ")}).`,
    );
  }
  return config;
}
