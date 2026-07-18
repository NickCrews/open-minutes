import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DB, meetingsTable } from "@open-minutes/core/db";
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
    fetchVideoMetadata: async () => {
      throw new Error("unexpected fetchVideoMetadata call");
    },
    downloadVideoAudio: async () => {
      throw new Error("unexpected downloadVideoAudio call");
    },
    ...overrides,
  };
}

/** Insert a bare meeting row (as if previously ingested). Returns its id. */
export async function insertMeeting(
  db: DB,
  municipalityId: number,
  youtubeId: string,
  startTime?: Date,
): Promise<number> {
  const [row] = await db
    .insert(meetingsTable)
    .values({
      municipality_id: municipalityId,
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
