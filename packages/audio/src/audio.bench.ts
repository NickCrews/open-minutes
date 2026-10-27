import { test } from "vite-plus/test";
import { halfUntranscribedRollCall } from "@open-minutes/fixtures/clips";
import { detectSpeech } from "./vad.js";
import {
  loadTranscriptionModels,
  transcribeAudio,
  transcribeRange,
} from "./transcribe.js";
import { readWav } from "@open-minutes/codecs";

// How long the audio models take per minute of meeting audio, so swapping a
// model (or its settings) shows what it costs. The clip is exactly one minute,
// so each benchmark's mean time is the time per minute of audio; multiply by
// ~180 for a three-hour meeting. Run with `pnpm bench`.
//
// Models load before timing starts; loading isn't per minute of audio.

const rollCall = halfUntranscribedRollCall();
const wave = await readWav(rollCall.wavPath);
const opts = {
  // Each run takes a second or more, so a handful is plenty.
  iterations: 5,
  warmupIterations: 1,
  setup: () => loadTranscriptionModels(),
};

test("per minute of audio", async ({ bench }) => {
  await bench.compare(
    bench("speech runs (Silero VAD, 0.2 s pauses)", () => {
      detectSpeech(wave);
    }),
    bench("transcribeRange, one pass", async () => {
      await transcribeRange(wave, 0, 60);
    }),
    bench("transcribeAudio, the pipeline's VAD + windowed pass", async () => {
      await transcribeAudio(wave);
    }),
    opts,
  );
});
