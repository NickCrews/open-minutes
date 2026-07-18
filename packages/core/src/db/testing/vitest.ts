import { beforeAll, test as baseTest } from "vitest";
import type { DB } from "../index";
import { createTestDb, ensureTestTemplate, type TestDb } from "./index";

// Vitest fixture giving each test its own fresh, migrated, empty database,
// dropped automatically when the test finishes:
//
//   import { test } from "@open-minutes/core/db/testing/vitest";
//
//   test("plays in its own sandbox", async ({ db }) => { ... });
//
// Kept separate from ./index so non-vitest callers (scripts, CLIs) can import
// the plain utilities without pulling in vitest.

// The first ensure in a process may start docker and run migrations, which
// doesn't fit inside a default 5s test timeout. Do it in a hook with its own
// generous timeout; it memoizes, so the per-test fixture below then only pays
// for the cheap template clone. Registers in every file importing this module.
beforeAll(async () => {
  await ensureTestTemplate();
}, 120_000);

export const test = baseTest.extend<{ testDb: TestDb; db: DB }>({
  // eslint-disable-next-line no-empty-pattern
  testDb: async ({}, use) => {
    const testDb = await createTestDb();
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
