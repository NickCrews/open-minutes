import { describe, expect } from "vitest";
import { asc } from "drizzle-orm";
import { meetingsTable, processingRunsTable } from "@open-minutes/db";
import { loadBodies } from "@open-minutes/fixtures/test-data";
import { discoverMeetings } from "./discover";
import { listPending } from "./process";
import {
  GOLDEN_GBOS,
  fakeYouTube,
  goldenGbosId,
  goldenTest as test,
  insertMeeting,
} from "./testing";

const assemblyPlaylist = loadBodies()
  .find((b) => b.id === "assembly")!
  .video_sources.find((s) => s.kind === "playlist")!.youtube_id;

describe("discoverMeetings", () => {
  test("records each new video as a pending meeting of the body that listed it", async ({
    db,
  }) => {
    await insertMeeting(db, await goldenGbosId(db), "already-in-db");
    const yt = fakeYouTube({
      videosInChannel: async () => [
        {
          id: "gbos-new",
          title: "GBOS Regular Meeting 9/15/26",
          duration: 5400,
        },
        { id: "already-in-db", title: "Old" },
      ],
      videosInPlaylist: async (playlistId) =>
        playlistId === assemblyPlaylist
          ? [
              // Upcoming stream: no duration yet. "March 4" has no year, so
              // the listing's timestamp supplies it.
              {
                id: "assembly-new",
                title: "Assembly March 4",
                timestamp: 1772668800,
              },
              // Also on the GBOS channel: the first source to list it wins.
              { id: "gbos-new", title: "GBOS Regular Meeting 9/15/26" },
            ]
          : [],
    });

    const discovered = await discoverMeetings(db, { yt });
    expect(discovered).toMatchObject([
      { youtubeId: "gbos-new", body: "gbos", date: "2026-09-15" },
      { youtubeId: "assembly-new", body: "assembly", date: "2026-03-04" },
    ]);

    const rows = await db
      .select()
      .from(meetingsTable)
      .orderBy(asc(meetingsTable.id));
    expect(rows.map((m) => [m.youtube_id, m.title, m.duration_secs])).toEqual([
      ["already-in-db", "", null],
      ["gbos-new", "GBOS Regular Meeting 9/15/26", "01:30:00"],
      ["assembly-new", "Assembly March 4", null],
    ]);
    // Nothing is processed: no runs, and every new meeting is pending.
    expect(await db.select().from(processingRunsTable)).toEqual([]);
    expect((await listPending(db)).map((m) => m.youtubeId)).toEqual([
      "gbos-new",
      "assembly-new",
      "already-in-db",
    ]);
  });

  test("records nothing twice", async ({ db }) => {
    const yt = fakeYouTube({
      videosInChannel: async () => [{ id: "v1", title: "A meeting" }],
      videosInPlaylist: async () => [],
    });
    expect(await discoverMeetings(db, { yt })).toHaveLength(1);
    expect(await discoverMeetings(db, { yt })).toEqual([]);
    expect(await db.select().from(meetingsTable)).toHaveLength(1);
  });

  test("--body restricts the scrape to that body", async ({ db }) => {
    const scraped: string[] = [];
    const yt = fakeYouTube({
      videosInChannel: async (channelId) => {
        scraped.push(channelId);
        return [{ id: "v1" }];
      },
    });
    await discoverMeetings(db, { yt, body: "gbos" });
    expect(scraped).toEqual([GOLDEN_GBOS.channelId]);
  });
});
