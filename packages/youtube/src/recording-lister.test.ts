import { describe, expect, it } from "vite-plus/test";
import { youtubeSource } from "./recording-lister";

describe("youtubeSource", () => {
  // A channel expands into one nested playlist per tab ("Videos", "Live", ...),
  // so these assert we walk down to the videos rather than handing back the
  // tabs. MOA is the regression case: it has both tabs, and returning them
  // unflattened listed exactly 2 channel-ID "videos".
  it.each([
    { name: "GBOS", id: "UCOUlNInprZEjhbpVPiJOlEA", minVideos: 10 },
    { name: "MOA", id: "UCZDEuWj4IxdlwBhqrk62_XA", minVideos: 1000 },
  ])(
    "lists the videos in the $name channel",
    // MOA's flat playlist is thousands of entries and several MB of JSON, so
    // scraping it takes about a minute.
    { tags: ["ytdlp"] },
    async ({ id, minVideos }) => {
      const videos = await youtubeSource({
        kind: "channel",
        id,
      }).listRecordings();
      expect(videos.length).toBeGreaterThan(minVideos);
      expect(videos).toContainEqual({
        id: expect.any(String),
        title: expect.any(String),
      });
      expect(videos.map((v) => v.id)).not.toContain(id);
      expect(new Set(videos.map((v) => v.id)).size).toBe(videos.length);
    },
  );
});
