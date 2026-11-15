import { describe, expect } from "vite-plus/test";
import { eq, sql } from "drizzle-orm";
import { type DB, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { datasetState } from "@open-minutes/seed";
import { formatClock } from "@open-minutes/core/clock";
import {
  applyChangeset,
  ChangesetError,
  checkChangeset,
  fixRules,
} from "./edit";
import { findMeetingId, loadMeeting, lockEdits, saveSegments } from "./meeting";
import { labelOf, render } from "./view";

const test = dbTest({ data: datasetState("all") });
const SLUG = "gbos-2026-03-23";
const OTHER = "gbos-2026-05-18";

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
    const result = await fixRules({ db, meetingId: id });
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
    const result = await fixRules({ db, meetingId: id, dryRun: true });
    expect(result.saved).toBe(false);
    const after = await loadMeeting(db, id);
    expect(after.segments[3]!.words[0]!.text).toBe("um");
  });

  test("changes nothing in a clean meeting", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const result = await fixRules({ db, meetingId: id });
    expect(result.notes).toEqual([]);
    expect(result.rows).toEqual({});
  });
});

describe("changesets", () => {
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

  /** A changeset that moves the meeting's fourth segment's second word to 0. */
  async function outOfOrder(db: DB, slug: string): Promise<string> {
    const id = await findMeetingId(db, slug);
    const seg = (await loadMeeting(db, id)).segments[3]!;
    return `UPDATE segments SET words = jsonb_set(words, '{1,start}', '0') WHERE id = ${seg.id};\n`;
  }

  const bio = async (db: DB) =>
    (
      await db.execute<{ bio: string }>(
        sql`SELECT bio FROM people WHERE slug = 'kyle-kelley'`,
      )
    )[0]!.bio;

  test("saves a changeset, and counts the rows it changed", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const result = await applyChangeset({ db, sql: await changeset(db, id) });
    expect(result).toEqual({
      rows: {
        people: { updated: 1, inserted: 0, deleted: 0 },
        segments: { updated: 1, inserted: 0, deleted: 0 },
      },
      meetings: [{ id, slug: SLUG }],
    });
    const after = await loadMeeting(db, id);
    expect(after.segments[3]!.words[0]!.text).toBe("Fixed");
    expect(await bio(db)).toBe("A new bio.");
  });

  test("checking one saves nothing", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const before = await bio(db);
    const result = await checkChangeset({ db, sql: await changeset(db, id) });
    expect(result.rows.segments).toEqual({
      updated: 1,
      inserted: 0,
      deleted: 0,
    });
    const [meeting] = result.meetings;
    expect(result.meetings).toHaveLength(1);
    expect(meeting!.after.id).toBe(id);
    expect(meeting!.after.segments[3]!.words[0]!.text).toBe("Fixed");
    expect(meeting!.before.segments[3]!.words[0]!.text).not.toBe("Fixed");
    expect((await loadMeeting(db, id)).segments[3]!.words[0]!.text).not.toBe(
      "Fixed",
    );
    expect(await bio(db)).toBe(before);
  });

  test("saves a changeset whatever the meeting rules would find", async ({
    db,
  }) => {
    const id = await findMeetingId(db, SLUG);
    await applyChangeset({ db, sql: await outOfOrder(db, SLUG) });
    expect((await loadMeeting(db, id)).segments[3]!.words[1]!.start).toBe(0);
  });

  test("checking one reports the violations it introduces and resolves", async ({
    db,
  }) => {
    const id = await findMeetingId(db, SLUG);
    const seg = (await loadMeeting(db, id)).segments[3]!;
    const breaks = await outOfOrder(db, SLUG);
    const [introduced] = (await checkChangeset({ db, sql: breaks })).meetings;
    expect(introduced!.added.map((i) => i.code)).toEqual(["word-out-of-order"]);
    expect(introduced!.resolved).toEqual([]);
    await applyChangeset({ db, sql: breaks });
    const [resolved] = (
      await checkChangeset({
        db,
        sql: `UPDATE segments SET words = $w$${JSON.stringify(seg.words)}$w$ WHERE id = ${seg.id};`,
      })
    ).meetings;
    expect(resolved!.resolved.map((i) => i.code)).toEqual([
      "word-out-of-order",
    ]);
    expect(resolved!.added).toEqual([]);
  });

  test("changes and checks any number of meetings", async ({ db }) => {
    const meetings = [
      { id: await findMeetingId(db, SLUG), slug: SLUG },
      { id: await findMeetingId(db, OTHER), slug: OTHER },
    ].sort((a, b) => a.id - b.id);
    const both =
      (await outOfOrder(db, SLUG)) +
      (await outOfOrder(db, OTHER)) +
      `UPDATE meetings SET title = title || '!' WHERE slug = '${OTHER}';`;
    const checked = await checkChangeset({ db, sql: both });
    expect(checked.rows).toEqual({
      meetings: { updated: 1, inserted: 0, deleted: 0 },
      segments: { updated: 2, inserted: 0, deleted: 0 },
    });
    expect(
      checked.meetings.map((m) => [m.after.slug, m.added.map((i) => i.code)]),
    ).toEqual(meetings.map((m) => [m.slug, ["word-out-of-order"]]));
    expect((await applyChangeset({ db, sql: both })).meetings).toEqual(
      meetings,
    );
  });

  test("a changeset that changes only people changes no meetings", async ({
    db,
  }) => {
    const changeset = `UPDATE people SET bio = 'x' WHERE slug = 'kyle-kelley';`;
    expect((await checkChangeset({ db, sql: changeset })).meetings).toEqual([]);
    expect((await applyChangeset({ db, sql: changeset })).meetings).toEqual([]);
  });

  test("a failed assertion stops it, with its message", async ({ db }) => {
    const before = await bio(db);
    const applied = applyChangeset({
      db,
      sql: `UPDATE people SET bio = 'x' WHERE slug = 'kyle-kelley';
       SELECT om.assert(false, 'Kyle has no slug');`,
    });
    await expect(applied).rejects.toThrow(
      new ChangesetError("assertion failed: Kyle has no slug", true),
    );
    await expect(applied).rejects.toMatchObject({ assertion: true });
    expect(await bio(db)).toBe(before);
  });

  test("applying one waits for another edit to finish", async ({ db }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const other = db.transaction(async (tx) => {
      await lockEdits(tx);
      locked();
      await held;
      await tx.execute(
        sql`UPDATE people SET bio = 'first' WHERE slug = 'kyle-kelley'`,
      );
    });
    await lockTaken;
    let applied = false;
    const apply = applyChangeset({
      db,
      sql: `SELECT om.assert((SELECT bio FROM people WHERE slug = 'kyle-kelley') = 'first', 'sees the other edit');
        UPDATE people SET bio = 'second' WHERE slug = 'kyle-kelley';`,
    }).then(() => (applied = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(applied).toBe(false);
    release();
    await other;
    await apply;
    expect(await bio(db)).toBe("second");
  });

  test("runs as the changeset role, which may only change rows", async ({
    db,
  }) => {
    const refused = {
      "CREATE TABLE x (id int)": "permission denied for schema public",
      "ALTER TABLE segments ADD COLUMN x int":
        "must be owner of table segments",
      "UPDATE bodies SET name = 'x'": "permission denied for table bodies",
      "UPDATE people SET created_at = now()":
        "permission denied for table people",
      "INSERT INTO people (name, voice_embedding) SELECT 'x', voice_embedding FROM people LIMIT 1":
        "permission denied for table people",
      "UPDATE meetings SET timezone = 'UTC'":
        "permission denied for table meetings",
      "DELETE FROM meetings": "permission denied for table meetings",
      "UPDATE chapter_generations SET reviewed_by_human = true":
        "permission denied for table chapter_generations",
      "DELETE FROM chapter_generations":
        "permission denied for table chapter_generations",
      [`INSERT INTO chapter_generations (meeting_id, model, prompt_version, reviewed_by_human)
        SELECT id, 'm', 'v', true FROM meetings LIMIT 1`]:
        "permission denied for table chapter_generations",
      "UPDATE chapters SET meeting_id = meeting_id":
        "permission denied for table chapters",
      "TRUNCATE segments": "permission denied for table segments",
      "RESET ROLE":
        'cannot set parameter "role" within security-definer function',
      "CREATE TEMP TABLE segments (id int)":
        "created or altered a database object",
      "ALTER FUNCTION om.run(text) SECURITY INVOKER":
        "created or altered a database object",
    };
    for (const [statement, error] of Object.entries(refused))
      await expect(
        applyChangeset({ db, sql: statement }),
        statement,
      ).rejects.toThrow(error);
  });
});

describe("what a changeset may write", () => {
  test("replaces a meeting's chapters with a new generation", async ({
    db,
  }) => {
    const id = await findMeetingId(db, SLUG);
    const before = await loadMeeting(db, id);
    const changeset = `
      DELETE FROM chapters WHERE meeting_id = om.meeting_id('${SLUG}');
      WITH g AS (
        INSERT INTO chapter_generations (meeting_id, model, prompt_version)
        VALUES (om.meeting_id('${SLUG}'), 'human', 'none')
        RETURNING id, meeting_id
      )
      INSERT INTO chapters (meeting_id, generation_id, start_secs, end_secs, title, summary)
      SELECT meeting_id, id, '0 seconds', '600 seconds', 'Opening', 'The meeting opens.' FROM g;
    `;
    const checked = await checkChangeset({ db, sql: changeset });
    expect(checked.rows).toEqual({
      chapter_generations: { updated: 0, inserted: 1, deleted: 0 },
      chapters: {
        updated: 0,
        inserted: 1,
        deleted: before.chapters.length,
      },
    });
    expect(checked.meetings.map((m) => m.after.id)).toEqual([id]);
    await applyChangeset({ db, sql: changeset });
    const after = await loadMeeting(db, id);
    expect(after.chapters.map((c) => c.title)).toEqual(["Opening"]);
    expect(after.generation).toMatchObject({
      model: "human",
      reviewed_by_human: false,
    });
  });

  test("merges two people", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const { segments } = await loadMeeting(db, id);
    const [keep, drop] = [
      ...new Set(
        segments.flatMap((s) => (s.person === null ? [] : [s.person])),
      ),
    ];
    const changeset = `
      UPDATE segments SET person_id = ${keep} WHERE person_id = ${drop};
      DELETE FROM people WHERE id = ${drop};
    `;
    const { rows } = await applyChangeset({ db, sql: changeset });
    expect(rows.people).toEqual({ updated: 0, inserted: 0, deleted: 1 });
    const after = await loadMeeting(db, id);
    expect(after.people.has(drop!)).toBe(false);
    await expect(
      applyChangeset({ db, sql: `DELETE FROM people WHERE id = ${keep};` }),
    ).rejects.toThrow("violates foreign key constraint");
  });

  test("sets a meeting's date, time and bodies", async ({ db }) => {
    const id = await findMeetingId(db, SLUG);
    const changeset = `
      UPDATE meetings SET date = '2026-03-24', time = '18:30' WHERE slug = '${SLUG}';
      INSERT INTO meeting_bodies (meeting_id, body_id)
      SELECT om.meeting_id('${SLUG}'), id FROM bodies WHERE slug = 'luc';
    `;
    const { rows, meetings } = await applyChangeset({ db, sql: changeset });
    expect(rows).toEqual({
      meeting_bodies: { updated: 0, inserted: 1, deleted: 0 },
      meetings: { updated: 1, inserted: 0, deleted: 0 },
    });
    expect(meetings.map((m) => m.id)).toEqual([id]);
    const after = await loadMeeting(db, id);
    expect(after).toMatchObject({
      date: "2026-03-24",
      time: "18:30:00",
      bodySlugs: ["gbos", "luc"],
    });
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
