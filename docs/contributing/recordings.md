# Recordings and scouts

How Open Minutes finds recordings on the sites that publish them, decides
which are meetings, and stores their audio.

A **recording** (see [TERMINOLOGY.md](../../TERMINOLOGY.md)) is a row of its
own, written as soon as a recording is found, before and independent of any
meeting. A meeting points at its recording. Recordings that aren't meetings
stay in the table, so no scan of a site rediscovers or rejudges them.

Finding recordings and judging them are separate jobs. **Scouts** find
recordings and may judge them. Whatever turns a recording into a meeting
judges what a scout left open.

## Storage

`SITES` in `@open-minutes/core` lists the sites, and `Site` is its type:

```ts
export const SITES = ["youtube", "akleg"] as const;
export type Site = (typeof SITES)[number];
```

In `packages/db/src/schema.ts`, `oneOf` builds a check from such a list, beside
`kebabCase`:

```ts
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

export const recordingsTable = pgTable(
  "recordings",
  {
    id: serial().primaryKey(),
    site: varchar().$type<Site>().notNull(),
    // Its ID on its site: a YouTube video ID, or an akleg.gov meeting ID.
    external_id: varchar().notNull(),
    permalink: varchar(),
    // As the site gives them.
    title: varchar().notNull().default(""),
    description: varchar().notNull().default(""),
    // When the site published it, in UTC; null when the site doesn't say.
    published_at: timestamp(),
    duration_secs: secondsInterval(),
    // The `Scout.id` that reported it, eg "moa-youtube"; null for one added by
    // hand. Scouts live in code, so not a foreign key.
    scout_id: varchar(),
    found_at: timestamp().notNull().defaultNow(),
    // Whether it is a meeting. Null until a scout or ingestion decides.
    is_meeting: boolean(),
    // Notes on that decision, from whoever made it.
    notes: varchar().notNull().default(""),
    // When its audio reached the blob store, at
    // recordings/<site>/<external_id>/speech.webm; null until then.
    audio_stored_at: timestamp(),
    // Failed attempts to fetch and store its audio, and the last one's error.
    audio_failures: integer().notNull().default(0),
    audio_error: varchar(),
  },
  (table) => [
    unique("recordings_site_external_id_unique").on(
      table.site,
      table.external_id,
    ),
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

// On meetings:
recording_id: integer()
  .notNull()
  .unique()
  .references(() => recordingsTable.id),
```

A recording is **available** when `is_meeting` is not false, `audio_stored_at`
is set, and no meeting points at it.

## Scouts

A scout watches one place on a site and reports each new recording there. One
place can carry several bodies' meetings: the GBOS channel carries GBOS and
Girdwood committee meetings, and the MOA channel carries the Assembly, PZC and
committees.

How much a scout decides is up to it. At minimum it reports the recording and
what the site says about it. It may also decide whether the recording is a
meeting and name its bodies.

| id             | Watches                                 | Bodies                   | Schedule                  |
| -------------- | --------------------------------------- | ------------------------ | ------------------------- |
| `gbos-youtube` | GBOS channel `UCOUlNInprZEjhbpVPiJOlEA` | `gbos`, `luc`            | daily, weekdays           |
| `moa-youtube`  | MOA channel `UCZDEuWj4IxdlwBhqrk62_XA`  | `assembly`, `pzc`, `ced` | every six hours, weekdays |
| `akleg`        | akleg.gov committees                    | `hres`                   | daily                     |

`SCOUTS` in `packages/scouts/src/scouts/index.ts` lists them, with their
cron schedules.

The akleg.gov scout knows each recording's body from its committee code, and
that every one is a meeting. It reports a meeting a day after its scheduled
start, so one still being recorded isn't reported with part of its audio. Its
`FetchAudio` downloads the recording's MP3.
akleg.gov doesn't say when it published a
recording, so its `published_at` is null; the meeting's date and time are in
its title. The YouTube scouts apply title rules, eg "test"
in the title means not a meeting, and leave the rest null.

### Contract

`@open-minutes/core/scout` defines what a scout is. Its fields mirror the
`recordings` columns, so the harness copies them straight across:

```ts
/** A recording's key: `recordings.site` and `recordings.external_id`. */
interface RecordingKey {
  site: Site;
  external_id: string;
}

/**
 * What a scout reports for one recording: its `recordings` columns, minus
 * the ones the harness fills in (`id`, `scout_id`, `found_at`,
 * `audio_stored_at`, `audio_failures`, `audio_error`), plus any bodies it can
 * name, as slugs, which the harness writes to `recording_bodies`.
 */
interface ScoutedRecording extends RecordingKey {
  permalink: string | null;
  title: string;
  description: string;
  published_at: Date | null;
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
  /** Yields recordings as it finds them, so a run cut short keeps what it found. */
  scan(ctx: ScoutContext): AsyncIterable<ScoutedRecording>;
}

interface ScoutContext {
  /** The ones no scout has reported yet. */
  unseen(recordings: readonly RecordingKey[]): Promise<RecordingKey[]>;
  logger: Logger;
  signal: AbortSignal;
  now: Date;
}

/**
 * Where a scout's messages go; `console` is one. `error` is for something
 * that failed while the scan goes on, eg one recording's metadata.
 */
type Logger = Pick<Console, "info" | "warn" | "error">;

/**
 * Downloads a recording's audio to `dest` as the site serves it, the best
 * quality it offers, unconverted. One per site, not per scout, so a recording
 * added by hand can be fetched too.
 */
type FetchAudio = (
  external_id: string,
  dest: string,
  signal: AbortSignal,
) => Promise<void>;
```

Scouts don't touch the database. They may shell out, use the filesystem and
read environment variables.

A scout reports only recordings whose audio is complete: a live or upcoming
stream waits until it has ended.

A scout that throws has failed; the harness keeps what it yielded before the
throw. One that hits a problem with a single recording calls `logger.error`
and moves on.

### Where the code lives

- `@open-minutes/core/scout`: the contract above.
- [`packages/youtube`](../../packages/youtube/README.md) and
  [`packages/akleg`](../../packages/akleg/README.md): talking to each site,
  including each site's `FetchAudio`.
- [`packages/scouts`](../../packages/scouts/README.md): the scouts, which use
  those packages, and the harness that runs them.

### The harness

`pnpm scout run [--scout <id>] [--dry-run] [--audio-cap <n>]` runs scouts and writes each report
to `recordings` and `recording_bodies` as it is yielded. It rejects a report
naming a body that isn't in its scout's `bodies`. With no `--scout`, it runs
each scout whose cron fell in the past hour.

After the scans, the harness fetches audio for each recording with
`is_meeting` not false, no `audio_stored_at` and fewer than 3
`audio_failures`, newest `published_at` first (unknown last), up to
`--audio-cap` per run (default 10). For each, it calls its site's `FetchAudio` into a temporary file,
encodes it for speech with
[`encode-speech-audio.sh`](../../.github/scripts/encode-speech-audio.sh)
(16 kHz mono Opus at 24 kbps, in WebM, from whatever format the site serves),
checks that the result's duration is within a few seconds of `duration_secs`
when that is known, uploads it to `recordings/<site>/<external_id>/speech.webm`
in the blob store, and sets `audio_stored_at`. A failure increments
`audio_failures`, sets `audio_error`, and is retried on a later run until the
third. Resetting `audio_failures` to 0 retries it again. Uploads use the AWS
CLI and the bucket `BLOB_STORE_BUCKET` names; a run that can't upload stops
before fetching anything, so it counts no failures. `--audio-cap 0` only
scouts.

A run logs each scout's messages prefixed with its id. Errors become GitHub
Actions annotations in CI, and a run with any error, a failed scout or a
failed fetch exits non-zero, so the workflow shows red.

`pnpm scout available` lists available recordings, and `pnpm scout failed`
those that have given up on their audio, with `audio_error`.

`.github/workflows/scout.yml` runs `pnpm scout run` hourly.

### YouTube

- The scouts list a channel with `yt-dlp --flat-playlist -J`, then run
  `yt-dlp --skip-download -J` for each recording `unseen` returns.
- `published_at` is yt-dlp's `release_timestamp` for a stream or premiere,
  otherwise its `timestamp`.
- They skip a stream that is live or upcoming (yt-dlp's `live_status`).
- Its `FetchAudio` downloads YouTube's Opus stream (format 251), else its
  best audio, with yt-dlp.
- A video with "test" in its title is not a meeting.
- In CI, yt-dlp goes through the WARP or Tor egress in
  [`packages/ytdlp/egress`](../../packages/ytdlp/README.md); see
  [youtube-in-ci.md](../research/youtube-in-ci.md).

## Turning a recording into a meeting

Turning an available recording into a meeting never deals with the
recording's site: its scout and the harness have already normalized what that needs, the
`recordings` row and the audio in the blob store, to a common format.

1. If the recording's `is_meeting` is null, decide it from the title,
   description and duration, before transcribing. A recording that isn't a
   meeting gets `is_meeting` false and `notes`, and nothing more happens to it.
2. Read the audio from the blob store, then transcribe, diarize, align and
   recognize speakers.
3. Decide the bodies, date and time from the title and the opening of the
   transcript, starting from the scout's `recording_bodies` if it gave any. A
   body that can't be determined is left off; the meeting is stored without it
   and flagged for a person or agent to fill in.
4. In one transaction, store the meeting, its `meeting_bodies` and segments,
   and set the recording's `is_meeting` to true.

Starting this automatically after scouting, and the chapters and summaries
that follow it, are outside the scouts' job.

## Tests

- Each scout runs end to end against its live site, YouTube or akleg.gov, with
  as little mocking as possible, and must report real recordings correctly.
- Each site's `FetchAudio` runs against the live site on one short recording,
  and its output encodes with `encode-speech-audio.sh`.
- The harness runs with fake scouts. Its tests cover which scouts run for a
  given hour's crons, and the database and blob store before and after a run:
  rows written, `unseen` skipping recordings already reported, unknown bodies
  rejected, reports kept from a scout that throws, audio uploaded, the per-run
  cap, a failed fetch retried until its third failure, a duration mismatch
  counted as a failure, and the exit code.
- Deciding `is_meeting` and bodies for recordings a scout left open.
