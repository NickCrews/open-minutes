import type { ModelSpec } from "./model.js";

// Kept apart from embed.ts, which loads sherpa-onnx's native module on import,
// so code that only needs to name the model (e.g. a dataset's fingerprint)
// doesn't load it.

// 3D-Speaker CAM++ (zh_en-common_advanced) — produces 192-dim voice embeddings.
// Used both by the diarizer internally (for clustering) and by us directly (for
// centroids + diarize.ts's post-clustering merge). We deliberately use the
// "common_advanced" variant rather than en_voxceleb: on GBOS audio it separates
// speakers far more cleanly (different speakers ~0.1-0.25 cosine vs en_voxceleb's
// muddy 0.45-0.5), which is what makes both clustering and recognition reliable.
// NOTE: the release tag "speaker-recongition-models" is misspelled upstream;
// that misspelling is the correct, canonical URL.
export const EMBEDDING_MODEL_SPEC = {
  name: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
  single_file: true,
  files: {
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx": true,
  },
} as const satisfies ModelSpec;
