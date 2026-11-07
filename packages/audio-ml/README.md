# @open-minutes/audio-ml

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

## Audio functions

The audio functions are small building blocks that all take the same input:
`fn(audio: AudioInput, opts?: BaseOptions & {...}): Promise<T[]>`, with the
types in `@open-minutes/audio-ml/input`.

- `audio` is a path or a `WaveForm` of 16 kHz mono samples.
- `opts.span` says where results are needed: one `{ start, end }`, or a list
  of them. Times are seconds or clock strings such as `"1:02:03.40"`; a
  missing or null `start` or `end` is that end of the file. Omitted, the
  whole file.
- `opts.signal` is an `AbortSignal`.

`prepareInput` in `input.ts` is the wrapper every function goes through: it
reads the audio, checks it is 16 kHz, parses the times, sorts the spans,
joins those that overlap or touch, clamps them to the file, and checks the
signal.

Every function follows these rules:

1. **One function, one ONNX model.** A call runs its model over the audio it
   is given, and no other model. The same audio and options give the same
   result. Whatever a function needs from another model, such as voice
   activity spans, is computed upstream and passed in.
2. **`span` is a lower bound.** Results are complete inside the span(s).
   Outside them, a function may skip the work, or may compute and return
   results anyway.
3. **A list of spans is a mask, not a batch.** Spans are sorted, overlaps
   joined, and nearby spans may be processed together, so a result inside
   one span may depend on the rest of the mask.
4. **Results are flat lists of time-stamped items**, with times in seconds
   from the start of the file.
5. **Every function is async.**
6. **Results aren't cached.** Callers cache them, keyed on the options.
   Loaded models stay cached.

`detectVoiceActivity` in `@open-minutes/audio-ml/vad` finds where someone is
talking (Silero VAD, with pauses down to 0.2 s), as a list of `Span`s from
`@open-minutes/core/span`, which also clips, merges, subtracts and totals
them and finds the gaps between them (the pauses). A voice activity span
that crosses the edge of the mask is returned whole.

A checked-in minute of real meeting audio from
`@open-minutes/datasets/clips` tests what VAD and `transcribeRange` hear
(`vad.test.ts`, `transcribe.test.ts`), and
`src/audio.bench.ts` times the models on it. Because the clip is one minute
long, `pnpm bench` reports each model's time per minute of audio, so a model
swap shows what it costs.
