import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWaveAudio } from "@open-minutes/audio/wav";
import {
  metadataFromYtDlpInfo,
  youtube,
  youtubeConfigFromEnv,
  youtubeSource,
} from ".";

// Tagged `ytdlp`: from a datacenter IP it needs WARP or Tor installed.
const tags = ["ytdlp"];
const yt = youtube({});

describe("youtube", () => {
  it("gets a video's metadata", { tags }, async () => {
    expect(await yt.getMetadata("9HoIM5INxpI")).toEqual({
      id: "9HoIM5INxpI",
      permalink: "https://www.youtube.com/watch?v=9HoIM5INxpI",
      channelId: "UCOUlNInprZEjhbpVPiJOlEA",
      title: "Girdwood Board of Supervisors Regular Meeting March 23, 2026",
      description: expect.stringContaining("www.muni.org/gbos"),
      durationSecs: 9970,
      publishedAt: new Date("2026-03-24T19:05:28Z"),
    });
  });

  it("downloads a video's WebM audio", { tags }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "youtube-audio-"));
    try {
      const path = join(dir, "short.webm");
      // A 5 s video.
      const url = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
      await yt.downloadAudio(url, path);
      const wave = await ensureWaveAudio(path);
      expect(wave.sampleRate).toBe(16_000);
      expect(wave.samples.length / 16_000).toBeCloseTo(5, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("metadataFromYtDlpInfo", () => {
  it("falls back to a watch URL and nulls for missing fields", () => {
    expect(metadataFromYtDlpInfo({ id: "QUF1uLgzL-s" })).toEqual({
      id: "QUF1uLgzL-s",
      permalink: "https://www.youtube.com/watch?v=QUF1uLgzL-s",
      channelId: "",
      title: "",
      description: "",
      durationSecs: null,
      publishedAt: null,
    });
  });

  it("dates a stream by its start, not its upload", () => {
    const meta = metadataFromYtDlpInfo({
      id: "QUF1uLgzL-s",
      timestamp: 1_774_400_000,
      release_timestamp: 1_774_390_000,
    });
    expect(meta.publishedAt).toEqual(new Date(1_774_390_000_000));
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
