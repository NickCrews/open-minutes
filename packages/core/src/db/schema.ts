import { defineRelations, SQL, sql } from "drizzle-orm";
import {
  pgTable,
  integer,
  interval,
  jsonb,
  timestamp,
  serial,
  varchar,
  vector,
  index,
  check,
} from "drizzle-orm/pg-core";
import { N_DIMENSIONS as VOICE_N_DIMENSIONS } from "../voice_embeddings";
import { TranscriptWord } from "../transcription";

const secondsInterval = () => interval({ fields: "second", precision: 3 });

/**
 * A government: the Municipality of Anchorage, the City & Borough of Juneau.
 * A place with boundaries — it never meets and never has minutes. That's what
 * the bodies inside it do.
 */
export const jurisdictionsTable = pgTable("jurisdictions", {
  id: serial().primaryKey(),
  name: varchar().notNull().default(""),
  name_short: varchar().notNull().default(""),
  state: varchar().notNull().default(""),
  postcode: varchar().default(""),
  created_at: timestamp().notNull().defaultNow(),
});

/**
 * A deliberative body that actually meets: the Anchorage Assembly, the Girdwood
 * Board of Supervisors, the Anchorage School Board. Meetings hang off these,
 * not off the jurisdiction — one jurisdiction has many, and they are what a
 * reader browses by.
 */
export const bodiesTable = pgTable("bodies", {
  id: serial().primaryKey(),
  jurisdiction_id: integer()
    .notNull()
    .references(() => jurisdictionsTable.id),
  name: varchar().notNull().default(""),
  name_short: varchar().notNull().default(""),
  homepage_url: varchar(),
  // IANA zone the body meets in, eg "America/Anchorage". Meeting times are
  // stored as UTC instants, so this is what turns one back into the wall-clock
  // time that was on the agenda — the only time a reader (or an editor typing
  // one in) ever thinks in.
  timezone: varchar().notNull(),
  created_at: timestamp().notNull().defaultNow(),
});

/**
 * Where a body's video comes from. Deliberately not a column on `bodies`,
 * because neither direction of that relationship is one-to-one: the MOA channel
 * carries the Assembly, P&Z and the school board mixed together, and a single
 * body may be spread across a channel plus several playlists. Ingestion uses
 * the source a video was found under to decide which body it belongs to.
 */
export const videoSourcesTable = pgTable("video_sources", {
  id: serial().primaryKey(),
  body_id: integer()
    .notNull()
    .references(() => bodiesTable.id),
  kind: varchar().$type<"channel" | "playlist">().notNull(),
  // A YouTube channel id (UC...) or playlist id (PL...), per `kind`.
  youtube_id: varchar().notNull(),
  url: varchar().generatedAlwaysAs(
    (): SQL =>
      sql`CASE ${videoSourcesTable.kind}
            WHEN 'channel' THEN 'https://www.youtube.com/channel/' || ${videoSourcesTable.youtube_id}
            WHEN 'playlist' THEN 'https://www.youtube.com/playlist?list=' || ${videoSourcesTable.youtube_id}
          END`,
  ),
  created_at: timestamp().notNull().defaultNow(),
});

export const meetingsTable = pgTable("meetings", {
  id: serial().primaryKey(),
  body_id: integer()
    .notNull()
    .references(() => bodiesTable.id),
  youtube_id: varchar().notNull().default("").unique(),
  youtube_url: varchar().generatedAlwaysAs(
    (): SQL =>
      sql`CASE WHEN ${meetingsTable.youtube_id} != '' THEN 'https://www.youtube.com/watch?v=' || ${meetingsTable.youtube_id} ELSE '' END`,
  ),
  title: varchar().notNull().default(""),
  description: varchar().notNull().default(""),
  // An instant, not a wall-clock reading: the meeting is over and the moment it
  // gavelled in is a fact, one that has to line up with video timestamps and
  // sort against meetings in other zones. Render it through the body's
  // `timezone` to get back the time that was on the agenda.
  start_time: timestamp({ withTimezone: true }),
  duration_secs: secondsInterval(),
  created_at: timestamp().notNull().defaultNow(),
});

export const peopleTable = pgTable(
  "people",
  {
    id: serial().primaryKey(),
    // Null until a human identifies this voice. Nullable rather than "" so the
    // "not yet identified" branch is a type-level obligation everywhere a name
    // renders — the UI substitutes a per-meeting placeholder there.
    name: varchar(),
    created_at: timestamp().notNull().defaultNow(),
    voice_embedding: vector({ dimensions: VOICE_N_DIMENSIONS }).notNull(),
  },
  (table) => [
    index("idx_voice_embedding_l2").using(
      "hnsw",
      table.voice_embedding.op("vector_l2_ops"),
    ),
  ],
);

export const segmentsTable = pgTable(
  "segments",
  {
    id: serial().primaryKey(),
    meeting_id: integer()
      .notNull()
      .references(() => meetingsTable.id),
    person_id: integer().references(() => peopleTable.id),
    // Local diarization label within this meeting (eg "speaker 3"). Preserves the
    // unlabeled/segmented distinction when person_id is null: both null = no
    // speaker info at all; speaker_number set = diarized but not yet identified.
    speaker_number: integer(),
    // Everything below through duration_secs is derived from `words` by SQL
    // functions (created by hand in the migrations that introduced them —
    // drizzle-kit doesn't manage functions), so it can never drift from the
    // word-level data. Note duration_secs re-derives from `words` rather than
    // subtracting the two columns above: Postgres forbids a generated column
    // referencing another generated column.
    text: varchar().generatedAlwaysAs(
      (): SQL => sql`words_to_text(${segmentsTable.words})`,
    ),
    start_secs: secondsInterval().generatedAlwaysAs(
      (): SQL => sql`words_start_secs(${segmentsTable.words})`,
    ),
    end_secs: secondsInterval().generatedAlwaysAs(
      (): SQL => sql`words_end_secs(${segmentsTable.words})`,
    ),
    duration_secs: secondsInterval().generatedAlwaysAs(
      (): SQL =>
        sql`words_end_secs(${segmentsTable.words}) - words_start_secs(${segmentsTable.words})`,
    ),
    words: jsonb().$type<TranscriptWord[]>().notNull(),
    created_at: timestamp().notNull().defaultNow(),
  },
  (table) => [
    // A wordless segment has no text and no position on the timeline — it would
    // sort last under `ORDER BY start_secs` and render as an empty bubble. It's
    // never something the pipeline legitimately produces.
    check("segments_words_nonempty", sql`jsonb_array_length(${table.words}) > 0`),
  ],
);

export const relations = defineRelations(
  {
    jurisdictionsTable,
    bodiesTable,
    videoSourcesTable,
    meetingsTable,
    peopleTable,
    segmentsTable,
  },
  (r) => ({
    jurisdictionsTable: {
      bodies: r.many.bodiesTable({
        from: r.jurisdictionsTable.id,
        to: r.bodiesTable.jurisdiction_id,
      }),
    },
    bodiesTable: {
      jurisdiction: r.one.jurisdictionsTable({
        from: r.bodiesTable.jurisdiction_id,
        to: r.jurisdictionsTable.id,
        optional: false,
      }),
      videoSources: r.many.videoSourcesTable({
        from: r.bodiesTable.id,
        to: r.videoSourcesTable.body_id,
      }),
      meetings: r.many.meetingsTable({
        from: r.bodiesTable.id,
        to: r.meetingsTable.body_id,
      }),
    },
    videoSourcesTable: {
      body: r.one.bodiesTable({
        from: r.videoSourcesTable.body_id,
        to: r.bodiesTable.id,
        optional: false,
      }),
    },
    meetingsTable: {
      body: r.one.bodiesTable({
        from: r.meetingsTable.body_id,
        to: r.bodiesTable.id,
        optional: false,
      }),
      segments: r.many.segmentsTable({
        from: r.meetingsTable.id,
        to: r.segmentsTable.meeting_id,
      }),
    },
    peopleTable: {
      segments: r.many.segmentsTable({
        from: r.peopleTable.id,
        to: r.segmentsTable.person_id,
      }),
    },
    segmentsTable: {
      meeting: r.one.meetingsTable({
        from: r.segmentsTable.meeting_id,
        to: r.meetingsTable.id,
        optional: false,
      }),
      person: r.one.peopleTable({
        from: r.segmentsTable.person_id,
        to: r.peopleTable.id,
      }),
    },
  }),
);
