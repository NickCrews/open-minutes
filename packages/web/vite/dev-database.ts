import { prepareDatabase } from "@open-minutes/db/ensure";
import { resolveDatabaseUrl } from "@open-minutes/db/resolve";

/**
 * Runs when the dev server starts: makes sure the database the app is about
 * to use matches this checkout's schema, and returns its URL for the Worker.
 *
 * - Local (this git branch's docker-compose database): created and migrated
 *   as needed — switching branches just works. Seeding is left to `pnpm dev`
 *   (`pnpm db up`), which reads the datasets from dbranch.config.ts.
 * - Remote (e.g. `DB=prod pnpm web:dev`): never mutated from a dev server;
 *   startup fails if this code needs migrations the database doesn't have.
 *
 * The app itself runs in workerd, which can't see .env.local or .git, so it
 * can't resolve the target on its own; the caller passes the URL resolved
 * here into the Worker's environment.
 */
export async function prepareDevDatabase(): Promise<string> {
  const url = resolveDatabaseUrl();
  await prepareDatabase(url);
  return url;
}
