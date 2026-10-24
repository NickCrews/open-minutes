# ADR 0005: Store recordings as first-class rows

Date: 2026-10-24
Status: Proposed

## Context

A **recording** (see `TERMINOLOGY.md`) exists in the database only as two columns on the meeting made from it, `meetings.site_kind` and `meetings.site_id`.
Nothing records a recording we found but haven't ingested, or one we decided isn't a meeting, so every scan of a site rediscovers and rejudges both.
One place on a site can carry several bodies' meetings: the GBOS channel carries GBOS and Girdwood committee meetings, and the MOA channel carries the Assembly, PZC and committees.
Deciding which recordings are meetings, and of which bodies, needs judgment, often an LLM's.

## Decision

Recordings get their own table, written when a recording is found, before and independent of any meeting.
A meeting points at its recording, and exists from the moment a recording is judged to be one, before it is transcribed.
Everything that finds, judges or ingests recordings reads and writes these tables.

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
    // The `Scout.id` that reported it, eg "moa-youtube"; null for one added by
    // hand or backfilled. Scouts live in code, so not a foreign key.
    scout_id: varchar(),
    found_at: timestamp().notNull().defaultNow(),
    is_meeting: boolean().notNull(),
    // The scout's notes on its decision: why it rejected a recording, or how it
    // read a meeting's bodies, date and time.
    notes: varchar().notNull().default(""),
  },
  (table) => [
    unique("recordings_site_site_id_unique").on(table.site, table.site_id),
    check("recordings_site_known", oneOf(table.site, SITES)),
  ],
);

// meetings: replaces site_kind, site_id and url, and adds transcribed_at.
recording_id: integer()
  .notNull()
  .unique()
  .references(() => recordingsTable.id),
// When ingestion stored its transcript; null until then.
transcribed_at: timestamp(),
```

- A recording is a meeting when `is_meeting`, and rejected otherwise.
  Rejected recordings stay, so nothing judges them twice.
- For a meeting, the harness also creates its `meetings` row (title, description, date, time, timezone) and its `meeting_bodies` rows, in the same transaction as the recording.
- An available meeting is a meeting with no `transcribed_at`.
- Ingestion stores a meeting's segments and sets `transcribed_at` in one transaction.
  It may still refine the meeting's time from the gavel-in.
- Everything that shows transcripts (the web app, search, `llms.txt`, agent tools, the DuckDB export) reads only meetings with `transcribed_at`.
- A migration creates a recording for each existing meeting, points the meeting at it, sets `transcribed_at` to the meeting's `created_at`, then drops `meetings.site_kind`, `site_id`, `url` and `bodies.meeting_source`.
- `MeetingSource`, `listerFor` and `resolveBody` go away.

### Scouts

Recordings are written by **scouts**.
A scout watches one place on a site and reports each new recording as a meeting of one or more of the bodies it covers, or as not a meeting.
A harness runs scouts on a schedule and writes their reports to `recordings`, `meetings` and `meeting_bodies`.

| id             | Watches                                 | Bodies                             | Schedule                      | Classifies with |
| -------------- | --------------------------------------- | ---------------------------------- | ----------------------------- | --------------- |
| `gbos-youtube` | GBOS channel `UCOUlNInprZEjhbpVPiJOlEA` | `gbos`, LUC, other Girdwood bodies | daily, weekdays               | LLM             |
| `moa-youtube`  | MOA channel                             | `assembly`, `pzc`, `ced`, …        | several times a day, weekdays | LLM             |
| `akleg`        | akleg.gov committees                    | `hres`, …                          | daily                         | committee code  |

#### Contract (`@open-minutes/core/scout`)

```ts
/** A recording's key: `recordings.site` and `recordings.site_id`. */
interface RecordingKey {
  site: Site; // see SITES
  site_id: string;
}

/**
 * What a scout reports for one recording: its `recordings` columns, minus the
 * ones the harness fills in (`id`, `scout_id`, `found_at`), and, for a
 * meeting, its `meetings` columns and its bodies as slugs, which the harness
 * turns into `meeting_bodies` rows.
 */
interface ScoutedRecording extends RecordingKey {
  permalink: string | null;
  is_meeting: boolean;
  notes: string;
  title: string;
  description: string;
  date: string | null;
  time: string | null;
  timezone: string | null; // null on a meeting means the first body's
  bodies: string[]; // at least one when is_meeting, none otherwise
}

interface Scout {
  id: string;
  name: string;
  bodies: readonly string[]; // slugs it may report
  schedule: string; // cron, UTC
  scan(ctx: ScoutContext): Promise<ScoutedRecording[]>;
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
- Every recording a scout examines is reported, as a meeting or not.

#### Harness

- `om scout [--scout <id>] [--dry-run]` runs scouts and writes `recordings`, `meetings` and `meeting_bodies`.
  It validates bodies against the scout's `bodies`.
- `om available` lists meetings with no `transcribed_at`.
- `.github/workflows/scout.yml` runs hourly, and runs each scout whose cron fell in the past hour.

#### YouTube

- List with `yt-dlp --flat-playlist -J`, then `yt-dlp --skip-download -J` for each recording `unseen` returns.
- In CI, yt-dlp goes through the WARP/Tor egress in `packages/youtube/egress`.
- Classification happens inside the scout.

#### Tests

- Each scout end to end against its live site, YouTube or akleg.gov, with as little mocking as possible: run it and check it reports real recordings correctly.
- The harness, with fake scouts: which scouts run for a given hour's crons, and the database before and after a run (rows written, `unseen` skipping recordings already reported, unknown bodies rejected).
- The migration's backfill.

### Out of scope

- An LLM in `ScoutContext`.
- Ingesting automatically after scouting.
