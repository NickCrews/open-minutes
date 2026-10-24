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
A meeting points at its recording.
Everything that finds, judges or ingests recordings reads and writes that table.

### Storage

```ts
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
    title: varchar().notNull().default(""),
    description: varchar().notNull().default(""),
    date: date({ mode: "string" }),
    time: time(),
    timezone: varchar(),
  },
  (table) => [
    unique("recordings_site_site_id_unique").on(table.site, table.site_id),
    check("recordings_site_known", sql`${table.site} IN ('youtube', 'akleg')`),
    check(
      "recordings_meeting_has_timezone",
      sql`NOT ${table.is_meeting} OR ${table.timezone} IS NOT NULL`,
    ),
    check(
      "recordings_timezone_valid",
      sql`${table.timezone} IS NULL OR iana_timezone_error(${table.timezone}) IS NULL`,
    ),
    check(
      "recordings_time_requires_date",
      sql`${table.time} IS NULL OR ${table.date} IS NOT NULL`,
    ),
  ],
);

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
  (table) => [
    primaryKey({ columns: [table.recording_id, table.body_id] }),
    index("idx_recording_bodies_body").on(table.body_id),
  ],
);
```

- A recording is a meeting candidate when `is_meeting`, and rejected otherwise.
  Rejected recordings stay, so nothing judges them twice.
- `meetings.recording_id` (non-null, unique, FK to `recordings.id`) replaces `meetings.site_kind`, `site_id` and the generated `url`.
- An available meeting is a recording with `is_meeting` and no meeting pointing at it.
- Ingestion reads the recording's bodies, title, description and date, and creates the meeting pointing at it in one transaction.
- A migration creates a recording for each existing meeting, points the meeting at it, then drops `meetings.site_kind`, `site_id`, `url` and `bodies.meeting_source`.
- `MeetingSource`, `listerFor` and `resolveBody` go away.

### Scouts

Recordings are written by **scouts**.
A scout watches one place on a site and reports each new recording as a meeting of one or more of the bodies it covers, or as not a meeting.
A harness runs scouts on a schedule and writes their reports to `recordings`.

| id             | Watches                                 | Bodies                             | Schedule                      | Classifies with |
| -------------- | --------------------------------------- | ---------------------------------- | ----------------------------- | --------------- |
| `gbos-youtube` | GBOS channel `UCOUlNInprZEjhbpVPiJOlEA` | `gbos`, LUC, other Girdwood bodies | daily, weekdays               | LLM             |
| `moa-youtube`  | MOA channel                             | `assembly`, `pzc`, `ced`, …        | several times a day, weekdays | LLM             |
| `akleg`        | akleg.gov committees                    | `hres`, …                          | daily                         | committee code  |

#### Contract (`@open-minutes/core/scout`)

```ts
/** A recording's key: `recordings.site` and `recordings.site_id`. */
interface RecordingKey {
  site: Site;
  site_id: string;
}

/**
 * What a scout reports for one recording: a `recordings` row without the
 * columns the harness fills in (`id`, `scout_id`, `found_at`), plus its
 * bodies as slugs, which the harness turns into `recording_bodies` rows.
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

- `om scout [--scout <id>] [--dry-run]` runs scouts and writes `recordings`.
  It validates bodies against the scout's `bodies`.
- `om available` reads `recordings`.
- `.github/workflows/scout.yml` runs hourly, and runs each scout whose cron fell in the past hour.

#### YouTube

- List with `yt-dlp --flat-playlist -J`, then `yt-dlp --skip-download -J` for each recording `unseen` returns.
- In CI, yt-dlp goes through the WARP/Tor egress in `packages/youtube/egress`.
- Classification uses the Anthropic SDK, called inside the scout behind `classify(recordings, bodies): ScoutedRecording[]`.
  The API key comes from an env var.

#### Tests

- Each scout, with a faked listing and a faked `classify`.
- The harness rejecting unknown bodies.
- `om scout --dry-run` against a seeded database.
- The migration's backfill.
- An on-demand eval of `classify` on the golden meetings plus saved non-meeting recordings.

### Out of scope

- An LLM in `ScoutContext`.
- Ingesting automatically after scouting.

### Open questions

- Should scouting create the meeting row, leaving it untranscribed, so a meeting's bodies, date and time live only on `meetings` and `meeting_bodies`?
