import { defineRelations, SQL, sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
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

export const MEETING_STATUSES = [
  "discovered",
  "downloaded",
  "transcribed",
  "diarized",
  "aligned",
  "identified",
  "embedded",
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
export const meetingStatusEnum = pgEnum("meeting_status", MEETING_STATUSES);

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
  status: meetingStatusEnum().notNull().default("discovered"),
  transcription: jsonb(),
  diarization: jsonb(),
  created_at: timestamp().notNull().defaultNow(),
});

export const peopleTable = pgTable(
  "people",
  {
    id: serial().primaryKey(),
    name: varchar().notNull().default(""),
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

export interface SegmentWord {
  text: string;
  start: number;
  end: number;
}

export const segmentsTable = pgTable("segments", {
  id: serial().primaryKey(),
  meeting_id: integer()
    .notNull()
    .references(() => meetingsTable.id),
  person_id: integer().references(() => peopleTable.id),
  text: varchar().notNull(),
  start_secs: secondsInterval(),
  end_secs: secondsInterval(),
  duration_secs: secondsInterval().generatedAlwaysAs(
    (): SQL => sql`${segmentsTable.end_secs} - ${segmentsTable.start_secs}`,
  ),
  words: jsonb().$type<SegmentWord[]>(),
  created_at: timestamp().notNull().defaultNow(),
});

export const relations = defineRelations(
  { municipalitiesTable, meetingsTable, peopleTable, segmentsTable },
  (r) => ({
    meetingsTable: {
      municipality: r.one.municipalitiesTable({
        from: r.meetingsTable.municipality_id,
        to: r.municipalitiesTable.id,
      }),
    },
    peopleTable: {
      segments: r.many.segmentsTable({
        from: r.peopleTable.id,
        to: r.segmentsTable.person_id,
      }),
    },
  }),
);
