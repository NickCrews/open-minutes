import { describe, expect, it } from "vite-plus/test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureWaveForm } from "@open-minutes/codecs";
import { fileURLToPath } from "node:url";
import type {
  BlobFile,
  BlobStore,
  BlobStoreWriter,
} from "@open-minutes/blobstore";
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

  describe("for a video missing from the store", () => {
    // 1.5 s of Opus, standing in for youtube()'s audio.
    const tones = fileURLToPath(
      new URL("../../codecs/src/fixtures/tones.webm", import.meta.url),
    );
    const fromYoutube: YouTube = {
      ...unreachable,
      getMetadata: async (id) => ({
        id,
        permalink: `https://www.youtube.com/watch?v=${id}`,
        channelId: "UC123",
        title: "from YouTube",
        description: "",
        durationSecs: 2,
        publishedAt: new Date("2026-03-24T19:05:28Z"),
      }),
      downloadAudio: async (_id, path) => copyFile(tones, path),
    };

    /** An empty blob store in memory, and a writer to it. */
    const memoryStore = () => {
      const blobs = new Map<
        string,
        { body: Uint8Array; contentType: string }
      >();
      const file = (key: string): BlobFile => ({
        key,
        url: `memory:${key}`,
        get: async () => blobs.get(key)?.body ?? null,
      });
      const store: BlobStore = {
        youtube: (id) => ({
          metadataJson: file(`youtube/${id}/metadata.json`),
          speechWebm: file(`youtube/${id}/speech.webm`),
        }),
        duckdbExport: file("exports/open-minutes.duckdb"),
      };
      const writer: BlobStoreWriter = {
        put: async (file, body, contentType) => {
          blobs.set(file.key, { body, contentType });
        },
      };
      return { store, writer, blobs };
    };

    it("gets the metadata from YouTube and stores it", async () => {
      const { store, writer, blobs } = memoryStore();
      const metadata = await storedYoutube(fromYoutube, {
        store,
        writer,
      }).getMetadata("QUF1uLgzL-s");
      expect(metadata.title).toBe("from YouTube");
      const stored = blobs.get("youtube/QUF1uLgzL-s/metadata.json")!;
      expect(stored.contentType).toBe("application/json");
      expect(JSON.parse(new TextDecoder().decode(stored.body))).toEqual({
        ...metadata,
        publishedAt: "2026-03-24T19:05:28.000Z",
      });
      // The next one reads it from the store.
      expect(
        await storedYoutube(unreachable, { store }).getMetadata("QUF1uLgzL-s"),
      ).toEqual(metadata);
    });

    it("gets the audio from YouTube and stores it", async () => {
      const dir = await mkdtemp(join(tmpdir(), "stored-youtube-miss-"));
      try {
        const { store, writer, blobs } = memoryStore();
        const path = join(dir, "audio.webm");
        await storedYoutube(fromYoutube, { store, writer }).downloadAudio(
          "QUF1uLgzL-s",
          path,
        );
        const stored = blobs.get("youtube/QUF1uLgzL-s/speech.webm")!;
        expect(stored.contentType).toBe("audio/webm");
        expect(new Uint8Array(readFileSync(path))).toEqual(
          new Uint8Array(readFileSync(tones)),
        );
        expect(stored.body).toEqual(new Uint8Array(readFileSync(tones)));

        // The next one reads it from the store.
        const again = join(dir, "again.webm");
        await storedYoutube(unreachable, { store }).downloadAudio(
          "QUF1uLgzL-s",
          again,
        );
        expect(readFileSync(again)).toEqual(readFileSync(path));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
