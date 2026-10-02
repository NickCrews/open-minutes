import { describe, it, expect } from "vitest";
import { youtubeFromEnv } from ".";
import { rmSync, existsSync } from "node:fs";

describe("YouTube Module", () => {
  const yt = youtubeFromEnv();

  // A channel expands into one nested playlist per tab ("Videos", "Live", ...),
  // so these assert we walk down to the videos rather than handing back the
  // tabs. MOA is the regression case: it has both tabs, and returning them
  // unflattened made `om available` report exactly 2 channel-ID "videos".
  const channels = [
    { name: "GBOS", id: "UCOUlNInprZEjhbpVPiJOlEA", minVideos: 10 },
    { name: "MOA", id: "UCZDEuWj4IxdlwBhqrk62_XA", minVideos: 1000 },
  ];

  it.each(channels)(
    "should fetch videos in the $name channel",
    // MOA's flat playlist is thousands of entries and several MB of JSON, so
    // scraping it takes about a minute.
    { tags: ["slow"] },
    async ({ id, minVideos }) => {
      const videos = await yt.videosInChannel(id);
      expect(videos).toBeInstanceOf(Array);
      expect(videos.length).toBeGreaterThan(minVideos);
      expect(videos[0]).toHaveProperty("id");
      expect(videos[0]).toHaveProperty("title");
      for (const video of videos) {
        expect(video.id).not.toBe(id);
        expect(video.entries).toBeUndefined();
      }
      expect(new Set(videos.map((v) => v.id)).size).toBe(videos.length);
    },
  );

  // YouTube makes datacenter IPs (like GitHub's runners) "sign in to confirm
  // you're not a bot", so in CI this reads from the object store
  // (OBJECT_STORE_PUBLIC_URL; see fetchStored). A run without it skips.
  it.skipIf(process.env.CI && !process.env.OBJECT_STORE_PUBLIC_URL)(
    "should download video audio",
    async () => {
      // A 5 sec video for testing
      const sampleVideo = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
      const path = new URL("./test_audio/short.wav", import.meta.url).pathname;
      // Clean up any existing file before test
      rmSync(path, { force: true });
      expect(existsSync(path)).toBe(false);
      let result = await yt.ensureAudioDownloaded(sampleVideo, path, {
        overwrite: true,
      });
      expect(existsSync(path)).toBe(true);
      expect(result).toHaveProperty("downloaded", true);
      result = await yt.ensureAudioDownloaded(sampleVideo, path);
      expect(result).toHaveProperty("downloaded", false);
    },
    // Long enough for a fetch-youtube-audio run, when the store doesn't have it yet.
    10 * 60_000,
  );
});
