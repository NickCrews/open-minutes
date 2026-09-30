import { beforeAll, test as baseTest } from "vitest";
import type { DB } from "../index";
import {
  createTestDb,
  ensureTestTemplate,
  type TestDb,
  type TestDbOptions,
} from "./index";

// Vitest fixtures giving each test its own fresh database in a declared state,
// dropped automatically when the test finishes:
//
//   import { test } from "@open-minutes/db/testing/vitest";
//   test("plays in its own sandbox", async ({ db }) => { ... });   // empty
//
//   const test = dbTest({ data: goldenData });                     // seeded
//   test("starts from the golden data", async ({ db }) => { ... });
//
// Kept separate from ./index so non-vitest callers (scripts, CLIs) can import
// the plain utilities without pulling in vitest.

/**
 * A vitest `test` whose `db` / `testDb` fixtures are fresh clones of the
 * declared state. Call at module scope: it registers a `beforeAll` hook.
 */
export function dbTest(
  options: TestDbOptions & {
    /**
     * How long building the template may take the first time. The default
     * suits migrations plus a quick seed; a dataset that does real work (e.g.
     * computing voiceprints from audio) needs more. Built once, then cached.
     */
    setupTimeoutMs?: number;
  } = {},
) {
  // The first ensure in a process may start docker, migrate, and seed, which
  // doesn't fit inside a default 5s test timeout. Do it in a hook with its own
  // generous timeout; it memoizes, so the per-test fixture below then only
  // pays for the cheap template clone.
  beforeAll(async () => {
    await ensureTestTemplate(options);
  }, options.setupTimeoutMs ?? 120_000);

  return baseTest.extend<{ testDb: TestDb; db: DB }>({
    // eslint-disable-next-line no-empty-pattern
    testDb: async ({}, use) => {
      const testDb = await createTestDb(options);
      try {
        await use(testDb);
      } finally {
        await testDb.drop();
      }
    },
    db: async ({ testDb }, use) => {
      await use(testDb.db);
    },
  });
}

/** Fresh, migrated, empty database per test. */
export const test = dbTest();
