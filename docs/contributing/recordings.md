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

| id             | Watches                                 | Bodies                             | Schedule                      |
| -------------- | --------------------------------------- | ---------------------------------- | ----------------------------- |
| `gbos-youtube` | GBOS channel `UCOUlNInprZEjhbpVPiJOlEA` | `gbos`, LUC, other Girdwood bodies | daily, weekdays               |
| `moa-youtube`  | MOA channel                             | `assembly`, `pzc`, `ced`, …        | several times a day, weekdays |
| `akleg`        | akleg.gov committees                    | `hres`, …                          | daily                         |

The akleg.gov scout knows each recording's body from its committee code, and
that every one is a meeting. akleg.gov doesn't say when it published a
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
 * `audio_stored_at`), plus any bodies it can name, as slugs, which the
 * harness writes to `recording_bodies`.
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

Scouts don't touch the database. They may shell out, use the filesystem and
read environment variables.

### Where the code lives

- `@open-minutes/core/scout`: the contract above.
- [`packages/youtube`](../../packages/youtube/README.md) and
  [`packages/akleg`](../../packages/akleg/README.md): talking to each site.
- `packages/scouts`: the scouts, which use those packages, and the harness that
  runs them.

### The harness

`pnpm scout run [--scout <id>] [--dry-run]` runs scouts and writes their
reports to `recordings` and `recording_bodies`. It rejects a report naming a
body that isn't in its scout's `bodies`. With no `--scout`, it runs each scout
whose cron fell in the past hour.

After writing a run's reports, the harness fetches audio for each recording
with `is_meeting` not false and no `audio_stored_at`, newest `published_at`
first (unknown last), up to a cap per run. For each, it calls the scout's `fetchAudio` into a temporary file,
encodes it for speech with
[`encode-speech-audio.sh`](../../.github/scripts/encode-speech-audio.sh),
uploads it to `recordings/<site>/<external_id>/speech.webm` in the blob store, and
sets `audio_stored_at`. A failed fetch is logged and retried on the next run.

`pnpm scout available` lists available recordings.

`.github/workflows/scout.yml` runs `pnpm scout run` hourly.

### YouTube

- The scouts list a channel with `yt-dlp --flat-playlist -J`, then run
  `yt-dlp --skip-download -J` for each recording `unseen` returns.
- `published_at` is yt-dlp's `release_timestamp` for a stream or premiere,
  otherwise its `timestamp`.
- `fetchAudio` downloads YouTube's Opus stream (format 251) with yt-dlp.
- In CI, yt-dlp goes through the WARP or Tor egress in
  [`packages/ytdlp/egress`](../../packages/ytdlp/README.md); see
  [youtube-in-ci.md](../research/youtube-in-ci.md).

## Turning a recording into a meeting

Turning an available recording into a meeting never deals with the
recording's site: its scout has already normalized what that needs, the
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
- Each scout's `fetchAudio` runs against its live site on one short recording.
- The harness runs with fake scouts. Its tests cover which scouts run for a
  given hour's crons, and the database and blob store before and after a run:
  rows written, `unseen` skipping recordings already reported, unknown bodies
  rejected, audio uploaded, the per-run cap, and a failed fetch retried on the
  next run.
- Deciding `is_meeting` and bodies for recordings a scout left open.
