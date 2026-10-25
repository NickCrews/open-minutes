# @open-minutes/audio

Speech processing for meeting audio, run locally with
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Given a meeting's audio
(16 kHz mono WAV, or WebM/Opus or MP3 as a site serves it, decoded by
[`@open-minutes/codecs`](../codecs/README.md)), it transcribes it (NeMo
Parakeet ASR, with Silero VAD cutting it into speech runs), diarizes it into
anonymous speaker turns (pyannote segmentation), and computes a voiceprint per
speaker (3D-Speaker CAM++). It returns `@open-minutes/core` types;
`@open-minutes/ingest` gets the audio and writes the results to the database.

This is the only package that depends on `sherpa-onnx-node`. Other packages
read and write WAV files through `@open-minutes/audio/wav`, whose
`ensureWaveAudio` also decodes a WebM/Opus or MP3 file.

The ONNX models (~650MB) are downloaded into `src/models/` (gitignored) the
first time each is used, or all at once with `pnpm om models`.
