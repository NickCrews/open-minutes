import { describe, expect } from "vitest";
import type { ListedVideo } from "@open-minutes/core/video-lister";
import type { MeetingSource } from "@open-minutes/core/meeting-source";
import { loadBodies } from "@open-minutes/fixtures/test-data";
import { listAvailable } from "./available";
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
 * were scraped, in `scraped`, as their JSON.
 */
function fakeSources(videos: (source: MeetingSource) => ListedVideo[]) {
  const scraped: string[] = [];
  const sourceFor = (source: MeetingSource) => ({
    listVideos: async () => {
      scraped.push(JSON.stringify(source));
      return videos(source);
    },
  });
  return { scraped, sourceFor };
}

const GBOS_SOURCE: MeetingSource = {
  type: "youtube_channel",
  channel_id: GOLDEN_GBOS.channelId,
};

describe("listAvailable", () => {
  goldenTest(
    "returns scraped meetings minus ingested ones, newest first",
    async ({ db }) => {
      await insertMeeting(db, await goldenGbosId(db), "already-in-db");

      const { sourceFor } = fakeSources((source) =>
        // Source order is newest-first; listAvailable must preserve it. The
        // other golden bodies' playlists have nothing new.
        source.type === "youtube_channel" &&
        source.channel_id === GOLDEN_GBOS.channelId
          ? [{ id: "newest" }, { id: "already-in-db" }, { id: "oldest" }]
          : [],
      );

      expect(await listAvailable(db, { sourceFor })).toEqual([
        { site: "youtube", siteId: "newest", body: "gbos" },
        { site: "youtube", siteId: "oldest", body: "gbos" },
      ]);
    },
  );

  goldenTest(
    "scrapes only bodies that have a meeting source",
    async ({ db }) => {
      await insertBody(db, { name: "No Channel Town", name_short: "NCT" });

      const { scraped, sourceFor } = fakeSources((source) => [
        { id: `video-${JSON.stringify(source)}` },
      ]);

      const available = await listAvailable(db, { sourceFor });
      const goldenSources = loadBodies().flatMap((b) =>
        b.meeting_source ? [JSON.stringify(b.meeting_source)] : [],
      );
      expect(scraped.sort()).toEqual(goldenSources.sort());
      expect(available.map((m) => m.siteId).sort()).toEqual(
        goldenSources.map((s) => `video-${s}`).sort(),
      );
    },
  );

  // An empty database: the only bodies are the ones inserted here.
  test("lists each body's meetings under its site", async ({ db }) => {
    await insertBody(db, {
      name: "House Resources Committee",
      name_short: "HRES",
      source: { type: "akleg_committee", committee: "HRES" },
    });
    // The same ID on another site is a different meeting.
    await insertMeeting(
      db,
      await insertBody(db, { name: "X", name_short: "X" }),
      "HRES 2026-01-01 13:00:00",
    );

    const { sourceFor } = fakeSources(() => [
      { id: "HRES 2026-02-01 13:00:00" },
      { id: "HRES 2026-01-01 13:00:00" },
    ]);
    expect(await listAvailable(db, { sourceFor })).toEqual([
      { site: "akleg", siteId: "HRES 2026-02-01 13:00:00", body: "hres" },
      { site: "akleg", siteId: "HRES 2026-01-01 13:00:00", body: "hres" },
    ]);

    await insertMeeting(
      db,
      await insertBody(db, { name: "Y", name_short: "Y" }),
      "HRES 2026-01-01 13:00:00",
      { site: "akleg" },
    );
    expect(await listAvailable(db, { sourceFor })).toEqual([
      { site: "akleg", siteId: "HRES 2026-02-01 13:00:00", body: "hres" },
    ]);
  });

  goldenTest("--body restricts the scrape to that body", async ({ db }) => {
    await insertBody(db, {
      name: "Other Town Council",
      name_short: "OT",
      source: { type: "youtube_channel", channel_id: "UC_OTHER_CHANNEL" },
    });

    const { scraped, sourceFor } = fakeSources(() => [{ id: "video" }]);

    const available = await listAvailable(db, { body: "gbos", sourceFor });
    expect(scraped).toEqual([JSON.stringify(GBOS_SOURCE)]);
    expect(available).toEqual([
      { site: "youtube", siteId: "video", body: "gbos" },
    ]);
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
