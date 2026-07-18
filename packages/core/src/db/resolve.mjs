// Answers "which database?" for every entrypoint: app code, drizzle-kit, the
// seed/nuke scripts, and tests. Plain JavaScript so bare `node` scripts like
// nuke.mjs can import it without a TS runner.
//
// A target is either a name ("local", "prod", ...) that resolves to
// DATABASE_URL_<NAME> in the workspace-root .env.local, or a full postgres://
// URL used verbatim. The `DB` env var selects the target when code doesn't:
//
//   DB=prod pnpm db:migrate
//   DB=postgres://... pnpm db:seed
import console from "node:console";
import process from "node:process";
import { URL } from "node:url";
import { loadRootDotEnv } from "../dotenv.mjs";

// The zero-config default for "local". The single source of truth for this
// URL; it must match the postgres service in docker-compose.yml. Setting
// DATABASE_URL_LOCAL overrides it like any other named database.
const DEFAULT_LOCAL_URL =
  "postgres://postgres:postgres@localhost:5432/open_minutes";

/** Databases already announced this process, so repeat resolutions stay quiet. */
const logged = new Set();

/**
 * Resolves a database target to a postgres connection URL.
 *
 * Logs which database was chosen (password redacted, once per process) —
 * except for URLs passed as an explicit argument, where the caller already
 * knows exactly what it's connecting to.
 *
 * @param {string} [target] A name ("local", "prod", ...) resolved via
 *   DATABASE_URL_<NAME>, or a full postgres:// URL. Defaults to $DB, then
 *   $DATABASE_URL, then "local".
 * @returns {string} The connection URL.
 */
export function resolveDatabaseUrl(target) {
  loadRootDotEnv();
  const explicitUrl = target?.includes("://") ?? false;
  target ??= process.env.DB || process.env.DATABASE_URL || "local";
  const url = resolve(target);
  if (!explicitUrl && !logged.has(url)) {
    logged.add(url);
    const name = target.includes("://") ? "" : ` ${target}`;
    console.error(`Using database${name}: ${redactUrl(url)}`);
  }
  return url;
}

/**
 * @param {string} target
 * @returns {string}
 */
function resolve(target) {
  if (target.includes("://")) return target;
  const key = `DATABASE_URL_${target.toUpperCase().replaceAll("-", "_")}`;
  const url = process.env[key];
  if (url) return url;
  // "local" works with zero configuration: docker-compose's postgres.
  if (target === "local") return DEFAULT_LOCAL_URL;
  const known = new Set(
    Object.keys(process.env)
      .filter((k) => k.startsWith("DATABASE_URL_"))
      .map((k) => k.slice("DATABASE_URL_".length).toLowerCase()),
  );
  known.add("local");
  throw new Error(
    `Unknown database "${target}": set ${key} in .env.local, or use one of: ${[...known].sort().join(", ")}`,
  );
}

/**
 * The URL with its password masked, safe for logging.
 *
 * @param {string} url
 * @returns {string}
 */
function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return url;
  }
}
