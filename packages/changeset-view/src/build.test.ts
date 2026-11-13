import { describe, expect } from "vite-plus/test";
import { sql } from "drizzle-orm";
import type { DB } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { datasetState } from "@open-minutes/seed";
import { formatClock } from "@open-minutes/core/clock";
import { findMeetingId, labelOf, loadMeeting } from "@open-minutes/edit";
import { buildChangesetDiff } from "./build";

const test = dbTest({ data: datasetState("all") });
const SLUG = "gbos-2026-03-23";

/** The fourth segment's first two words, and the label of the segment after it. */
async function landmarks(db: DB) {
  const id = await findMeetingId(db, SLUG);
  const meeting = await loadMeeting(db, id);
  const seg = meeting.segments[3]!;
  return {
    id,
    meeting,
    first: seg.words[0]!,
    second: seg.words[1]!,
    nextLabel: labelOf(meeting.segments[4]!, meeting.people),
  };
}

const bio = async (db: DB) =>
  (
    await db.execute<{ bio: string }>(
      sql`SELECT bio FROM people WHERE slug = 'kyle-kelley'`,
    )
  )[0]!.bio;

describe("buildChangesetDiff", () => {
  test("reports what each statement does, and saves nothing", async ({
    db,
  }) => {
    const { id, meeting, first, second, nextLabel } = await landmarks(db);
    const bioBefore = await bio(db);
    const changeset = `
-- The first word is misheard.
SELECT om.replace_words('${SLUG}', '${formatClock(first.start)}', '${first.text}', 'Fixed words');
SELECT om.assert(true, 'always');
-- The next speaker starts a word early.
SELECT om.split_segment('${SLUG}', '${formatClock(second.start)}', NULL, '${nextLabel}');
UPDATE people SET bio = 'A new bio.' WHERE slug = 'kyle-kelley';
`;
    const diff = await buildChangesetDiff({
      db,
      meetingId: id,
      sql: changeset,
      base: "test",
    });

    expect(diff.error).toBeNull();
    expect(diff.meeting).toMatchObject({ id, slug: SLUG });
    expect(diff.statements.map((s) => [s.kind, s.status])).toEqual([
      ["replace_words", "ok"],
      ["assert", "ok"],
      ["split_segment", "ok"],
      ["UPDATE", "ok"],
    ]);
    const [replace, assert, split, update] = diff.statements;

    expect(replace!.comment).toBe("The first word is misheard.");
    expect(replace!.changes).toEqual([
      {
        kind: "words",
        start: first.start,
        old: first.text,
        new: "Fixed words",
      },
    ]);
    expect(replace!.rows).toEqual({
      segments: { updated: 1, inserted: 0, deleted: 0 },
    });
    const after = replace!.hunks[0]!.after.flatMap((s) => s.items);
    expect(after).toContainEqual({
      text: "Fixed",
      start: first.start,
      mark: "ins",
    });
    // The hunk also shows the segments before, for context.
    const changed = replace!.hunks[0]!.before.find((s) => s.index === 3)!;
    expect(changed.speaker.label).toBe(
      labelOf(meeting.segments[3]!, meeting.people),
    );
    expect(changed.items[0]).toEqual({
      text: first.text,
      start: first.start,
      mark: "del",
    });

    expect(assert!.changes).toEqual([]);
    expect(assert!.rows).toEqual({});

    expect(split!.changes).toContainEqual(
      expect.objectContaining({ kind: "speaker", new: nextLabel }),
    );
    expect(split!.hunks[0]!.after.some((s) => s.changed)).toBe(true);

    expect(update!.rows).toEqual({
      people: { updated: 1, inserted: 0, deleted: 0 },
    });
    expect(update!.hunks).toEqual([]);

    expect(Object.keys(diff.rows).sort()).toEqual(["people", "segments"]);
    expect(await bio(db)).toBe(bioBefore);
    expect((await loadMeeting(db, id)).segments[3]!.words[0]!.text).toBe(
      first.text,
    );
  });

  test("shows the person fields a statement changes", async ({ db }) => {
    const { id, meeting } = await landmarks(db);
    const kyle = [...meeting.people.values()].find(
      (p) => p.slug === "kyle-kelley",
    )!;
    const diff = await buildChangesetDiff({
      db,
      meetingId: id,
      sql: "UPDATE people SET bio = 'A new bio.' WHERE slug = 'kyle-kelley';",
      base: "test",
    });
    expect(diff.statements[0]!.fields).toEqual([
      {
        row: `person ${kyle.id}`,
        field: "bio",
        old: kyle.bio,
        new: "A new bio.",
      },
    ]);
  });

  test("attributes rule violations to the statement that changes them", async ({
    db,
  }) => {
    const { id, first } = await landmarks(db);
    const diff = await buildChangesetDiff({
      db,
      meetingId: id,
      sql: `SELECT om.replace_words('${SLUG}', '${formatClock(first.start)}', '${first.text}', 'um ${first.text}');`,
      base: "test",
    });
    expect(diff.statements[0]!.introduced).toContainEqual(
      expect.objectContaining({ code: "filler-word", start: first.start }),
    );
    expect(diff.introduced.map((i) => i.code)).toContain("filler-word");
  });

  test("stops at a failed assertion, keeping what ran before it", async ({
    db,
  }) => {
    const { id, first } = await landmarks(db);
    const diff = await buildChangesetDiff({
      db,
      meetingId: id,
      sql: `
SELECT om.replace_words('${SLUG}', '${formatClock(first.start)}', '${first.text}', 'Fixed');
SELECT om.assert(false, 'nobody has a bio');
SELECT om.relabel('${SLUG}', '${formatClock(first.start)}', 'unlabeled');
`,
      base: "test",
    });
    expect(diff.error).toEqual({
      statement: 1,
      message: "assertion failed: nobody has a bio",
      assertion: true,
    });
    expect(diff.statements.map((s) => s.status)).toEqual([
      "ok",
      "failed",
      "not-run",
    ]);
    expect(diff.statements[0]!.changes).toHaveLength(1);
    expect(diff.resolved).toEqual([]);
    expect(diff.introduced).toEqual([]);
  });
});
