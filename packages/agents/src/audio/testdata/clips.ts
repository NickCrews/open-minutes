import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWave, type WaveForm } from "@open-minutes/ingest/audio";
import { parsePsv } from "@open-minutes/fixtures/psv";
import { toolContext } from "../../context";
import type { ToolContext } from "../../tool";
import { type AudioMeeting, labelGoldenSegments } from "../meeting";

// Short stretches of real meeting audio, checked in so the audio tools can be
// tested (and timed) without downloading a meeting. Each is a 16 kHz mono
// 16-bit WAV with the golden's transcript of it beside it as PSV, its times
// shifted so the clip starts at 0.

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Clip {
  /** Where it was cut from, for messages. */
  source: string;
  /** Seconds into the source meeting the clip starts at. */
  offsetSecs: number;
  wave: WaveForm;
  meeting: AudioMeeting;
}

/**
 * 0:01:45–0:02:45 of the March 23, 2026 GBOS meeting (gbos_9HoIM5INxpI):
 * the end of the land acknowledgement, the chair asking staff for the roll
 * call, the roll call, and the chair's announcements. Its transcript (as the
 * golden had it) is missing the first half of the roll call: "Are we all
 * connected? Brian Burnett? Present. Brianna Sullivan? Present. Thanks.",
 * at 0:00:12–0:00:21 of the clip, which the full-meeting pass dropped.
 */
export function rollCallClip(): Clip {
  return loadClip("gbos-roll-call", "gbos_9HoIM5INxpI", 105);
}

function loadClip(name: string, source: string, offsetSecs: number): Clip {
  const wave = readWave(join(HERE, `${name}.wav`));
  const segments = labelGoldenSegments(
    parsePsv({ path: join(HERE, `${name}.psv`) }),
  );
  return {
    source,
    offsetSecs,
    wave,
    meeting: {
      ref: name,
      youtubeId: source,
      audioPath: join(HERE, `${name}.wav`),
      // Fresh each time, so speech runs cached by one test don't leak into
      // another (or into a benchmark).
      cacheDir: mkdtempSync(join(tmpdir(), `audio-clip-${name}-`)),
      segments,
      wave: () => wave,
    },
  };
}

/** A context whose only meeting is `clip`, under its name, and no database. */
export function clipContext(clip: Clip): ToolContext {
  return {
    ...toolContext(() => Promise.reject(new Error("No database for clips"))),
    meeting: async (ref) => {
      if (ref !== clip.meeting.ref) throw new Error(`No clip "${ref}"`);
      return clip.meeting;
    },
  };
}
