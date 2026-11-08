import { describe, expect } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { type DB, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { datasetState } from "@open-minutes/seed";
import { fixRules } from "./edit";
import { findMeetingId, loadMeeting, saveSegments } from "./meeting";
import { labelOf, render } from "./view";

const test = dbTest({ data: datasetState("all") });
const SLUG = "gbos-2026-03-23";

/** Add a filler at the start of the meeting's fourth segment. */
async function addFiller(db: DB, id: number): Promise<void> {
  const seg = (await loadMeeting(db, id)).segments[3]!;
  await db
    .update(segmentsTable)
    .set({
      words: [{ text: "um", start: seg.words[0]!.start - 0.1 }, ...seg.words],
    })
    .where(eq(segmentsTable.id, seg.id));
}

describe("fixRules", () => {
  test("drops a filler the transcript gained", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    await addFiller(db, id);
    const result = await fixRules(db, id);
    expect(result.saved).toBe(true);
    expect(result.notes).toEqual([expect.stringMatching(/^fixed filler-word/)]);
    const after = await loadMeeting(db, id);
    expect(after.segments[3]!.words.map((w) => w.text)).not.toContain("um");
  });

  test("a dry run saves nothing", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    await addFiller(db, id);
    const result = await fixRules(db, id, { dryRun: true });
    expect(result.saved).toBe(false);
    const after = await loadMeeting(db, id);
    expect(after.segments[3]!.words[0]!.text).toBe("um");
  });

  test("changes nothing in a clean meeting", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const result = await fixRules(db, id);
    expect(result.notes).toEqual([]);
    expect(result.rows).toEqual({ updated: 0, inserted: 0, deleted: 0 });
  });
});

describe("saveSegments", () => {
  test("keeps the ids of segments that start on the same word", async ({
    db,
  }) => {
    const id = await findMeetingId(db, SLUG);
    const before = await loadMeeting(db, id);
    const kyle = before.segments.find(
      (s) => labelOf(s, before.people) === "identified:kyle-kelley",
    )!.person;
    // Split the fourth segment at its tenth word, giving the rest to Kyle.
    const seg = before.segments[3]!;
    const after = [
      ...before.segments.slice(0, 3),
      { ...seg, words: seg.words.slice(0, 10) },
      { speakerNumber: null, person: kyle, words: seg.words.slice(10) },
      ...before.segments.slice(4),
    ];
    const saved = await saveSegments(db, id, before.segments, after);
    expect(saved).toEqual({ updated: 1, inserted: 1, deleted: 0 });
    const reloaded = await loadMeeting(db, id);
    expect(reloaded.segments[3]!.id).toBe(seg.id);
    expect(render(reloaded, { seg: 4 })).toContain("identified:kyle-kelley");
  });
});
