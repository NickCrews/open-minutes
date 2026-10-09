import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import {
  type DB,
  bodiesTable,
  meetingBodiesTable,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/db";
import { asc, eq } from "drizzle-orm";
import type { VideoMetadata } from "@open-minutes/core/audio-provider";
import type {
  SpeechSegment,
  TranscriptSegment,
} from "@open-minutes/core/transcription";
import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import { addMeeting } from "./add";
import { recognizeSpeakers } from "./recognize";
import { saveTranscript } from "./save";
import { parseMeetingRef } from "./sites";
import {
  align,
  clean,
  diarize,
  downloadAudio,
  embedSpeakers,
  transcribe,
} from "./steps";
import {
  GOLDEN_GBOS,
  fakeSite,
  goldenGbosId,
  goldenTest as test,
  insertMeeting,
} from "./testing";
import { getMeetingAudio } from "./test-utils/audio-cache";
import { meetingWorkDir } from "./work-dir";

const VIDEO_ID = "test-video-1";
const VIDEO = { siteKind: "youtube", siteId: VIDEO_ID } as const;

/** The short names of the bodies that held a meeting, alphabetical. */
async function bodiesOf(db: DB, meetingId: number): Promise<string[]> {
  const rows = await db
    .select({ name_short: bodiesTable.name_short })
    .from(meetingBodiesTable)
    .innerJoin(bodiesTable, eq(bodiesTable.id, meetingBodiesTable.body_id))
    .where(eq(meetingBodiesTable.meeting_id, meetingId))
    .orderBy(asc(bodiesTable.name_short));
  return rows.map((r) => r.name_short);
}

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
// recognizer output that clean must strip.
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

const DIARIZATION = {
  turns: [
    { start: 0.4, end: 1.5, speakerNum: 0 },
    { start: 4.9, end: 5.5, speakerNum: 1 },
  ],
};

// Orthogonal voiceprints (cosine similarity 0), so the two speakers can't
// both match one person.
function embedding(hotIndex: number): number[] {
  const vec = new Array<number>(N_DIMENSIONS).fill(0);
  vec[hotIndex] = 1;
  return vec;
}

const EMBEDDINGS = [
  { speaker: 0, centroid: embedding(0) },
  { speaker: 1, centroid: embedding(1) },
];

/**
 * A work directory holding what transcribe, diarize and embed_speakers would
 * have written, so the cheap steps around them can run without models.
 */
async function workDirWithModelOutputs(workRoot: string): Promise<string> {
  const dir = await meetingWorkDir(workRoot, VIDEO);
  await writeFile(join(dir, "audio.wav"), "not really audio");
  await writeFile(
    join(dir, "transcription.json"),
    JSON.stringify(TRANSCRIPTION),
  );
  await writeFile(join(dir, "diarization.json"), JSON.stringify(DIARIZATION));
  await writeFile(join(dir, "embeddings.json"), JSON.stringify(EMBEDDINGS));
  return dir;
}

describe("addMeeting", () => {
  test("adds an untranscribed meeting with its site's metadata", async ({
    db,
  }) => {
    const youtube = fakeSite({
      getMetadata: async () => ({
        ...METADATA,
        title:
          "Girdwood Board of Supervisors and Girdwood Land Use Committee Joint Meeting August 30, 2022",
      }),
    });
    const added = await addMeeting(db, youtube, VIDEO, ["gbos", "luc"]);
    expect(added).toMatchObject({
      ...VIDEO,
      bodies: ["gbos", "luc"],
      timezone: "America/Anchorage",
      date: "2022-08-30",
      time: null,
    });

    const [meeting] = await db.select().from(meetingsTable);
    expect(meeting).toMatchObject({
      id: added.meetingId,
      site_kind: "youtube",
      site_id: VIDEO_ID,
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      description: METADATA.description,
      date: "2022-08-30",
      transcribed_at: null,
    });
    expect(meeting!.duration_secs).toBe("01:00:00");
    expect(await bodiesOf(db, meeting!.id)).toEqual(["GBOS", "LUC"]);
  });

  test("an akleg.gov meeting takes its committee's timezone", async ({
    db,
  }) => {
    const akleg = fakeSite({
      getMetadata: async () => ({
        id: "HRES 2018-09-10 14:00:00",
        channelId: "HRES",
        title: "House RESOURCES - 2018-09-10 14:00:00",
        description: "Anch LIO AUDITORIUM",
        durationSecs: 3600,
        uploadDate: "2018-09-10",
      }),
    });
    const ref = parseMeetingRef(
      "https://www.akleg.gov/basis/Meeting/Detail?Meeting=HRES%202018-09-10%2014:00:00",
    );
    const added = await addMeeting(db, akleg, ref, ["hres"]);
    expect(added).toMatchObject({
      siteKind: "akleg",
      siteId: "HRES 2018-09-10 14:00:00",
      timezone: "America/Juneau",
      date: "2018-09-10",
      time: "14:00",
    });
  });

  test("refuses an unknown body or a meeting already added, without asking the site", async ({
    db,
  }) => {
    // Every fake call throws, so a refusal proves nothing was fetched.
    await expect(addMeeting(db, fakeSite(), VIDEO, ["nope"])).rejects.toThrow(
      /No body with slug "nope"/,
    );
    await insertMeeting(db, await goldenGbosId(db), VIDEO_ID);
    await expect(addMeeting(db, fakeSite(), VIDEO, ["gbos"])).rejects.toThrow(
      /already meeting/,
    );
    expect(await db.select().from(meetingsTable)).toHaveLength(1);
  });
});

describe("downloadAudio", () => {
  test("puts the site's audio in the work directory", async ({ workRoot }) => {
    const dir = await meetingWorkDir(workRoot, VIDEO);
    const calls: unknown[] = [];
    const youtube = fakeSite({
      ensureAudioDownloaded: async (...args) => {
        calls.push(args);
        return { downloaded: true };
      },
    });
    expect(await downloadAudio(youtube, VIDEO_ID, dir)).toEqual({
      path: join(dir, "audio.wav"),
      downloaded: true,
    });
    expect(calls).toEqual([[VIDEO_ID, join(dir, "audio.wav"), {}]]);
  });
});

describe("clean and align", () => {
  test("clean writes cleaned.json and leaves transcription.json verbatim", async ({
    workRoot,
  }) => {
    const dir = await workDirWithModelOutputs(workRoot);
    expect(await clean(dir)).toEqual({ wordsBefore: 4, wordsAfter: 3 });
    expect(
      JSON.parse(await readFile(join(dir, "transcription.json"), "utf8")),
    ).toEqual(TRANSCRIPTION);

    expect(await align(dir)).toEqual({ segments: 2, speakers: 2 });
    const segments = JSON.parse(
      await readFile(join(dir, "segments.json"), "utf8"),
    ) as TranscriptSegment[];
    // The filler is gone and its capital passed on.
    expect(segments).toEqual([
      {
        speakerNum: 0,
        words: [
          { text: "Hello", start: 0.5 },
          { text: "everyone", start: 1.0 },
        ],
      },
      { speakerNum: 1, words: [{ text: "Thanks", start: 5.0 }] },
    ]);
  });

  test("a step run before the one it reads from says which to run", async ({
    workRoot,
  }) => {
    const dir = await meetingWorkDir(workRoot, VIDEO);
    await expect(clean(dir)).rejects.toThrow(/run transcribe first/);
    await expect(align(dir)).rejects.toThrow(/run clean_transcription first/);
    await expect(transcribe(dir)).rejects.toThrow(/run download_audio first/);
    await expect(diarize(dir)).rejects.toThrow(/run download_audio first/);
    await expect(embedSpeakers(dir)).rejects.toThrow(
      /run download_audio first/,
    );
  });
});

describe("recognizeSpeakers and saveTranscript", () => {
  test("match known voices, create the rest, and mark the meeting transcribed", async ({
    db,
    workRoot,
  }) => {
    const meetingId = await insertMeeting(db, await goldenGbosId(db), VIDEO_ID);
    const [known] = await db
      .insert(peopleTable)
      .values({ slug: "known", voice_embedding: embedding(0) })
      .returning({ id: peopleTable.id });
    const dir = await workDirWithModelOutputs(workRoot);
    await clean(dir);
    await align(dir);

    expect(await recognizeSpeakers(db, dir)).toEqual([
      { speaker: 0, personId: known!.id, similarity: 1 },
      { speaker: 1, personId: null, similarity: null },
    ]);
    // Recognition only reads.
    expect(await db.select().from(peopleTable)).toHaveLength(1);

    expect(await saveTranscript(db, meetingId, dir)).toEqual({
      segments: 2,
      recognized: 1,
      newPeople: 1,
    });
    const segments = await db
      .select()
      .from(segmentsTable)
      .orderBy(asc(segmentsTable.speaker_number));
    expect(segments).toMatchObject([
      { meeting_id: meetingId, speaker_number: 0, person_id: known!.id },
      { meeting_id: meetingId, speaker_number: 1, text: "Thanks" },
    ]);
    const [created] = await db
      .select()
      .from(peopleTable)
      .where(eq(peopleTable.id, segments[1]!.person_id!));
    expect(created).toMatchObject({ slug: null, name: null });
    const [meeting] = await db.select().from(meetingsTable);
    expect(meeting!.transcribed_at).toBeInstanceOf(Date);

    await expect(saveTranscript(db, meetingId, dir)).rejects.toThrow(
      /already has a transcript/,
    );
    expect(await db.select().from(segmentsTable)).toHaveLength(2);
  });

  test("saveTranscript without recognition writes nothing", async ({
    db,
    workRoot,
  }) => {
    const meetingId = await insertMeeting(db, await goldenGbosId(db), VIDEO_ID);
    const dir = await workDirWithModelOutputs(workRoot);
    await clean(dir);
    await align(dir);
    await expect(saveTranscript(db, meetingId, dir)).rejects.toThrow(
      /run recognize_speakers first/,
    );
    expect(await db.select().from(segmentsTable)).toHaveLength(0);
    expect(await db.select().from(peopleTable)).toHaveLength(0);
  });

  test(
    "every step on a real fixture meeting",
    { tags: ["slow"] },
    async ({ db, workRoot }) => {
      const fixture = getMeetingData("gbos-2026-03-23");
      const audio = await getMeetingAudio(fixture);
      const meeting = {
        siteKind: "youtube",
        siteId: fixture.youtube_id,
      } as const;
      // Fake only the network: metadata is canned and "download" links the
      // cached fixture audio. Every other step runs for real.
      const youtube = fakeSite({
        getMetadata: async () => ({ ...METADATA, id: fixture.youtube_id }),
        ensureAudioDownloaded: async (_id, path) => {
          await mkdir(join(path, ".."), { recursive: true });
          await symlink(audio.path, path);
          return { downloaded: true };
        },
      });
      const { meetingId } = await addMeeting(db, youtube, meeting, ["gbos"]);
      const dir = await meetingWorkDir(workRoot, meeting);
      await downloadAudio(youtube, fixture.youtube_id, dir);
      await transcribe(dir);
      await clean(dir);
      await diarize(dir);
      await align(dir);
      await embedSpeakers(dir);
      await recognizeSpeakers(db, dir);
      await saveTranscript(db, meetingId, dir);

      for (const file of ["transcription.json", "diarization.json"])
        expect(existsSync(join(dir, file))).toBe(true);
      const segments = await db.select().from(segmentsTable);
      expect(segments.length).toBeGreaterThan(0);
      expect(segments.some((s) => s.person_id !== null)).toBe(true);
    },
  );
});
