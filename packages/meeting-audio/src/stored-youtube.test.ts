import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeToWav, SAMPLE_RATE } from "@open-minutes/codecs";
import type { YouTube } from "@open-minutes/youtube";
import { storedYoutube } from "./stored-youtube";

// A YouTube that fails, so a video missing from the store fails the test
// instead of falling back to yt-dlp.
const unreachable: YouTube = {
  site: "youtube",
  audioExtension: "webm",
  getMetadata: async () => {
    throw new Error("unexpected getMetadata call");
  },
  ensureAudioDownloaded: async () => {
    throw new Error("unexpected ensureAudioDownloaded call");
  },
};
const yt = storedYoutube(unreachable);

describe("storedYoutube", () => {
  it("gets a video's metadata from the blob store", async () => {
    expect(await yt.getMetadata("9HoIM5INxpI")).toEqual({
      id: "9HoIM5INxpI",
      permalink: "https://www.youtube.com/watch?v=9HoIM5INxpI",
      channelId: "UCOUlNInprZEjhbpVPiJOlEA",
      title: "Girdwood Board of Supervisors Regular Meeting March 23, 2026",
      description: expect.stringContaining("www.muni.org/gbos"),
      durationSecs: 9970,
      publishedAt: new Date("2026-03-24T19:05:28Z"),
      isComplete: true,
    });
  });

  it("downloads a video's WebM audio from the blob store, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stored-youtube-audio-"));
    try {
      const path = join(dir, "short.webm");
      // A 5 s video.
      const url = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
      expect(await yt.ensureAudioDownloaded(url, path)).toEqual({
        downloaded: true,
      });
      const wavPath = join(dir, "short.wav");
      await decodeToWav(path, wavPath);
      // A 44-byte header and 16-bit mono samples.
      const { size } = await stat(wavPath);
      expect((size - 44) / 2 / SAMPLE_RATE).toBeCloseTo(5, 0);
      expect(await yt.ensureAudioDownloaded(url, path)).toEqual({
        downloaded: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to YouTube for a video missing from the store", async () => {
    const fallback = storedYoutube({
      ...unreachable,
      getMetadata: async (id) => ({
        id,
        permalink: `https://www.youtube.com/watch?v=${id}`,
        channelId: "",
        title: "from YouTube",
        description: "",
        durationSecs: null,
        publishedAt: null,
        isComplete: true,
      }),
    });
    // A well-formed ID no video has.
    expect((await fallback.getMetadata("zzzzzzzzzzz")).title).toBe(
      "from YouTube",
    );
  });
});
