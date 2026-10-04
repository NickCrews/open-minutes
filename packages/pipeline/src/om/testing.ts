import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DB,
  bodiesTable,
  jurisdictionsTable,
  meetingsTable,
  videoSourcesTable,
} from "@open-minutes/db";
import { eq } from "drizzle-orm";
import type { YouTube } from "@open-minutes/youtube";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { goldenData } from "@open-minutes/fixtures/golden-data";
import { loadBodies } from "@open-minutes/fixtures/test-data";

// Test helpers for the om API tests (not collected by vitest — no .test suffix).

/**
 * A {@link YouTube} boundary where every call throws unless overridden, so a
 * test both avoids the network and proves which calls were (not) made.
 */
export function fakeYouTube(overrides: Partial<YouTube> = {}): YouTube {
  return {
    getMetadata: async () => {
      throw new Error("unexpected getMetadata call");
    },
    ensureAudioDownloaded: async () => {
      throw new Error("unexpected ensureAudioDownloaded call");
    },
    ...overrides,
  };
}

/**
 * Insert a body, with its video sources, under a throwaway jurisdiction of the
 * same name. Returns its id. For tests that need a second body alongside the
 * golden GBOS one (see {@link goldenTest}).
 */
export async function insertBody(
  db: DB,
  body: {
    name: string;
    name_short: string;
    timezone?: string;
    sources?: Array<{ kind: "channel" | "playlist"; youtube_id: string }>;
  },
): Promise<number> {
  const [jurisdiction] = await db
    .insert(jurisdictionsTable)
    .values({ name: body.name, name_short: body.name_short })
    .returning({ id: jurisdictionsTable.id });
  const [row] = await db
    .insert(bodiesTable)
    .values({
      name: body.name,
      name_short: body.name_short,
      jurisdiction_id: jurisdiction!.id,
      timezone: body.timezone ?? "America/Anchorage",
    })
    .returning({ id: bodiesTable.id });
  if (body.sources?.length) {
    await db
      .insert(videoSourcesTable)
      .values(body.sources.map((s) => ({ ...s, body_id: row!.id })));
  }
  return row!.id;
}

/** Insert a bare meeting row (as if previously ingested). Returns its id. */
export async function insertMeeting(
  db: DB,
  bodyId: number,
  youtubeId: string,
  date?: string,
): Promise<number> {
  const [row] = await db
    .insert(meetingsTable)
    .values({
      body_id: bodyId,
      youtube_id: youtubeId,
      date,
    })
    .returning({ id: meetingsTable.id });
  return row!.id;
}

const workRootFixture = {
  // eslint-disable-next-line no-empty-pattern
  workRoot: async ({}, use: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), "om-work-"));
    try {
      await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

/** An empty database, plus a disposable work-directory root for ingest tests. */
export const test = dbTest().extend<{ workRoot: string }>(workRootFixture);

/**
 * A database starting from the golden dataset (the MOA jurisdiction and its
 * bodies with their video sources, from test-data/), plus a work root.
 * Tests layer their own scenario rows on top.
 */
export const goldenTest = dbTest({ data: goldenData }).extend<{
  workRoot: string;
}>(workRootFixture);

const goldenGbos = loadBodies().find((b) => b.id === "gbos")!;

/** GBOS as test-data/bodies.jsonl declares it: the one source of truth. */
export const GOLDEN_GBOS = {
  name_short: goldenGbos.name_short,
  channelId: goldenGbos.video_sources.find((s) => s.kind === "channel")!
    .youtube_id,
};

/** The golden GBOS body's id in a database seeded with {@link goldenData}. */
export async function goldenGbosId(db: DB): Promise<number> {
  const [row] = await db
    .select({ id: bodiesTable.id })
    .from(bodiesTable)
    .where(eq(bodiesTable.name_short, GOLDEN_GBOS.name_short));
  if (!row) throw new Error("No GBOS body: is this a goldenTest database?");
  return row.id;
}
