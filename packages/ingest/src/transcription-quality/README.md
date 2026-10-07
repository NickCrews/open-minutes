# Transcription quality

How well `transcribeAudio` (in `@open-minutes/audio`) does, and why it's built
the way it is. The tests here form a hierarchy:

1. **[north-star.test.ts](north-star.test.ts): what we optimize.** Word
   error rate against the hand-corrected golden meetings, and runtime as a
   fraction of the audio's length. These two numbers decide every change to
   transcription. A change that lowers WER without slowing us down much is
   good, however it gets there.

2. **[parakeet.characterization.test.ts](parakeet.characterization.test.ts):
   what the model does.** Facts about the recognizer that the implementation
   leans on: that a repeated decode gives the same words, that moving a window
   10 ms rewrites ~5% of them, how much lead-in and lead-out a window needs,
   that a long pass can drop seconds of speech, where a single pass tops out.
   They're here so nobody has to measure them again, and so a model upgrade
   that changes one is noticed. They are not requirements: if a change
   improves the north star and breaks one of these, update or delete the
   characterization.

3. **Unit tests next to the code** (`packages/audio/src/transcribe.test.ts`
   and friends): that the implementation does what it says, eg that
   `findDroppedSpeech` finds a run with no words. They support the design of
   the day and change with it.

Everything here is tagged `slow`: it needs the meetings' audio and the
models. Run it with `pnpm test:slow transcription-quality`, or just the north
star with `pnpm test:slow north-star`, and compare the logged `WER=` and `RTF=`
lines before and after a change.

The goldens are the reference, so a word the goldens are missing counts
against a transcriber that hears it. When the north star shows a stretch the
transcriber hears and the golden doesn't have, fix the golden (see the
`transcript-cleanup` skill) before reading the WER.
