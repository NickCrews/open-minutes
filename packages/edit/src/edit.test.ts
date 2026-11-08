import { describe, expect } from "vite-plus/test";
import { eq, sql } from "drizzle-orm";
import { type DB, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { datasetState } from "@open-minutes/seed";
import { formatClock } from "@open-minutes/core/clock";
import { ChangesetError, fixRules, runChangeset } from "./edit";
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
    // The segment starts on another word, so it is a new row.
    expect(result.rows).toEqual({
      segments: { updated: 0, inserted: 1, deleted: 1 },
    });
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
    expect(result.rows).toEqual({});
  });
});

describe("runChangeset", () => {
  /** A changeset fixing the fourth segment's first word, and Kyle's bio. */
  async function changeset(db: DB, id: number): Promise<string> {
    const word = (await loadMeeting(db, id)).segments[3]!.words[0]!;
    return `
      SELECT om.assert(
        (SELECT bio FROM people WHERE slug = 'kyle-kelley') IS NOT NULL,
        'Kyle has a bio'
      );
      SELECT om.replace_words('${SLUG}', '${formatClock(word.start)}', '${word.text}', 'Fixed');
      UPDATE people SET bio = 'A new bio.' WHERE slug = 'kyle-kelley';
    `;
  }

  const bio = async (db: DB) =>
    (
      await db.execute<{ bio: string }>(
        sql`SELECT bio FROM people WHERE slug = 'kyle-kelley'`,
      )
    )[0]!.bio;

  test("saves a changeset, and counts the rows it changed", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const result = await runChangeset(db, id, await changeset(db, id));
    expect(result.saved).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.rows).toEqual({
      people: { updated: 1, inserted: 0, deleted: 0 },
      segments: { updated: 1, inserted: 0, deleted: 0 },
    });
    const after = await loadMeeting(db, id);
    expect(after.segments[3]!.words[0]!.text).toBe("Fixed");
    expect(await bio(db)).toBe("A new bio.");
  });

  test("a dry run saves nothing", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const before = await bio(db);
    const result = await runChangeset(db, id, await changeset(db, id), {
      dryRun: true,
    });
    expect(result.saved).toBe(false);
    expect(result.rows.segments).toEqual({
      updated: 1,
      inserted: 0,
      deleted: 0,
    });
    expect(result.meeting.segments[3]!.words[0]!.text).toBe("Fixed");
    expect((await loadMeeting(db, id)).segments[3]!.words[0]!.text).not.toBe(
      "Fixed",
    );
    expect(await bio(db)).toBe(before);
  });

  test("doesn't save a changeset that adds a rule error", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const seg = (await loadMeeting(db, id)).segments[3]!;
    const result = await runChangeset(
      db,
      id,
      `UPDATE segments SET words = jsonb_set(words, '{1,start}', '0') WHERE id = ${seg.id};`,
    );
    expect(result.saved).toBe(false);
    expect(result.added.map((i) => i.code)).toEqual(["word-out-of-order"]);
    expect((await loadMeeting(db, id)).segments[3]!.words).toEqual(seg.words);
  });

  test("a failed assertion stops it, with its message", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const before = await bio(db);
    const run = runChangeset(
      db,
      id,
      `UPDATE people SET bio = 'x' WHERE slug = 'kyle-kelley';
       SELECT om.assert(false, 'Kyle has no slug');`,
    );
    await expect(run).rejects.toThrow(
      new ChangesetError("assertion failed: Kyle has no slug", true),
    );
    await expect(run).rejects.toMatchObject({ assertion: true });
    expect(await bio(db)).toBe(before);
  });

  test("refuses a changeset that changes another meeting", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    await expect(
      runChangeset(
        db,
        id,
        `UPDATE meetings SET title = 'x' WHERE slug = 'gbos-2026-05-18';`,
      ),
    ).rejects.toThrow("the changeset changed other meetings: gbos-2026-05-18");
    await expect(
      runChangeset(
        db,
        id,
        `DELETE FROM segments WHERE id = (SELECT min(id) FROM segments WHERE meeting_id <> ${id});`,
      ),
    ).rejects.toThrow(/^the changeset changed other meetings: /);
  });

  test("runs as the changeset role, which may only change rows", async ({
    db,
  }) => {
    const id = await findMeetingId(db, SLUG);
    const refused = {
      "CREATE TABLE x (id int)": "permission denied for schema public",
      "ALTER TABLE segments ADD COLUMN x int":
        "must be owner of table segments",
      "UPDATE bodies SET name = 'x'": "permission denied for table bodies",
      "DELETE FROM chapters": "permission denied for table chapters",
      "UPDATE people SET created_at = now()":
        "permission denied for table people",
      "UPDATE meetings SET date = NULL": "permission denied for table meetings",
      "TRUNCATE segments": "permission denied for table segments",
      "RESET ROLE":
        'cannot set parameter "role" within security-definer function',
      "CREATE TEMP TABLE segments (id int)":
        "created or altered a database object",
      "ALTER FUNCTION om.run(text) SECURITY INVOKER":
        "created or altered a database object",
    };
    for (const [statement, error] of Object.entries(refused))
      await expect(runChangeset(db, id, statement), statement).rejects.toThrow(
        error,
      );
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
