import { expect, test } from "vitest";
import { TRANSCRIPT_VERSION, transcriptInputs } from "./transcript";

// A transcript run records TRANSCRIPT_VERSION, and meetings transcribed at an
// older one show as stale. That only works if the version is bumped whenever
// the output would change. This pins it to the inputs we can see: if you
// changed a model or a cleaning rule, bump TRANSCRIPT_VERSION in transcript.ts
// as well as updating this snapshot (`pnpm vitest -u`). Logic changes the
// snapshot can't see (a threshold, alignment) need a bump too.
test("TRANSCRIPT_VERSION moves with the models and cleaning rules", () => {
  expect({ version: TRANSCRIPT_VERSION, ...transcriptInputs() })
    .toMatchInlineSnapshot(`
      {
        "cleaningRules": [
          "dash",
          "filler",
          "false-start",
          "stutter",
        ],
        "models": [
          "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
          "silero_vad",
          "sherpa-onnx-pyannote-segmentation-3-0",
          "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced",
        ],
        "version": "1",
      }
    `);
});
