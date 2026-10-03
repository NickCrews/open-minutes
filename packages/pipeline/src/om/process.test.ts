import { describe, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  meetingsTable,
  processingRunsTable,
  segmentsTable,
} from "@open-minutes/db";
import { listPending, processMeeting, processMeetings } from "./process";
import { MAX_ATTEMPTS } from "./runs";
import type { Step } from "./steps";
import { TRANSCRIPT_VERSION } from "./transcript";
import {
  fakeYouTube,
  goldenGbosId,
  goldenTest as test,
  insertMeeting,
  insertRun,
} from "./testing";

/**
 * A transcript step that writes one segment saying `word`, standing in for the
 * real pipeline so these tests are about the bookkeeping around a step.
 */
function fakeTranscriptStep(
  word = "hello",
  version = TRANSCRIPT_VERSION,
): Step & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "transcript",
    version,
    after: [],
    calls,
    async run({ meeting }) {
      calls.push(meeting.youtubeId);
      if (word === "") throw new Error("no audio");
      return {
        details: { word },
        summary: "1 segment",
        async write(tx) {
          await tx
            .delete(segmentsTable)
            .where(eq(segmentsTable.meeting_id, meeting.id));
          await tx.insert(segmentsTable).values({
            meeting_id: meeting.id,
            words: [{ text: word, start: 1 }],
          });
        },
      };
    },
  };
}

/** A chapters step made from the transcript, that writes nothing. */
function fakeChaptersStep(): Step & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "chapters",
    version: "1",
    after: ["transcript"],
    calls,
    async run({ meeting }) {
      calls.push(meeting.youtubeId);
      return { details: {}, summary: "no chapters", write: async () => {} };
    },
  };
}

const yt = fakeYouTube();

describe("processMeeting", () => {
  test("runs a pending step and records the run with its output", async ({
    db,
  }) => {
    const meetingId = await insertMeeting(db, await goldenGbosId(db), "v1");
    const step = fakeTranscriptStep();

    const result = await processMeeting(db, "v1", { yt, steps: [step] });
    expect(result).toEqual({
      youtubeId: "v1",
      meetingId,
      steps: [
        { step: "transcript", outcome: "succeeded", summary: "1 segment" },
      ],
    });

    const [run] = await db.select().from(processingRunsTable);
    expect(run).toMatchObject({
      meeting_id: meetingId,
      step: "transcript",
      version: TRANSCRIPT_VERSION,
      status: "succeeded",
      details: expect.objectContaining({ word: "hello" }),
    });
    expect(await db.select().from(segmentsTable)).toHaveLength(1);

    // Done now, so a second pass does nothing.
    const again = await processMeeting(db, "v1", { yt, steps: [step] });
    expect(again.steps).toMatchObject([
      { step: "transcript", outcome: "skipped", state: { kind: "done" } },
    ]);
    expect(step.calls).toEqual(["v1"]);
  });

  test("reprocesses a stale step only when asked, replacing its output", async ({
    db,
  }) => {
    const meetingId = await insertMeeting(db, await goldenGbosId(db), "v1");
    await processMeeting(db, "v1", {
      yt,
      steps: [fakeTranscriptStep("old", "0")],
    });

    const step = fakeTranscriptStep("new");
    const skipped = await processMeeting(db, "v1", { yt, steps: [step] });
    expect(skipped.steps).toMatchObject([
      { outcome: "skipped", state: { kind: "stale", version: "0" } },
    ]);

    await processMeeting(db, "v1", { yt, steps: [step], stale: true });
    const segments = await db
      .select()
      .from(segmentsTable)
      .where(eq(segmentsTable.meeting_id, meetingId));
    expect(segments.map((s) => s.text)).toEqual(["new"]);
    // The audit trail keeps both runs.
    const runs = await db
      .select()
      .from(processingRunsTable)
      .orderBy(asc(processingRunsTable.id));
    expect(runs.map((r) => [r.version, r.status])).toEqual([
      ["0", "succeeded"],
      [TRANSCRIPT_VERSION, "succeeded"],
    ]);
  });

  test("records a failure, writes nothing, and stops before later steps", async ({
    db,
  }) => {
    await insertMeeting(db, await goldenGbosId(db), "v1");
    const chapters = fakeChaptersStep();

    await expect(
      processMeeting(db, "v1", {
        yt,
        steps: [fakeTranscriptStep(""), chapters],
      }),
    ).rejects.toThrow("no audio");

    expect(await db.select().from(segmentsTable)).toEqual([]);
    expect(await db.select().from(processingRunsTable)).toMatchObject([
      { step: "transcript", status: "failed", error: "no audio" },
    ]);
    expect(chapters.calls).toEqual([]);
  });

  test("runs later steps once the ones they're made from are done", async ({
    db,
  }) => {
    await insertMeeting(db, await goldenGbosId(db), "v1");
    const chapters = fakeChaptersStep();
    const result = await processMeeting(db, "v1", {
      yt,
      steps: [fakeTranscriptStep(), chapters],
    });
    expect(result.steps.map((s) => [s.step, s.outcome])).toEqual([
      ["transcript", "succeeded"],
      ["chapters", "succeeded"],
    ]);
  });

  test("refuses a video that isn't a meeting yet", async ({ db }) => {
    await expect(
      processMeeting(db, "never-seen", { yt, steps: [fakeTranscriptStep()] }),
    ).rejects.toThrow(/No meeting for video never-seen/);
  });
});

describe("processMeetings", () => {
  test("continues past failures and reports every outcome", async ({ db }) => {
    const gbos = await goldenGbosId(db);
    await insertMeeting(db, gbos, "good");
    const summary = await processMeetings(db, ["missing", "good"], {
      yt,
      steps: [fakeTranscriptStep()],
    });
    expect(summary.failures.map((f) => f.youtubeId)).toEqual(["missing"]);
    expect(summary.results.map((r) => r.youtubeId)).toEqual(["good"]);
  });
});

describe("listPending", () => {
  test("lists meetings with a step due, newest first, up to the limit", async ({
    db,
  }) => {
    const gbos = await goldenGbosId(db);
    await insertMeeting(db, gbos, "undated");
    await insertMeeting(db, gbos, "older", "2025-01-01");
    await insertMeeting(db, gbos, "newer", "2026-01-01");
    await insertRun(db, await insertMeeting(db, gbos, "done", "2026-06-01"));
    await insertRun(db, await insertMeeting(db, gbos, "stale", "2026-05-01"), {
      version: "untracked",
    });
    const gaveUp = await insertMeeting(db, gbos, "gave-up", "2026-04-01");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await insertRun(db, gaveUp, { status: "failed" });
    }

    const ids = async (options = {}) =>
      (await listPending(db, options)).map((m) => m.youtubeId);
    expect(await ids()).toEqual(["newer", "older", "undated"]);
    expect(await ids({ limit: 2 })).toEqual(["newer", "older"]);
    expect(await ids({ stale: true })).toEqual([
      "stale",
      "newer",
      "older",
      "undated",
    ]);
    expect(await ids({ retry: true })).toEqual([
      "gave-up",
      "newer",
      "older",
      "undated",
    ]);
    expect(await listPending(db, { limit: 1 })).toEqual([
      {
        youtubeId: "newer",
        meetingId: expect.any(Number),
        body: "gbos",
        steps: ["transcript"],
      },
    ]);
  });

  test("leaves out a meeting that is being processed", async ({ db }) => {
    const meetingId = await insertMeeting(db, await goldenGbosId(db), "busy");
    await db.insert(processingRunsTable).values({
      meeting_id: meetingId,
      step: "transcript",
      version: TRANSCRIPT_VERSION,
    });
    expect(await listPending(db)).toEqual([]);
  });

  test("filters by body", async ({ db }) => {
    await insertMeeting(db, await goldenGbosId(db), "v1");
    expect(await listPending(db, { body: "assembly" })).toEqual([]);
    expect(await listPending(db, { body: "gbos" })).toHaveLength(1);
  });
});

describe("meeting metadata", () => {
  test("a discovered meeting keeps its row through processing", async ({
    db,
  }) => {
    const meetingId = await insertMeeting(db, await goldenGbosId(db), "v1");
    await processMeeting(db, "v1", { yt, steps: [fakeTranscriptStep()] });
    const [meeting] = await db
      .select()
      .from(meetingsTable)
      .where(eq(meetingsTable.id, meetingId));
    expect(meeting!.youtube_id).toBe("v1");
  });
});
