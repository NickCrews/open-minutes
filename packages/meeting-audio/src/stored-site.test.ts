import { describe, expect, it } from "vite-plus/test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureWaveForm } from "@open-minutes/codecs";
import { fileURLToPath } from "node:url";
import { memoryBlobStore } from "@open-minutes/blobstore/testing";
import type { SiteAdapter } from "@open-minutes/core/site";
import { meetingId } from "@open-minutes/akleg";
import { videoId } from "@open-minutes/youtube";
import { storedSite } from "./stored-site";

/**
 * An adapter for `site` that fails, so a recording missing from the store
 * fails the test instead of reaching the site.
 */
function unreachable(site: "youtube" | "akleg"): SiteAdapter {
  return {
    site,
    audioExtension: site === "youtube" ? "webm" : "mp3",
    recordingId: site === "youtube" ? videoId : meetingId,
    getMetadata: async () => {
      throw new Error("unexpected getMetadata call");
    },
    downloadAudio: async () => {
      throw new Error("unexpected downloadAudio call");
    },
  };
}

/** `adapter`, with `audio` as every recording's audio. */
function serving(adapter: SiteAdapter, audio: string): SiteAdapter {
  return {
    ...adapter,
    getMetadata: async (id) => ({
      id,
      permalink: `https://example.com/${id}`,
      channelId: "UC123",
      title: `from ${adapter.site}`,
      description: "",
      durationSecs: 2,
      publishedAt: new Date("2026-03-24T19:05:28Z"),
    }),
    downloadAudio: async (_id, path) => copyFile(audio, path),
  };
}

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../codecs/src/fixtures/${name}`, import.meta.url));

describe("storedSite", () => {
  it("downloads a YouTube video's WebM audio from the blob store, replacing what's there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stored-site-audio-"));
    try {
      const path = join(dir, "short.webm");
      // A 5 s video.
      const url = "https://www.youtube.com/watch?v=QUF1uLgzL-s";
      await writeFile(path, "stale");
      await storedSite(unreachable("youtube")).downloadAudio(url, path);
      const wave = await ensureWaveForm(path);
      expect(wave.samples.length / wave.sampleRate).toBeCloseTo(5, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe.each([
    {
      site: "youtube" as const,
      ref: "https://youtu.be/QUF1uLgzL-s",
      id: "QUF1uLgzL-s",
      prefix: "youtube/QUF1uLgzL-s",
      audioName: "speech.webm",
      contentType: "audio/webm",
      audio: fixture("tones.webm"),
    },
    {
      site: "akleg" as const,
      ref: "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
      id: "HRES 2018-09-10 14:00:00",
      prefix: "akleg/HRES_2018-09-10_140000",
      audioName: "audio.mp3",
      contentType: "audio/mpeg",
      audio: fixture("tones.mp3"),
    },
  ])(
    "for a $site recording missing from the store",
    ({ site, ref, id, prefix, audioName, contentType, audio }) => {
      const fromSite = serving(unreachable(site), audio);

      it("gets the metadata from the site and stores it", async () => {
        const { store, writer, blobs } = memoryBlobStore();
        const metadata = await storedSite(fromSite, {
          store,
          writer,
        }).getMetadata(ref);
        expect(metadata).toMatchObject({ id, title: `from ${site}` });
        const stored = blobs.get(`${prefix}/metadata.json`)!;
        expect(stored.contentType).toBe("application/json");
        expect(JSON.parse(new TextDecoder().decode(stored.body))).toEqual({
          ...metadata,
          publishedAt: "2026-03-24T19:05:28.000Z",
        });
        // The next one reads it from the store.
        expect(
          await storedSite(unreachable(site), { store }).getMetadata(id),
        ).toEqual(metadata);
      });

      it("gets the audio from the site and stores it", async () => {
        const dir = await mkdtemp(join(tmpdir(), "stored-site-miss-"));
        try {
          const { store, writer, blobs } = memoryBlobStore();
          const path = join(dir, audioName);
          await storedSite(fromSite, { store, writer }).downloadAudio(
            ref,
            path,
          );
          const stored = blobs.get(`${prefix}/${audioName}`)!;
          expect(stored.contentType).toBe(contentType);
          expect(new Uint8Array(readFileSync(path))).toEqual(
            new Uint8Array(readFileSync(audio)),
          );
          expect(stored.body).toEqual(new Uint8Array(readFileSync(audio)));

          // The next one reads it from the store.
          const again = join(dir, `again-${audioName}`);
          await storedSite(unreachable(site), { store }).downloadAudio(
            id,
            again,
          );
          expect(readFileSync(again)).toEqual(readFileSync(path));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    },
  );
});
