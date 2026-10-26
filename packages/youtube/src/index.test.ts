import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWaveAudio } from "@open-minutes/audio/wav";
import { youtube, youtubeConfigFromEnv, youtubeSource } from ".";

// Tagged `ytdlp`: from a datacenter IP it needs WARP or Tor installed.
const tags = ["ytdlp"];
const yt = youtube({});

describe("youtube", () => {
  it("gets a video's metadata", { tags }, async () => {
    expect(await yt.getMetadata("9HoIM5INxpI")).toEqual({
      id: "9HoIM5INxpI",
      channelId: "UCOUlNInprZEjhbpVPiJOlEA",
      title: "Girdwood Board of Supervisors Regular Meeting March 23, 2026",
      description: expect.stringContaining("www.muni.org/gbos"),
      durationSecs: 9970,
      uploadDate: "2026-03-24",
    });
  });

  it("downloads a video's WebM audio, once", { tags }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "youtube-audio-"));
    try {
      const path = join(dir, "short.webm");
      // A 5 s video.
      const url = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
      expect(await yt.ensureAudioDownloaded(url, path)).toEqual({
        downloaded: true,
      });
      const wave = await ensureWaveAudio(path);
      expect(wave.sampleRate).toBe(16_000);
      expect(wave.samples.length / 16_000).toBeCloseTo(5, 0);
      expect(await yt.ensureAudioDownloaded(url, path)).toEqual({
        downloaded: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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

describe("youtubeConfigFromEnv", () => {
  it("reads YOUTUBE_EGRESS as a comma-separated list of routes", () => {
    expect(
      youtubeConfigFromEnv({
        YOUTUBE_EGRESS: " warp, ,socks5://127.0.0.1:9050,",
      }).routes,
    ).toEqual(["warp", "socks5://127.0.0.1:9050"]);
  });

  it.each([{}, { YOUTUBE_EGRESS: "" }, { YOUTUBE_EGRESS: " , " }])(
    "leaves the routes to @open-minutes/ytdlp for %j",
    (env) => {
      expect(youtubeConfigFromEnv(env).routes).toBeUndefined();
    },
  );
});
