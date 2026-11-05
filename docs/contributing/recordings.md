# Recordings and scouting

How Open Minutes finds recordings on upstream sites (eg youtube, akleg website), and stores their
metadata and audio for later processing into meetings.

Every meeting has exactly one **recording** (see [TERMINOLOGY.md](../../TERMINOLOGY.md)).
Every recoring has 0 or 1 meetings. 0 means that this is an eg unrelated video posted on the youtube channel.
Recordings being separate means:
- we can decouple the audio/transcript processing stage from the "discover and get the audio and metadata into the db" stage.
- A scan of a site does not have to reprocesses already seen non-meeting recordings.

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
    // Errors from the last (up to 3) failed attempts to store its audio.
    audio_error_history: varchar().array().default([]),
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

Switching to this from the old flat meetings table schema required a db migration.

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
`audio_stored_at` and fewer than 3 `audio_failures`, newest `published_at`
first (unknown last), up to a cap per run. It downloads each through
`storedSite` into a temporary file, which stores the audio in the blob store
in its site's format (speech Opus in WebM for YouTube, akleg.gov's MP3), and
sets `audio_stored_at`. A failure increments `audio_failures`, sets
`audio_error`, and is retried on a later run until the third. Resetting
`audio_failures` to 0 retries it again.

Different sites have different environment needs. eg scouting from youtube
may need WARP or TOR installed, see the site-specific package for details.

A failure with one recording or one source is logged with the source's body
and the run goes on. In CI, errors become GitHub Actions annotations, and a
run with any error exits non-zero, so the workflow shows red.

`.github/workflows/scout.yml` runs `pnpm scout run` hourly or on demand.

## Turning a recording into a meeting

We don't deal with this here, this is a followup step.
This scouting step SHOULD give the ingerst step everything
it needs so that it doesn't have to do site-specific stuff,
eg the ingest stage shouldn't have to actually hit the youtube servers.
This scouting should normalize each site to a common format.

## Tests

- The listers and adapters keep their own tests in their packages, including
  the live ones against YouTube and akleg.gov.
- Scouting runs against a database, fake listers, a fake `SiteAdapter` and
  `memoryBlobStore`. Its tests compare the database and blob store before and
  after a run: rows written, recordings already found not fetched again,
  bodies added for a recording listed by a second source, incomplete
  recordings skipped and found on a later run, audio stored, the per-run cap,
  a failed download retried until its third failure, and the exit code.
- The migration's backfill is tested.
- Deciding `is_meeting` and bodies for a recording.
