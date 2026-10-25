import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWave } from "@open-minutes/audio/wav";
import { type YouTube, youtube, youtubeConfigFromEnv, youtubeSource } from ".";
import { OBJECT_STORE_PUBLIC_URL } from "./store";

// Each source is tested for real, with the same expectations: the object
// store (works from anywhere, so it runs in the default suite) and yt-dlp
// (tagged `ytdlp`; from a datacenter IP it needs WARP or Tor installed).
const sources: { name: string; yt: YouTube; tags: string[] }[] = [
  {
    name: "the object store",
    // No routes, so a video missing from the store fails instead of falling
    // back to yt-dlp.
    yt: youtube({ objectStoreUrl: OBJECT_STORE_PUBLIC_URL, routes: [] }),
    tags: [],
  },
  {
    name: "yt-dlp",
    yt: youtube({}),
    tags: ["ytdlp"],
  },
];

describe.each(sources)("from $name", ({ yt, tags }) => {
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

  it("downloads a video's audio as 16 kHz WAV, once", { tags }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "youtube-audio-"));
    try {
      const path = join(dir, "short.wav");
      // A 5 s video.
      const url = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
      expect(await yt.ensureAudioDownloaded(url, path)).toEqual({
        downloaded: true,
      });
      const wave = readWave(path);
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
  // unflattened made `om available` report exactly 2 channel-ID "videos".
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
