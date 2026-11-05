// An ops file: one JSON object per line, `#` lines ignored. Transcript ops
// (see EditOp in @open-minutes/core/transcript-edit) name times as
// "H:MM:SS.ss" and speakers by label; `person` and `meeting` ops change rows
// other than the segments, and run before the transcript ops.

import { eq } from "drizzle-orm";
import { meetingsTable, peopleTable, SLUG_PATTERN } from "@open-minutes/db";
import { parseClock } from "@open-minutes/core/clock";
import type { EditOp } from "@open-minutes/core/transcript-edit";
import { parseSpeakerLabel, type Speaker } from "@open-minutes/core/transcript";
import type { Conn } from "./meeting";

/** An op as written in an ops file. */
export type RawOp = Record<string, unknown> & { op: string };

/**
 * Set fields of an existing person, found by `person` (a label: "person:<id>"
 * or "identified:<slug>"). A field left out is unchanged; null clears it.
 */
export interface PersonOp {
  op: "person";
  person: string;
  slug?: string | null;
  name?: string | null;
  bio?: string | null;
}

/** Set the meeting's slug or title. */
export interface MeetingOp {
  op: "meeting";
  slug?: string | null;
  title?: string;
}

export const OPS_HELP = `Ops, one JSON object per line ("#" lines ignored). T is "H:MM:SS.ss" as
render and words print it; L is a speaker label.
  {"op":"split","at":T,"word":W,"speaker":L}
      The word W at onset T starts a new segment spoken by L, which runs to
      the next segment. To give a turn back to the previous speaker, add a
      second split where they resume. If W already starts a segment, the whole
      segment is relabelled, so to move only W, first split at the word after
      it under the old label. Splitting in descending time order avoids both.
  {"op":"label","at":T,"speaker":L}
      Relabel the whole segment containing the word at onset T.
  {"op":"replace","at":T,"old":"good wood","new":"Girdwood"}
      Replace the words starting at onset T, which must read "old" exactly.
      "new" may have more or fewer words; "" deletes.
  {"op":"insert","words":["0:01:57.24 Are","0:01:57.52 we"],"speaker":L}
      Add words the transcript is missing, each at its onset. With "speaker",
      they are their own turn and the words after them go back to whoever was
      speaking; without it, they join the segment they fall in.
  {"op":"replace_all","old":"Gridwood","new":"Girdwood"}
      Replace every occurrence, ignoring case and trailing punctuation; the
      last old word's trailing punctuation is kept. Prints the count. A later
      "replace" that expects the old spelling will fail, and a common word
      ("Kelly") may match more than one person.
  {"op":"person","person":"person:7","slug":"kyle-kelley","name":"Kyle Kelley","bio":"..."}
      Set an existing person's slug, name or bio; null clears one. "person"
      is "person:<id>" or "identified:<slug>". Runs before the transcript
      ops, so they can label segments with the new slug.
  {"op":"meeting","slug":"gbos-2026-04-20","title":"..."}
      Set the meeting's slug or title. Runs before the transcript ops.
Labels:
  unlabeled            no speaker information
  segmented:spk-<n>    a voice diarization separated, local to this meeting
  identified:<slug>    the known person with that slug
  person:<id>          a person by id, for one with no slug yet
A label sets the segment's speaker to exactly that: a person and no speaker
number, or the reverse. Everyone a segment names needs a row in people, with
a voiceprint, so a voice that has none stays a speaker number.`;

/** Parse an ops file. */
export function parseOps(text: string): RawOp[] {
  return text.split("\n").flatMap((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    let op: unknown;
    try {
      op = JSON.parse(trimmed);
    } catch {
      throw new Error(`ops line ${i + 1}: not JSON: ${trimmed}`);
    }
    if (typeof op !== "object" || op === null || !("op" in op))
      throw new Error(`ops line ${i + 1}: no "op": ${trimmed}`);
    return [op as RawOp];
  });
}

/** "H:MM:SS.ss" as seconds; throws if malformed. */
export function parseTime(text: unknown): number {
  const secs = typeof text === "string" ? parseClock(text) : null;
  if (secs === null)
    throw new Error(`bad time ${JSON.stringify(text)} (want H:MM:SS.ss)`);
  return secs;
}

/**
 * The speaker a label names, its person as a `people.id`. Throws if it names
 * no one in the database.
 */
export async function resolveLabel(
  db: Conn,
  label: unknown,
): Promise<Speaker<number>> {
  if (typeof label !== "string")
    throw new Error(`bad speaker label ${JSON.stringify(label)}`);
  const byId = /^person:(\d+)$/.exec(label);
  if (byId) {
    const id = Number(byId[1]);
    const [row] = await db
      .select({ id: peopleTable.id })
      .from(peopleTable)
      .where(eq(peopleTable.id, id));
    if (!row) throw new Error(`no person with id ${id}`);
    return { speakerNumber: null, person: id };
  }
  const speaker = parseSpeakerLabel(label);
  if (speaker.person === null) return { ...speaker, person: null };
  const [row] = await db
    .select({ id: peopleTable.id })
    .from(peopleTable)
    .where(eq(peopleTable.slug, speaker.person));
  if (!row)
    throw new Error(
      `no person with slug ${JSON.stringify(speaker.person)}: give an existing person that slug with a "person" op`,
    );
  return { speakerNumber: null, person: row.id };
}

/** Run the `person` and `meeting` ops, in order. Returns what they did. */
export async function applyRowOps(
  db: Conn,
  meetingId: number,
  ops: readonly RawOp[],
): Promise<string[]> {
  const notes: string[] = [];
  for (const [i, raw] of ops.entries()) {
    const where = `op ${i + 1}`;
    try {
      if (raw.op === "person") {
        const op = raw as unknown as PersonOp;
        const { person } = await resolveLabel(db, op.person);
        const set: Partial<typeof peopleTable.$inferInsert> = {};
        if (op.slug !== undefined) {
          if (op.slug !== null && !SLUG_PATTERN.test(op.slug))
            throw new Error(`slug ${JSON.stringify(op.slug)} isn't kebab-case`);
          set.slug = op.slug;
        }
        if (op.name !== undefined) set.name = op.name?.trim() || null;
        if (op.bio !== undefined) set.bio = op.bio?.trim() || null;
        if (!Object.keys(set).length) throw new Error("sets nothing");
        await db
          .update(peopleTable)
          .set(set)
          .where(eq(peopleTable.id, person!));
        notes.push(`person ${person}: set ${Object.keys(set).join(", ")}`);
      } else if (raw.op === "meeting") {
        const op = raw as unknown as MeetingOp;
        const set: Partial<typeof meetingsTable.$inferInsert> = {};
        if (op.slug !== undefined) set.slug = op.slug;
        if (op.title !== undefined) set.title = op.title;
        if (!Object.keys(set).length) throw new Error("sets nothing");
        await db
          .update(meetingsTable)
          .set(set)
          .where(eq(meetingsTable.id, meetingId));
        notes.push(`meeting: set ${Object.keys(set).join(", ")}`);
      }
    } catch (err) {
      throw new Error(`${where}: ${(err as Error).message}`, { cause: err });
    }
  }
  return notes;
}

/**
 * The transcript ops among `ops`, with times in seconds and speakers resolved
 * to people ids. Run after {@link applyRowOps}, so a label can use a slug a
 * `person` op just set.
 */
export async function resolveEditOps(
  db: Conn,
  ops: readonly RawOp[],
): Promise<EditOp<number>[]> {
  const out: EditOp<number>[] = [];
  for (const [i, raw] of ops.entries()) {
    try {
      const op = await resolveEditOp(db, raw);
      if (op) out.push(op);
    } catch (err) {
      throw new Error(`op ${i + 1}: ${(err as Error).message}`, { cause: err });
    }
  }
  return out;
}

async function resolveEditOp(
  db: Conn,
  raw: RawOp,
): Promise<EditOp<number> | null> {
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string")
      throw new Error(`"${key}" must be a string in ${JSON.stringify(raw)}`);
    return v;
  };
  const word = raw.word === undefined ? undefined : str("word");
  switch (raw.op) {
    case "person":
    case "meeting":
      return null;
    case "split":
    case "label":
      return {
        op: raw.op,
        at: parseTime(raw.at),
        word,
        speaker: await resolveLabel(db, raw.speaker),
      };
    case "replace":
      return {
        op: "replace",
        at: parseTime(raw.at),
        old: str("old"),
        new: str("new"),
      };
    case "insert": {
      if (!Array.isArray(raw.words))
        throw new Error(`"words" must be an array of "H:MM:SS.ss word"`);
      return {
        op: "insert",
        words: raw.words.map((item: unknown) => {
          const m =
            typeof item === "string" ? /^(\S+)\s+(.+)$/.exec(item) : null;
          if (!m) throw new Error(`bad word ${JSON.stringify(item)}`);
          return { start: parseTime(m[1]), text: m[2]! };
        }),
        speaker:
          raw.speaker === undefined
            ? undefined
            : await resolveLabel(db, raw.speaker),
      };
    }
    case "replace_all":
      return { op: "replace_all", old: str("old"), new: str("new") };
    default:
      throw new Error(`unknown op ${JSON.stringify(raw.op)}`);
  }
}
