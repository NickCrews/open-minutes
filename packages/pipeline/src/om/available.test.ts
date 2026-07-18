import { describe, expect } from "vitest";
import { municipalitiesTable } from "@open-minutes/core/db";
import { getOrCreateGbos } from "@open-minutes/core/munis";
import { listAvailable } from "./available";
import { fakeYouTube, insertMeeting, test } from "./testing";

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

  test("scrapes only municipalities with a YouTube channel", async ({ db }) => {
    await getOrCreateGbos(db);
    await db
      .insert(municipalitiesTable)
      .values({ name: "No Channel Town", name_short: "NCT" });

    const scraped: string[] = [];
    const yt = fakeYouTube({
      videosInChannel: async (channelId) => {
        scraped.push(channelId);
        return [{ id: "v1" }];
      },
    });

    const ids = await listAvailable(db, { yt });
    expect(ids).toEqual(["v1"]);
    expect(scraped).toHaveLength(1);
  });

  test("--muni restricts the scrape to that municipality", async ({ db }) => {
    const gbos = await getOrCreateGbos(db);
    await db.insert(municipalitiesTable).values({
      name: "Other Town",
      name_short: "OT",
      youtube_channel_id: "UC_OTHER_CHANNEL",
    });

    const scraped: string[] = [];
    const yt = fakeYouTube({
      videosInChannel: async (channelId) => {
        scraped.push(channelId);
        return [{ id: `video-from-${channelId}` }];
      },
    });

    const ids = await listAvailable(db, { muni: "gbos", yt });
    expect(scraped).toEqual([gbos.youtube_channel_id]);
    expect(ids).toEqual([`video-from-${gbos.youtube_channel_id}`]);
  });

  test("rejects an unknown municipality slug", async ({ db }) => {
    await getOrCreateGbos(db);
    await expect(
      listAvailable(db, { muni: "atlantis", yt: fakeYouTube() }),
    ).rejects.toThrow(/atlantis/);
  });
});
