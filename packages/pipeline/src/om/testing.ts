import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DB,
  bodiesTable,
  jurisdictionsTable,
  meetingsTable,
  videoSourcesTable,
} from "@open-minutes/core/db";
import type { YouTube } from "@open-minutes/core/youtube";
import { test as dbTest } from "@open-minutes/core/db/testing/vitest";

// Test helpers for the om API tests (not collected by vitest — no .test suffix).

/**
 * A {@link YouTube} boundary where every call throws unless overridden, so a
 * test both avoids the network and proves which calls were (not) made.
 */
export function fakeYouTube(overrides: Partial<YouTube> = {}): YouTube {
  return {
    videosInChannel: async () => {
      throw new Error("unexpected videosInChannel call");
    },
    videosInPlaylist: async () => {
      throw new Error("unexpected videosInPlaylist call");
    },
    fetchVideoMetadata: async () => {
      throw new Error("unexpected fetchVideoMetadata call");
    },
    downloadVideoAudio: async () => {
      throw new Error("unexpected downloadVideoAudio call");
    },
    ...overrides,
  };
}

/**
 * Insert a body, with its video sources, under a throwaway jurisdiction of the
 * same name. Returns its id. For tests that need a second body alongside the
 * GBOS one from `getOrCreateGbos`.
 */
export async function insertBody(
  db: DB,
  body: {
    name: string;
    name_short: string;
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
  startTime?: Date,
): Promise<number> {
  const [row] = await db
    .insert(meetingsTable)
    .values({
      body_id: bodyId,
      youtube_id: youtubeId,
      start_time: startTime,
    })
    .returning({ id: meetingsTable.id });
  return row!.id;
}

/** The db fixture plus a disposable work-directory root for ingest tests. */
export const test = dbTest.extend<{ workRoot: string }>({
  // eslint-disable-next-line no-empty-pattern
  workRoot: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), "om-work-"));
    try {
      await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});
