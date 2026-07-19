import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { meetingsTable, segmentsTable } from "@open-minutes/core/db";
import { GBOS_MUNICIPALITY, getOrCreateGbos } from "@open-minutes/core/munis";
import type { VideoMetadata } from "@open-minutes/core/youtube";
import type { SpeechSegment } from "@open-minutes/core/transcription";
import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { getMeetingData } from "../test-utils/test-data";
import { ingestVideo, ingestVideos } from "./ingest";
import { listIngested } from "./ingested";
import { fakeYouTube, insertMeeting, test } from "./testing";

const VIDEO_ID = "test-video-1";

const METADATA: VideoMetadata = {
  id: VIDEO_ID,
  channelId: GBOS_MUNICIPALITY.youtube_channel_id,
  title: "Regular Meeting",
  description: "Agenda: everything",
  durationSecs: 3600,
};

// Two speakers, three words: speaker 0 says "Hello everyone", speaker 1 says
// "Thanks". Small enough to hand-verify the aligned segments below.
const TRANSCRIPTION: SpeechSegment[] = [
  {
    start: 0.4,
    end: 1.5,
    words: [
      { text: "Hello", start: 0.5, end: 0.9 },
      { text: "everyone", start: 1.0, end: 1.4 },
    ],
  },
  { start: 4.9, end: 5.5, words: [{ text: "Thanks", start: 5.0, end: 5.4 }] },
];

// Orthogonal voiceprints (cosine similarity 0), so the two speakers must
// resolve to two distinct people.
function embedding(hotIndex: number): number[] {
  const vec = new Array<number>(N_DIMENSIONS).fill(0);
  vec[hotIndex] = 1;
  return vec;
}

const DIARIZATION = {
  turns: [
    { start: 0.4, end: 1.5, speaker: 0 },
    { start: 4.9, end: 5.5, speaker: 1 },
  ],
  embeddings: { "0": embedding(0), "1": embedding(1) },
};

/**
 * Pre-seed a meeting's work directory with every stage artifact, as if a prior
 * run completed all compute stages and crashed before the DB commit.
 */
async function seedWorkDir(workRoot: string, youtubeId: string): Promise<void> {
  const dir = join(workRoot, `gbos_${youtubeId}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "audio.wav"), "not really audio");
  await writeFile(
    join(dir, "transcription.json"),
    JSON.stringify(TRANSCRIPTION, null, 2),
  );
  await writeFile(join(dir, "diarization.json"), JSON.stringify(DIARIZATION));
}

describe("ingestVideo", () => {
  test("skips an already-ingested video without touching YouTube", async ({
    db,
    workRoot,
  }) => {
    const gbos = await getOrCreateGbos(db);
    await insertMeeting(db, gbos.id, VIDEO_ID);

    // Every fake YouTube call throws, so success proves nothing was fetched.
    const result = await ingestVideo(db, VIDEO_ID, {
      yt: fakeYouTube(),
      workRoot,
    });

    expect(result).toEqual({ youtubeId: VIDEO_ID, status: "skipped" });
    expect(await db.select().from(meetingsTable)).toHaveLength(1);
  });

  test("rejects a video whose channel matches no municipality", async ({
    db,
    workRoot,
  }) => {
    await getOrCreateGbos(db);
    const yt = fakeYouTube({
      fetchVideoMetadata: async () => ({
        ...METADATA,
        channelId: "UC_SOMEONE_ELSES_CHANNEL",
      }),
    });

    await expect(ingestVideo(db, VIDEO_ID, { yt, workRoot })).rejects.toThrow(
      /no municipality/,
    );
    expect(await db.select().from(meetingsTable)).toHaveLength(0);
  });

  test("a stage failure leaves no meeting row (all-or-nothing)", async ({
    db,
    workRoot,
  }) => {
    await getOrCreateGbos(db);
    const yt = fakeYouTube({
      fetchVideoMetadata: async () => METADATA,
      downloadVideoAudio: async () => {
        throw new Error("network down");
      },
    });

    await expect(ingestVideo(db, VIDEO_ID, { yt, workRoot })).rejects.toThrow(
      "network down",
    );
    expect(await db.select().from(meetingsTable)).toHaveLength(0);
    expect(await db.select().from(segmentsTable)).toHaveLength(0);
  });

  test("resumes from cached artifacts and commits meeting + segments", async ({
    db,
    workRoot,
  }) => {
    await getOrCreateGbos(db);
    await seedWorkDir(workRoot, VIDEO_ID);

    // Only metadata is fetched; download/transcribe/diarize must all be
    // skipped because their artifacts exist (download would throw).
    const yt = fakeYouTube({ fetchVideoMetadata: async () => METADATA });

    const result = await ingestVideo(db, VIDEO_ID, { yt, workRoot });
    expect(result).toMatchObject({
      youtubeId: VIDEO_ID,
      status: "ingested",
      segmentCount: 2,
    });

    const [meeting] = await db.select().from(meetingsTable);
    expect(meeting).toMatchObject({
      youtube_id: VIDEO_ID,
      title: METADATA.title,
      description: METADATA.description,
      start_time: null,
    });
    expect(meeting!.duration_secs).toBe("01:00:00");

    const segments = (await db.select().from(segmentsTable)).sort(
      (a, b) => a.speaker_number! - b.speaker_number!,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      meeting_id: meeting!.id,
      speaker_number: 0,
      text: "Hello everyone",
    });
    expect(segments[1]).toMatchObject({ speaker_number: 1, text: "Thanks" });
    expect(segments[0]!.words).toEqual(TRANSCRIPTION[0]!.words);
    // Orthogonal voiceprints → two distinct identified people.
    expect(segments[0]!.person_id).not.toBeNull();
    expect(segments[1]!.person_id).not.toBeNull();
    expect(segments[0]!.person_id).not.toBe(segments[1]!.person_id);

    // Re-ingesting the same video is a harmless no-op.
    const again = await ingestVideo(db, VIDEO_ID, {
      yt: fakeYouTube(),
      workRoot,
    });
    expect(again.status).toBe("skipped");
    expect(await db.select().from(segmentsTable)).toHaveLength(2);
  });

  test(
    "full pipeline on a real fixture meeting",
    { tags: ["slow"] },
    async ({ db, workRoot }) => {
      await getOrCreateGbos(db);
      const meeting = getMeetingData("gbos_9HoIM5INxpI");
      const audio = await meeting.getAudio();

      // Fake only the network boundary: metadata is canned and "download"
      // symlinks the cached fixture audio. Transcribe/diarize/align/identify
      // run for real.
      const yt = fakeYouTube({
        fetchVideoMetadata: async () => ({
          ...METADATA,
          id: meeting.youtube_id,
        }),
        downloadVideoAudio: async (_id, path) => {
          const { symlink } = await import("node:fs/promises");
          await mkdir(join(path, ".."), { recursive: true });
          await symlink(audio.path, path);
          return { downloaded: true };
        },
      });

      const result = await ingestVideo(db, meeting.youtube_id, {
        yt,
        workRoot,
      });
      expect(result.status).toBe("ingested");

      const workDir = join(workRoot, `gbos_${meeting.youtube_id}`);
      expect(existsSync(join(workDir, "transcription.json"))).toBe(true);
      expect(existsSync(join(workDir, "diarization.json"))).toBe(true);

      const segments = await db.select().from(segmentsTable);
      expect(segments.length).toBeGreaterThan(0);
      expect(segments.some((s) => s.person_id !== null)).toBe(true);
    },
  );
});

describe("ingestVideos", () => {
  test("continues past failures and reports every outcome", async ({
    db,
    workRoot,
  }) => {
    await getOrCreateGbos(db);
    const goodId = "good-video";
    const badId = "bad-video";
    await seedWorkDir(workRoot, goodId);

    const yt = fakeYouTube({
      fetchVideoMetadata: async (videoId) => {
        if (videoId === badId) throw new Error("video is private");
        return { ...METADATA, id: goodId };
      },
    });

    const summary = await ingestVideos(db, [badId, goodId], { yt, workRoot });

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]!.youtubeId).toBe(badId);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({
      youtubeId: goodId,
      status: "ingested",
    });
    const meetings = await db.select().from(meetingsTable);
    expect(meetings).toHaveLength(1);
    expect(meetings[0]!.youtube_id).toBe(goodId);
  });
});

describe("listIngested", () => {
  test("lists meetings newest first with segment counts, filterable by id", async ({
    db,
    workRoot,
  }) => {
    const gbos = await getOrCreateGbos(db);
    await seedWorkDir(workRoot, VIDEO_ID);
    const yt = fakeYouTube({ fetchVideoMetadata: async () => METADATA });
    await ingestVideo(db, VIDEO_ID, { yt, workRoot });
    // An older meeting with no segments.
    await insertMeeting(db, gbos.id, "older-video", new Date("2020-01-01"));

    const all = await listIngested(db);
    expect(all.map((m) => m.youtubeId)).toEqual([VIDEO_ID, "older-video"]);
    expect(all[0]).toMatchObject({
      muni: "gbos",
      title: METADATA.title,
      segmentCount: 2,
      durationSecs: "01:00:00",
    });
    expect(all[1]!.segmentCount).toBe(0);

    const filtered = await listIngested(db, ["older-video", "not-ingested"]);
    expect(filtered.map((m) => m.youtubeId)).toEqual(["older-video"]);
  });
});
