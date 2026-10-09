import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { meetingWorkDir } from "@open-minutes/pipeline";
import { fakeSite, goldenTest as test } from "@open-minutes/pipeline/testing";
import { toolContext } from "../context";
import { callTool, ToolError } from "../tool";
import { listMeetings } from "../tools";
import {
  addMeetingTool,
  alignSpeakersTool,
  cleanTranscriptionTool,
  downloadAudioTool,
  findDateInTranscript,
  recognizeSpeakersTool,
  saveTranscriptTool,
} from "./tools";

const VIDEO_ID = "test-video-1";

const youtube = fakeSite({
  getMetadata: async () => ({
    id: VIDEO_ID,
    channelId: "UC_GBOS",
    title: "GBOS Regular Meeting",
    description: "",
    durationSecs: 60,
    uploadDate: "2026-06-16",
  }),
  ensureAudioDownloaded: async (_id, path) => {
    await writeFile(path, "not really audio");
    return { downloaded: true };
  },
});

/** What transcribe, diarize and embed_speakers would have written. */
async function writeModelOutputs(dir: string) {
  const json = (name: string, value: unknown) =>
    writeFile(join(dir, name), JSON.stringify(value));
  await json("transcription.json", [
    {
      start: 0,
      end: 4,
      words: [
        { text: "Call", start: 0.1 },
        { text: "the", start: 0.3 },
        { text: "regular", start: 0.5 },
        { text: "meeting", start: 0.9 },
        { text: "to", start: 1.2 },
        { text: "order,", start: 1.3 },
        { text: "June", start: 1.8 },
        { text: "15th,", start: 2.1 },
        { text: "at", start: 2.6 },
        { text: "7:02", start: 2.8 },
        { text: "p.m.", start: 3.2 },
      ],
    },
  ]);
  await json("diarization.json", {
    turns: [{ start: 0, end: 4, speakerNum: 0 }],
  });
  await json("embeddings.json", [
    { speaker: 0, centroid: new Array<number>(N_DIMENSIONS).fill(0.1) },
  ]);
}

describe("pipeline step tools", () => {
  test("take a meeting from its site to a saved transcript", async ({
    db,
    workRoot,
  }) => {
    const ctx = toolContext(db, { sites: { youtube }, workRoot });
    const added = await callTool(ctx, addMeetingTool, {
      id: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      bodies: ["gbos"],
    });
    expect(added).toMatchObject({ site: "youtube", id: VIDEO_ID, date: null });
    const listed = async () =>
      (await callTool(ctx, listMeetings, {})).find(
        (m) => m.id === added.meeting,
      );
    expect(await listed()).toMatchObject({ transcribed: false, segments: 0 });

    const meeting = added.meeting;
    await callTool(ctx, downloadAudioTool, { meeting });
    await writeModelOutputs(
      await meetingWorkDir(workRoot, { siteKind: "youtube", siteId: VIDEO_ID }),
    );
    await callTool(ctx, cleanTranscriptionTool, { meeting });
    await callTool(ctx, alignSpeakersTool, { meeting });
    expect(await callTool(ctx, recognizeSpeakersTool, { meeting })).toEqual([
      { speaker: 0, personId: null, similarity: null },
    ]);
    expect(await callTool(ctx, saveTranscriptTool, { meeting })).toEqual({
      segments: 1,
      recognized: 0,
      newPeople: 1,
    });
    expect(await listed()).toMatchObject({ transcribed: true, segments: 1 });

    expect(
      await callTool(ctx, findDateInTranscript, { meeting, year: 2026 }),
    ).toMatchObject({
      meeting: { date: null, time: null },
      transcript: { date: "2026-06-15", time: "19:02" },
    });

    await expect(
      callTool(ctx, saveTranscriptTool, { meeting }),
    ).rejects.toThrow(ToolError);
  });

  test("refuse a step whose input isn't there yet", async ({
    db,
    workRoot,
  }) => {
    const ctx = toolContext(db, { sites: { youtube }, workRoot });
    const { meeting } = await callTool(ctx, addMeetingTool, {
      id: VIDEO_ID,
      bodies: ["gbos"],
    });
    const refused = callTool(ctx, alignSpeakersTool, { meeting });
    await expect(refused).rejects.toThrow(ToolError);
    await expect(refused).rejects.toThrow(/run clean_transcription first/);
  });
});
