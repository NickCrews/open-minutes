import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWaveAudio } from "@open-minutes/audio/wav";
import { youtube } from "./site-adapter";

// Tagged `ytdlp`: from a datacenter IP it needs WARP or Tor installed.
const tags = ["ytdlp"];
const yt = youtube();

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
