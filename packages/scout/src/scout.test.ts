import { describe, expect, vi } from "vite-plus/test";
import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import {
  type DB,
  bodiesTable,
  jurisdictionsTable,
  recordingBodiesTable,
  recordingsTable,
} from "@open-minutes/db";
import { test } from "@open-minutes/db/testing/vitest";
import { memoryBlobStore } from "@open-minutes/blobstore/testing";
import type { MeetingSource } from "@open-minutes/core/meeting-source";
import type { RecordingLister, SiteAdapter } from "@open-minutes/core/site";
import { MAX_AUDIO_FAILURES, type ScoutOptions, scout } from "./scout";

/** A recording on the fake YouTube. */
interface FakeVideo {
  durationSecs?: number | null;
  publishedAt?: Date | null;
  /** Its audio download fails with this. */
  audioError?: string;
}

/**
 * A fake YouTube whose playlists list `playlists`' videos, a memory blob
 * store, and a quiet log, with `run` scouting them.
 */
function world(db: DB) {
  const playlists = new Map<string, string[]>();
  const videos = new Map<string, FakeVideo>();
  const calls = { metadata: [] as string[], audio: [] as string[] };
  const youtube: SiteAdapter = {
    site: "youtube",
    recordingId: (id) => id,
    permalink: (id) => `https://www.youtube.com/watch?v=${id}`,
    async getMetadata(id) {
      calls.metadata.push(id);
      const video = videos.get(id);
      if (!video) throw new Error(`Video ${id} is private`);
      return {
        id,
        permalink: `https://www.youtube.com/watch?v=${id}`,
        channelId: "UC1",
        title: `Video ${id}`,
        description: `About ${id}`,
        durationSecs:
          video.durationSecs === undefined ? 60 : video.durationSecs,
        publishedAt: video.publishedAt ?? null,
      };
    },
    async downloadAudio(id, path) {
      calls.audio.push(id);
      const error = videos.get(id)?.audioError;
      if (error) throw new Error(error);
      await writeFile(path, `audio of ${id}`);
    },
  };
  const akleg: SiteAdapter = {
    site: "akleg",
    recordingId: (id) => id,
    permalink: (id) => `https://www.akleg.gov/${id}`,
    getMetadata: async () => {
      throw new Error("unexpected akleg.gov call");
    },
    downloadAudio: async () => {
      throw new Error("unexpected akleg.gov call");
    },
  };
  const listerFor = (source: MeetingSource): RecordingLister => ({
    async listRecordings() {
      if (source.type !== "youtube_playlist") throw new Error("not a playlist");
      const ids = playlists.get(source.playlist_id);
      if (!ids) throw new Error(`Playlist ${source.playlist_id} is gone`);
      return ids.map((id) => ({ id }));
    },
  });
  const { store, writer, blobs } = memoryBlobStore();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = (options: Partial<ScoutOptions> = {}) =>
    scout({
      db,
      sites: { youtube, akleg },
      listerFor,
      store,
      writer,
      log,
      ...options,
    });
  return { playlists, videos, calls, blobs, log, run };
}

/** Bodies gbos and luc, each with a playlist, and quiet, with none. */
async function insertBodies(db: DB) {
  const [j] = await db
    .insert(jurisdictionsTable)
    .values({ slug: "moa", name: "Anchorage" })
    .returning({ id: jurisdictionsTable.id });
  const body = (slug: string, meeting_source: MeetingSource | null) => ({
    slug,
    jurisdiction_id: j!.id,
    timezone: "America/Anchorage",
    meeting_source,
  });
  await db
    .insert(bodiesTable)
    .values([
      body("gbos", { type: "youtube_playlist", playlist_id: "PLgbos" }),
      body("luc", { type: "youtube_playlist", playlist_id: "PLluc" }),
      body("quiet", null),
    ]);
}

async function recordings(db: DB) {
  return db.query.recordingsTable.findMany({
    with: { bodies: { columns: { slug: true }, orderBy: { slug: "asc" } } },
    orderBy: { external_id: "asc" },
  });
}

describe("scout", () => {
  test("stores new recordings' rows, bodies, metadata and audio", async ({
    db,
  }) => {
    await insertBodies(db);
    const w = world(db);
    w.playlists.set("PLgbos", ["a", "b"]);
    w.playlists.set("PLluc", []);
    w.videos.set("a", { publishedAt: new Date("2026-03-24T03:00:00Z") });
    w.videos.set("b", { durationSecs: 90.5 });

    const report = await w.run();

    expect(report).toMatchObject({ errors: 0, exitCode: 0 });
    expect(report.found.map((r) => r.external_id)).toEqual(["a", "b"]);
    const rows = await recordings(db);
    expect(rows).toEqual([
      expect.objectContaining({
        site: "youtube",
        external_id: "a",
        permalink: "https://www.youtube.com/watch?v=a",
        title: "Video a",
        description: "About a",
        published_at: new Date("2026-03-24T03:00:00Z"),
        duration_secs: "00:01:00",
        is_meeting: null,
        notes: "",
        audio_stored_at: expect.any(Date),
        audio_error_history: [],
        bodies: [{ slug: "gbos" }],
      }),
      expect.objectContaining({
        external_id: "b",
        published_at: null,
        duration_secs: "00:01:30.5",
        audio_stored_at: expect.any(Date),
        bodies: [{ slug: "gbos" }],
      }),
    ]);
    expect([...w.blobs.keys()].sort()).toEqual([
      "youtube/a/metadata.json",
      "youtube/a/speech.webm",
      "youtube/b/metadata.json",
      "youtube/b/speech.webm",
    ]);
    expect(
      new TextDecoder().decode(w.blobs.get("youtube/a/speech.webm")!.body),
    ).toBe("audio of a");
  });

  test("doesn't fetch recordings already found again, and adds the bodies of other sources listing them", async ({
    db,
  }) => {
    await insertBodies(db);
    const w = world(db);
    w.playlists.set("PLgbos", ["a"]);
    w.playlists.set("PLluc", []);
    w.videos.set("a", {});
    await w.run();
    w.calls.metadata.length = 0;
    w.calls.audio.length = 0;

    // A joint meeting, now in LUC's playlist too.
    w.playlists.set("PLluc", ["a"]);
    const report = await w.run();

    expect(w.calls).toEqual({ metadata: [], audio: [] });
    expect(report.found).toEqual([]);
    expect(report.bodiesAdded).toEqual([
      { site: "youtube", external_id: "a", body: "luc" },
    ]);
    expect((await recordings(db)).map((r) => r.bodies)).toEqual([
      [{ slug: "gbos" }, { slug: "luc" }],
    ]);
  });

  test("skips a recording with no complete audio, and finds it once it has", async ({
    db,
  }) => {
    await insertBodies(db);
    const w = world(db);
    w.playlists.set("PLgbos", ["live"]);
    w.playlists.set("PLluc", []);
    w.videos.set("live", { durationSecs: null });

    expect((await w.run()).found).toEqual([]);
    expect(await recordings(db)).toEqual([]);
    expect(w.blobs.size).toBe(0);

    w.videos.set("live", { durationSecs: 7200 });
    expect((await w.run()).found.map((r) => r.external_id)).toEqual(["live"]);
    expect(await recordings(db)).toHaveLength(1);
  });

  test("stores at most maxAudio recordings' audio, newest first, unknown last", async ({
    db,
  }) => {
    await insertBodies(db);
    const w = world(db);
    w.playlists.set("PLgbos", ["old", "unknown", "new"]);
    w.playlists.set("PLluc", []);
    w.videos.set("old", { publishedAt: new Date("2025-01-01") });
    w.videos.set("unknown", {});
    w.videos.set("new", { publishedAt: new Date("2026-01-01") });

    const first = await w.run({ maxAudio: 2 });
    expect(first.audioStored.map((r) => r.external_id)).toEqual(["new", "old"]);
    const second = await w.run({ maxAudio: 2 });
    expect(second.audioStored.map((r) => r.external_id)).toEqual(["unknown"]);
    expect(w.calls.audio).toEqual(["new", "old", "unknown"]);
  });

  test("doesn't store audio for a recording that isn't a meeting", async ({
    db,
  }) => {
    await insertBodies(db);
    const w = world(db);
    w.playlists.set("PLgbos", ["a"]);
    w.playlists.set("PLluc", []);
    w.videos.set("a", {});
    await w.run({ maxAudio: 0 });
    await db
      .update(recordingsTable)
      .set({ is_meeting: false })
      .where(eq(recordingsTable.external_id, "a"));

    expect((await w.run()).audioStored).toEqual([]);
    expect(w.calls.audio).toEqual([]);
  });

  test("retries a failed download until its third failure, and again once its errors are emptied", async ({
    db,
  }) => {
    await insertBodies(db);
    const w = world(db);
    w.playlists.set("PLgbos", ["a"]);
    w.playlists.set("PLluc", []);
    w.videos.set("a", { audioError: "HTTP 403" });

    for (let i = 0; i < MAX_AUDIO_FAILURES; i++) {
      expect(await w.run()).toMatchObject({ errors: 1, exitCode: 1 });
    }
    expect(await w.run()).toMatchObject({ errors: 0, exitCode: 0 });
    expect(w.calls.audio).toEqual(["a", "a", "a"]);
    const [row] = await recordings(db);
    expect(row).toMatchObject({
      audio_stored_at: null,
      audio_error_history: ["HTTP 403", "HTTP 403", "HTTP 403"],
    });
    expect(w.log.error).toHaveBeenCalledWith(
      "youtube a: storing audio: HTTP 403",
    );

    w.videos.set("a", {});
    await db
      .update(recordingsTable)
      .set({ audio_error_history: [] })
      .where(eq(recordingsTable.external_id, "a"));
    expect((await w.run()).audioStored).toEqual([
      { site: "youtube", external_id: "a" },
    ]);
  });

  test("logs a failing source or recording with its body, and goes on", async ({
    db,
  }) => {
    await insertBodies(db);
    const w = world(db);
    // PLgbos isn't listed, so listing it fails.
    w.playlists.set("PLluc", ["private", "b"]);
    w.videos.set("b", {});

    const report = await w.run();

    expect(report).toMatchObject({ errors: 2, exitCode: 1 });
    expect(w.log.error.mock.calls).toEqual([
      ["gbos: Playlist PLgbos is gone"],
      ["luc: youtube private: Video private is private"],
    ]);
    expect((await recordings(db)).map((r) => r.external_id)).toEqual(["b"]);
  });

  test("scans only --body's source", async ({ db }) => {
    await insertBodies(db);
    const w = world(db);
    w.playlists.set("PLluc", ["b"]);
    w.videos.set("b", {});

    expect(await w.run({ body: "luc" })).toMatchObject({ errors: 0 });
    await expect(w.run({ body: "quiet" })).rejects.toThrow(/no meeting source/);
    await expect(w.run({ body: "nobody" })).rejects.toThrow(/No body nobody/);
  });

  test("with dryRun, reports what it would do and writes nothing", async ({
    db,
  }) => {
    await insertBodies(db);
    const w = world(db);
    w.playlists.set("PLgbos", ["a"]);
    w.playlists.set("PLluc", []);
    w.videos.set("a", {});
    await w.run({ maxAudio: 0 });
    w.playlists.set("PLluc", ["a", "b"]);
    w.videos.set("b", { publishedAt: new Date("2026-01-01") });
    const before = await recordings(db);
    const blobsBefore = [...w.blobs.keys()];

    const report = await w.run({ dryRun: true, writer: null });

    expect(report.found.map((r) => r.external_id)).toEqual(["b"]);
    expect(report.bodiesAdded).toEqual([
      { site: "youtube", external_id: "a", body: "luc" },
      { site: "youtube", external_id: "b", body: "luc" },
    ]);
    expect(report.audioStored).toEqual([]);
    expect(w.log.info).toHaveBeenCalledWith("Would store audio for youtube b.");
    expect(w.log.info).toHaveBeenCalledWith("Would store audio for youtube a.");
    expect(w.calls.audio).toEqual([]);
    expect(await recordings(db)).toEqual(before);
    expect(await db.select().from(recordingBodiesTable)).toHaveLength(1);
    expect([...w.blobs.keys()]).toEqual(blobsBefore);
  });

  test("needs a blob store writer unless dryRun", async ({ db }) => {
    await insertBodies(db);
    await expect(world(db).run({ writer: null })).rejects.toThrow(
      /blob store's keys/,
    );
  });
});
