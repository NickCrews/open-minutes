# ADR 0005: Store recordings as first-class rows

Date: 2026-10-24
Status: Proposed

## Context

A **recording** (see `TERMINOLOGY.md`) exists in the database only as two columns on the meeting made from it, `meetings.site_kind` and `meetings.site_id`.
Nothing records a recording we found but haven't ingested, or one we decided isn't a meeting, so every scan of a site rediscovers and rejudges both.
One place on a site can carry several bodies' meetings: the GBOS channel carries GBOS and Girdwood committee meetings, and the MOA channel carries the Assembly, PZC and committees.

## Decision

Recordings get their own table, written when a recording is found, before and independent of any meeting.
A meeting points at its recording.
Finding recordings and judging them are separate jobs: **scouts** find recordings and may judge them, and **ingestion** judges whatever a scout left open.

### Storage

```ts
// @open-minutes/core, replacing SiteKind and SITE_KINDS
export const SITES = ["youtube", "akleg"] as const;
export type Site = (typeof SITES)[number];

// packages/db/src/schema.ts, beside kebabCase
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

export const recordingsTable = pgTable(
  "recordings",
  {
    id: serial().primaryKey(),
    site: varchar().$type<Site>().notNull(),
    // Its ID on its site: a YouTube video ID, or an akleg.gov meeting ID.
    site_id: varchar().notNull(),
    permalink: varchar(),
    // As the site gives them.
    title: varchar().notNull().default(""),
    description: varchar().notNull().default(""),
    upload_date: date({ mode: "string" }),
    duration_secs: secondsInterval(),
    // The `Scout.id` that reported it, eg "moa-youtube"; null for one added by
    // hand or backfilled. Scouts live in code, so not a foreign key.
    scout_id: varchar(),
    found_at: timestamp().notNull().defaultNow(),
    // Whether it is a meeting. Null until a scout or ingestion decides.
    is_meeting: boolean(),
    // Notes on that decision, from whoever made it.
    notes: varchar().notNull().default(""),
    // When its audio reached the object store, at
    // recordings/<site>/<site_id>/speech.webm; null until then.
    audio_stored_at: timestamp(),
  },
  (table) => [
    unique("recordings_site_site_id_unique").on(table.site, table.site_id),
    check("recordings_site_known", oneOf(table.site, SITES)),
  ],
);

// Bodies a scout says a recording belongs to; a hint for ingestion.
export const recordingBodiesTable = pgTable(
  "recording_bodies",
  {
    recording_id: integer()
      .notNull()
      .references(() => recordingsTable.id, { onDelete: "cascade" }),
    body_id: integer()
      .notNull()
      .references(() => bodiesTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.recording_id, table.body_id] })],
);

// meetings: replaces site_kind, site_id and url.
recording_id: integer()
  .notNull()
  .unique()
  .references(() => recordingsTable.id),
```

- An available recording is one with `is_meeting` not false, `audio_stored_at` set, and no meeting pointing at it.
- A migration creates a recording for each existing meeting, with `is_meeting` true, points the meeting at it, then drops `meetings.site_kind`, `site_id`, `url` and `bodies.meeting_source`.
- `MeetingSource`, `listerFor` and `resolveBody` go away.

### Ingestion

Ingestion never deals with a recording's site: the site's scout has already normalized what ingestion needs, the `recordings` row and the audio in the object store, to a common format.

1. If the recording's `is_meeting` is null, decide it, before transcribing, from the title, description and duration.
   A recording that isn't a meeting gets `is_meeting` false and `notes`, and ingestion stops.
2. Read the audio from the object store, then transcribe, diarize, align and recognize, as now.
3. Decide the bodies, date and time from the title and the opening of the transcript, starting from the scout's `recording_bodies` if it gave any.
   A body ingestion can't determine is left off; the meeting is stored without it and flagged for a person or agent to fill in.
4. Store the meeting, its `meeting_bodies` and segments, set `is_meeting` true, all in one transaction.

### Scouts

A scout watches one place on a site and reports each new recording.
How much it decides is up to it: the minimum is the recording and what the site says about it, and it may also decide whether it is a meeting and suggest its bodies.
A harness runs scouts on a schedule and writes their reports.

| id             | Watches                                 | Bodies                             | Schedule                      |
| -------------- | --------------------------------------- | ---------------------------------- | ----------------------------- |
| `gbos-youtube` | GBOS channel `UCOUlNInprZEjhbpVPiJOlEA` | `gbos`, LUC, other Girdwood bodies | daily, weekdays               |
| `moa-youtube`  | MOA channel                             | `assembly`, `pzc`, `ced`, …        | several times a day, weekdays |
| `akleg`        | akleg.gov committees                    | `hres`, …                          | daily                         |

The akleg.gov scout knows each recording's body from its committee code and that every one is a meeting.
The YouTube scouts start with title rules, eg "test" in the title means not a meeting, and leave the rest null.

#### Contract (`@open-minutes/core/scout`)

```ts
/** A recording's key: `recordings.site` and `recordings.site_id`. */
interface RecordingKey {
  site: Site; // see SITES
  site_id: string;
}

/**
 * What a scout reports for one recording: its `recordings` columns, minus
 * the ones the harness fills in (`id`, `scout_id`, `found_at`), plus any
 * bodies it can name, as slugs, which the harness writes to
 * `recording_bodies`.
 */
interface ScoutedRecording extends RecordingKey {
  permalink: string | null;
  title: string;
  description: string;
  upload_date: string | null;
  duration_secs: number | null;
  is_meeting: boolean | null; // null leaves it to ingestion
  notes: string;
  bodies: string[]; // may be empty
}

interface Scout {
  id: string;
  name: string;
  bodies: readonly string[]; // slugs it may report
  schedule: string; // cron, UTC
  scan(ctx: ScoutContext): Promise<ScoutedRecording[]>;
  /** Download the recording's audio to `dest` as Opus, converting if the site serves another format. */
  fetchAudio(
    recording: RecordingKey,
    dest: string,
    signal: AbortSignal,
  ): Promise<void>;
}

interface ScoutContext {
  /** The ones no scout has reported yet. */
  unseen(recordings: readonly RecordingKey[]): Promise<RecordingKey[]>;
  log(message: string): void;
  signal: AbortSignal;
  now: Date;
}
```

- Scouts don't touch the database.
  They may shell out, use the filesystem and read env vars.

#### Harness

- `om scout [--scout <id>] [--dry-run]` runs scouts and writes `recordings` and `recording_bodies`.
  It validates bodies against the scout's `bodies`.
- After writing a run's reports, the harness fetches audio eagerly: for each recording with `is_meeting` not false and no `audio_stored_at`, newest first and up to a cap per run, it calls `fetchAudio` into a temporary file, encodes it for speech (`.github/scripts/encode-speech-audio.sh`), uploads it to `recordings/<site>/<site_id>/speech.webm` and sets `audio_stored_at`.
  A failed fetch is logged and retried on the next run.
- `om available` lists available recordings.
- `.github/workflows/scout.yml` runs hourly, and runs each scout whose cron fell in the past hour.

#### YouTube

- List with `yt-dlp --flat-playlist -J`, then `yt-dlp --skip-download -J` for each recording `unseen` returns.
- `fetchAudio` downloads YouTube's Opus stream (format 251) with yt-dlp.
- In CI, yt-dlp goes through the WARP/Tor egress in `packages/youtube/egress`.
- `fetch-youtube-audio.yml` goes away; the scout workflow does its job.

#### Tests

- Each scout end to end against its live site, YouTube or akleg.gov, with as little mocking as possible: run it and check it reports real recordings correctly.
- Each scout's `fetchAudio` against its live site, on one short recording.
- The harness, with fake scouts: which scouts run for a given hour's crons, and the database and object store before and after a run (rows written, `unseen` skipping recordings already reported, unknown bodies rejected, audio uploaded, the per-run cap, a failed fetch retried next run).
- Ingestion deciding `is_meeting` and bodies for recordings a scout left open.
- The migration's backfill.

### Out of scope

- An LLM in `ScoutContext`.
- Starting ingestion (transcription, chapters, summaries) automatically after scouting.
