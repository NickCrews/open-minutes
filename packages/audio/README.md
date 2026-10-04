# @open-minutes/audio

Speech processing for meeting audio, run locally with
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Given a 16 kHz mono WAV,
it transcribes it (NeMo Parakeet ASR, with Silero VAD cutting it into speech
runs), diarizes it into anonymous speaker turns (pyannote segmentation), and
computes a voiceprint per speaker (3D-Speaker CAM++). It returns
`@open-minutes/core` types and knows nothing about the database or where the
audio came from; `@open-minutes/ingest` does that.

This is the only package that depends on `sherpa-onnx-node`. Other packages
read and write WAV files through `@open-minutes/audio/wav`.

The ONNX models (~650MB) are downloaded into `src/models/` (gitignored) the
first time each is used, or all at once with `pnpm om models`.
