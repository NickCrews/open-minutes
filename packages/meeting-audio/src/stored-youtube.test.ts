import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWaveForm } from "@open-minutes/codecs";
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
  downloadAudio: async () => {
    throw new Error("unexpected downloadAudio call");
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
    });
  });

  it("downloads a video's WebM audio from the blob store, replacing what's there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stored-youtube-audio-"));
    try {
      const path = join(dir, "short.webm");
      // A 5 s video.
      const url = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
      await writeFile(path, "stale");
      await yt.downloadAudio(url, path);
      const wave = await ensureWaveForm(path);
      expect(wave.samples.length / wave.sampleRate).toBeCloseTo(5, 0);
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
      }),
    });
    // A well-formed ID no video has.
    expect((await fallback.getMetadata("zzzzzzzzzzz")).title).toBe(
      "from YouTube",
    );
  });
});
