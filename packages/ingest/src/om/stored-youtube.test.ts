import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWaveAudio } from "@open-minutes/audio/wav";
import { BLOB_STORE_PUBLIC_URL } from "@open-minutes/blobstore";
import type { YouTube } from "@open-minutes/youtube";
import { blobStoreConfigFromEnv, storedYoutube } from "./stored-youtube";

// A YouTube that fails, so a video missing from the store fails the test
// instead of falling back to yt-dlp.
const unreachable: YouTube = {
  audioExtension: "webm",
  getMetadata: async () => {
    throw new Error("unexpected getMetadata call");
  },
  ensureAudioDownloaded: async () => {
    throw new Error("unexpected ensureAudioDownloaded call");
  },
};
const yt = storedYoutube(unreachable, { url: BLOB_STORE_PUBLIC_URL });

describe("storedYoutube", () => {
  it("gets a video's metadata from the blob store", async () => {
    expect(await yt.getMetadata("9HoIM5INxpI")).toEqual({
      id: "9HoIM5INxpI",
      channelId: "UCOUlNInprZEjhbpVPiJOlEA",
      title: "Girdwood Board of Supervisors Regular Meeting March 23, 2026",
      description: expect.stringContaining("www.muni.org/gbos"),
      durationSecs: 9970,
      uploadDate: "2026-03-24",
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

  it("falls back to YouTube for a video missing from the store", async () => {
    const fallback = storedYoutube(
      {
        ...unreachable,
        getMetadata: async (id) => ({
          id,
          channelId: "",
          title: "from YouTube",
          description: "",
          durationSecs: null,
          uploadDate: null,
        }),
      },
      { url: BLOB_STORE_PUBLIC_URL },
    );
    // A well-formed ID no video has.
    expect((await fallback.getMetadata("zzzzzzzzzzz")).title).toBe(
      "from YouTube",
    );
  });
});

describe("blobStoreConfigFromEnv", () => {
  it("is null without BLOB_STORE_PUBLIC_URL", () => {
    expect(
      blobStoreConfigFromEnv({ YOUTUBE_AUDIO_DISPATCH_TOKEN: "t" }),
    ).toBeNull();
  });

  it("reads the URL and dispatch token", () => {
    expect(
      blobStoreConfigFromEnv({
        BLOB_STORE_PUBLIC_URL: "https://example.com",
        YOUTUBE_AUDIO_DISPATCH_TOKEN: "t",
      }),
    ).toEqual({ url: "https://example.com", dispatchToken: "t" });
  });
});
