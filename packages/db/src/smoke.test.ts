import { describe, expect } from "vite-plus/test";
import { sql } from "drizzle-orm";
import { test } from "./testing/vitest";

describe("db smoke test", () => {
  test("connects and returns a result", async ({ db }) => {
    const [result] = await db.execute(sql`SELECT 1 AS value`);
    expect(result!.value).toBe(1);
  });
});
