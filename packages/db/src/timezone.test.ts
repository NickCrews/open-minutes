import { describe, expect } from "vitest";
import { test } from "./testing/vitest";
import { bodiesTable, jurisdictionsTable } from "./schema";
import { ianaTimezoneError } from "./timezone";

describe("ianaTimezoneError", () => {
  test("accepts IANA Area/Location zones", async ({ db }) => {
    for (const name of [
      "America/Anchorage",
      "America/Argentina/Buenos_Aires",
      "America/Port-au-Prince",
    ]) {
      expect(await ianaTimezoneError(db, name), name).toBeNull();
    }
  });

  test("explains what's wrong with everything else", async ({ db }) => {
    const cases: [string, string][] = [
      ["America/Anchorge", "not a known time zone"],
      ["Nope/Nope", "not a known time zone"],
      ["PST", "not an IANA time zone name"],
      ["EST5EDT", "not an IANA time zone name"],
      ["Foo+3", "not an IANA time zone name"],
      ["Foo/Bar+3", "not an IANA time zone name"],
      ["UTC", "not an IANA time zone name"],
      ["", "not an IANA time zone name"],
      ["Etc/UTC", "fixed UTC offset"],
      ["Etc/GMT+5", "fixed UTC offset"],
    ];
    for (const [name, error] of cases) {
      expect(await ianaTimezoneError(db, name), name).toContain(error);
    }
  });
});

describe("bodies.timezone", () => {
  test("rejects what ianaTimezoneError rejects", async ({ db }) => {
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
