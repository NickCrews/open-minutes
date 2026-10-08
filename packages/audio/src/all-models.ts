import { ensureDownloaded, type ModelSpec } from "./model.js";
import { TRANSCRIPTION_MODEL_SPEC, VAD_MODEL_SPEC } from "./transcribe.js";
import { SEGMENTATION_MODEL_SPEC } from "./diarize.js";
import { EMBEDDING_MODEL_SPEC } from "./embed.js";
import { MUSIC_MODEL_SPEC } from "./music.js";

// Every model this package uses. Each stage downloads its own models lazily on
// first use; this list exists so they can all be fetched up front (`om
// models`), eg in CI before the tests, so no test pays for a download.
export const ALL_MODEL_SPECS: readonly ModelSpec[] = [
  TRANSCRIPTION_MODEL_SPEC,
  VAD_MODEL_SPEC,
  SEGMENTATION_MODEL_SPEC,
  EMBEDDING_MODEL_SPEC,
  MUSIC_MODEL_SPEC,
];

/** Downloads whichever models are missing. */
export function ensureAllModels(): void {
  for (const spec of ALL_MODEL_SPECS) {
    ensureDownloaded(spec);
  }
}
