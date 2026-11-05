// Editing a meeting in a database: apply an ops file, or the meeting rules'
// fixes, in one transaction that holds the meeting's row lock, checked by
// the meeting rules before anything is saved.

import { eq } from "drizzle-orm";
import { chaptersTable, type DB, meetingsTable } from "@open-minutes/db";
import { fixMeeting, type MeetingIssue } from "@open-minutes/core/rules";
import { applyEdits } from "@open-minutes/core/transcript-edit";
import type { Segment } from "@open-minutes/core/transcript";
import {
  type DbMeeting,
  loadMeeting,
  loadPeople,
  type Saved,
  saveSegments,
} from "./meeting";
import { applyRowOps, type RawOp, resolveEditOps } from "./ops";
import { meetingIssues, newIssues, ruleMeeting, ruleSpecs } from "./view";

export interface EditOptions {
  /** Report what would change, and save nothing. */
  dryRun?: boolean;
  /** Save even if the edit adds errors. */
  allowErrors?: boolean;
}

export interface EditResult {
  /** What the ops or fixes said they did. */
  notes: string[];
  /** The meeting as edited. */
  meeting: DbMeeting;
  /** Issues the edit added, errors and warnings. */
  added: MeetingIssue[];
  /** Whether it was saved: not on a dry run, or when it added errors. */
  saved: boolean;
  /** Rows changed; zeros when not saved. */
  rows: Saved;
}

class Rollback extends Error {}

/** Apply an ops file's ops to a meeting. Throws on an op that doesn't apply. */
export function applyOps(
  db: DB,
  meetingId: number,
  ops: readonly RawOp[],
  options: EditOptions = {},
): Promise<EditResult> {
  return editMeeting(db, meetingId, options, async (tx, before) => {
    const notes = await applyRowOps(tx, meetingId, ops);
    const edits = await resolveEditOps(tx, ops);
    const reloaded = await loadMeeting(tx, meetingId);
    const edited = applyEdits(stripIds(before.segments), edits);
    return {
      notes: [...notes, ...edited.notes],
      meeting: {
        ...reloaded,
        segments: edited.segments.map((s) => ({ ...s, id: 0 })),
        people: await loadPeople(
          tx,
          edited.segments.flatMap((s) => (s.person === null ? [] : [s.person])),
        ),
      },
    };
  });
}

/**
 * Apply the fixes of every rule the meeting follows, to its title, transcript
 * and chapters.
 */
export function fixRules(
  db: DB,
  meetingId: number,
  options: EditOptions = {},
): Promise<EditResult> {
  return editMeeting(db, meetingId, options, async (tx, before) => {
    const { meeting: fixed, fixed: issues } = await fixMeeting(
      { ...ruleMeeting(before), segments: stripIds(before.segments) },
      ruleSpecs(before),
    );
    const chapters = (fixed.chapters ?? []).map((c, i) => ({
      ...c,
      id: before.chapters[i]!.id,
    }));
    if (fixed.title !== before.title)
      await tx
        .update(meetingsTable)
        .set({ title: fixed.title })
        .where(eq(meetingsTable.id, meetingId));
    for (const [i, c] of chapters.entries()) {
      const old = before.chapters[i]!;
      if (
        c.title !== old.title ||
        c.summary !== old.summary ||
        JSON.stringify(c.bullets) !== JSON.stringify(old.bullets)
      )
        await tx
          .update(chaptersTable)
          .set({ title: c.title, summary: c.summary, bullets: [...c.bullets] })
          .where(eq(chaptersTable.id, c.id));
    }
    return {
      notes: issues.map((i) => `fixed ${i.code}: ${i.message}`),
      meeting: {
        ...before,
        title: fixed.title ?? before.title,
        segments: fixed.segments.map((s) => ({
          speakerNumber: s.speakerNumber,
          person: s.person as number | null,
          words: s.words,
          id: 0,
        })),
        chapters,
      },
    };
  });
}

async function editMeeting(
  db: DB,
  meetingId: number,
  { dryRun = false, allowErrors = false }: EditOptions,
  edit: (
    tx: Parameters<Parameters<DB["transaction"]>[0]>[0],
    before: DbMeeting,
  ) => Promise<{ notes: string[]; meeting: DbMeeting }>,
): Promise<EditResult> {
  let result: EditResult | undefined;
  try {
    await db.transaction(async (tx) => {
      const before = await loadMeeting(tx, meetingId, { lock: true });
      const { notes, meeting } = await edit(tx, before);
      const added = newIssues(
        await meetingIssues(before),
        await meetingIssues(meeting),
      );
      const blocked = !allowErrors && added.some((i) => i.severity === "error");
      result = {
        notes,
        meeting,
        added,
        saved: false,
        rows: { updated: 0, inserted: 0, deleted: 0 },
      };
      if (dryRun || blocked) throw new Rollback();
      result.rows = await saveSegments(
        tx,
        meetingId,
        before.segments,
        meeting.segments,
      );
      result.saved = true;
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result!;
}

function stripIds(segments: DbMeeting["segments"]): Segment<number>[] {
  return segments.map((s) => ({
    speakerNumber: s.speakerNumber,
    person: s.person,
    words: s.words,
  }));
}
