import { describe, expect, test as plainTest } from "vitest";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { devData } from "@open-minutes/fixtures/dev-data";
import { toolContext } from "./context";
import {
  callTool,
  type Db,
  parametersOf,
  toAgentTool,
  ToolError,
} from "./tool";
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
  updateMeeting,
  splitSegment,
  tools,
  updatePerson,
} from "./tools";

const test = dbTest({ data: devData });
/** The March 23, 2026 GBOS golden meeting, the one with chapters. */
const GBOS = "gbos-2026-03-23";

async function personId(db: Db, slug: string) {
  const [p] = await callTool(toolContext(db), findPeople, { query: slug });
  return p!.id;
}

/** Brian Burnett's "This is Brian Burnett chiming in" segment. */
async function brianSegment(db: Db) {
  const segments = await callTool(toolContext(db), getTranscript, {
    meeting: GBOS,
  });
  return segments.find((s) => s.text.includes("Burnett chiming"))!;
}

describe("reading", () => {
  test("lists meetings with their sizes", async ({ db }) => {
    const meetings = await callTool(toolContext(db), listMeetings, {});
    const gbos = meetings.find((m) => m.slug === GBOS);
    expect(gbos).toMatchObject({ bodies: ["GBOS"], chapters: 34 });
    expect(gbos!.segments).toBeGreaterThan(200);
  });

  test("reads part of a transcript, with words on request", async ({ db }) => {
    const part = await callTool(toolContext(db), getTranscript, {
      meeting: GBOS,
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
    const speakers = await callTool(toolContext(db), listSpeakers, {
      meeting: GBOS,
    });
    expect(speakers[0]!.speaker).toMatchObject({ slug: "mike-edgington" });
    expect(speakers[0]!.secs).toBeGreaterThan(speakers[1]!.secs);
  });

  test("a clean meeting has no issues", async ({ db }) => {
    expect(
      await callTool(toolContext(db), checkMeetingTool, { meeting: GBOS }),
    ).toEqual([]);
  });

  test("takes a meeting by slug or by id", async ({ db }) => {
    const meetings = await callTool(toolContext(db), listMeetings, {});
    const { id } = meetings.find((m) => m.slug === GBOS)!;
    const bySlug = await callTool(toolContext(db), getChapters, {
      meeting: GBOS,
    });
    expect(bySlug.length).toBeGreaterThan(0);
    for (const meeting of [id, `${id}`])
      expect(await callTool(toolContext(db), getChapters, { meeting })).toEqual(
        bySlug,
      );
  });

  test("refuses bad input with a readable message", async ({ db }) => {
    await expect(
      callTool(toolContext(db), getTranscript, { meeting: -1 }),
    ).rejects.toThrow(/Invalid input for get_transcript[\s\S]*meeting/);
    await expect(
      callTool(toolContext(db), checkMeetingTool, { meeting: 999 }),
    ).rejects.toThrow(/No meeting with id "999"/);
    await expect(
      callTool(toolContext(db), getTranscript, { meeting: "gbos_nope" }),
    ).rejects.toThrow(/No meeting with slug "gbos_nope"/);
    await expect(
      callTool(toolContext(db), getTranscript, { meeting: "99999999999" }),
    ).rejects.toThrow(ToolError);
  });
});

describe("relabel_segments", () => {
  test("a dry run saves nothing", async ({ db }) => {
    const seg = await brianSegment(db);
    const mike = await personId(db, "mike-edgington");
    const out = await callTool(toolContext(db), relabelSegments, {
      segmentIds: [seg.id],
      speaker: { personId: mike },
      dryRun: true,
    });
    expect(out.applied).toBe(false);
    expect(out.issues).toEqual([]);
    expect((await brianSegment(db)).speaker).toMatchObject({
      slug: "brian-burnett",
    });
  });

  test("saves, and can make speech unattributed", async ({ db }) => {
    const seg = await brianSegment(db);
    const out = await callTool(toolContext(db), relabelSegments, {
      segmentIds: [seg.id],
      speaker: {},
    });
    expect(out.applied).toBe(true);
    expect((await brianSegment(db)).speaker).toBeNull();
  });
});

describe("split_segment and merge_segments", () => {
  test("split then merge restores the segment", async ({ db }) => {
    const seg = await brianSegment(db);
    const split = await callTool(toolContext(db), splitSegment, {
      segmentId: seg.id,
      atWord: 3,
      speaker: { speakerNumber: 42 },
    });
    expect(split.applied).toBe(true);
    const after = await callTool(toolContext(db), getTranscript, {
      meeting: GBOS,
    });
    const i = after.findIndex((s) => s.id === seg.id);
    expect(after[i]!.text).toBe("I have I");
    expect(after[i + 1]).toMatchObject({
      id: split.result.newSegmentId,
      speaker: { speakerNumber: 42 },
    });

    const merged = await callTool(toolContext(db), mergeSegments, {
      segmentIds: [split.result.newSegmentId, seg.id],
    });
    expect(merged.applied).toBe(true);
    expect((await brianSegment(db)).text).toBe(seg.text);
  });

  test("refuses segments that aren't next to each other", async ({ db }) => {
    const [a, , c] = await callTool(toolContext(db), getTranscript, {
      meeting: GBOS,
    });
    await expect(
      callTool(toolContext(db), mergeSegments, { segmentIds: [a!.id, c!.id] }),
    ).rejects.toThrow(/consecutive/);
  });

  test("refuses a split point outside the segment", async ({ db }) => {
    const seg = await brianSegment(db);
    await expect(
      callTool(toolContext(db), splitSegment, {
        segmentId: seg.id,
        atWord: 999,
      }),
    ).rejects.toThrow(/atWord must be/);
  });
});

describe("people", () => {
  test("names a person, and refuses a slug someone else has", async ({
    db,
  }) => {
    const id = await personId(db, "bray-keefer");
    const out = await callTool(toolContext(db), updatePerson, {
      personId: id,
      bio: "Landscape architect.",
    });
    expect(out.result).toMatchObject({
      slug: "bray-keefer",
      bio: "Landscape architect.",
    });
    await expect(
      callTool(toolContext(db), updatePerson, {
        personId: id,
        slug: "kyle-kelley",
      }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  test("refuses an en or em dash in a name or bio", async ({ db }) => {
    const id = await personId(db, "bray-keefer");
    await expect(
      callTool(toolContext(db), updatePerson, {
        personId: id,
        bio: "Planner 2019–2022.",
      }),
    ).rejects.toThrow(/plain hyphen/);
    await expect(
      callTool(toolContext(db), updatePerson, {
        personId: id,
        name: "Bray — Keefer",
      }),
    ).rejects.toThrow(/plain hyphen/);
  });

  test("merges one voice split across two people", async ({ db }) => {
    const keep = await personId(db, "kellie-okonek");
    const merge = await personId(db, "brianna-sullivan");
    const before = await callTool(toolContext(db), listSpeakers, {
      meeting: GBOS,
    });
    const segs = (slug: string) =>
      before.find(
        (s) => s.speaker && "slug" in s.speaker && s.speaker.slug === slug,
      )!.segments;
    const expected = segs("kellie-okonek") + segs("brianna-sullivan");

    const out = await callTool(toolContext(db), mergePeople, {
      keepId: keep,
      mergeId: merge,
    });
    expect(out.applied).toBe(true);
    const after = await callTool(toolContext(db), listSpeakers, {
      meeting: GBOS,
    });
    expect(
      after.find(
        (s) =>
          s.speaker &&
          "slug" in s.speaker &&
          s.speaker.slug === "kellie-okonek",
      )!.segments,
    ).toBe(expected);
    expect(
      await callTool(toolContext(db), findPeople, { query: "brianna" }),
    ).toEqual([]);
  });
});

describe("update_meeting", () => {
  test("makes a meeting joint, and back", async ({ db }) => {
    const ctx = toolContext(db);
    const bodiesOf = async () =>
      (await callTool(ctx, listMeetings, {})).find((m) => m.slug === GBOS)!
        .bodies;
    expect(await bodiesOf()).toEqual(["GBOS"]);

    const result = await callTool(ctx, updateMeeting, {
      meeting: GBOS,
      bodies: ["gbos", "LUC", "luc"],
    });
    expect(result.applied).toBe(true);
    expect(result.result.bodies).toEqual(["GBOS", "LUC"]);
    expect(await bodiesOf()).toEqual(["GBOS", "LUC"]);

    await callTool(ctx, updateMeeting, { meeting: GBOS, bodies: ["gbos"] });
    expect(await bodiesOf()).toEqual(["GBOS"]);
  });

  test("sets the fields given and leaves the rest", async ({ db }) => {
    const ctx = toolContext(db);
    const before = (await callTool(ctx, listMeetings, {})).find(
      (m) => m.slug === GBOS,
    )!;
    const { result } = await callTool(ctx, updateMeeting, {
      meeting: GBOS,
      title: "Renamed",
      time: "19:00",
      timezone: "America/Juneau",
    });
    expect(result).toMatchObject({
      title: "Renamed",
      date: before.date,
      time: "19:00:00",
      timezone: "America/Juneau",
      bodies: ["GBOS"],
    });

    // Clearing the date clears the time with it.
    const cleared = await callTool(ctx, updateMeeting, {
      meeting: GBOS,
      date: null,
    });
    expect(cleared.result).toMatchObject({ date: null, time: null });
  });

  test("refuses bad values", async ({ db }) => {
    const ctx = toolContext(db);
    const refuses = (input: object, error?: RegExp) =>
      expect(
        callTool(ctx, updateMeeting, { meeting: GBOS, ...input }),
      ).rejects.toThrow(error);
    await refuses({}, /Nothing to change/);
    await refuses({ bodies: [] });
    await refuses({ bodies: ["nope"] }, /No body with slug "nope"/);
    await refuses({ date: "June 15" });
    await refuses({ time: "7pm" });
    await refuses({ timezone: "Mars/Olympus" });
    await refuses({ date: null, time: "19:00" }, /needs a date/);
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
    const out = await callTool(toolContext(db), replaceChapters, {
      meeting: GBOS,
      model: "human",
      reviewedByHuman: true,
      chapters: [
        chapter(0, 5000, "First half"),
        chapter(5000, 9957, "Second half"),
      ],
    });
    expect(out.applied).toBe(true);
    expect(
      (await callTool(toolContext(db), getChapters, { meeting: GBOS })).map(
        (c) => c.title,
      ),
    ).toEqual(["First half", "Second half"]);
    // Two 80-minute chapters break the size convention: warned, still saved.
    expect(out.issues.every((i) => i.severity === "warning")).toBe(true);
  });

  test("refuses overlapping chapters before touching the database", async ({
    db,
  }) => {
    await expect(
      callTool(toolContext(db), replaceChapters, {
        meeting: GBOS,
        model: "human",
        chapters: [chapter(0, 100), chapter(50, 200)],
      }),
    ).rejects.toThrow(
      /chapter 2 \("50"\) starts before the previous chapter ends/,
    );
  });

  test("rolls back a change that introduces an error", async ({ db }) => {
    const before = await callTool(toolContext(db), getChapters, {
      meeting: GBOS,
    });
    const out = await callTool(toolContext(db), replaceChapters, {
      meeting: GBOS,
      model: "human",
      chapters: [chapter(0, 99_999, "Runs past the end")],
    });
    expect(out.applied).toBe(false);
    expect(out.newErrors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/ends after the meeting does/),
      }),
    ]);
    expect(
      await callTool(toolContext(db), getChapters, { meeting: GBOS }),
    ).toEqual(before);
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
    const agentTool = toAgentTool(listMeetings, toolContext(db));
    expect(agentTool).toMatchObject({
      name: "list_meetings",
      label: "List meetings",
    });
    const result = await agentTool.execute("call-1", {});
    expect(result.content[0]!.type).toBe("text");
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });
});
