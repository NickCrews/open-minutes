import { describe, expect } from "vitest";
import { test } from "./testing/vitest";
import { bodiesTable, jurisdictionsTable } from "./schema";
import { isIanaTimezone } from "./timezone";

describe("isIanaTimezone", () => {
  test("accepts IANA Area/Location zones", async ({ db }) => {
    for (const name of [
      "America/Anchorage",
      "America/Argentina/Buenos_Aires",
      "America/Port-au-Prince",
    ]) {
      expect(await isIanaTimezone(db, name), name).toBe(true);
    }
  });

  test("rejects typos, abbreviations, offsets and fixed zones", async ({
    db,
  }) => {
    for (const name of [
      "America/Anchorge",
      "Nope/Nope",
      "PST",
      "EST5EDT",
      "Foo+3",
      "Foo/Bar+3",
      "UTC",
      "Etc/UTC",
      "Etc/GMT+5",
      "",
    ]) {
      expect(await isIanaTimezone(db, name), name).toBe(false);
    }
  });
});

describe("bodies.timezone", () => {
  test("rejects what isIanaTimezone rejects", async ({ db }) => {
    const [jurisdiction] = await db
      .insert(jurisdictionsTable)
      .values({ name: "Testville" })
      .returning({ id: jurisdictionsTable.id });
    await expect(
      db.insert(bodiesTable).values({
        jurisdiction_id: jurisdiction!.id,
        timezone: "UTC",
      }),
    ).rejects.toThrow();
  });
});
