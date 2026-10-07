import { describe, expect } from "vitest";
import { ianaTimezoneError as jsTimezoneError } from "@open-minutes/core/timezone";
import { test } from "./testing/vitest";
import { bodiesTable, jurisdictionsTable, meetingsTable } from "./schema";
import { ianaTimezoneError } from "./timezone";

const VALID = [
  "America/Anchorage",
  "America/Juneau",
  "America/Argentina/Buenos_Aires",
  "America/Port-au-Prince",
];

const INVALID: [string, string][] = [
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

describe("ianaTimezoneError", () => {
  test("accepts IANA Area/Location zones", async ({ db }) => {
    for (const name of VALID) {
      expect(await ianaTimezoneError(db, name), name).toBeNull();
    }
  });

  test("explains what's wrong with everything else", async ({ db }) => {
    for (const [name, error] of INVALID) {
      expect(await ianaTimezoneError(db, name), name).toContain(error);
    }
  });

  test("agrees with core's database-free copy, message for message", async ({
    db,
  }) => {
    for (const name of [...VALID, ...INVALID.map(([name]) => name)]) {
      expect(jsTimezoneError(name), name).toBe(
        await ianaTimezoneError(db, name),
      );
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

describe("meetings.timezone", () => {
  test("rejects what ianaTimezoneError rejects", async ({ db }) => {
    await expect(
      db.insert(meetingsTable).values({
        site_kind: "youtube",
        site_id: "x",
        timezone: "Etc/GMT+9",
      }),
    ).rejects.toThrow();
  });
});
