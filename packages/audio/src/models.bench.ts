import { fileURLToPath } from "node:url";
import { bench, describe } from "vitest";
import { detectSpeech } from "./speech-runs";
import {
  loadTranscriptionModels,
  transcribeAudio,
  transcribeRange,
} from "./transcribe";
import { readWave } from "./wav";

// How long the audio models take per minute of meeting audio, so swapping a
// model (or its settings) shows what it costs. The clip is exactly one minute
// (0:01:45–0:02:45 of the March 23, 2026 GBOS meeting, a roll call), so each
// benchmark's mean time is the time per minute of audio; multiply by ~180 for
// a three-hour meeting. Run with `pnpm bench`.
//
// Models load before timing starts; loading isn't per minute of audio.

const wave = readWave(
  fileURLToPath(new URL("./testdata/gbos-roll-call.wav", import.meta.url)),
);
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
      detectSpeech(wave);
    },
    opts,
  );

  bench(
    "transcribeRange, one pass",
    async () => {
      await transcribeRange(wave, 0, 60);
    },
    opts,
  );

  bench(
    "transcribeAudio, the pipeline's VAD + windowed pass",
    async () => {
      await transcribeAudio(wave);
    },
    opts,
  );
});
