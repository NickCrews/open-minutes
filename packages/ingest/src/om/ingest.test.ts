import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bodiesTable, meetingsTable, segmentsTable } from "@open-minutes/db";
import { eq } from "drizzle-orm";
import type { VideoMetadata } from "@open-minutes/core/audio-provider";
import type { SpeechSegment } from "@open-minutes/core/transcription";
import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import { ingestMeeting, ingestMeetings, parseMeetingLines } from "./ingest";
import { listIngested } from "./ingested";
import {
  GOLDEN_GBOS,
  fakeSite,
  goldenGbosId,
  goldenTest as test,
  insertBody,
  insertMeeting,
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
async function seedWorkDir(workRoot: string, dirName: string): Promise<void> {
  const dir = join(workRoot, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "audio.wav"), "not really audio");
  await writeFile(
    join(dir, "transcription.json"),
    JSON.stringify(TRANSCRIPTION, null, 2),
  );
  await writeFile(join(dir, "diarization.json"), JSON.stringify(DIARIZATION));
  await writeFile(join(dir, "embeddings.json"), JSON.stringify(EMBEDDINGS));
}

describe("ingestMeeting", () => {
  test("skips an already-ingested video without touching YouTube", async ({
    db,
    workRoot,
  }) => {
    await insertMeeting(db, await goldenGbosId(db), VIDEO_ID);

    // Every fake YouTube call throws, so success proves nothing was fetched.
    const result = await ingestMeeting(db, VIDEO_ID, {
      sites: { youtube: fakeSite() },
      workRoot,
    });

    expect(result).toEqual({
      site: "youtube",
      siteId: VIDEO_ID,
      status: "skipped",
    });
    expect(await db.select().from(meetingsTable)).toHaveLength(1);
  });

  test("rejects a video whose channel matches no body", async ({
    db,
    workRoot,
  }) => {
    const youtube = fakeSite({
      getMetadata: async () => ({
        ...METADATA,
        channelId: "UC_SOMEONE_ELSES_CHANNEL",
      }),
    });

    await expect(
      ingestMeeting(db, VIDEO_ID, { sites: { youtube }, workRoot }),
    ).rejects.toThrow(/no body's meeting source/);
    expect(await db.select().from(meetingsTable)).toHaveLength(0);
  });

  test("a stage failure leaves no meeting row (all-or-nothing)", async ({
    db,
    workRoot,
  }) => {
    const youtube = fakeSite({
      getMetadata: async () => METADATA,
      ensureAudioDownloaded: async () => {
        throw new Error("network down");
      },
    });

    await expect(
      ingestMeeting(db, VIDEO_ID, { sites: { youtube }, workRoot }),
    ).rejects.toThrow("network down");
    expect(await db.select().from(meetingsTable)).toHaveLength(0);
    expect(await db.select().from(segmentsTable)).toHaveLength(0);
  });

  test("resumes from cached artifacts and commits meeting + segments", async ({
    db,
    workRoot,
  }) => {
    await seedWorkDir(workRoot, `gbos_${VIDEO_ID}`);

    // Only metadata is fetched; download/transcribe/diarize must all be
    // skipped because their artifacts exist (download would throw).
    const youtube = fakeSite({ getMetadata: async () => METADATA });

    const result = await ingestMeeting(db, VIDEO_ID, {
      sites: { youtube },
      workRoot,
    });
    expect(result).toMatchObject({
      site: "youtube",
      siteId: VIDEO_ID,
      status: "ingested",
      segmentCount: 2,
      // Neither the title nor the transcript says when the meeting was.
      when: { date: null, time: null },
    });

    const [meeting] = await db.select().from(meetingsTable);
    expect(meeting).toMatchObject({
      site: "youtube",
      site_id: VIDEO_ID,
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      title: METADATA.title,
      description: METADATA.description,
      date: null,
      time: null,
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
    const again = await ingestMeeting(db, VIDEO_ID, {
      sites: { youtube: fakeSite() },
      workRoot,
    });
    expect(again.status).toBe("skipped");
    expect(await db.select().from(segmentsTable)).toHaveLength(2);
  });

  test(
    "full pipeline on a real fixture meeting",
    { tags: ["slow"] },
    async ({ db, workRoot }) => {
      const meeting = getMeetingData("gbos-2026-03-23");
      const audio = await getMeetingAudio(meeting);

      // Fake only the network boundary: metadata is canned and "download"
      // symlinks the cached fixture audio. Transcribe/diarize/align/identify
      // run for real.
      const youtube = fakeSite({
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

      const result = await ingestMeeting(db, meeting.youtube_id, {
        sites: { youtube },
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

describe("which body a meeting belongs to", () => {
  const AKLEG_ID = "HRES 2018-09-10 14:00:00";
  const AKLEG_METADATA: VideoMetadata = {
    id: AKLEG_ID,
    channelId: "HRES",
    title: "House RESOURCES - 2018-09-10 14:00:00",
    description: "Anch LIO AUDITORIUM",
    durationSecs: 3600,
    uploadDate: "2018-09-10",
  };

  test("an akleg.gov meeting is its committee's", async ({ db, workRoot }) => {
    // The golden HRES body's meeting source is the committee.
    const [hres] = await db
      .select({ id: bodiesTable.id })
      .from(bodiesTable)
      .where(eq(bodiesTable.name_short, "HRES"));
    await seedWorkDir(workRoot, "hres_HRES-2018-09-10-14-00-00");

    // A URL names it too; YouTube is never asked.
    const result = await ingestMeeting(
      db,
      "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
      {
        sites: {
          youtube: fakeSite(),
          akleg: fakeSite({ getMetadata: async () => AKLEG_METADATA }),
        },
        workRoot,
      },
    );
    expect(result).toMatchObject({
      site: "akleg",
      siteId: AKLEG_ID,
      status: "ingested",
      // From the title.
      when: { date: "2018-09-10", time: "14:00" },
    });
    const [meeting] = await db.select().from(meetingsTable);
    expect(meeting).toMatchObject({
      body_id: hres!.id,
      site: "akleg",
      site_id: AKLEG_ID,
      url: "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
    });
  });

  test("a playlist's meeting needs its body named", async ({
    db,
    workRoot,
  }) => {
    const council = await insertBody(db, {
      name: "Town Council",
      name_short: "TC",
      source: { type: "youtube_playlist", playlist_id: "PL_COUNCIL" },
    });
    await seedWorkDir(workRoot, `tc_${VIDEO_ID}`);
    const youtube = fakeSite({
      getMetadata: async () => ({ ...METADATA, channelId: "UC_MOA" }),
    });

    await expect(
      ingestMeeting(db, VIDEO_ID, { sites: { youtube }, workRoot }),
    ).rejects.toThrow(/say which body/);

    const result = await ingestMeeting(
      db,
      { ref: VIDEO_ID, body: "tc" },
      { sites: { youtube }, workRoot },
    );
    expect(result.status).toBe("ingested");
    const [meeting] = await db.select().from(meetingsTable);
    expect(meeting!.body_id).toBe(council);
  });

  test("a named body must publish on the meeting's site", async ({
    db,
    workRoot,
  }) => {
    const youtube = fakeSite({ getMetadata: async () => METADATA });
    await expect(
      ingestMeeting(
        db,
        { ref: VIDEO_ID, body: "nope" },
        { sites: { youtube }, workRoot },
      ),
    ).rejects.toThrow(/No body with slug "nope"/);

    const akleg = fakeSite({ getMetadata: async () => AKLEG_METADATA });
    await expect(
      ingestMeeting(
        db,
        { ref: AKLEG_ID, body: "gbos" },
        { sites: { akleg }, workRoot },
      ),
    ).rejects.toThrow(/can't belong to GBOS, whose meetings are on youtube/);
    expect(await db.select().from(meetingsTable)).toHaveLength(0);
  });
});

describe("parseMeetingLines", () => {
  it("reads `om available`'s lines, whose IDs may hold spaces", () => {
    expect(
      parseMeetingLines(
        "hTKVG_L61ec\tgbos\nHRES 2018-09-10 14:00:00\thres\n\n  xTDznaSElgY \n",
        "default",
      ),
    ).toEqual([
      { ref: "hTKVG_L61ec", body: "gbos" },
      { ref: "HRES 2018-09-10 14:00:00", body: "hres" },
      { ref: "xTDznaSElgY", body: "default" },
    ]);
  });
});

describe("ingestMeetings", () => {
  test("continues past failures and reports every outcome", async ({
    db,
    workRoot,
  }) => {
    const goodId = "good-video";
    const badId = "bad-video";
    await seedWorkDir(workRoot, `gbos_${goodId}`);

    const youtube = fakeSite({
      getMetadata: async (videoId) => {
        if (videoId === badId) throw new Error("video is private");
        return { ...METADATA, id: goodId };
      },
    });

    const summary = await ingestMeetings(db, [badId, goodId], {
      sites: { youtube },
      workRoot,
    });

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]!.meeting).toEqual({ ref: badId });
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({
      siteId: goodId,
      status: "ingested",
    });
    const meetings = await db.select().from(meetingsTable);
    expect(meetings).toHaveLength(1);
    expect(meetings[0]!.site_id).toBe(goodId);
  });
});

describe("listIngested", () => {
  test("lists meetings newest first with segment counts, filterable by id", async ({
    db,
    workRoot,
  }) => {
    await seedWorkDir(workRoot, `gbos_${VIDEO_ID}`);
    const youtube = fakeSite({ getMetadata: async () => METADATA });
    await ingestMeeting(db, VIDEO_ID, { sites: { youtube }, workRoot });
    // An older meeting with no segments.
    await insertMeeting(db, await goldenGbosId(db), "older-video", {
      date: "2020-01-01",
    });

    const all = await listIngested(db);
    expect(all.map((m) => m.siteId)).toEqual([VIDEO_ID, "older-video"]);
    expect(all[0]).toMatchObject({
      body: "gbos",
      title: METADATA.title,
      segmentCount: 2,
      durationSecs: "01:00:00",
    });
    expect(all[1]!.segmentCount).toBe(0);

    const filtered = await listIngested(db, ["older-video", "not-ingested"]);
    expect(filtered.map((m) => m.siteId)).toEqual(["older-video"]);
  });
});
