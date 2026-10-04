import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DB,
  bodiesTable,
  jurisdictionsTable,
  meetingsTable,
} from "@open-minutes/db";
import { eq } from "drizzle-orm";
import type { AudioProvider } from "@open-minutes/core/audio-provider";
import type { MeetingSource, Site } from "@open-minutes/core/meeting-source";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { goldenData } from "@open-minutes/fixtures/golden-data";
import { loadBodies } from "@open-minutes/fixtures/test-data";

// Test helpers for the om API tests (not collected by vitest — no .test suffix).

/**
 * A site (YouTube, akleg.gov) where every call throws unless overridden, so a
 * test both avoids the network and proves which calls were (not) made.
 */
export function fakeSite(
  overrides: Partial<AudioProvider> = {},
): AudioProvider {
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
 * Insert a body, with its meeting source, under a throwaway jurisdiction of the
 * same name. Returns its id. For tests that need a second body alongside the
 * golden GBOS one (see {@link goldenTest}).
 */
export async function insertBody(
  db: DB,
  body: {
    name: string;
    name_short: string;
    timezone?: string;
    source?: MeetingSource;
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
      meeting_source: body.source,
    })
    .returning({ id: bodiesTable.id });
  return row!.id;
}

/**
 * Insert a bare meeting row (as if previously ingested), by default a YouTube
 * video. Returns its id.
 */
export async function insertMeeting(
  db: DB,
  bodyId: number,
  siteId: string,
  { date, site = "youtube" }: { date?: string; site?: Site } = {},
): Promise<number> {
  const [row] = await db
    .insert(meetingsTable)
    .values({ body_id: bodyId, site, site_id: siteId, date })
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
 * A database starting from the golden dataset (the jurisdictions and their
 * bodies with their meeting sources, from test-data/), plus a work root.
 * Tests layer their own scenario rows on top.
 */
export const goldenTest = dbTest({ data: goldenData }).extend<{
  workRoot: string;
}>(workRootFixture);

const goldenGbos = loadBodies().find((b) => b.id === "gbos")!;
if (goldenGbos.meeting_source?.type !== "youtube_channel")
  throw new Error("Golden GBOS's meeting source should be a YouTube channel");

/** GBOS as test-data/bodies.jsonl declares it: the one source of truth. */
export const GOLDEN_GBOS = {
  name_short: goldenGbos.name_short,
  channelId: goldenGbos.meeting_source.channel_id,
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
