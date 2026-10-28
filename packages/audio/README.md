# @open-minutes/audio

Speech processing for meeting audio, run locally with
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Given a meeting's audio
(16 kHz mono WAV, or WebM/Opus or MP3 as a site serves it, decoded by
[`@open-minutes/codecs`](../codecs/README.md)), it transcribes it (NeMo
Parakeet ASR, with Silero VAD cutting it into speech runs), diarizes it into
anonymous speaker turns (pyannote segmentation), and computes a voiceprint per
speaker (3D-Speaker CAM++). It returns `@open-minutes/core` types and
doesn't touch the database.

This is the only package that depends on `sherpa-onnx-node`. Its functions
take a path or a `WaveForm` (mono samples and their sample rate), and read
and decode paths with [`@open-minutes/codecs`](../codecs/README.md)'s
`ensureWaveForm`.

The ONNX models (~650MB) are downloaded into `src/models/` (gitignored) the
first time each is used, or all at once with `pnpm models`.

`@open-minutes/audio/vad` finds where someone is talking (Silero VAD,
with pauses down to 0.2 s), as a list of `Span`s from
`@open-minutes/core/span`, which also clips, merges, subtracts and totals
them and finds the gaps between them (the pauses). It caches nothing:
callers that reuse speech runs keep them themselves.

A checked-in minute of real meeting audio from
`@open-minutes/datasets/clips` tests what VAD and `transcribeRange` hear
(`vad.test.ts`, `transcribe.test.ts`), and
`src/audio.bench.ts` times the models on it. Because the clip is one minute
long, `pnpm bench` reports each model's time per minute of audio, so a model
swap shows what it costs.
