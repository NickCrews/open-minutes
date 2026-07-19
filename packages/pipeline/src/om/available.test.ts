import { describe, expect } from "vitest";
import {
  GBOS_YOUTUBE_CHANNEL_ID,
  getOrCreateGbos,
} from "@open-minutes/core/bodies";
import { listAvailable } from "./available";
import { fakeYouTube, insertBody, insertMeeting, test } from "./testing";

describe("listAvailable", () => {
  test("returns scraped IDs minus ingested ones, newest first", async ({
    db,
  }) => {
    const gbos = await getOrCreateGbos(db);
    await insertMeeting(db, gbos.id, "already-in-db");

    const yt = fakeYouTube({
      // Channel order is newest-first; listAvailable must preserve it.
      videosInChannel: async () => [
        { id: "newest" },
        { id: "already-in-db" },
        { id: "oldest" },
      ],
    });

    const ids = await listAvailable(db, { yt });
    expect(ids).toEqual(["newest", "oldest"]);
  });

  test("scrapes only bodies that have a video source", async ({ db }) => {
    await getOrCreateGbos(db);
    await insertBody(db, { name: "No Channel Town", name_short: "NCT" });

    const scraped: string[] = [];
    const yt = fakeYouTube({
      videosInChannel: async (channelId) => {
        scraped.push(channelId);
        return [{ id: "v1" }];
      },
    });

    const ids = await listAvailable(db, { yt });
    expect(ids).toEqual(["v1"]);
    expect(scraped).toEqual([GBOS_YOUTUBE_CHANNEL_ID]);
  });

  test("scrapes a playlist source via the playlist API", async ({ db }) => {
    // Bodies that share a channel with their siblings are separated by
    // playlist, so a playlist source must not be scraped as a channel.
    await insertBody(db, {
      name: "Anchorage Assembly",
      name_short: "Assembly",
      sources: [{ kind: "playlist", youtube_id: "PL_ASSEMBLY" }],
    });

    const yt = fakeYouTube({
      videosInPlaylist: async (playlistId) => [{ id: `video-${playlistId}` }],
    });

    expect(await listAvailable(db, { yt })).toEqual(["video-PL_ASSEMBLY"]);
  });

  test("--body restricts the scrape to that body", async ({ db }) => {
    await getOrCreateGbos(db);
    await insertBody(db, {
      name: "Other Town Council",
      name_short: "OT",
      sources: [{ kind: "channel", youtube_id: "UC_OTHER_CHANNEL" }],
    });

    const scraped: string[] = [];
    const yt = fakeYouTube({
      videosInChannel: async (channelId) => {
        scraped.push(channelId);
        return [{ id: `video-from-${channelId}` }];
      },
    });

    const ids = await listAvailable(db, { body: "gbos", yt });
    expect(scraped).toEqual([GBOS_YOUTUBE_CHANNEL_ID]);
    expect(ids).toEqual([`video-from-${GBOS_YOUTUBE_CHANNEL_ID}`]);
  });

  test("rejects an unknown body slug", async ({ db }) => {
    await getOrCreateGbos(db);
    await expect(
      listAvailable(db, { body: "atlantis", yt: fakeYouTube() }),
    ).rejects.toThrow(/atlantis/);
  });
});
