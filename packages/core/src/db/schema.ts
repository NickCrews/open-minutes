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
} from "drizzle-orm/pg-core";
import { N_DIMENSIONS as VOICE_N_DIMENSIONS } from "../voice_embeddings";
import { TranscriptWord } from "../transcription";

const secondsInterval = () => interval({ fields: "second", precision: 3 });

export const municipalitiesTable = pgTable("municipalities", {
  id: serial().primaryKey(),
  name: varchar().notNull().default(""),
  name_short: varchar().notNull().default(""),
  state: varchar().notNull().default(""),
  postcode: varchar().default(""),
  youtube_channel_id: varchar().default(""),
  youtube_channel_url: varchar().generatedAlwaysAs(
    (): SQL =>
      sql`CASE WHEN ${municipalitiesTable.youtube_channel_id} != '' THEN 'https://www.youtube.com/channel/' || ${municipalitiesTable.youtube_channel_id} ELSE '' END`,
  ),
  created_at: timestamp().notNull().defaultNow(),
});

export const meetingsTable = pgTable("meetings", {
  id: serial().primaryKey(),
  municipality_id: integer()
    .notNull()
    .references(() => municipalitiesTable.id),
  youtube_id: varchar().notNull().default("").unique(),
  youtube_url: varchar().generatedAlwaysAs(
    (): SQL =>
      sql`CASE WHEN ${meetingsTable.youtube_id} != '' THEN 'https://www.youtube.com/watch?v=' || ${meetingsTable.youtube_id} ELSE '' END`,
  ),
  title: varchar().notNull().default(""),
  description: varchar().notNull().default(""),
  start_time: timestamp(),
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

export const segmentsTable = pgTable("segments", {
  id: serial().primaryKey(),
  meeting_id: integer()
    .notNull()
    .references(() => meetingsTable.id),
  person_id: integer().references(() => peopleTable.id),
  // Local diarization label within this meeting (eg "speaker 3"). Preserves the
  // unlabeled/segmented distinction when person_id is null: both null = no
  // speaker info at all; speaker_number set = diarized but not yet identified.
  speaker_number: integer(),
  // Derived from `words` by the words_to_text() SQL function (created by hand in
  // the migration that introduced this column — drizzle-kit doesn't manage
  // functions), so it can never drift from the word-level data.
  text: varchar().generatedAlwaysAs(
    (): SQL => sql`words_to_text(${segmentsTable.words})`,
  ),
  start_secs: secondsInterval(),
  end_secs: secondsInterval(),
  duration_secs: secondsInterval().generatedAlwaysAs(
    (): SQL => sql`${segmentsTable.end_secs} - ${segmentsTable.start_secs}`,
  ),
  words: jsonb().$type<TranscriptWord[]>().notNull(),
  created_at: timestamp().notNull().defaultNow(),
});

export const relations = defineRelations(
  { municipalitiesTable, meetingsTable, peopleTable, segmentsTable },
  (r) => ({
    municipalitiesTable: {
      meetings: r.many.meetingsTable({
        from: r.municipalitiesTable.id,
        to: r.meetingsTable.municipality_id,
      }),
    },
    meetingsTable: {
      municipality: r.one.municipalitiesTable({
        from: r.meetingsTable.municipality_id,
        to: r.municipalitiesTable.id,
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
