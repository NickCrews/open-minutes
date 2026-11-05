# Recordings and scouting

How Open Minutes finds recordings on the sites that publish them (YouTube,
akleg.gov), and stores their metadata and audio for later processing into
meetings.

Every meeting has exactly one **recording** (see [TERMINOLOGY.md](../../TERMINOLOGY.md)).
Every recording has 0 or 1 meetings. 0 means it isn't a meeting, eg an
unrelated video posted on a body's YouTube channel.
Keeping recordings separate from meetings means:

- Finding recordings and storing their metadata and audio is decoupled from
  transcribing them.
- A scan of a site doesn't reprocess recordings it has already seen, including
  ones that aren't meetings.

## Storage

```ts
// Site = 'youtube' | 'akleg' from core

const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

export const recordingsTable = pgTable(
  "recordings",
  {
    id: serial().primaryKey(),
    site: varchar().$type<Site>().notNull(),
    // Its ID on its site: a YouTube video ID, or an akleg.gov meeting ID.
    external_id: varchar().notNull(),
    // Copied from its `RecordingMetadata` when it is found.
    permalink: varchar().notNull(),
    title: varchar().notNull().default(""),
    description: varchar().notNull().default(""),
    // When the site published it; null when the site doesn't say.
    published_at: timestamp(),
    duration_secs: secondsInterval().notNull(),
    found_at: timestamp().notNull().defaultNow(),
    // Whether it is a meeting. Null until ingestion decides.
    is_meeting: boolean(),
    // Notes on that decision.
    notes: varchar().notNull().default(""),
    // When its audio reached the blob store, at
    // `blobStore().recording(site, external_id).audio`; null until then.
    audio_stored_at: timestamp(),
    // The error from each failed attempt to store its audio, oldest first.
    // Scouting stops trying after 3; emptying it retries.
    audio_error_history: varchar().array().notNull().default([]),
  },
  (table) => [
    unique("recordings_site_external_id_unique").on(
      table.site,
      table.external_id,
    ),
    check("recordings_site_known", oneOf(table.site, SITES)),
  ],
);

// The bodies whose meeting source lists a recording: a hint for ingestion. A
// recording in two bodies' playlists, eg a joint meeting, has both.
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

// On meetings, replacing site_kind, site_id and url:
recording_id: integer()
  .notNull()
  .unique()
  .references(() => recordingsTable.id),
```

A recording is **available** when `is_meeting` is not false, `audio_stored_at`
is set, and no meeting points at it.

### Migration

One migration creates `recordings` and `recording_bodies`, backfills them from
`meetings`, and replaces `meetings.site_kind`, `site_id` and `url` with
`recording_id`. In order:

1. Insert one `recordings` row per meeting:
   - `site`, `external_id`, `permalink`: the meeting's `site_kind`, `site_id`
     and `url`.
   - `title`, `description`: the meeting's.
   - `duration_secs`: the meeting's, else the end of its last segment, else 0.
   - `published_at`: null. Meetings don't record it.
   - `found_at`: the meeting's `created_at`.
   - `is_meeting`: true. `notes`: "".
   - `audio_stored_at`: null, so the next scouting run stores its audio. For
     most it is already in the blob store, and `storedSite` returns it from
     there without reaching the site.
   - `audio_error_history`: empty.
2. Copy `meeting_bodies` into `recording_bodies`.
3. Add `meetings.recording_id`, set it from the matching `recordings` row, then
   make it not null and unique.
4. Drop `meetings.site_kind`, `site_id` and `url`, and their unique constraint
   and check.

The seed (`packages/seed`) inserts a `recordings` row for each fixture meeting
before the meeting, the same way.

## Scouting

`pnpm scout run [--body <slug>] [--dry-run]`, in a new `packages/scout`, scans
the meeting source of every body that has one, or only the named body's:

1. List the source's recordings with its site's `RecordingLister`.
2. For each one not yet in `recordings`, get its metadata through
   `storedSite`, which also stores it in the blob store, and insert its row.
   One whose `durationSecs` is null (a YouTube stream still live or upcoming,
   an akleg.gov meeting whose audio isn't posted) is skipped, so a later run
   finds it again once it is complete. Rows are written one at a time, so a
   run cut short keeps what it found.
3. Add the source's body to `recording_bodies` for every listed recording,
   including ones already found, so a recording that later appears in a second
   body's playlist gains that body too.

Then it stores audio for each recording with `is_meeting` not false, no
`audio_stored_at` and fewer than 3 entries in `audio_error_history`, newest
`published_at` first (unknown last), up to `--max-audio <n>` per run
(default 20). It downloads each through `storedSite` into a temporary file,
which stores the audio in the blob store in its site's format (speech Opus in
WebM for YouTube, akleg.gov's MP3), and sets `audio_stored_at`. A failure
appends its error to `audio_error_history`, and the recording is retried on a
later run until its third failure. Emptying `audio_error_history` retries it
again.

`--dry-run` lists what the run would do: the new recordings, the bodies added
to `recording_bodies`, and the recordings whose audio it would store. It
fetches new recordings' metadata from their sites, but writes nothing to the
database or the blob store.

A failure with one recording or one source is logged with the source's body
and the run goes on. In CI, errors become GitHub Actions annotations, and a
run with any error exits non-zero, so the workflow shows red.

### In CI

`.github/workflows/scout.yml` runs `pnpm scout run` hourly or on demand, on
`ubuntu-latest`, with a 60-minute timeout. A `concurrency` group without
cancellation keeps runs from overlapping: a run that starts while another is
going waits for it.

- **Database**: production, connected as `export-duckdb.yml` does, through
  `neonctl` with `NEON_PROJECT_ID` and `NEON_API_KEY`.
- **Blob store**: `BLOB_STORE_ENDPOINT`, `BLOB_STORE_BUCKET`,
  `BLOB_STORE_ACCESS_KEY_ID` and `BLOB_STORE_SECRET_ACCESS_KEY` from secrets,
  so `storedSite` stores what it fetches.
- **YouTube**: listing a channel or playlist works from a runner's IP, but
  yt-dlp's metadata and audio requests are refused. The workflow restores the
  WARP and Tor .deb cache as `fetch-youtube-audio.yml` does, and `pnpm scout
  run --debs <dir>` builds its YouTube adapter with `installEgress`, so yt-dlp
  installs and goes through WARP or Tor when a direct request is refused.
  `YOUTUBE_AUDIO_DISPATCH_TOKEN` isn't set: the run is already on a runner, so
  dispatching `fetch-youtube-audio.yml` gains nothing.
- **akleg.gov**: no setup.

## Turning a recording into a meeting

That is a later step, not covered here. Scouting gives it everything it
needs, in the same form for every site: the `recordings` row,
`recording_bodies`, and the metadata and audio in the blob store. Ingestion
never reaches a recording's site.

## Tests

- The listers and adapters keep their own tests in their packages, including
  the live ones against YouTube and akleg.gov.
- Scouting runs against a database, fake listers, a fake `SiteAdapter` and
  `memoryBlobStore`. Its tests compare the database and blob store before and
  after a run: rows written, recordings already found not fetched again,
  bodies added for a recording listed by a second source, incomplete
  recordings skipped and found on a later run, audio stored, the per-run cap,
  a failed download retried until its third failure, `--dry-run` writing
  nothing, and the exit code.
- The migration's backfill is tested: a meeting's `recordings` and
  `recording_bodies` rows, `recording_id`, and the `duration_secs` fallbacks.
