import { describe, expect, test as plainTest } from "vitest";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { eq } from "drizzle-orm";
import {
  BODY_RULE_SPECS,
  checkMeeting as checkMeetingData,
  RULE_SPECS,
} from "@open-minutes/core/rules";
import { segmentsTable } from "@open-minutes/db";
import { ruleMeeting } from "@open-minutes/fixtures/check";
import { devData } from "@open-minutes/fixtures/dev-data";
import {
  loadAllTestData,
  meetingGlossary,
} from "@open-minutes/fixtures/test-data";
import { checkMeeting } from "./check";
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
  getGlossary,
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
    expect(gbos).toMatchObject({ bodies: ["gbos"], chapters: 34 });
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

  test("checks every golden by the same rules as its files", async ({ db }) => {
    const meetings = await callTool(toolContext(db), listMeetings, {});
    for (const golden of loadAllTestData().meetings) {
      const { id } = meetings.find((m) => m.slug === golden.slug)!;
      const summary = (i: {
        severity: string;
        code: string;
        message: string;
      }) => `${golden.slug}: ${i.severity} ${i.code}: ${i.message}`;
      const { rules } = await meetingGlossary(golden.body_slugs);
      const specs = [
        ...RULE_SPECS,
        ...BODY_RULE_SPECS.filter((spec) => rules.includes(spec.code)),
      ];
      expect((await checkMeeting(db, id)).map(summary)).toEqual(
        (await checkMeetingData(ruleMeeting(golden), specs)).map(summary),
      );
    }
  });

  test("holds a meeting to its bodies' body-specific rules", async ({ db }) => {
    const { id } = await brianSegment(db);
    const [row] = await db
      .select({ words: segmentsTable.words })
      .from(segmentsTable)
      .where(eq(segmentsTable.id, id));
    const [first, ...rest] = row!.words;
    await db
      .update(segmentsTable)
      .set({ words: [{ ...first!, text: "AO2026-23" }, ...rest] })
      .where(eq(segmentsTable.id, id));
    expect(
      await callTool(toolContext(db), checkMeetingTool, { meeting: GBOS }),
    ).toContainEqual(
      expect.objectContaining({ code: "bill-number", segmentId: id }),
    );
  });

  test("gives a meeting the glossaries of its bodies", async ({ db }) => {
    const glossary = await callTool(toolContext(db), getGlossary, {
      meeting: GBOS,
    });
    expect(glossary.glossaries).toEqual([
      "common",
      "alaska",
      "moa",
      "girdwood",
    ]);
    expect(glossary.rules).toContain("bill-number");
    expect(glossary.entries).toContainEqual(
      expect.objectContaining({ headword: "GHEC" }),
    );
  });

  test("reports a filler as an error", async ({ db }) => {
    const { id } = await brianSegment(db);
    const [row] = await db
      .select({ words: segmentsTable.words })
      .from(segmentsTable)
      .where(eq(segmentsTable.id, id));
    const [first, ...rest] = row!.words;
    await db
      .update(segmentsTable)
      .set({
        words: [{ text: "Um,", start: first!.start - 0.1 }, first!, ...rest],
      })
      .where(eq(segmentsTable.id, id));
    expect(
      await callTool(toolContext(db), checkMeetingTool, { meeting: GBOS }),
    ).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "filler-word",
        segmentId: id,
      }),
    ]);
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
  test("saves, and can make speech unattributed", async ({ db }) => {
    const seg = await brianSegment(db);
    const out = await callTool(toolContext(db), relabelSegments, {
      segmentIds: [seg.id],
      speaker: {},
    });
    expect(out).toEqual({ relabelled: 1 });
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
    const after = await callTool(toolContext(db), getTranscript, {
      meeting: GBOS,
    });
    const i = after.findIndex((s) => s.id === seg.id);
    expect(after[i]!.text).toBe("I have I");
    expect(after[i + 1]).toMatchObject({
      id: split.newSegmentId,
      speaker: { speakerNumber: 42 },
    });

    const merged = await callTool(toolContext(db), mergeSegments, {
      segmentIds: [split.newSegmentId, seg.id],
    });
    expect(merged).toEqual({
      segmentId: seg.id,
      removed: [split.newSegmentId],
    });
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
    expect(out).toMatchObject({
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

    await callTool(toolContext(db), mergePeople, {
      keepId: keep,
      mergeId: merge,
    });
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
    expect(await bodiesOf()).toEqual(["gbos"]);

    const result = await callTool(ctx, updateMeeting, {
      meeting: GBOS,
      bodies: ["gbos", "LUC", "luc"],
    });
    expect(result.bodies).toEqual(["gbos", "luc"]);
    expect(await bodiesOf()).toEqual(["gbos", "luc"]);

    await callTool(ctx, updateMeeting, { meeting: GBOS, bodies: ["gbos"] });
    expect(await bodiesOf()).toEqual(["gbos"]);
  });

  test("sets the fields given and leaves the rest", async ({ db }) => {
    const ctx = toolContext(db);
    const before = (await callTool(ctx, listMeetings, {})).find(
      (m) => m.slug === GBOS,
    )!;
    const result = await callTool(ctx, updateMeeting, {
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
      bodies: ["gbos"],
    });

    // Clearing the date clears the time with it.
    const cleared = await callTool(ctx, updateMeeting, {
      meeting: GBOS,
      date: null,
    });
    expect(cleared).toMatchObject({ date: null, time: null });
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
    await refuses({ timezone: "Mars/Olympus" }, /not a known time zone/);
    await refuses({ timezone: "UTC" }, /not an IANA time zone name/);
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
    expect(out.chapters).toBe(2);
    expect(
      (await callTool(toolContext(db), getChapters, { meeting: GBOS })).map(
        (c) => c.title,
      ),
    ).toEqual(["First half", "Second half"]);
  });

  test("saves chapters that break the rules, for check_meeting to report", async ({
    db,
  }) => {
    await callTool(toolContext(db), replaceChapters, {
      meeting: GBOS,
      model: "human",
      chapters: [chapter(0, 99_999, "Runs past the end")],
    });
    expect(
      (await callTool(toolContext(db), getChapters, { meeting: GBOS })).map(
        (c) => c.title,
      ),
    ).toEqual(["Runs past the end"]);
    expect(
      await callTool(toolContext(db), checkMeetingTool, { meeting: GBOS }),
    ).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringMatching(/ends after the meeting does/),
      }),
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
