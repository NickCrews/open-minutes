import { describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { test } from "./testing/vitest";
import type { DB } from "./index";
import {
  bodiesTable,
  jurisdictionsTable,
  meetingsTable,
  segmentsTable,
} from "./schema";

async function insertMeeting(db: DB): Promise<number> {
  const [jurisdiction] = await db
    .insert(jurisdictionsTable)
    .values({ name: "Testville" })
    .returning({ id: jurisdictionsTable.id });
  const [body] = await db
    .insert(bodiesTable)
    .values({
      name: "Testville Council",
      jurisdiction_id: jurisdiction!.id,
      timezone: "America/Anchorage",
    })
    .returning({ id: bodiesTable.id });
  const [meeting] = await db
    .insert(meetingsTable)
    .values({ body_id: body!.id })
    .returning({ id: meetingsTable.id });
  return meeting!.id;
}

describe("segments.text generated column", () => {
  test("derives text from words on insert", async ({ db }) => {
    const meetingId = await insertMeeting(db);
    const [seg] = await db
      .insert(segmentsTable)
      .values({
        meeting_id: meetingId,
        words: [
          { text: "hello", start: 0, end: 0.5 },
          { text: "world", start: 0.5, end: 1 },
        ],
      })
      .returning({ text: segmentsTable.text });
    expect(seg!.text).toBe("hello world");
  });

  test("follows words on update, so it can never drift", async ({ db }) => {
    const meetingId = await insertMeeting(db);
    const [seg] = await db
      .insert(segmentsTable)
      .values({
        meeting_id: meetingId,
        words: [{ text: "helo", start: 0, end: 0.5 }],
      })
      .returning({ id: segmentsTable.id });
    const [updated] = await db
      .update(segmentsTable)
      .set({ words: [{ text: "hello", start: 0, end: 0.5 }] })
      .where(eq(segmentsTable.id, seg!.id))
      .returning({ text: segmentsTable.text });
    expect(updated!.text).toBe("hello");
  });

  test("preserves word order in long transcripts", async ({ db }) => {
    const meetingId = await insertMeeting(db);
    // Enough words that any order instability in the jsonb unnesting would show.
    const words = Array.from({ length: 200 }, (_, i) => ({
      text: `w${i}`,
      start: i,
      end: i + 1,
    }));
    const [seg] = await db
      .insert(segmentsTable)
      .values({ meeting_id: meetingId, words })
      .returning({ text: segmentsTable.text });
    expect(seg!.text).toBe(words.map((w) => w.text).join(" "));
  });
});

describe("segments timing generated columns", () => {
  test("spans the first word's onset to the last word's offset", async ({
    db,
  }) => {
    const meetingId = await insertMeeting(db);
    const [seg] = await db
      .insert(segmentsTable)
      .values({
        meeting_id: meetingId,
        words: [
          { text: "hello", start: 2, end: 2.5 },
          { text: "there", start: 2.5, end: 3 },
          { text: "world", start: 3.25, end: 4.5 },
        ],
      })
      .returning({
        start: segmentsTable.start_secs,
        end: segmentsTable.end_secs,
        duration: segmentsTable.duration_secs,
      });
    expect(seg!.start).toBe("00:00:02");
    expect(seg!.end).toBe("00:00:04.5");
    expect(seg!.duration).toBe("00:00:02.5");
  });

  test("follows words on update, so they can never drift", async ({ db }) => {
    const meetingId = await insertMeeting(db);
    const [seg] = await db
      .insert(segmentsTable)
      .values({
        meeting_id: meetingId,
        words: [{ text: "hello", start: 0, end: 0.5 }],
      })
      .returning({ id: segmentsTable.id });
    const [updated] = await db
      .update(segmentsTable)
      .set({ words: [{ text: "hello", start: 10, end: 10.5 }] })
      .where(eq(segmentsTable.id, seg!.id))
      .returning({ start: segmentsTable.start_secs });
    expect(updated!.start).toBe("00:00:10");
  });

  test("rejects a wordless segment, which would have no position at all", async ({
    db,
  }) => {
    const meetingId = await insertMeeting(db);
    // Drizzle wraps the driver error, so the constraint name is on the cause.
    const err = await db
      .insert(segmentsTable)
      .values({ meeting_id: meetingId, words: [] })
      .then(
        () => null,
        (e: Error) => e,
      );
    expect((err?.cause as { constraint_name?: string })?.constraint_name).toBe(
      "segments_words_nonempty",
    );
  });
});
