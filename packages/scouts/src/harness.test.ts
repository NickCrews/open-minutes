import { describe, expect } from "vite-plus/test";
import { writeFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { blobStore } from "@open-minutes/blobstore";
import type { Scout, ScoutedRecording } from "@open-minutes/core/scout";
import { dataset } from "@open-minutes/datasets";
import {
  type DB,
  meetingsTable,
  recordingBodiesTable,
  recordingsTable,
} from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import {
  type AudioTools,
  availableRecordings,
  failedRecordings,
  scan,
  storeAudio,
} from "./harness";
import { runLogger } from "./logger";
import { runScouts } from "./run";

const test = dbTest({ data: dataset("bodies") });

function report(
  external_id: string,
  fields: Partial<ScoutedRecording> = {},
): ScoutedRecording {
  return {
    site: "youtube",
    external_id,
    permalink: `https://www.youtube.com/watch?v=${external_id}`,
    title: `Meeting ${external_id}`,
    description: "",
    published_at: null,
    duration_secs: 60,
    is_meeting: null,
    notes: "",
    bodies: [],
    ...fields,
  };
}

/**
 * A scout that reports whichever of `reports` are unseen, then throws if
 * `fail` says to.
 */
function fakeScout(
  id: string,
  reports: ScoutedRecording[],
  { bodies = ["gbos", "luc"], schedule = "0 17 * * *", fail = false } = {},
): Scout {
  return {
    id,
    name: id,
    bodies,
    schedule,
    async *scan(ctx) {
      const todo = new Set(
        (await ctx.unseen(reports)).map((k) => `${k.site} ${k.external_id}`),
      );
      for (const r of reports) {
        if (todo.has(`${r.site} ${r.external_id}`)) yield r;
      }
      if (fail) throw new Error("the site went away");
    },
  };
}

/** A run logger that keeps its lines. */
function testLogger() {
  const lines: string[] = [];
  return {
    logger: runLogger({ sink: (l) => lines.push(l), annotate: false }),
    lines,
  };
}

async function recordings(db: DB) {
  return db
    .select({
      external_id: recordingsTable.external_id,
      scout_id: recordingsTable.scout_id,
      is_meeting: recordingsTable.is_meeting,
    })
    .from(recordingsTable)
    .orderBy(recordingsTable.id);
}

describe("scan", () => {
  test("writes each report, with its bodies", async ({ db }) => {
    const { logger } = testLogger();
    const results = await scan({
      db,
      scouts: [
        fakeScout("gbos-youtube", [
          report("a", {
            bodies: ["gbos", "luc"],
            is_meeting: true,
            notes: "joint",
          }),
          report("b", { is_meeting: false, notes: "a test" }),
        ]),
      ],
      logger,
    });
    expect(results).toEqual([
      { scout: "gbos-youtube", reported: 2, rejected: 0, failed: false },
    ]);
    expect(logger.errors).toBe(0);
    const [a] = await db
      .select()
      .from(recordingsTable)
      .where(eq(recordingsTable.external_id, "a"));
    expect(a).toMatchObject({
      site: "youtube",
      permalink: "https://www.youtube.com/watch?v=a",
      title: "Meeting a",
      duration_secs: "00:01:00",
      scout_id: "gbos-youtube",
      is_meeting: true,
      notes: "joint",
      audio_stored_at: null,
      audio_failures: 0,
    });
    expect(
      await db.execute(sql`SELECT b.slug FROM ${recordingBodiesTable} rb
        JOIN bodies b ON b.id = rb.body_id ORDER BY b.slug`),
    ).toEqual([{ slug: "gbos" }, { slug: "luc" }]);
  });

  test("skips recordings any scout has already reported", async ({ db }) => {
    const { logger } = testLogger();
    await scan({ db, scouts: [fakeScout("one", [report("a")])], logger });
    const results = await scan({
      db,
      scouts: [fakeScout("two", [report("a"), report("b")])],
      logger,
    });
    expect(results[0]).toMatchObject({ reported: 1 });
    expect(await recordings(db)).toEqual([
      { external_id: "a", scout_id: "one", is_meeting: null },
      { external_id: "b", scout_id: "two", is_meeting: null },
    ]);
  });

  test("rejects a report naming a body that isn't its scout's", async ({
    db,
  }) => {
    const { logger, lines } = testLogger();
    const results = await scan({
      db,
      scouts: [
        fakeScout("gbos-youtube", [
          report("a", { bodies: ["assembly"] }),
          report("b", { bodies: ["gbos"] }),
        ]),
      ],
      logger,
    });
    expect(results[0]).toMatchObject({ reported: 1, rejected: 1 });
    expect(logger.errors).toBe(1);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^\[gbos-youtube\] rejected youtube a: body "assembly"/,
      ),
    );
    expect((await recordings(db)).map((r) => r.external_id)).toEqual(["b"]);
  });

  test("keeps what a scout yielded before it threw", async ({ db }) => {
    const { logger, lines } = testLogger();
    const results = await scan({
      db,
      scouts: [
        fakeScout("flaky", [report("a"), report("b")], { fail: true }),
        fakeScout("fine", [report("c")]),
      ],
      logger,
    });
    expect(results).toEqual([
      { scout: "flaky", reported: 2, rejected: 0, failed: true },
      { scout: "fine", reported: 1, rejected: 0, failed: false },
    ]);
    expect(lines).toContainEqual(
      expect.stringMatching(/^\[flaky\] failed: Error: the site went away/),
    );
    expect((await recordings(db)).map((r) => r.external_id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("writes nothing in a dry run", async ({ db }) => {
    const { logger } = testLogger();
    const results = await scan({
      db,
      scouts: [fakeScout("one", [report("a")])],
      logger,
      dryRun: true,
    });
    expect(results[0]).toMatchObject({ reported: 1 });
    expect(await recordings(db)).toEqual([]);
  });
});

/**
 * Fake audio tools: each fetch writes a file holding `durations[external_id]`
 * (default the recording's own), which `duration` reads back. `fail` lists
 * external IDs whose fetch throws.
 */
function fakeTools({
  durations = {} as Record<string, number>,
  fail = [] as string[],
} = {}) {
  const uploads: string[] = [];
  const fetched: string[] = [];
  const tools: AudioTools = {
    fetchAudio: {
      youtube: async (id, dest) => {
        fetched.push(id);
        if (fail.includes(id)) throw new Error(`no such video ${id}`);
        await writeFile(dest, String(durations[id] ?? 60));
      },
      akleg: async (id, dest) => {
        fetched.push(id);
        await writeFile(dest, String(durations[id] ?? 60));
      },
    },
    encode: async (input, output) => {
      const { readFile } = await import("node:fs/promises");
      await writeFile(output, await readFile(input));
    },
    duration: async (file) => {
      const { readFile } = await import("node:fs/promises");
      return Number(await readFile(file, "utf8"));
    },
    upload: async (_file, key) => {
      uploads.push(key);
    },
    store: blobStore("https://blobs.example"),
  };
  return { tools, uploads, fetched };
}

async function insert(
  db: DB,
  rows: Partial<typeof recordingsTable.$inferInsert>[],
) {
  await db.insert(recordingsTable).values(
    rows.map((r, i) => ({
      site: "youtube" as const,
      external_id: `r${i}`,
      duration_secs: "60",
      ...r,
    })),
  );
}

describe("storeAudio", () => {
  test("stores audio newest first, up to the cap, skipping non-meetings", async ({
    db,
  }) => {
    await insert(db, [
      { external_id: "old", published_at: new Date("2026-01-01") },
      { external_id: "unknown-date" },
      { external_id: "new", published_at: new Date("2026-10-01") },
      { external_id: "not-a-meeting", is_meeting: false },
      {
        site: "akleg",
        external_id: "HRES 2026-03-02 13:00:00",
        is_meeting: true,
        published_at: new Date("2026-03-03"),
      },
    ]);
    const { tools, uploads } = fakeTools();
    const { logger } = testLogger();
    expect(await storeAudio({ db, tools, logger, cap: 3 })).toEqual({
      stored: 3,
      failed: 0,
    });
    expect(uploads).toEqual([
      "recordings/youtube/new/speech.webm",
      "recordings/akleg/HRES 2026-03-02 13:00:00/speech.webm",
      "recordings/youtube/old/speech.webm",
    ]);
    const stored = await db
      .select({ external_id: recordingsTable.external_id })
      .from(recordingsTable)
      .where(sql`${recordingsTable.audio_stored_at} IS NOT NULL`)
      .orderBy(recordingsTable.external_id);
    expect(stored.map((r) => r.external_id)).toEqual([
      "HRES 2026-03-02 13:00:00",
      "new",
      "old",
    ]);

    // The next run picks up the rest, and never the non-meeting.
    uploads.length = 0;
    await storeAudio({ db, tools, logger, cap: 10 });
    expect(uploads).toEqual(["recordings/youtube/unknown-date/speech.webm"]);
  });

  test("retries a failed fetch until its third failure", async ({ db }) => {
    await insert(db, [{ external_id: "gone" }]);
    const { tools, fetched } = fakeTools({ fail: ["gone"] });
    for (let run = 0; run < 4; run++) {
      const { logger } = testLogger();
      await storeAudio({ db, tools, logger, cap: 10 });
      expect(logger.errors).toBe(run < 3 ? 1 : 0);
    }
    expect(fetched).toEqual(["gone", "gone", "gone"]);
    expect(await failedRecordings(db)).toEqual([
      {
        id: expect.any(Number),
        site: "youtube",
        external_id: "gone",
        audio_failures: 3,
        audio_error: "no such video gone",
      },
    ]);

    // Resetting the count retries it.
    await db.update(recordingsTable).set({ audio_failures: 0 });
    await storeAudio({ db, tools, logger: testLogger().logger, cap: 10 });
    expect(fetched).toHaveLength(4);
  });

  test("counts audio much shorter or longer than the site says as a failure", async ({
    db,
  }) => {
    await insert(db, [
      { external_id: "close", duration_secs: "60" },
      { external_id: "short", duration_secs: "60" },
      { external_id: "no-duration", duration_secs: null },
    ]);
    const { tools, uploads } = fakeTools({
      durations: { close: 63, short: 30, "no-duration": 999 },
    });
    const { logger, lines } = testLogger();
    expect(await storeAudio({ db, tools, logger, cap: 10 })).toEqual({
      stored: 2,
      failed: 1,
    });
    expect(uploads.sort()).toEqual([
      "recordings/youtube/close/speech.webm",
      "recordings/youtube/no-duration/speech.webm",
    ]);
    expect(lines).toContainEqual(
      expect.stringContaining(
        "encoded audio is 30.0 s, but the site says 60 s",
      ),
    );
  });

  test("fetches nothing in a dry run", async ({ db }) => {
    await insert(db, [{ external_id: "a" }]);
    const { tools, fetched } = fakeTools();
    await storeAudio({
      db,
      tools,
      logger: testLogger().logger,
      cap: 10,
      dryRun: true,
    });
    expect(fetched).toEqual([]);
  });
});

describe("availableRecordings", () => {
  test("lists recordings with audio that no meeting points at and aren't ruled out", async ({
    db,
  }) => {
    const stored = new Date("2026-10-01");
    await insert(db, [
      { external_id: "ready", audio_stored_at: stored },
      { external_id: "meeting", is_meeting: true, audio_stored_at: stored },
      { external_id: "no-audio" },
      {
        external_id: "not-a-meeting",
        is_meeting: false,
        audio_stored_at: stored,
      },
      { external_id: "taken", audio_stored_at: stored },
    ]);
    const [taken] = await db
      .select({ id: recordingsTable.id })
      .from(recordingsTable)
      .where(eq(recordingsTable.external_id, "taken"));
    await db
      .insert(meetingsTable)
      .values({ recording_id: taken!.id, timezone: "America/Anchorage" });
    expect(
      (await availableRecordings(db)).map((r) => r.external_id).sort(),
    ).toEqual(["meeting", "ready"]);
  });
});

describe("runScouts", () => {
  const scouts = [
    fakeScout("morning", [report("a")], { schedule: "0 17 * * *" }),
    fakeScout("evening", [report("b")], { schedule: "0 3 * * *" }),
  ];

  test("runs the scouts whose cron fell in the past hour, then stores audio", async ({
    db,
  }) => {
    const { tools, uploads } = fakeTools();
    const result = await runScouts({
      db,
      scouts,
      logger: testLogger().logger,
      tools,
      now: new Date("2026-10-26T17:20:00Z"),
    });
    expect(result.scans.map((s) => s.scout)).toEqual(["morning"]);
    expect(result).toMatchObject({ audio: { stored: 1, failed: 0 }, ok: true });
    expect(uploads).toEqual(["recordings/youtube/a/speech.webm"]);
  });

  test("runs --scout now, whatever its schedule", async ({ db }) => {
    const result = await runScouts({
      db,
      scouts,
      scoutId: "evening",
      logger: testLogger().logger,
      tools: fakeTools().tools,
      now: new Date("2026-10-26T17:20:00Z"),
    });
    expect(result.scans.map((s) => s.scout)).toEqual(["evening"]);
  });

  test("is not ok when a scout fails", async ({ db }) => {
    const result = await runScouts({
      db,
      scouts: [fakeScout("x", [report("a")], { fail: true })],
      scoutId: "x",
      logger: testLogger().logger,
      tools: fakeTools().tools,
    });
    expect(result).toMatchObject({ audio: { stored: 1 }, ok: false });
  });

  test("is not ok when a fetch fails", async ({ db }) => {
    const result = await runScouts({
      db,
      scouts: [fakeScout("x", [report("a")])],
      scoutId: "x",
      logger: testLogger().logger,
      tools: fakeTools({ fail: ["a"] }).tools,
    });
    expect(result).toMatchObject({
      audio: { stored: 0, failed: 1 },
      ok: false,
    });
  });
});
