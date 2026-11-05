import { describe, expect } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { peopleTable, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { datasetState } from "@open-minutes/seed";
import { applyOps, fixRules } from "./edit";
import { findMeetingId, loadMeeting } from "./meeting";
import { parseOps } from "./ops";
import { labelOf, render } from "./view";

const test = dbTest({ data: datasetState("all") });
const SLUG = "gbos-2026-03-23";

describe("applyOps", () => {
  test("saves an edit, keeping the ids of segments it didn't move", async ({
    db,
  }) => {
    const id = await findMeetingId(db, SLUG);
    const before = await loadMeeting(db, id);
    const result = await applyOps(
      db,
      id,
      parseOps(
        [
          "# Kyle answers",
          '{"op":"split","at":"0:00:47.09","word":"Sorry,","speaker":"identified:kyle-kelley"}',
          '{"op":"replace","at":"0:00:52.69","old":"It\'s","new":"It is"}',
        ].join("\n"),
      ),
    );
    expect(result.saved).toBe(true);
    expect(result.rows).toEqual({ updated: 1, inserted: 1, deleted: 0 });
    const after = await loadMeeting(db, id);
    expect(after.segments).toHaveLength(before.segments.length + 1);
    expect(after.segments[3]!.id).toBe(before.segments[3]!.id);
    expect(labelOf(after.segments[4]!, after.people)).toBe(
      "identified:kyle-kelley",
    );
    expect(render(after, { seg: 4 })).toContain("[0:00:52.69] It is March 23");
  });

  test("a dry run saves nothing", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const result = await applyOps(
      db,
      id,
      parseOps('{"op":"replace_all","old":"GBOS","new":"the board"}'),
      { dryRun: true },
    );
    expect(result.saved).toBe(false);
    expect(result.notes[0]).toMatch(/: [1-9]\d*$/);
    const rows = await db
      .select({ text: segmentsTable.text })
      .from(segmentsTable)
      .where(eq(segmentsTable.meeting_id, id));
    expect(rows.some((r) => r.text?.includes("GBOS"))).toBe(true);
  });

  test("doesn't save an edit that adds a rule error", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const result = await applyOps(
      db,
      id,
      parseOps('{"op":"insert","words":["0:00:45.00 um"]}'),
    );
    expect(result.saved).toBe(false);
    expect(result.added.map((i) => i.code)).toEqual(["filler-word"]);
  });

  test("names a person, then labels a segment with them", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const [anon] = await db
      .update(peopleTable)
      .set({ slug: null, name: null })
      .where(eq(peopleTable.slug, "kyle-kelley"))
      .returning({ id: peopleTable.id });
    const result = await applyOps(
      db,
      id,
      parseOps(
        [
          '{"op":"label","at":"0:00:07.81","speaker":"identified:kyle-kelley"}',
          `{"op":"person","person":"person:${anon!.id}","slug":"kyle-kelley","name":"Kyle Kelley"}`,
        ].join("\n"),
      ),
    );
    expect(result.saved).toBe(true);
    const after = await loadMeeting(db, id);
    expect(after.segments[0]!.person).toBe(anon!.id);
  });

  test("refuses a label no one has", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    await expect(
      applyOps(
        db,
        id,
        parseOps(
          '{"op":"label","at":"0:00:07.81","speaker":"identified:nobody"}',
        ),
      ),
    ).rejects.toThrow(/^op 1: no person with slug "nobody"/);
  });
});

describe("fixRules", () => {
  test("drops a filler the transcript gained", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    await applyOps(
      db,
      id,
      parseOps('{"op":"insert","words":["0:00:45.00 um"]}'),
      { allowErrors: true },
    );
    const result = await fixRules(db, id);
    expect(result.saved).toBe(true);
    expect(result.notes).toEqual([expect.stringMatching(/^fixed filler-word/)]);
    const after = await loadMeeting(db, id);
    expect(after.segments[3]!.words.map((w) => w.text)).not.toContain("um");
  });
});
