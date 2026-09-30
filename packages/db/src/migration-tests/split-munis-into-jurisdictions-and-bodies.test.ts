import { describe, expect } from "vitest";
import { sqlData } from "../testing";
import { dbTest } from "../testing/vitest";

// Migration test: start from the schema just *before* the migration, seed it
// with data shaped like production's at the time, apply exactly this one
// migration, and check the data came across correctly.
//
// Pinning both ends to named versions (rather than "latest") keeps this test
// valid forever: migrations are append-only, so these two schemas never change
// even as later migrations pile up.
//
// Seed and inspect with raw SQL: drizzle's table objects describe the *latest*
// schema, which neither end of this test is.

const BEFORE = "panoramic_dagger";
const MIGRATION = "split-munis-into-jurisdictions-and-bodies";

const test = dbTest({
  schemaVersion: BEFORE,
  data: sqlData(
    "legacy-municipalities",
    `
    INSERT INTO municipalities (id, name, name_short, state, youtube_channel_id) VALUES
      (1, 'Girdwood Board of Supervisors', 'GBOS', 'AK', 'UCgbos'),
      (2, 'Anchorage Assembly', 'Anchorage Assembly', 'AK', ''),
      (3, 'City and Borough of Juneau', 'Juneau', 'AK', 'UCjuneau');
    INSERT INTO meetings (municipality_id, youtube_id, title) VALUES
      (1, 'vid-gbos', 'GBOS regular meeting'),
      (2, 'vid-assembly', 'Assembly regular meeting'),
      (3, 'vid-juneau', 'Juneau regular meeting');
    `,
  ),
});

describe(MIGRATION, () => {
  test("splits municipalities into jurisdictions, bodies, and video sources", async ({
    testDb,
  }) => {
    const sql = testDb.client;
    const [before] = await sql`SELECT count(*)::int AS n FROM municipalities`;
    expect(before!.n).toBe(3);

    expect(await testDb.migrateTo(MIGRATION)).toEqual([
      expect.stringMatching(new RegExp(`_${MIGRATION}$`)),
    ]);

    const bodies = await sql`
      SELECT b.name_short AS body, j.name_short AS jurisdiction
      FROM bodies b JOIN jurisdictions j ON j.id = b.jurisdiction_id
      ORDER BY b.name_short`;
    // GBOS and the Assembly are reparented under one real MOA jurisdiction,
    // and the Assembly gets its proper short name.
    expect(bodies).toEqual([
      { body: "Assembly", jurisdiction: "MOA" },
      { body: "GBOS", jurisdiction: "MOA" },
      { body: "Juneau", jurisdiction: "Juneau" },
    ]);

    // The placeholder jurisdictions the generic backfill made are gone.
    const jurisdictions = await sql`
      SELECT name_short FROM jurisdictions ORDER BY name_short`;
    expect(jurisdictions.map((r) => r.name_short)).toEqual(["Juneau", "MOA"]);

    // Only non-empty YouTube channels become video sources.
    const sources = await sql`
      SELECT b.name_short AS body, v.kind, v.youtube_id, v.url
      FROM video_sources v JOIN bodies b ON b.id = v.body_id
      ORDER BY b.name_short`;
    expect(sources).toEqual([
      {
        body: "GBOS",
        kind: "channel",
        youtube_id: "UCgbos",
        url: "https://www.youtube.com/channel/UCgbos",
      },
      {
        body: "Juneau",
        kind: "channel",
        youtube_id: "UCjuneau",
        url: "https://www.youtube.com/channel/UCjuneau",
      },
    ]);

    // Every meeting follows its municipality to the matching body.
    const meetings = await sql`
      SELECT m.youtube_id, b.name_short AS body
      FROM meetings m JOIN bodies b ON b.id = m.body_id
      ORDER BY m.youtube_id`;
    expect(meetings).toEqual([
      { youtube_id: "vid-assembly", body: "Assembly" },
      { youtube_id: "vid-gbos", body: "GBOS" },
      { youtube_id: "vid-juneau", body: "Juneau" },
    ]);

    const [legacy] = await sql`SELECT to_regclass('municipalities') AS t`;
    expect(legacy!.t).toBeNull();
  });

  test("then migrates cleanly the rest of the way to latest", async ({
    testDb,
  }) => {
    await testDb.migrateTo(MIGRATION);
    const rest = await testDb.migrateTo("latest");
    expect(rest.length).toBeGreaterThan(0);
  });

  test("refuses to migrate backwards", async ({ testDb }) => {
    await testDb.migrateTo(MIGRATION);
    await expect(testDb.migrateTo(BEFORE)).rejects.toThrow(
      /migrations only go forward/,
    );
  });
});
