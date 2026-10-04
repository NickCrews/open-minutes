import { describe, expect } from "vitest";
import type { ListedVideo } from "@open-minutes/core/video-lister";
import { loadBodies } from "@open-minutes/fixtures/test-data";
import { type VideoSourceRow, listAvailable } from "./available";
import {
  GOLDEN_GBOS,
  goldenGbosId,
  goldenTest,
  insertBody,
  insertMeeting,
  test,
} from "./testing";

/**
 * A `sourceFor` whose sources list `videos(source)` and record which sources
 * were scraped, in `scraped`, as "kind:youtube_id".
 */
function fakeSources(videos: (source: VideoSourceRow) => ListedVideo[]) {
  const scraped: string[] = [];
  const sourceFor = (source: VideoSourceRow) => ({
    listVideos: async () => {
      scraped.push(`${source.kind}:${source.youtube_id}`);
      return videos(source);
    },
  });
  return { scraped, sourceFor };
}

describe("listAvailable", () => {
  goldenTest(
    "returns scraped IDs minus ingested ones, newest first",
    async ({ db }) => {
      await insertMeeting(db, await goldenGbosId(db), "already-in-db");

      const { sourceFor } = fakeSources((source) =>
        // Source order is newest-first; listAvailable must preserve it. The
        // other golden bodies' playlists have nothing new.
        source.youtube_id === GOLDEN_GBOS.channelId
          ? [{ id: "newest" }, { id: "already-in-db" }, { id: "oldest" }]
          : [],
      );

      const ids = await listAvailable(db, { sourceFor });
      expect(ids).toEqual(["newest", "oldest"]);
    },
  );

  goldenTest("scrapes only bodies that have a video source", async ({ db }) => {
    await insertBody(db, { name: "No Channel Town", name_short: "NCT" });

    const { scraped, sourceFor } = fakeSources((source) => [
      { id: `video-${source.youtube_id}` },
    ]);

    const ids = await listAvailable(db, { sourceFor });
    const goldenSources = loadBodies().flatMap((b) => b.video_sources);
    expect(scraped.sort()).toEqual(
      goldenSources.map((s) => `${s.kind}:${s.youtube_id}`).sort(),
    );
    expect(ids.sort()).toEqual(
      goldenSources.map((s) => `video-${s.youtube_id}`).sort(),
    );
  });

  // An empty database: the only body is the one with a playlist source.
  test("hands a playlist source over as a playlist", async ({ db }) => {
    // Bodies that share a channel with their siblings are separated by
    // playlist, so a playlist source must not be scraped as a channel.
    await insertBody(db, {
      name: "Anchorage Assembly",
      name_short: "Assembly",
      sources: [{ kind: "playlist", youtube_id: "PL_ASSEMBLY" }],
    });

    const { scraped, sourceFor } = fakeSources(() => [
      { id: "assembly-video" },
    ]);

    expect(await listAvailable(db, { sourceFor })).toEqual(["assembly-video"]);
    expect(scraped).toEqual(["playlist:PL_ASSEMBLY"]);
  });

  goldenTest("--body restricts the scrape to that body", async ({ db }) => {
    await insertBody(db, {
      name: "Other Town Council",
      name_short: "OT",
      sources: [{ kind: "channel", youtube_id: "UC_OTHER_CHANNEL" }],
    });

    const { scraped, sourceFor } = fakeSources((source) => [
      { id: `video-from-${source.youtube_id}` },
    ]);

    const ids = await listAvailable(db, { body: "gbos", sourceFor });
    expect(scraped).toEqual([`channel:${GOLDEN_GBOS.channelId}`]);
    expect(ids).toEqual([`video-from-${GOLDEN_GBOS.channelId}`]);
  });

  goldenTest("rejects an unknown body slug", async ({ db }) => {
    const { sourceFor } = fakeSources(() => {
      throw new Error("unexpected listVideos call");
    });
    await expect(
      listAvailable(db, { body: "atlantis", sourceFor }),
    ).rejects.toThrow(/atlantis/);
  });
});
