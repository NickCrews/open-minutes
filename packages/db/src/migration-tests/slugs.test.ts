import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// See split-munis-into-jurisdictions-and-bodies.test.ts for how migration
// tests work.

const BEFORE = "joint-meetings";
const MIGRATION = "slugs";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "before-slugs",
    `
    INSERT INTO jurisdictions (id, name, name_short) VALUES
      (1, 'Municipality of Anchorage', 'MOA'),
      (2, 'State of Alaska', 'Alaska'),
      (3, 'Nowhere Borough', '');
    INSERT INTO bodies (id, jurisdiction_id, name, name_short, timezone) VALUES
      (1, 1, 'Girdwood Board of Supervisors', 'GBOS', 'America/Anchorage'),
      (2, 1, 'Land Use Committee', 'Land Use  Cmte.', 'America/Anchorage'),
      (3, 1, 'Another GBOS', 'gbos', 'America/Anchorage'),
      (4, 3, '', '', 'America/Anchorage');
    `,
  ),
});

describe(MIGRATION, () => {
  test("backfills kebab-case slugs from name_short", async ({ testDb }) => {
    const sql = testDb.client;
    expect(await testDb.migrateTo(MIGRATION)).toEqual([
      expect.stringMatching(new RegExp(`_${MIGRATION}$`)),
    ]);

    expect(await sql`SELECT id, slug FROM jurisdictions ORDER BY id`).toEqual([
      { id: 1, slug: "moa" },
      { id: 2, slug: "ak" },
      { id: 3, slug: "nowhere-borough" },
    ]);
    expect(await sql`SELECT id, slug FROM bodies ORDER BY id`).toEqual([
      { id: 1, slug: "gbos" },
      { id: 2, slug: "land-use-cmte" },
      { id: 3, slug: "gbos-3" },
      { id: 4, slug: "body-4" },
    ]);
  });

  test("requires a unique kebab-case slug", async ({ testDb }) => {
    const sql = testDb.client;
    await testDb.migrateTo(MIGRATION);
    await expect(
      sql`INSERT INTO jurisdictions (id, name) VALUES (9, 'No Slug')`,
    ).rejects.toThrow(/null value in column "slug"/);
    await expect(
      sql`INSERT INTO jurisdictions (id, slug) VALUES (9, 'moa')`,
    ).rejects.toThrow(/jurisdictions_slug_key/);
    await expect(
      sql`INSERT INTO bodies (id, jurisdiction_id, slug, timezone)
        VALUES (9, 1, 'GBOS', 'America/Anchorage')`,
    ).rejects.toThrow(/bodies_slug_valid/);
  });

  test("requires kebab-case people and meeting slugs", async ({ testDb }) => {
    const sql = testDb.client;
    await testDb.migrateTo(MIGRATION);
    const vector = `[${Array(192).fill(0).join(",")}]`;
    await sql`INSERT INTO people (slug, voice_embedding) VALUES (NULL, ${vector}), ('kyle-kelley', ${vector})`;
    await expect(
      sql`INSERT INTO people (slug, voice_embedding) VALUES ('kyle--kelley', ${vector})`,
    ).rejects.toThrow(/people_slug_valid/);
    await sql`INSERT INTO meetings (slug, site_kind, site_id, timezone)
      VALUES ('gbos-2026-03-23', 'youtube', 'a', 'America/Anchorage')`;
    await expect(
      sql`INSERT INTO meetings (slug, site_kind, site_id, timezone)
        VALUES ('GBOS 2026', 'youtube', 'b', 'America/Anchorage')`,
    ).rejects.toThrow(/meetings_slug_valid/);
  });
});
