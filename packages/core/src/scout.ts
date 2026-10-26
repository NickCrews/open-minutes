/**
 * What a scout is: code that watches one place on a site and reports each new
 * recording there. See docs/contributing/recordings.md.
 */
import type { RecordingKey } from "./site";

export type { RecordingKey, Site } from "./site";

/**
 * What a scout reports for one recording: its `recordings` columns, minus
 * the ones the harness fills in (`id`, `scout_id`, `found_at`,
 * `audio_stored_at`, `audio_failures`, `audio_error`), plus any bodies it can
 * name, as slugs, which the harness writes to `recording_bodies`.
 */
export interface ScoutedRecording extends RecordingKey {
  permalink: string | null;
  title: string;
  description: string;
  published_at: Date | null;
  duration_secs: number | null;
  /** Null leaves it to ingestion. */
  is_meeting: boolean | null;
  notes: string;
  /** May be empty. */
  bodies: string[];
}

export interface Scout {
  id: string;
  name: string;
  /** Slugs of the bodies it may report. */
  bodies: readonly string[];
  /** A cron expression, in UTC. */
  schedule: string;
  /**
   * Yields recordings as it finds them, so a run cut short keeps what it
   * found. Only recordings whose audio is complete: a live or upcoming
   * stream waits until it has ended.
   */
  scan(ctx: ScoutContext): AsyncIterable<ScoutedRecording>;
}

export interface ScoutContext {
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
export type Logger = Pick<Console, "info" | "warn" | "error">;

/**
 * Downloads a recording's audio to `dest` as the site serves it, the best
 * quality it offers, unconverted. One per site, not per scout, so a recording
 * added by hand can be fetched too.
 */
export type FetchAudio = (
  external_id: string,
  dest: string,
  signal: AbortSignal,
) => Promise<void>;
