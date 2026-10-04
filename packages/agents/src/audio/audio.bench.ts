import { bench, describe } from "vitest";
import {
  detectSpeech,
  loadTranscriptionModels,
  transcribeAudio,
  transcribeRange,
} from "@open-minutes/ingest/audio";
import { callTool } from "../tool";
import { findUntranscribedSpeech } from "./tools";
import { clipContext, rollCallClip } from "./testdata/clips";

// How long the audio models take per minute of meeting audio, so swapping a
// model (or its settings) shows what it costs. The clip is exactly one minute,
// so each benchmark's mean time is the time per minute of audio; multiply by
// ~180 for a three-hour meeting. Run with `pnpm bench`.
//
// Models load before timing starts; loading isn't per minute of audio.

const rollCall = rollCallClip();
const opts = {
  // Each run takes a second or more, so a handful is plenty.
  iterations: 5,
  warmupIterations: 1,
  setup: () => loadTranscriptionModels(),
};

describe("per minute of audio", () => {
  bench(
    "speech runs (Silero VAD, 0.2 s pauses)",
    () => {
      detectSpeech(rollCall.wave);
    },
    opts,
  );

  bench(
    "transcribeRange, one pass",
    async () => {
      await transcribeRange(rollCall.wave, 0, 60);
    },
    opts,
  );

  bench(
    "transcribeAudio, the pipeline's VAD + windowed pass",
    async () => {
      await transcribeAudio(rollCall.wave);
    },
    opts,
  );
});

describe("find_untranscribed_speech on the clip", () => {
  // Fresh each run, so the speech runs aren't served from the cache.
  bench(
    "speech runs + decoding the one stretch it finds",
    async () => {
      const clip = rollCallClip();
      await callTool(clipContext(clip), findUntranscribedSpeech, {
        meeting: clip.meeting.ref,
      });
    },
    opts,
  );
});
