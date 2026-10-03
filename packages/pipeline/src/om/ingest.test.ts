import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import {
  meetingsTable,
  processingRunsTable,
  segmentsTable,
} from "@open-minutes/db";
import type { VideoMetadata } from "../audio-provider";
import type { SpeechSegment } from "@open-minutes/core/transcription";
import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import { ingestVideo, ingestVideos } from "./ingest";
import { listMeetings } from "./meetings";
import { TRANSCRIPT_VERSION } from "./transcript";
import {
  GOLDEN_GBOS,
  fakeYouTube,
  goldenGbosId,
  goldenTest as test,
  insertMeeting,
  insertRun,
} from "./testing";
import { getMeetingAudio } from "../test-utils/audio-cache";

const VIDEO_ID = "test-video-1";

const METADATA: VideoMetadata = {
  id: VIDEO_ID,
  channelId: GOLDEN_GBOS.channelId,
  title: "Regular Meeting",
  description: "Agenda: everything",
  durationSecs: 3600,
  uploadDate: null,
};

// Two speakers: speaker 0 says "Um, hello everyone", speaker 1 says "Thanks".
// Small enough to hand-verify the aligned segments below. The "Um," is raw
// recognizer output that the clean stage must strip before anything is stored.
const TRANSCRIPTION: SpeechSegment[] = [
  {
    start: 0.4,
    end: 1.5,
    words: [
      { text: "Um,", start: 0.45 },
      { text: "hello", start: 0.5 },
      { text: "everyone", start: 1.0 },
    ],
  },
  { start: 4.9, end: 5.5, words: [{ text: "Thanks", start: 5.0 }] },
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
    { start: 0.4, end: 1.5, speakerNum: 0 },
    { start: 4.9, end: 5.5, speakerNum: 1 },
  ],
};

const EMBEDDINGS = [
  { speaker: 0, centroid: embedding(0) },
  { speaker: 1, centroid: embedding(1) },
];

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
  await writeFile(join(dir, "embeddings.json"), JSON.stringify(EMBEDDINGS));
}

describe("ingestVideo", () => {
  test("skips an already-transcribed video without touching YouTube", async ({
    db,
    workRoot,
  }) => {
    await insertRun(
      db,
      await insertMeeting(db, await goldenGbosId(db), VIDEO_ID),
    );

    // Every fake YouTube call throws, so success proves nothing was fetched.
    const result = await ingestVideo(db, VIDEO_ID, {
      yt: fakeYouTube(),
      workRoot,
    });

    expect(result).toEqual({ youtubeId: VIDEO_ID, status: "skipped" });
    expect(await db.select().from(meetingsTable)).toHaveLength(1);
  });

  test("rejects a video whose channel matches no body", async ({
    db,
    workRoot,
  }) => {
    const yt = fakeYouTube({
      getMetadata: async () => ({
        ...METADATA,
        channelId: "UC_SOMEONE_ELSES_CHANNEL",
      }),
    });

    await expect(ingestVideo(db, VIDEO_ID, { yt, workRoot })).rejects.toThrow(
      /matches no body's video sources/,
    );
    expect(await db.select().from(meetingsTable)).toHaveLength(0);
  });

  test("a stage failure records a failed run and writes no transcript", async ({
    db,
    workRoot,
  }) => {
    const yt = fakeYouTube({
      getMetadata: async () => METADATA,
      ensureAudioDownloaded: async () => {
        throw new Error("network down");
      },
    });

    await expect(ingestVideo(db, VIDEO_ID, { yt, workRoot })).rejects.toThrow(
      "network down",
    );
    // The meeting stays recorded, so the sweep retries it.
    const [meeting] = await db.select().from(meetingsTable);
    expect(meeting).toMatchObject({
      youtube_id: VIDEO_ID,
      title: "Regular Meeting",
    });
    expect(await db.select().from(segmentsTable)).toHaveLength(0);
    const runs = await db.select().from(processingRunsTable);
    expect(runs).toMatchObject([
      {
        meeting_id: meeting!.id,
        step: "transcript",
        version: TRANSCRIPT_VERSION,
        status: "failed",
        error: "network down",
      },
    ]);
    expect(runs[0]!.finished_at).not.toBeNull();
  });

  test("resumes from cached artifacts and commits meeting + segments", async ({
    db,
    workRoot,
  }) => {
    await seedWorkDir(workRoot, VIDEO_ID);

    // Only metadata is fetched; download/transcribe/diarize must all be
    // skipped because their artifacts exist (download would throw).
    const yt = fakeYouTube({ getMetadata: async () => METADATA });

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
      date: null,
      time: null,
    });
    expect(meeting!.duration_secs).toBe("01:00:00");

    // The run that made the transcript, and what it was made with.
    const [run] = await db.select().from(processingRunsTable);
    expect(run).toMatchObject({
      meeting_id: meeting!.id,
      step: "transcript",
      version: TRANSCRIPT_VERSION,
      status: "succeeded",
      error: null,
      details: expect.objectContaining({
        segments: 2,
        speakers: 2,
        models: expect.arrayContaining([expect.any(String)]),
        cleaningRules: expect.arrayContaining(["filler"]),
        transcriptFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      }),
    });
    expect(run!.finished_at!.getTime()).toBeGreaterThanOrEqual(
      run!.started_at.getTime(),
    );

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
    // Cleaned: the filler is gone and its capital passed on.
    expect(segments[0]!.words).toEqual([
      { text: "Hello", start: 0.5 },
      { text: "everyone", start: 1.0 },
    ]);
    // Orthogonal voiceprints → two distinct identified people.
    expect(segments[0]!.person_id).not.toBeNull();
    expect(segments[1]!.person_id).not.toBeNull();
    expect(segments[0]!.person_id).not.toBe(segments[1]!.person_id);

    // The cached transcription stays verbatim, so cleaning rules can change
    // without re-transcribing.
    const cached = JSON.parse(
      await readFile(
        join(workRoot, `gbos_${VIDEO_ID}`, "transcription.json"),
        "utf8",
      ),
    ) as SpeechSegment[];
    expect(cached).toEqual(TRANSCRIPTION);

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
      const meeting = getMeetingData("gbos_9HoIM5INxpI");
      const audio = await getMeetingAudio(meeting);

      // Fake only the network boundary: metadata is canned and "download"
      // symlinks the cached fixture audio. Transcribe/diarize/align/identify
      // run for real.
      const yt = fakeYouTube({
        getMetadata: async () => ({
          ...METADATA,
          id: meeting.youtube_id,
        }),
        ensureAudioDownloaded: async (_id, path) => {
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
    const goodId = "good-video";
    const badId = "bad-video";
    await seedWorkDir(workRoot, goodId);

    const yt = fakeYouTube({
      getMetadata: async (videoId) => {
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

describe("listMeetings", () => {
  test("lists meetings newest first with segment counts and step states", async ({
    db,
    workRoot,
  }) => {
    await seedWorkDir(workRoot, VIDEO_ID);
    const yt = fakeYouTube({ getMetadata: async () => METADATA });
    await ingestVideo(db, VIDEO_ID, { yt, workRoot });
    // An older meeting, discovered but not yet transcribed.
    await insertMeeting(
      db,
      await goldenGbosId(db),
      "older-video",
      "2020-01-01",
    );

    const all = await listMeetings(db);
    expect(all.map((m) => m.youtubeId)).toEqual([VIDEO_ID, "older-video"]);
    expect(all[0]).toMatchObject({
      body: "gbos",
      title: METADATA.title,
      segmentCount: 2,
      durationSecs: "01:00:00",
      steps: {
        transcript: { kind: "done", version: TRANSCRIPT_VERSION },
      },
    });
    expect(all[1]).toMatchObject({
      segmentCount: 0,
      steps: { transcript: { kind: "pending", failures: 0 } },
    });

    const filtered = await listMeetings(db, ["older-video", "not-ingested"]);
    expect(filtered.map((m) => m.youtubeId)).toEqual(["older-video"]);
  });
});
