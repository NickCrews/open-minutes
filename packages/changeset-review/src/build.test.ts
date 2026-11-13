import { describe, expect } from "vite-plus/test";
import { sql } from "drizzle-orm";
import type { DB } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import { datasetState } from "@open-minutes/seed";
import { formatClock } from "@open-minutes/core/clock";
import { findMeetingId, labelOf, loadMeeting } from "@open-minutes/edit";
import { buildChangesetDiff } from "./build";
import type { StatementDiff } from "./types";

const test = dbTest({ data: datasetState("all") });
const SLUG = "gbos-2026-03-23";
const OTHER = "gbos-2026-05-18";

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
    const diff = await buildChangesetDiff({ db, sql: changeset, base: "test" });

    expect(diff.error).toBeNull();
    expect(diff.meetings).toMatchObject([{ id, slug: SLUG }]);
    expect(diff.statements.map((s) => [s.kind, s.status])).toEqual([
      ["replace_words", "ok"],
      ["assert", "ok"],
      ["split_segment", "ok"],
      ["UPDATE", "ok"],
    ]);
    const [replace, assert, split, update] = diff.statements;
    const inMeeting = (s: StatementDiff | undefined) => {
      expect(s!.meetings.map((m) => m.meeting)).toEqual([id]);
      return s!.meetings[0]!;
    };

    expect(replace!.comment).toBe("The first word is misheard.");
    expect(inMeeting(replace).changes).toEqual([
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
    const after = inMeeting(replace).hunks[0]!.after.flatMap((s) => s.items);
    expect(after).toContainEqual({
      text: "Fixed",
      start: first.start,
      mark: "ins",
    });
    // The hunk also shows the segments before, for context.
    const changed = inMeeting(replace).hunks[0]!.before.find(
      (s) => s.index === 3,
    )!;
    expect(changed.speaker.label).toBe(
      labelOf(meeting.segments[3]!, meeting.people),
    );
    expect(changed.items[0]).toEqual({
      text: first.text,
      start: first.start,
      mark: "del",
    });

    expect(assert!.meetings).toEqual([]);
    expect(assert!.rows).toEqual({});

    expect(inMeeting(split).changes).toContainEqual(
      expect.objectContaining({ kind: "speaker", new: nextLabel }),
    );
    expect(inMeeting(split).hunks[0]!.after.some((s) => s.changed)).toBe(true);

    expect(update!.rows).toEqual({
      people: { updated: 1, inserted: 0, deleted: 0 },
    });
    expect(update!.meetings).toEqual([]);
    expect(update!.people).toEqual([
      expect.objectContaining({ field: "bio", new: "A new bio." }),
    ]);

    expect(Object.keys(diff.rows).sort()).toEqual(["people", "segments"]);
    expect(diff.outcomes.map((o) => o.meeting)).toEqual([id]);
    expect(await bio(db)).toBe(bioBefore);
    expect((await loadMeeting(db, id)).segments[3]!.words[0]!.text).toBe(
      first.text,
    );
  });

  test("shows the person fields a statement changes", async ({ db }) => {
    const { meeting } = await landmarks(db);
    const kyle = [...meeting.people.values()].find(
      (p) => p.slug === "kyle-kelley",
    )!;
    const diff = await buildChangesetDiff({
      db,
      sql: `UPDATE people SET bio = 'A new bio.' WHERE slug = 'kyle-kelley';
UPDATE people SET bio = 'A newer bio.' WHERE slug = 'kyle-kelley';`,
      base: "test",
    });
    expect(diff.meetings).toEqual([]);
    expect(diff.statements[0]!.people).toEqual([
      {
        row: `person ${kyle.id}`,
        field: "bio",
        old: kyle.bio,
        new: "A new bio.",
      },
    ]);
    // The second statement's before is the first's after.
    expect(diff.statements[1]!.people).toEqual([
      {
        row: `person ${kyle.id}`,
        field: "bio",
        old: "A new bio.",
        new: "A newer bio.",
      },
    ]);
  });

  test("follows each meeting a statement changes, from the first statement that changes it", async ({
    db,
  }) => {
    const { id, first, second } = await landmarks(db);
    const other = await findMeetingId(db, OTHER);
    const otherWord = (await loadMeeting(db, other)).segments[2]!.words[0]!;
    const diff = await buildChangesetDiff({
      db,
      sql: `
SELECT om.replace_words('${SLUG}', '${formatClock(first.start)}', '${first.text}', 'One');
SELECT om.replace_words('${OTHER}', '${formatClock(otherWord.start)}', '${otherWord.text}', 'Two');
UPDATE meetings SET title = 'Both' WHERE slug IN ('${SLUG}', '${OTHER}');
SELECT om.replace_words('${SLUG}', '${formatClock(second.start)}', '${second.text}', 'Three');
`,
      base: "test",
    });
    expect(diff.error).toBeNull();
    const ids = [id, other].sort((a, b) => a - b);
    expect(diff.meetings.map((m) => [m.id, m.title])).toEqual(
      ids.map((i) => [i, "Both"]),
    );
    expect(
      diff.statements.map((s) => s.meetings.map((m) => m.meeting)),
    ).toEqual([[id], [other], ids, [id]]);
    const [, , rename, again] = diff.statements;
    expect(rename!.meetings.map((m) => m.changes)).toEqual([[], []]);
    expect(rename!.meetings[0]!.fields).toEqual([
      expect.objectContaining({ row: "meeting", field: "title", new: "Both" }),
    ]);
    // Each statement's diff is against the meeting as the last one left it.
    expect(again!.meetings[0]!.changes).toEqual([
      { kind: "words", start: second.start, old: second.text, new: "Three" },
    ]);
    expect(diff.outcomes.map((o) => o.meeting)).toEqual(ids);
    expect((await loadMeeting(db, other)).title).not.toBe("Both");
  });

  test("attributes rule violations to the statement that changes them", async ({
    db,
  }) => {
    const { first } = await landmarks(db);
    const diff = await buildChangesetDiff({
      db,
      sql: `SELECT om.replace_words('${SLUG}', '${formatClock(first.start)}', '${first.text}', 'um ${first.text}');`,
      base: "test",
    });
    expect(diff.statements[0]!.meetings[0]!.introduced).toContainEqual(
      expect.objectContaining({ code: "filler-word", start: first.start }),
    );
    expect(diff.outcomes[0]!.introduced.map((i) => i.code)).toContain(
      "filler-word",
    );
  });

  test("stops at a failed assertion, keeping what ran before it", async ({
    db,
  }) => {
    const { first } = await landmarks(db);
    const diff = await buildChangesetDiff({
      db,
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
    expect(diff.statements[0]!.meetings[0]!.changes).toHaveLength(1);
    expect(diff.outcomes).toEqual([]);
  });
});
