import { describe, expect, test as plainTest } from "vitest";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { devData } from "@open-minutes/fixtures/dev-data";
import { callTool, parametersOf, toAgentTool, ToolError } from "./tool";
import {
  checkMeetingTool,
  findPeople,
  getChapters,
  getTranscript,
  listMeetings,
  listSpeakers,
  mergePeople,
  mergeSegments,
  relabelSegments,
  replaceChapters,
  splitSegment,
  tools,
  updatePerson,
} from "./tools";

const test = dbTest({ data: devData });
/** The March 23, 2026 GBOS golden meeting, the one with chapters. */
async function gbosId(db: Parameters<typeof callTool>[0]) {
  const meetings = await callTool(db, listMeetings, {});
  return meetings.find((m) => m.youtubeId === "9HoIM5INxpI")!.id;
}

async function personId(db: Parameters<typeof callTool>[0], slug: string) {
  const [p] = await callTool(db, findPeople, { query: slug });
  return p!.id;
}

/** Bryan Burnett's "This is Brian Burnett chiming in" segment. */
async function bryanSegment(db: Parameters<typeof callTool>[0]) {
  const segments = await callTool(db, getTranscript, {
    meetingId: await gbosId(db),
  });
  return segments.find((s) => s.text.includes("Brian Burnett chiming"))!;
}

describe("reading", () => {
  test("lists meetings with their sizes", async ({ db }) => {
    const MEETING = await gbosId(db);
    const meetings = await callTool(db, listMeetings, {});
    const gbos = meetings.find((m) => m.id === MEETING);
    expect(gbos).toMatchObject({ body: "GBOS", chapters: 34 });
    expect(gbos!.segments).toBeGreaterThan(200);
  });

  test("reads part of a transcript, with words on request", async ({ db }) => {
    const MEETING = await gbosId(db);
    const part = await callTool(db, getTranscript, {
      meetingId: MEETING,
      from: 600,
      to: 700,
      words: true,
    });
    expect(part.length).toBeGreaterThan(0);
    for (const s of part) {
      expect(s.end).toBeGreaterThanOrEqual(600);
      expect(s.start).toBeLessThanOrEqual(700);
      expect(s.words![0]).toMatchObject({ i: 0 });
    }
  });

  test("tallies speakers, longest first", async ({ db }) => {
    const MEETING = await gbosId(db);
    const speakers = await callTool(db, listSpeakers, { meetingId: MEETING });
    expect(speakers[0]!.speaker).toMatchObject({ slug: "mike-edgington" });
    expect(speakers[0]!.secs).toBeGreaterThan(speakers[1]!.secs);
  });

  test("a clean meeting has no issues", async ({ db }) => {
    const MEETING = await gbosId(db);
    expect(
      await callTool(db, checkMeetingTool, { meetingId: MEETING }),
    ).toEqual([]);
  });

  test("refuses bad input with a readable message", async ({ db }) => {
    await expect(
      callTool(db, getTranscript, { meetingId: "one" }),
    ).rejects.toThrow(/Invalid input for get_transcript[\s\S]*meetingId/);
    await expect(
      callTool(db, checkMeetingTool, { meetingId: 999 }),
    ).rejects.toThrow(ToolError);
  });
});

describe("relabel_segments", () => {
  test("a dry run saves nothing", async ({ db }) => {
    const seg = await bryanSegment(db);
    const mike = await personId(db, "mike-edgington");
    const out = await callTool(db, relabelSegments, {
      segmentIds: [seg.id],
      speaker: { personId: mike },
      dryRun: true,
    });
    expect(out.applied).toBe(false);
    expect(out.issues).toEqual([]);
    expect((await bryanSegment(db)).speaker).toMatchObject({
      slug: "bryan-burnett",
    });
  });

  test("saves, and can make speech unattributed", async ({ db }) => {
    const seg = await bryanSegment(db);
    const out = await callTool(db, relabelSegments, {
      segmentIds: [seg.id],
      speaker: {},
    });
    expect(out.applied).toBe(true);
    expect((await bryanSegment(db)).speaker).toBeNull();
  });
});

describe("split_segment and merge_segments", () => {
  test("split then merge restores the segment", async ({ db }) => {
    const MEETING = await gbosId(db);
    const seg = await bryanSegment(db);
    const split = await callTool(db, splitSegment, {
      segmentId: seg.id,
      atWord: 3,
      speaker: { speakerNumber: 42 },
    });
    expect(split.applied).toBe(true);
    const after = await callTool(db, getTranscript, { meetingId: MEETING });
    const i = after.findIndex((s) => s.id === seg.id);
    expect(after[i]!.text).toBe("I have I");
    expect(after[i + 1]).toMatchObject({
      id: split.result.newSegmentId,
      speaker: { speakerNumber: 42 },
    });

    const merged = await callTool(db, mergeSegments, {
      segmentIds: [split.result.newSegmentId, seg.id],
    });
    expect(merged.applied).toBe(true);
    expect((await bryanSegment(db)).text).toBe(seg.text);
  });

  test("refuses segments that aren't next to each other", async ({ db }) => {
    const MEETING = await gbosId(db);
    const [a, , c] = await callTool(db, getTranscript, { meetingId: MEETING });
    await expect(
      callTool(db, mergeSegments, { segmentIds: [a!.id, c!.id] }),
    ).rejects.toThrow(/consecutive/);
  });

  test("refuses a split point outside the segment", async ({ db }) => {
    const seg = await bryanSegment(db);
    await expect(
      callTool(db, splitSegment, { segmentId: seg.id, atWord: 999 }),
    ).rejects.toThrow(/atWord must be/);
  });
});

describe("people", () => {
  test("names a person, and refuses a slug someone else has", async ({
    db,
  }) => {
    const id = await personId(db, "bray-keefer");
    const out = await callTool(db, updatePerson, {
      personId: id,
      bio: "Landscape architect.",
    });
    expect(out.result).toMatchObject({
      slug: "bray-keefer",
      bio: "Landscape architect.",
    });
    await expect(
      callTool(db, updatePerson, { personId: id, slug: "kyle-kelly" }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  test("refuses an en or em dash in a name or bio", async ({ db }) => {
    const id = await personId(db, "bray-keefer");
    await expect(
      callTool(db, updatePerson, { personId: id, bio: "Planner 2019–2022." }),
    ).rejects.toThrow(/plain hyphen/);
    await expect(
      callTool(db, updatePerson, { personId: id, name: "Bray — Keefer" }),
    ).rejects.toThrow(/plain hyphen/);
  });

  test("merges one voice split across two people", async ({ db }) => {
    const MEETING = await gbosId(db);
    const keep = await personId(db, "kellie-okonek");
    const merge = await personId(db, "brianna-sullivan");
    const before = await callTool(db, listSpeakers, { meetingId: MEETING });
    const segs = (slug: string) =>
      before.find(
        (s) => s.speaker && "slug" in s.speaker && s.speaker.slug === slug,
      )!.segments;
    const expected = segs("kellie-okonek") + segs("brianna-sullivan");

    const out = await callTool(db, mergePeople, {
      keepId: keep,
      mergeId: merge,
    });
    expect(out.applied).toBe(true);
    const after = await callTool(db, listSpeakers, { meetingId: MEETING });
    expect(
      after.find(
        (s) =>
          s.speaker &&
          "slug" in s.speaker &&
          s.speaker.slug === "kellie-okonek",
      )!.segments,
    ).toBe(expected);
    expect(await callTool(db, findPeople, { query: "brianna" })).toEqual([]);
  });
});

describe("replace_chapters", () => {
  const chapter = (start: number, end: number, title = `${start}`) => ({
    start,
    end,
    title,
    summary: "Something happened.",
  });

  test("replaces the chapters as a new generation", async ({ db }) => {
    const MEETING = await gbosId(db);
    const out = await callTool(db, replaceChapters, {
      meetingId: MEETING,
      model: "human",
      reviewedByHuman: true,
      chapters: [
        chapter(0, 5000, "First half"),
        chapter(5000, 9957, "Second half"),
      ],
    });
    expect(out.applied).toBe(true);
    expect(
      (await callTool(db, getChapters, { meetingId: MEETING })).map(
        (c) => c.title,
      ),
    ).toEqual(["First half", "Second half"]);
    // Two 80-minute chapters break the size convention: warned, still saved.
    expect(out.issues.every((i) => i.severity === "warning")).toBe(true);
  });

  test("refuses overlapping chapters before touching the database", async ({
    db,
  }) => {
    const MEETING = await gbosId(db);
    await expect(
      callTool(db, replaceChapters, {
        meetingId: MEETING,
        model: "human",
        chapters: [chapter(0, 100), chapter(50, 200)],
      }),
    ).rejects.toThrow(
      /chapter 2 \("50"\) starts before the previous chapter ends/,
    );
  });

  test("rolls back a change that introduces an error", async ({ db }) => {
    const MEETING = await gbosId(db);
    const before = await callTool(db, getChapters, { meetingId: MEETING });
    const out = await callTool(db, replaceChapters, {
      meetingId: MEETING,
      model: "human",
      chapters: [chapter(0, 99_999, "Runs past the end")],
    });
    expect(out.applied).toBe(false);
    expect(out.newErrors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/ends after the meeting does/),
      }),
    ]);
    expect(await callTool(db, getChapters, { meetingId: MEETING })).toEqual(
      before,
    );
  });
});

describe("tool definitions", () => {
  plainTest("have unique snake_case names and object JSON Schemas", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(parametersOf(t)).toMatchObject({ type: "object" });
    }
  });

  test("adapt to pi's AgentTool shape", async ({ db }) => {
    const agentTool = toAgentTool(listMeetings, db);
    expect(agentTool).toMatchObject({
      name: "list_meetings",
      label: "List meetings",
    });
    const result = await agentTool.execute("call-1", {});
    expect(result.content[0]!.type).toBe("text");
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });
});
