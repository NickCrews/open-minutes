# ADR 0005: Scouts find meetings per site, not per body

Date: 2026-10-19
Status: Proposed

## Context

Several bodies publish recordings to one place: the GBOS channel carries GBOS and Girdwood committee meetings, and the MOA channel carries the Assembly, PZC and committees.
Deciding which recordings are meetings, and of which bodies, needs judgment, often an LLM's.

## Decision

A **scout** (see `TERMINOLOGY.md`) watches one place on a site and reports each new recording as a meeting of one or more of its bodies, or as not a meeting.
A harness runs scouts on a schedule and stores their reports.
Ingestion stays a separate step.

### Scouts

| id             | Watches                                 | Bodies                             | Schedule                      | Classifies with |
| -------------- | --------------------------------------- | ---------------------------------- | ----------------------------- | --------------- |
| `gbos-youtube` | GBOS channel `UCOUlNInprZEjhbpVPiJOlEA` | `gbos`, LUC, other Girdwood bodies | daily, weekdays               | LLM             |
| `moa-youtube`  | MOA channel                             | `assembly`, `pzc`, `ced`, …        | several times a day, weekdays | LLM             |
| `akleg`        | akleg.gov committees                    | `hres`, …                          | daily                         | committee code  |

### Contract (`@open-minutes/core/scout`)

```ts
interface RecordingId {
  site: "youtube" | "akleg";
  id: string;
}

interface Scout {
  id: string;
  name: string;
  bodies: readonly string[]; // slugs it may report
  schedule: string; // cron, UTC
  scan(ctx: ScoutContext): Promise<ScoutReport>;
}

interface ScoutContext {
  seen(recording: RecordingId): boolean;
  bodies: ReadonlyArray<{ slug: string; name: string; timezone: string }>;
  log(message: string): void;
  signal: AbortSignal;
  now: Date;
}

interface ScoutReport {
  meetings: FoundMeeting[];
  rejected: Array<{ recording: RecordingId; reason: string }>;
}

interface FoundMeeting {
  recording: RecordingId;
  bodies: string[]; // at least one
  title: string;
  description: string;
  date: string | null;
  time: string | null;
  timezone?: string; // defaults to the first body's
}
```

- Scouts don't touch the database.
  They may shell out, use the filesystem and read env vars.
- Every recording a scout examines is reported as a meeting or as rejected.

### Storage

- `recordings`: `site`, `recording_id` (unique together), `scout_id`, `found_at`, `is_meeting`, `reason`, `title`, `description`, `date`, `time`, `timezone`, `meeting_id` (nullable FK).
- `recording_bodies`: `recording_id`, `body_id`.
- An available meeting is a recording with `is_meeting` and no `meeting_id`.
- `ingestMeeting` reads bodies, title, description and date from the recording, and sets `recordings.meeting_id` in its transaction.
- A migration backfills a recording for each existing meeting, then drops `bodies.meeting_source`.
- `MeetingSource`, `listerFor` and `resolveBody` go away.

### Harness

- `om scout [--scout <id>] [--dry-run]` runs scouts and writes `recordings`.
  It validates bodies against the scout's `bodies`.
- `om available` reads `recordings`.
- `.github/workflows/scout.yml` runs hourly, and runs each scout whose cron fell in the past hour.

### YouTube

- List with `yt-dlp --flat-playlist -J`, then `yt-dlp --skip-download -J` for each recording not yet seen.
- In CI, yt-dlp goes through the WARP/Tor egress in `packages/youtube/egress`.
- Classification uses the Anthropic SDK, called inside the scout behind `classify(recordings, bodies): ScoutReport`.
  The API key comes from an env var.

### Tests

- Each scout, with a faked listing and a faked `classify`.
- The harness rejecting unknown bodies.
- `om scout --dry-run` against a seeded database.
- The migration's backfill.
- An on-demand eval of `classify` on the golden meetings plus saved non-meeting recordings.

### Out of scope

- Renaming `meetings.site_kind`/`site_id`.
- An LLM in `ScoutContext`.
- Ingesting automatically after scouting.
