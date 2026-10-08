import { asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bodiesTable,
  chapterGenerationsTable,
  chaptersTable,
  ianaTimezoneError,
  meetingBodiesTable,
  meetingsTable,
  peopleTable,
  segmentsTable,
} from "@open-minutes/db";
import { bodySlug } from "@open-minutes/core/bodies";
import { chapterErrors } from "@open-minutes/core/chapters";
import {
  parseMeetingDate,
  parseMeetingTime,
} from "@open-minutes/core/meeting-date";
import { hasTypographicDash } from "@open-minutes/core/text";
import { transcriptFingerprint } from "@open-minutes/core/transcript-fingerprint";
import { LAST_WORD_DURATION_SEC } from "@open-minutes/core/transcription";
import { audioTools } from "./audio/tools";
import { checkMeeting, type Issue } from "./check";
import { loadChapters, loadSegments, round, speakerOf } from "./load";
import { findMeeting, meetingRef } from "./meeting-ref";
import { type Db, defineTool, type Tool, ToolError } from "./tool";

// Tools for an agent cleaning up a meeting's data: reading the transcript,
// fixing who said what, naming people, and replacing chapters; and, in
// ./audio/tools.ts, listening to the audio. Every write
// runs in a transaction, re-checks the meetings it touched, and rolls back if
// it introduced an error; `dryRun` always rolls back, to preview a change.

const id = z.int().positive();
const dryRun = z
  .boolean()
  .default(false)
  .describe("Check the change and report the result without saving it.");

/** What a write reports: whether it was saved, and the meeting's state after. */
export interface EditResult<T> {
  applied: boolean;
  dryRun: boolean;
  result: T;
  /** Errors this change would have introduced. Non-empty means not applied. */
  newErrors: Issue[];
  /** Every issue in the touched meetings after the change, old ones included. */
  issues: Issue[];
}

class Rollback extends Error {}

async function applyEdit<T>(
  db: Db,
  meetingIds: number[],
  dry: boolean,
  change: (tx: Db) => Promise<T>,
): Promise<EditResult<T>> {
  const check = async (tx: Db) =>
    (await Promise.all(meetingIds.map((m) => checkMeeting(tx, m)))).flat();
  const key = (i: Issue) =>
    `${i.code}|${i.message}|${"segmentId" in i ? i.segmentId : ""}|${"chapterId" in i ? i.chapterId : ""}`;
  let out: EditResult<T> | undefined;
  try {
    await db.transaction(async (tx) => {
      const before = new Set(
        (await check(tx)).filter((i) => i.severity === "error").map(key),
      );
      let result: T;
      try {
        result = await change(tx);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        // A database constraint said no: pass its reason on to the agent.
        const cause = (err as { cause?: { message?: string } }).cause;
        throw new ToolError(cause?.message ?? (err as Error).message);
      }
      const issues = await check(tx);
      const newErrors = issues.filter(
        (i) => i.severity === "error" && !before.has(key(i)),
      );
      out = {
        applied: !dry && newErrors.length === 0,
        dryRun: dry,
        result,
        newErrors,
        issues,
      };
      if (!out.applied) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out!;
}

async function segmentsByIds(db: Db, ids: number[]) {
  const rows = await db
    .select()
    .from(segmentsTable)
    .where(inArray(segmentsTable.id, ids));
  const missing = ids.filter((i) => !rows.some((r) => r.id === i));
  if (missing.length) throw new ToolError(`No segment ${missing.join(", ")}`);
  return rows;
}

const speakerInput = z
  .object({
    personId: id.optional().describe("A person, named or anonymous."),
    speakerNumber: z
      .int()
      .nonnegative()
      .optional()
      .describe("A diarization speaker number, local to this meeting."),
  })
  .refine((s) => s.personId === undefined || s.speakerNumber === undefined, {
    message: "give personId or speakerNumber, not both",
  })
  .describe(
    "Who the segments are by: {personId} or {speakerNumber}; {} for unattributed speech.",
  );

const speakerColumns = (s: z.infer<typeof speakerInput>) => ({
  person_id: s.personId ?? null,
  speaker_number: s.speakerNumber ?? null,
});

export const listMeetings = defineTool({
  name: "list_meetings",
  label: "List meetings",
  description:
    "List every meeting with its id, slug, bodies (several for a joint meeting), date, and how many segments and chapters it has. Start here to find a meeting: other tools take its slug or its id.",
  input: z.object({}),
  run: async (ctx) => {
    const db = await ctx.db();
    const meetings = await db
      .select({
        id: meetingsTable.id,
        slug: meetingsTable.slug,
        title: meetingsTable.title,
        date: meetingsTable.date,
        url: meetingsTable.url,
      })
      .from(meetingsTable)
      .orderBy(asc(meetingsTable.id));
    const counts = async (table: typeof segmentsTable | typeof chaptersTable) =>
      new Map(
        (
          await db
            .select({ m: table.meeting_id, n: count() })
            .from(table)
            .groupBy(table.meeting_id)
        ).map((r) => [r.m, r.n]),
      );
    const [segments, chapters] = [
      await counts(segmentsTable),
      await counts(chaptersTable),
    ];
    const bodies = new Map<number, string[]>();
    for (const r of await db
      .select({
        m: meetingBodiesTable.meeting_id,
        body: bodiesTable.name_short,
      })
      .from(meetingBodiesTable)
      .innerJoin(bodiesTable, eq(bodiesTable.id, meetingBodiesTable.body_id))
      .orderBy(asc(bodiesTable.name_short)))
      bodies.set(r.m, [...(bodies.get(r.m) ?? []), r.body]);
    return meetings.map((m) => ({
      ...m,
      bodies: bodies.get(m.id) ?? [],
      segments: segments.get(m.id) ?? 0,
      chapters: chapters.get(m.id) ?? 0,
    }));
  },
});

const meetingDate = z
  .string()
  .refine((v) => parseMeetingDate(v) !== null, "a date, YYYY-MM-DD")
  .transform((v) => parseMeetingDate(v)!);
const meetingTime = z
  .string()
  .refine((v) => parseMeetingTime(v) !== null, "a time, HH:MM or HH:MM:SS")
  .transform((v) => parseMeetingTime(v)!);

export const updateMeeting = defineTool({
  name: "update_meeting",
  label: "Update meeting",
  description:
    'Set any of a meeting\'s title, description, date, time, timezone and bodies; fields left out stay as they are. date ("YYYY-MM-DD") and time ("HH:MM") are the wall clock where the meeting was held, in its timezone (eg "America/Anchorage"); null makes either unknown, and clearing the date clears the time. bodies replaces the bodies that held it, by slug: one for most meetings, several for a joint meeting, eg ["gbos", "luc"]. Ingestion records only the body whose source published the meeting; add a joint meeting\'s other bodies here.',
  input: z.object({
    meeting: meetingRef,
    title: z.string().trim().optional(),
    description: z.string().optional(),
    date: meetingDate.nullable().optional(),
    time: meetingTime.nullable().optional(),
    timezone: z
      .string()
      .trim()
      .optional()
      .describe('An IANA zone of a place, eg "America/Anchorage".'),
    bodies: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe('Body slugs, eg ["gbos", "luc"].'),
    dryRun,
  }),
  run: async (ctx, { meeting: ref, bodies: slugs, dryRun: dry, ...fields }) => {
    const db = await ctx.db();
    const meeting = await findMeeting(db, ref);
    if (Object.keys(fields).length === 0 && slugs === undefined)
      throw new ToolError("Nothing to change");
    if (fields.date === null) {
      if (fields.time) throw new ToolError("A time needs a date");
      fields.time = null;
    }
    if (fields.timezone !== undefined) {
      const error = await ianaTimezoneError(db, fields.timezone);
      if (error) throw new ToolError(error);
    }

    let bodies: { id: number; name: string; name_short: string }[] | undefined;
    if (slugs !== undefined) {
      const all = await db
        .select({
          id: bodiesTable.id,
          name: bodiesTable.name,
          name_short: bodiesTable.name_short,
        })
        .from(bodiesTable);
      bodies = [...new Set(slugs.map((s) => s.toLowerCase()))].map((slug) => {
        const body = all.find((b) => bodySlug(b) === slug);
        if (!body)
          throw new ToolError(
            `No body with slug "${slug}"; bodies are ${all.map(bodySlug).join(", ")}`,
          );
        return body;
      });
    }

    return applyEdit(db, [meeting.id], dry, async (tx) => {
      if (Object.keys(fields).length > 0)
        await tx
          .update(meetingsTable)
          .set(fields)
          .where(eq(meetingsTable.id, meeting.id));
      if (bodies) {
        await tx
          .delete(meetingBodiesTable)
          .where(eq(meetingBodiesTable.meeting_id, meeting.id));
        await tx
          .insert(meetingBodiesTable)
          .values(
            bodies.map((b) => ({ meeting_id: meeting.id, body_id: b.id })),
          );
      }
      const [row] = await tx
        .select({
          id: meetingsTable.id,
          slug: meetingsTable.slug,
          title: meetingsTable.title,
          description: meetingsTable.description,
          date: meetingsTable.date,
          time: meetingsTable.time,
          timezone: meetingsTable.timezone,
        })
        .from(meetingsTable)
        .where(eq(meetingsTable.id, meeting.id));
      const held = await tx
        .select({ name_short: bodiesTable.name_short })
        .from(meetingBodiesTable)
        .innerJoin(bodiesTable, eq(bodiesTable.id, meetingBodiesTable.body_id))
        .where(eq(meetingBodiesTable.meeting_id, meeting.id))
        .orderBy(asc(bodiesTable.name_short));
      return { ...row!, bodies: held.map((b) => b.name_short) };
    });
  },
});

export const getTranscript = defineTool({
  name: "get_transcript",
  label: "Get transcript",
  description:
    "Read a meeting's transcript as segments (a run of words by one speaker), in time order, with segment ids, start and end seconds, speaker, and text. Pass from/to (seconds) to read part of a long meeting. Pass words: true to get each word's index and onset, which split_segment needs.",
  input: z.object({
    meeting: meetingRef,
    from: z
      .number()
      .nonnegative()
      .optional()
      .describe("Seconds; segments ending before this are left out."),
    to: z
      .number()
      .nonnegative()
      .optional()
      .describe("Seconds; segments starting after this are left out."),
    words: z.boolean().default(false),
  }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    const { id: meetingId } = await findMeeting(db, input.meeting);
    const segments = await loadSegments(db, meetingId);
    return segments
      .map((s) => ({
        id: s.id,
        start: round(s.words[0]!.start),
        end: round(s.words.at(-1)!.start + LAST_WORD_DURATION_SEC),
        speaker: speakerOf(s),
        text: s.words.map((w) => w.text).join(" "),
        ...(input.words && {
          words: s.words.map((w, i) => ({ i, start: w.start, text: w.text })),
        }),
      }))
      .filter(
        (s) =>
          (input.from === undefined || s.end >= input.from) &&
          (input.to === undefined || s.start <= input.to),
      );
  },
});

export const listSpeakers = defineTool({
  name: "list_speakers",
  label: "List speakers",
  description:
    "List everyone who speaks in a meeting, by person or speaker number, with their segment count, speaking seconds, and first segment. Useful for spotting one voice split across two labels.",
  input: z.object({ meeting: meetingRef }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    const bySpeaker = new Map<
      string,
      {
        speaker: ReturnType<typeof speakerOf>;
        segments: number;
        secs: number;
        firstSegmentId: number;
        firstAt: number;
      }
    >();
    const { id: meetingId } = await findMeeting(db, input.meeting);
    for (const s of await loadSegments(db, meetingId)) {
      const speaker = speakerOf(s);
      const k = JSON.stringify(
        speaker && ("personId" in speaker ? speaker.personId : speaker),
      );
      const secs =
        s.words.at(-1)!.start + LAST_WORD_DURATION_SEC - s.words[0]!.start;
      const entry = bySpeaker.get(k);
      if (entry) {
        entry.segments++;
        entry.secs += secs;
      } else
        bySpeaker.set(k, {
          speaker,
          segments: 1,
          secs,
          firstSegmentId: s.id,
          firstAt: round(s.words[0]!.start),
        });
    }
    return [...bySpeaker.values()]
      .map((s) => ({ ...s, secs: round(s.secs) }))
      .sort((a, b) => b.secs - a.secs);
  },
});

export const findPeople = defineTool({
  name: "find_people",
  label: "Find people",
  description:
    "Search people by name, slug or bio (case-insensitive substring); omit query to list everyone. A person with a slug is a known person; one without is an anonymous voice recognition created.",
  input: z.object({
    query: z.string().optional(),
    limit: z.int().positive().max(500).default(50),
  }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    const q = input.query && `%${input.query}%`;
    return db
      .select({
        id: peopleTable.id,
        slug: peopleTable.slug,
        name: peopleTable.name,
        bio: peopleTable.bio,
        meetings: sql<number>`(SELECT count(DISTINCT meeting_id)::int FROM ${segmentsTable} WHERE person_id = ${peopleTable.id})`,
      })
      .from(peopleTable)
      .where(
        q
          ? or(
              ilike(peopleTable.name, q),
              ilike(peopleTable.slug, q),
              ilike(peopleTable.bio, q),
            )
          : undefined,
      )
      .orderBy(asc(peopleTable.id))
      .limit(input.limit);
  },
});

export const checkMeetingTool = defineTool({
  name: "check_meeting",
  label: "Check meeting",
  description:
    "List problems in a meeting's data, by the same rules as the golden fixtures. Errors (a write that introduces one is rolled back): no bodies, an empty segment, words or segments out of time order, a filler or stutter the clean stage removes, an invalid chapter. Warnings (probably wrong, or a broken convention): a speaker change inside a sentence near a longer pause, a chapter outside the size conventions, speech no chapter covers. Every write tool also returns this after its change.",
  input: z.object({ meeting: meetingRef }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    return checkMeeting(db, (await findMeeting(db, input.meeting)).id);
  },
});

export const relabelSegments = defineTool({
  name: "relabel_segments",
  label: "Relabel segments",
  description:
    "Attribute whole segments to a different speaker. If only part of a segment is by someone else, split_segment first.",
  input: z.object({
    segmentIds: z.array(id).min(1),
    speaker: speakerInput,
    dryRun,
  }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    const rows = await segmentsByIds(db, input.segmentIds);
    return applyEdit(
      db,
      [...new Set(rows.map((r) => r.meeting_id))],
      input.dryRun,
      async (tx) => {
        await tx
          .update(segmentsTable)
          .set(speakerColumns(input.speaker))
          .where(inArray(segmentsTable.id, input.segmentIds));
        return { relabelled: input.segmentIds.length };
      },
    );
  },
});

export const splitSegment = defineTool({
  name: "split_segment",
  label: "Split segment",
  description:
    "Split a segment in two where the speaker changes: words before atWord stay, words from atWord on become a new segment (by the given speaker, or the same one). Get word indices from get_transcript with words: true.",
  input: z.object({
    segmentId: id,
    atWord: z
      .int()
      .positive()
      .describe("Index of the first word of the new segment."),
    speaker: speakerInput.optional(),
    dryRun,
  }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    const [seg] = await segmentsByIds(db, [input.segmentId]);
    if (input.atWord >= seg!.words.length)
      throw new ToolError(
        `Segment ${seg!.id} has only ${seg!.words.length} words; atWord must be 1–${seg!.words.length - 1}`,
      );
    return applyEdit(db, [seg!.meeting_id], input.dryRun, async (tx) => {
      await tx
        .update(segmentsTable)
        .set({ words: seg!.words.slice(0, input.atWord) })
        .where(eq(segmentsTable.id, seg!.id));
      const [created] = await tx
        .insert(segmentsTable)
        .values({
          meeting_id: seg!.meeting_id,
          ...(input.speaker
            ? speakerColumns(input.speaker)
            : {
                person_id: seg!.person_id,
                speaker_number: seg!.speaker_number,
              }),
          words: seg!.words.slice(input.atWord),
        })
        .returning({ id: segmentsTable.id });
      return { segmentId: seg!.id, newSegmentId: created!.id };
    });
  },
});

export const mergeSegments = defineTool({
  name: "merge_segments",
  label: "Merge segments",
  description:
    "Join consecutive segments of one meeting into the earliest, which keeps its speaker unless one is given. Use when one turn was split, eg after relabelling makes neighbours the same speaker.",
  input: z.object({
    segmentIds: z.array(id).min(2),
    speaker: speakerInput.optional(),
    dryRun,
  }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    const rows = await segmentsByIds(db, input.segmentIds);
    const meetingId = rows[0]!.meeting_id;
    if (rows.some((r) => r.meeting_id !== meetingId))
      throw new ToolError("Segments are in different meetings");
    const order = (await loadSegments(db, meetingId)).map((s) => s.id);
    const positions = rows
      .map((r) => order.indexOf(r.id))
      .sort((a, b) => a - b);
    if (positions.some((p, i) => i > 0 && p !== positions[i - 1]! + 1))
      throw new ToolError(
        "Segments aren't consecutive; other segments come between them",
      );
    const sorted = positions.map((p) => rows.find((r) => r.id === order[p])!);
    const [first, ...rest] = sorted;
    return applyEdit(db, [meetingId], input.dryRun, async (tx) => {
      await tx.delete(segmentsTable).where(
        inArray(
          segmentsTable.id,
          rest.map((r) => r.id),
        ),
      );
      await tx
        .update(segmentsTable)
        .set({
          words: sorted.flatMap((r) => r.words),
          ...(input.speaker && speakerColumns(input.speaker)),
        })
        .where(eq(segmentsTable.id, first!.id));
      return { segmentId: first!.id, removed: rest.map((r) => r.id) };
    });
  },
});

/** A name or bio: non-blank, with plain hyphens (see core/text.ts). */
const personText = z
  .string()
  .trim()
  .min(1)
  .refine(
    (s) => !hasTypographicDash(s),
    "write a plain hyphen (-), not an en or em dash",
  );

export const updatePerson = defineTool({
  name: "update_person",
  label: "Update person",
  description:
    "Set a person's slug, name or bio; null clears one. Giving an anonymous person a slug makes them a known person (slugs are kebab-case and unique, eg margaret-tyler). Names show everywhere the person speaks.",
  input: z.object({
    personId: id,
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case, eg margaret-tyler")
      .nullable()
      .optional(),
    name: personText.nullable().optional(),
    bio: personText.nullable().optional(),
    dryRun,
  }),
  run: async (ctx, { personId, dryRun: dry, ...fields }) => {
    const db = await ctx.db();
    const [person] = await db
      .select({ id: peopleTable.id })
      .from(peopleTable)
      .where(eq(peopleTable.id, personId));
    if (!person) throw new ToolError(`No person ${personId}`);
    if (Object.keys(fields).length === 0)
      throw new ToolError("Nothing to change");
    return applyEdit(db, [], dry, async (tx) => {
      const [row] = await tx
        .update(peopleTable)
        .set(fields)
        .where(eq(peopleTable.id, personId))
        .returning({
          id: peopleTable.id,
          slug: peopleTable.slug,
          name: peopleTable.name,
          bio: peopleTable.bio,
        });
      return row!;
    });
  },
});

export const mergePeople = defineTool({
  name: "merge_people",
  label: "Merge people",
  description:
    "Two person rows are the same individual (recognition split one voice in two): move every segment of mergeId to keepId and delete mergeId. keepId's slug, name and bio win; empty ones are filled from mergeId. keepId's voiceprint is kept as is.",
  input: z.object({ keepId: id, mergeId: id, dryRun }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    if (input.keepId === input.mergeId)
      throw new ToolError("keepId and mergeId are the same person");
    const people = await db
      .select()
      .from(peopleTable)
      .where(inArray(peopleTable.id, [input.keepId, input.mergeId]));
    const keep = people.find((p) => p.id === input.keepId);
    const merge = people.find((p) => p.id === input.mergeId);
    if (!keep || !merge)
      throw new ToolError(`No person ${!keep ? input.keepId : input.mergeId}`);
    const meetings = await db
      .selectDistinct({ m: segmentsTable.meeting_id })
      .from(segmentsTable)
      .where(inArray(segmentsTable.person_id, [input.keepId, input.mergeId]));
    return applyEdit(
      db,
      meetings.map((r) => r.m),
      input.dryRun,
      async (tx) => {
        const moved = await tx
          .update(segmentsTable)
          .set({ person_id: keep.id })
          .where(eq(segmentsTable.person_id, merge.id))
          .returning({ id: segmentsTable.id });
        await tx.delete(peopleTable).where(eq(peopleTable.id, merge.id));
        await tx
          .update(peopleTable)
          .set({
            slug: keep.slug ?? merge.slug,
            name: keep.name ?? merge.name,
            bio: keep.bio ?? merge.bio,
          })
          .where(eq(peopleTable.id, keep.id));
        return { personId: keep.id, movedSegments: moved.length };
      },
    );
  },
});

export const getChapters = defineTool({
  name: "get_chapters",
  label: "Get chapters",
  description:
    "Read a meeting's chapters in order, with start and end seconds, title, summary and bullets.",
  input: z.object({ meeting: meetingRef }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    const { id: meetingId } = await findMeeting(db, input.meeting);
    return (await loadChapters(db, meetingId)).map((c) => ({
      id: c.id,
      start: c.start,
      end: c.end,
      title: c.title,
      summary: c.summary,
      bullets: c.bullets,
    }));
  },
});

const chapterInput = z.object({
  start: z.number().nonnegative().describe("Seconds."),
  end: z.number().positive().describe("Seconds; after start."),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1).describe("One sentence."),
  bullets: z
    .array(z.string().trim().min(1))
    .default([])
    .describe("3–7 for a substantive chapter, 0–1 for a short procedural one."),
});

export const replaceChapters = defineTool({
  name: "replace_chapters",
  label: "Replace chapters",
  description:
    "Replace all of a meeting's chapters with a new set, recorded as a new generation (who wrote them, and whether a human reviewed them). Chapters must be in order and not overlap; they should cover all speech. See docs/chapters.md for the conventions. To edit one chapter, get_chapters, change it, and pass the whole list back.",
  input: z.object({
    meeting: meetingRef,
    model: z
      .string()
      .min(1)
      .describe('What wrote them: a model id, or "human".'),
    promptVersion: z.string().default(""),
    reviewedByHuman: z.boolean().default(false),
    chapters: z.array(chapterInput).min(1),
    dryRun,
  }),
  run: async (ctx, input) => {
    const db = await ctx.db();
    const invalid = chapterErrors(input.chapters);
    if (invalid.length)
      throw new ToolError(
        invalid
          .map(
            (e) =>
              `chapter ${e.chapter + 1} ("${input.chapters[e.chapter]!.title}") ${e.message}`,
          )
          .join("\n"),
      );
    const { id: meetingId } = await findMeeting(db, input.meeting);
    const segments = await loadSegments(db, meetingId);
    if (!segments.length)
      throw new ToolError(`Meeting ${input.meeting} has no transcript`);
    return applyEdit(db, [meetingId], input.dryRun, async (tx) => {
      const [generation] = await tx
        .insert(chapterGenerationsTable)
        .values({
          meeting_id: meetingId,
          model: input.model,
          prompt_version: input.promptVersion,
          reviewed_by_human: input.reviewedByHuman,
          transcript_fingerprint: transcriptFingerprint(segments),
        })
        .returning({ id: chapterGenerationsTable.id });
      await tx
        .delete(chaptersTable)
        .where(eq(chaptersTable.meeting_id, meetingId));
      await tx.insert(chaptersTable).values(
        input.chapters.map((c) => ({
          meeting_id: meetingId,
          generation_id: generation!.id,
          // Postgres reads a bare number as seconds.
          start_secs: `${c.start}`,
          end_secs: `${c.end}`,
          title: c.title,
          summary: c.summary,
          bullets: c.bullets,
        })),
      );
      return { generationId: generation!.id, chapters: input.chapters.length };
    });
  },
});

/** Every tool, in the order an agent would usually reach for them. */
export const tools: Tool[] = [
  listMeetings,
  getTranscript,
  listSpeakers,
  findPeople,
  checkMeetingTool,
  relabelSegments,
  splitSegment,
  mergeSegments,
  updatePerson,
  mergePeople,
  updateMeeting,
  getChapters,
  replaceChapters,
  ...audioTools,
] as Tool[];
