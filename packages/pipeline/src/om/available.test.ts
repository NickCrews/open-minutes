import { describe, expect } from "vitest";
import { loadBodies } from "@open-minutes/fixtures/test-data";
import { listAvailable } from "./available";
import {
  GOLDEN_GBOS,
  fakeYouTube,
  goldenGbosId,
  goldenTest,
  insertBody,
  insertMeeting,
  test,
  youtubeSourceUrl,
} from "./testing";

describe("listAvailable", () => {
  goldenTest(
    "returns scraped IDs minus ingested ones, newest first",
    async ({ db }) => {
      await insertMeeting(db, await goldenGbosId(db), "already-in-db");

      const lister = fakeYouTube({
        // Source order is newest-first; listAvailable must preserve it. The
        // other golden bodies' playlists have nothing new.
        listVideos: async (url) =>
          url === GOLDEN_GBOS.channelUrl
            ? [{ id: "newest" }, { id: "already-in-db" }, { id: "oldest" }]
            : [],
      });

      const ids = await listAvailable(db, { lister });
      expect(ids).toEqual(["newest", "oldest"]);
    },
  );

  goldenTest("scrapes only bodies that have a video source", async ({ db }) => {
    await insertBody(db, { name: "No Channel Town", name_short: "NCT" });

    const scraped: string[] = [];
    const lister = fakeYouTube({
      listVideos: async (url) => {
        scraped.push(url);
        return [{ id: `video-${url}` }];
      },
    });

    const ids = await listAvailable(db, { lister });
    const goldenUrls = loadBodies().flatMap((b) =>
      b.video_sources.map(youtubeSourceUrl),
    );
    expect(scraped.sort()).toEqual([...goldenUrls].sort());
    expect(ids.sort()).toEqual(goldenUrls.map((url) => `video-${url}`).sort());
  });

  // An empty database: the only body is the one with a playlist source.
  test("scrapes a playlist source at its playlist URL", async ({ db }) => {
    // Bodies that share a channel with their siblings are separated by
    // playlist, so a playlist source must not be scraped as a channel.
    await insertBody(db, {
      name: "Anchorage Assembly",
      name_short: "Assembly",
      sources: [{ kind: "playlist", youtube_id: "PL_ASSEMBLY" }],
    });

    const scraped: string[] = [];
    const lister = fakeYouTube({
      listVideos: async (url) => {
        scraped.push(url);
        return [{ id: "assembly-video" }];
      },
    });

    expect(await listAvailable(db, { lister })).toEqual(["assembly-video"]);
    expect(scraped).toEqual([
      "https://www.youtube.com/playlist?list=PL_ASSEMBLY",
    ]);
  });

  goldenTest("--body restricts the scrape to that body", async ({ db }) => {
    await insertBody(db, {
      name: "Other Town Council",
      name_short: "OT",
      sources: [{ kind: "channel", youtube_id: "UC_OTHER_CHANNEL" }],
    });

    const scraped: string[] = [];
    const lister = fakeYouTube({
      listVideos: async (url) => {
        scraped.push(url);
        return [{ id: `video-from-${url}` }];
      },
    });

    const ids = await listAvailable(db, { body: "gbos", lister });
    expect(scraped).toEqual([GOLDEN_GBOS.channelUrl]);
    expect(ids).toEqual([`video-from-${GOLDEN_GBOS.channelUrl}`]);
  });

  goldenTest("rejects an unknown body slug", async ({ db }) => {
    await expect(
      listAvailable(db, { body: "atlantis", lister: fakeYouTube() }),
    ).rejects.toThrow(/atlantis/);
  });
});
