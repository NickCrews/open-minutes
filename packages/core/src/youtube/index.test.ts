import { describe, it, expect } from "vitest";
import { videosInChannel, downloadVideoAudio } from ".";
import { rmSync, existsSync } from "node:fs";

describe("YouTube Module", () => {
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
      const videos = await videosInChannel(id);
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

  it("should download video audio", async () => {
    // A 5 sec video for testing
    const sampleVideo = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
    const path = new URL("./test_audio/short.wav", import.meta.url).pathname;
    // Clean up any existing file before test
    rmSync(path, { force: true });
    expect(existsSync(path)).toBe(false);
    let result = await downloadVideoAudio(sampleVideo, path, "overwrite");
    expect(existsSync(path)).toBe(true);
    expect(result).toHaveProperty("downloaded", true);
    result = await downloadVideoAudio(sampleVideo, path, "skip");
    expect(result).toHaveProperty("downloaded", false);
  }, 10_000);
});
