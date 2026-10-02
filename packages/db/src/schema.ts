import { defineRelations, SQL, sql } from "drizzle-orm";
import {
  pgTable,
  integer,
  interval,
  jsonb,
  timestamp,
  boolean,
  date,
  time,
  serial,
  varchar,
  vector,
  index,
  check,
  foreignKey,
  pgView,
  unique,
} from "drizzle-orm/pg-core";
import { N_DIMENSIONS as VOICE_N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";
import { TranscriptWord } from "@open-minutes/core/transcription";

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
  // IANA zone the body meets in, eg "America/Anchorage". A meeting's `date` and
  // `time` are wall-clock readings in this zone (see ADR 0004); this is what
  // would turn one into an instant, should anything ever need one.
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

export const meetingsTable = pgTable(
  "meetings",
  {
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
    // When the meeting happened, as the wall clock read in the body's `timezone`
    // — the form it appears in on an agenda, and the only one anyone reads off a
    // video. Split in two because we often know the day but not the hour: a null
    // `time` means "time unknown", never midnight. Both are null until someone
    // supplies them (ingestion can't derive either); a time without a date is
    // meaningless and forbidden. Kept as strings ("2026-06-14", "19:30:00") so no
    // JS Date — and no machine timezone — ever gets a chance to shift them. See
    // ADR 0004.
    date: date({ mode: "string" }),
    time: time(),
    duration_secs: secondsInterval(),
    created_at: timestamp().notNull().defaultNow(),
  },
  (table) => [
    check(
      "meetings_time_requires_date",
      sql`${table.time} IS NULL OR ${table.date} IS NOT NULL`,
    ),
  ],
);

export const peopleTable = pgTable(
  "people",
  {
    id: serial().primaryKey(),
    // Stable handle for a known person (eg "kyle-kelly") that means the same
    // person in every database: prod, dev and each test database. `id` can't do
    // this, since a serial id depends on one database's insert order: Kyle Kelly
    // might be person 7 in prod and person 2 in a test database.
    //
    // The slug links the golden fixtures to rows. For example:
    //   - people.jsonl has {"slug":"kyle-kelly","name":"Kyle Kelly",...}
    //   - meetings/gbos_9HoIM5INxpI/golden.psv labels his turns
    //     {"begin_speaker":"identified:kyle-kelly"}
    //   - seeding that meeting upserts the people row with slug "kyle-kelly",
    //     so seeding a second meeting he speaks in reuses the same row
    //   - after ingesting a held-out meeting, the e2e test checks that each
    //     segment its fixture labels "identified:<slug>" resolved to the person
    //     with that slug
    //
    // Within one database, segments across meetings share a person through
    // `person_id`, slug or no slug. Null for an anonymous voice that recognition
    // created; giving one a slug (eg with the update_person tool) makes them a
    // known person. Renaming a slug breaks the link to the fixtures, so rename
    // it everywhere it's used.
    slug: varchar().unique(),
    // Null until a human identifies this voice. Nullable rather than "" so the
    // "not yet identified" branch is a type-level obligation everywhere a name
    // renders — the UI substitutes a per-meeting placeholder there.
    name: varchar(),
    // Free-form background a human writes down: role, affiliation, tenure. Eg
    // "Mayor of Anchorage since 2024" or "member of GBOS from May 2020 to 2026".
    // Prose rather than structured fields — roles and dates are too irregular
    // across jurisdictions to model, and nothing queries this.
    bio: varchar(),
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
    check(
      "segments_words_nonempty",
      sql`jsonb_array_length(${table.words}) > 0`,
    ),
  ],
);

/**
 * One run that produced a meeting's chapters: a model pass, or a person writing
 * them by hand. Chapters can drift from the transcript they summarize, unlike
 * the generated columns on `segments`, so every chapter points at the run that
 * made it. Regenerating a meeting adds a run and replaces the meeting's
 * chapters with that run's; earlier runs stay as history. See docs/chapters.md.
 */
export const chapterGenerationsTable = pgTable(
  "chapter_generations",
  {
    id: serial().primaryKey(),
    meeting_id: integer()
      .notNull()
      .references(() => meetingsTable.id),
    // What wrote the chapters: a model id, or "human" for hand-written ones.
    model: varchar().notNull(),
    prompt_version: varchar().notNull(),
    // Hash of the transcript the chapters were written from, so a later
    // re-transcription can be detected as making them stale. Speaker relabels
    // don't change it: chapter speakers are derived, never stored.
    transcript_fingerprint: varchar().notNull(),
    generated_at: timestamp().notNull().defaultNow(),
    reviewed_by_human: boolean().notNull().default(false),
  },
  // The target of chapters' composite foreign key, which keeps a chapter's
  // meeting and its generation's meeting the same.
  (table) => [unique().on(table.id, table.meeting_id)],
);

/**
 * A table-of-contents entry for a meeting: a titled, summarized time range,
 * usually one agenda item or one stretch of public comment. A meeting's
 * chapters are ordered and never overlap (an exclusion constraint, added by
 * hand in the migration that created this table, enforces it), but gaps are
 * legal: silence before the stream starts, a recess, or a few seconds of slop
 * between neighbours. Who spoke in a chapter is derived from `segments`, in the
 * `chapter_speakers` view. See docs/chapters.md.
 */
export const chaptersTable = pgTable(
  "chapters",
  {
    id: serial().primaryKey(),
    meeting_id: integer().notNull(),
    generation_id: integer().notNull(),
    start_secs: secondsInterval().notNull(),
    end_secs: secondsInterval().notNull(),
    // A few words, scannable as a table of contents.
    title: varchar().notNull(),
    // One sentence: what a tooltip, a collapsed row, or an agent outline shows.
    summary: varchar().notNull(),
    // 3–7 for a substantive chapter, 0–1 for a short procedural one. Bullets
    // summarize the whole chapter, so they carry no timestamps.
    bullets: varchar()
      .array()
      .notNull()
      .default(sql`'{}'::varchar[]`),
  },
  (table) => [
    foreignKey({
      name: "chapters_generation_fkey",
      columns: [table.generation_id, table.meeting_id],
      foreignColumns: [
        chapterGenerationsTable.id,
        chapterGenerationsTable.meeting_id,
      ],
    }),
    check(
      "chapters_end_after_start",
      sql`${table.end_secs} > ${table.start_secs}`,
    ),
    check("chapters_start_nonnegative", sql`${table.start_secs} >= '0'`),
    // Invariants only; the size conventions (1–15 minutes, 3–7 bullets) are
    // prompt guidance checked in code, so they can change without a migration.
    check("chapters_title_nonblank", sql`btrim(${table.title}) <> ''`),
    check("chapters_summary_nonblank", sql`btrim(${table.summary}) <> ''`),
    check("chapters_bullets_nonblank", sql`'' <> ALL (${table.bullets})`),
    index("idx_chapters_meeting_start").on(table.meeting_id, table.start_secs),
  ],
);

/**
 * How long each speaker talked within each chapter: the segments overlapping
 * the chapter, clipped to its range, summed per speaker. Keyed like the web's
 * speaker grouping: by person when there is one, else by speaker number, else
 * neither (unattributed speech). Derived so relabelling a speaker shows up
 * here at once.
 */
export const chapterSpeakersView = pgView("chapter_speakers", {
  chapter_id: integer().notNull(),
  meeting_id: integer().notNull(),
  person_id: integer(),
  speaker_number: integer(),
  speaking_secs: secondsInterval().notNull(),
}).as(
  sql`SELECT c.id AS chapter_id, c.meeting_id, s.person_id,
        CASE WHEN s.person_id IS NULL THEN s.speaker_number END AS speaker_number,
        sum(LEAST(s.end_secs, c.end_secs) - GREATEST(s.start_secs, c.start_secs)) AS speaking_secs
      FROM chapters c
      JOIN segments s ON s.meeting_id = c.meeting_id
        AND s.start_secs < c.end_secs AND s.end_secs > c.start_secs
      GROUP BY c.id, c.meeting_id, s.person_id,
        CASE WHEN s.person_id IS NULL THEN s.speaker_number END`,
);

export const relations = defineRelations(
  {
    jurisdictionsTable,
    bodiesTable,
    videoSourcesTable,
    meetingsTable,
    peopleTable,
    segmentsTable,
    chapterGenerationsTable,
    chaptersTable,
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
      chapters: r.many.chaptersTable({
        from: r.meetingsTable.id,
        to: r.chaptersTable.meeting_id,
      }),
      chapterGenerations: r.many.chapterGenerationsTable({
        from: r.meetingsTable.id,
        to: r.chapterGenerationsTable.meeting_id,
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
    chapterGenerationsTable: {
      meeting: r.one.meetingsTable({
        from: r.chapterGenerationsTable.meeting_id,
        to: r.meetingsTable.id,
        optional: false,
      }),
      chapters: r.many.chaptersTable({
        from: r.chapterGenerationsTable.id,
        to: r.chaptersTable.generation_id,
      }),
    },
    chaptersTable: {
      meeting: r.one.meetingsTable({
        from: r.chaptersTable.meeting_id,
        to: r.meetingsTable.id,
        optional: false,
      }),
      generation: r.one.chapterGenerationsTable({
        from: r.chaptersTable.generation_id,
        to: r.chapterGenerationsTable.id,
        optional: false,
      }),
    },
  }),
);
