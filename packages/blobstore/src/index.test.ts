import { describe, expect, it } from "vite-plus/test";
import { blobStore, blobStoreWriterFromEnv } from "./index";

const keys = {
  BLOB_STORE_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  BLOB_STORE_BUCKET: "bucket",
  BLOB_STORE_ACCESS_KEY_ID: "id",
  BLOB_STORE_SECRET_ACCESS_KEY: "secret",
};

describe("blobStoreWriterFromEnv", () => {
  it("returns null when none of the keys are set", () => {
    expect(blobStoreWriterFromEnv({})).toBeNull();
  });

  it("returns a writer when all the keys are set", () => {
    expect(blobStoreWriterFromEnv(keys)).not.toBeNull();
  });

  it("throws naming the keys that are missing when only some are set", () => {
    const { BLOB_STORE_BUCKET: _, ...partial } = keys;
    expect(() => blobStoreWriterFromEnv(partial)).toThrow(
      /missing BLOB_STORE_BUCKET\./,
    );
  });
});

describe("blobStore", () => {
  it("gives each file the content type it's stored with", () => {
    const store = blobStore("https://blobs.example/");
    const video = store.recording("youtube", "9HoIM5INxpI");
    expect(video.audio).toMatchObject({
      url: "https://blobs.example/youtube/9HoIM5INxpI/speech.webm",
      contentType: "audio/webm",
    });
    expect(video.metadataJson.contentType).toBe("application/json");
  });

  it("keys an akleg.gov meeting by its ID without spaces or colons", () => {
    const store = blobStore("https://blobs.example/");
    const meeting = store.recording("akleg", "SL&C 2018-09-10 14:00:00");
    expect(meeting.audio).toMatchObject({
      key: "akleg/SL&C_2018-09-10_140000/audio.mp3",
      url: "https://blobs.example/akleg/SL%26C_2018-09-10_140000/audio.mp3",
      contentType: "audio/mpeg",
    });
  });

  it.each(["", ".", "..", "a/b"])("refuses %j as a recording ID", (id) => {
    const store = blobStore("https://blobs.example/");
    expect(() => store.recording("youtube", id)).toThrow(
      "Not a youtube recording ID",
    );
  });
});
