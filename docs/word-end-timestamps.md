# Estimating word end timestamps from token onsets

Date: 2026-07-19

## Status

Accepted. Partially addresses speaker misattribution at segment boundaries;
see "Consequences" for what remains.

## Context

Transcripts routinely split a sentence across a speaker change, with the last
word or two of an utterance credited to whoever spoke next:

```
Jennifer Wingard: ...thank you. if that is all, then let's move on to the 3rd quarterly
Bob Jones:        report. Thanks Jennifer. Let me start off...
```

The error was always in the same direction — a trailing word moving right, never
the reverse.

Parakeet reports one timestamp per token (the token's _onset_, quantized to the
encoder's ~12.5 fps frame grid) and no durations, so `tokensToWords` has to
estimate where a word ends. It ended each word at the **next word's onset**. In
the production database that made 99.6% of words have `end` exactly equal to the
following word's `start`, with the longest "word" lasting 79 seconds.

`alignSpeakers` assigns each word to the diarization turn it overlaps most. A
word whose real span is ~0.2s but whose recorded span reaches across a silence
into the next speaker's turn overlaps _that_ turn more than its own, and flips
sides. Sentence-final words were hit hardest twice over: punctuation tokens
attach to the preceding word, and the model emits `.` where it decides a sentence
ended — after the pause, sometimes seconds late (`"June."` measured 3.8s).

## Decision

A word spans `[first token onset, last **voiced** token onset + MAX_TOKEN_SEC]`,
truncated at the next word's onset so words never overlap.

- The word's _own_ last token ends it, not the next word's onset.
- Punctuation contributes text but no duration — nothing is voiced there.
- `MAX_TOKEN_SEC = 0.32` (4 frames). Measured token spacing inside continuous
  speech is 0.08–0.24s. The value is deliberately below `VAD_MIN_SILENCE_SEC`
  (0.5s), so an estimated word can never span a pause long enough for VAD to
  have cut at it.

## Consequences

Word durations are now p50 0.32s / p99 0.88s / max ~1.2s, down from a 79s
maximum. This matters beyond alignment: `segments.duration_secs` and the
per-word timings the web UI shows on hover were both wrong.

The fix addresses roughly **a third** of the boundary errors. In a controlled A/B
over a 60-minute meeting slice — same words, same real diarization turns, only
the word-end rule varying — boundaries that split a sentence fell from 17.1% to
11.7%.

The remaining two-thirds have a different cause: diarization turn boundaries
themselves land mid-word, with pyannote opening the next speaker's turn before
the current one finishes. Correct word durations cannot help there. Snapping
speaker changes to sentence or pause boundaries in `alignSpeakers` would address
it, but trades one error mode for another — genuine interruptions and crosstalk
would be wrongly merged. Deferred as a separate decision.

Existing transcripts keep their bad timings and boundaries until re-ingested; the
fix only affects new transcriptions. The golden fixtures were regenerated.

Regression tests: `align.test.ts` drives the real chain (tokens →
`tokensToWords` → `alignSpeakers`) and reproduces the failure above verbatim;
`transcribe.test.ts` pins the word-end rule directly.
