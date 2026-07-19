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
    .values({ name: "Testville Council", jurisdiction_id: jurisdiction!.id })
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
