import { join } from "node:path";
import { type GoldenSegment, parsePsv } from "./psv";
import { TEST_DATA_ROOT } from "./test-data";

// Short stretches of real meeting audio, checked in so the audio models and
// the tools built on them can be tested (and timed) without downloading a
// meeting. Each is a 16 kHz mono 16-bit WAV in test-data/clips/ with the
// golden's transcript of it beside it as PSV, its times shifted so the clip
// starts at 0.

const CLIPS_DIR = join(TEST_DATA_ROOT, "clips");

export interface AudioClip {
  /** The clip's file name, without extension. */
  name: string;
  /** The meeting it was cut from, for messages. */
  source: string;
  /** Seconds into the source meeting the clip starts at. */
  offsetSecs: number;
  wavPath: string;
  /** Its transcript, as the golden had it. */
  segments: GoldenSegment[];
}

/**
 * 0:01:45–0:02:45 of the March 23, 2026 GBOS meeting (gbos-2026-03-23):
 * the end of the land acknowledgement, the chair asking staff for the roll
 * call, the roll call, and the chair's announcements. Its transcript (as the
 * golden had it) is missing the first half of the roll call: "Are we all
 * connected? Brian Burnett? Present. Brianna Sullivan? Present. Thanks.",
 * at 0:00:12–0:00:21 of the clip, which the full-meeting pass dropped.
 */
export function halfUntranscribedRollCall(): AudioClip {
  return loadClip("gbos-roll-call-half-untranscribed", "gbos-2026-03-23", 105);
}

function loadClip(name: string, source: string, offsetSecs: number): AudioClip {
  return {
    name,
    source,
    offsetSecs,
    wavPath: join(CLIPS_DIR, `${name}.wav`),
    segments: parsePsv({ path: join(CLIPS_DIR, `${name}.psv`) }),
  };
}
