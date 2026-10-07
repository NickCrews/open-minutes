// Unit tests: transcribeAudio's parts do what they say. Whether its design is
// any good is measured by the WER and runtime of
// packages/ingest/src/transcription-quality/north-star.test.ts, which outranks
// these; see the README.md there.
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sherpa_onnx from "sherpa-onnx-node";
import {
  DROPPED_SPEECH_SEC,
  ensureModelFiles,
  findDroppedSpeech,
  loadTranscriptionModels,
  MERGE_WINDOW_SEC,
  tokensToWords,
  transcribeAudio,
  type TranscribeWindowEndEvent,
  VAD_MIN_SILENCE_SEC,
} from "./transcribe";
import { MAX_WORD_SEC } from "@open-minutes/core/transcription";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "..", "test-runs");

// transcribeAudio requires 16 kHz mono, but the model's bundled en.wav is 24 kHz.
// Resample it once (memoized on disk) for the unit tests. Done here rather than
// with ffmpeg so CI's test job needs no system binaries.
function sample16kHz(): string {
  const src = ensureModelFiles().test_wavs["en.wav"];
  const dest = join(RUNS_DIR, "en-16k.wav");
  if (!existsSync(dest)) {
    mkdirSync(RUNS_DIR, { recursive: true });
    const wave = sherpa_onnx.readWave(src);
    sherpa_onnx.writeWave(dest, {
      samples: resample(wave.samples, wave.sampleRate, 16_000),
      sampleRate: 16_000,
    });
  }
  return dest;
}

/**
 * Windowed-sinc resampling of mono samples, low-passed at the lower Nyquist
 * frequency so downsampling doesn't alias. Good enough for a test fixture.
 */
function resample(samples: Float32Array, from: number, to: number) {
  const ratio = from / to;
  const cutoff = Math.min(1, to / from); // as a fraction of the input Nyquist
  const halfWidth = Math.ceil(16 / cutoff);
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const center = i * ratio;
    let sum = 0;
    for (
      let j = Math.ceil(center - halfWidth);
      j <= Math.floor(center + halfWidth);
      j++
    ) {
      if (j < 0 || j >= samples.length) continue;
      const x = j - center;
      const sinc =
        x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / halfWidth); // Hann
      sum += samples[j]! * cutoff * sinc * window;
    }
    out[i] = sum;
  }
  return out;
}

// Parakeet reports one timestamp per token — the token's onset — and no
// durations. A word keeps only its first token's onset; ends are derived from
// the run structure later (see align.ts in @open-minutes/core).
describe("tokensToWords", () => {
  it("joins space-prefixed tokens into words and attaches punctuation", () => {
    const words = tokensToWords(
      [" A", "sk", " not", " what", ","],
      [0.0, 0.24, 0.4, 0.64, 0.8],
    );
    expect(words.map((w) => w.text)).toEqual(["Ask", "not", "what,"]);
  });

  it("takes a word's start from its first token", () => {
    const words = tokensToWords([" A", "sk", " not"], [0.0, 0.24, 0.4]);
    expect(words[0]!.start).toBe(0.0);
    expect(words[1]!.start).toBe(0.4);
  });

  it("does not let a late punctuation token change a word's start", () => {
    // The model emits "." where it decides the sentence ended — well after the
    // speech stopped. It attaches to the word's text but carries no timing.
    const words = tokensToWords([" June", ".", " Next"], [5.0, 8.4, 9.0]);
    expect(words[0]!.text).toBe("June.");
    expect(words[0]!.start).toBe(5.0);
    expect(words[1]!.start).toBe(9.0);
  });

  it("returns no words for no tokens", () => {
    expect(tokensToWords([], [])).toEqual([]);
  });
});

describe("findDroppedSpeech", () => {
  // Runs in samples at 1 Hz, so a run's bounds read as seconds.
  const run = (start: number, end: number) => ({
    startSample: start,
    endSample: end,
  });
  const at = (...onsets: number[]) =>
    onsets.map((start) => ({ text: "w", start }));
  const gap = DROPPED_SPEECH_SEC;

  it("finds nothing in steady speech", () => {
    expect(findDroppedSpeech([run(0, 4)], at(0.1, 1, 2, 3), 1)).toEqual([]);
  });

  it("finds a stretch with no onsets, from the word before to the word after", () => {
    expect(
      findDroppedSpeech([run(0, gap + 3)], at(0.1, 1, 1 + gap, 2 + gap), 1),
    ).toEqual([[1, 1 + gap]]);
  });

  it("finds a run's silent start and end, and a run with no words at all", () => {
    expect(
      findDroppedSpeech(
        [run(0, 10), run(20, 20 + gap)],
        at(gap + 1, gap + 2),
        1,
      ),
    ).toEqual([
      [0, gap + 1],
      [gap + 2, 10],
      [20, 20 + gap],
    ]);
  });

  it("joins stretches that share a word", () => {
    expect(
      findDroppedSpeech([run(0, 3 * gap)], at(0, gap, 2 * gap, 3 * gap), 1),
    ).toEqual([[0, 3 * gap]]);
  });
});

describe("VAD_MIN_SILENCE_SEC", () => {
  // The whole safety argument for deriving word ends from onsets rests on this
  // one inequality: a derived word is shorter than the shortest silence VAD
  // will cut at, so no word can span a pause and be credited to whoever speaks
  // after it. The two constants live in different packages; this is what
  // stops them drifting apart.
  it("is longer than any derived word, so no word spans a VAD cut", () => {
    expect(MAX_WORD_SEC).toBeLessThan(VAD_MIN_SILENCE_SEC);
  });
});

describe("transcribe", () => {
  // Downloading the ~460MB model (on a cold cache) and loading it (always,
  // several seconds) take longer than a test's default 5s timeout, so neither
  // happens inside a test. Resampling the sample wav is memoized here too.
  beforeAll(() => {
    loadTranscriptionModels();
    sample16kHz();
  }, 10 * 60_000);

  it("transcribes a 4 second audio sample", async () => {
    const segments = await transcribeAudio(sample16kHz());
    const words = segments.flatMap((s) => s.words);
    expect(words.map((w) => w.text)).toEqual([
      "Ask",
      "not",
      "what",
      "your",
      "country",
      "can",
      "do",
      "for",
      "you,",
      "ask",
      "what",
      "you",
      "can",
      "do",
      "for",
      "your",
      "country.",
    ]);

    // Each segment's bounds are ordered and contain its words' onsets.
    for (const s of segments) {
      expect(s.end).toBeGreaterThanOrEqual(s.start);
      for (const w of s.words) {
        expect(w.start).toBeGreaterThanOrEqual(s.start);
        expect(w.start).toBeLessThanOrEqual(s.end + 0.5); // small slack for model timing
      }
    }

    // Word onsets are monotonic across the flattened stream.
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.start);
    }
  });

  it("processes speech segments in parallel", async () => {
    // Build audio with several speech runs separated by long silence. The gap must
    // exceed MERGE_WINDOW_SEC so each run lands in its own decode window (otherwise
    // they'd merge into one window and decode serially); the silence itself is never
    // decoded — each window slices only its own run — so this stays cheap.
    const base = sherpa_onnx.readWave(sample16kHz());
    const sr = base.sampleRate;
    const silence = new Float32Array(Math.round((MERGE_WINDOW_SEC + 1) * sr));
    const parts = [base.samples, silence, base.samples, silence, base.samples];
    const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      samples.set(p, off);
      off += p.length;
    }

    const events: TranscribeWindowEndEvent[] = [];
    await transcribeAudio(
      { sampleRate: sr, samples },
      { tracing: { onWindowEnd: (e) => events.push(e) } },
    );

    expect(events.length).toBeGreaterThanOrEqual(3);

    // At least one pair of chunks must overlap in wall time — proof of parallelism.
    const overlapped = events.some((a, i) =>
      events.some(
        (b, j) =>
          i !== j && a.wallStartMs < b.wallEndMs && b.wallStartMs < a.wallEndMs,
      ),
    );
    expect(overlapped).toBe(true);

    // The decode phase's wall span (first decode start → last decode end) must be
    // less than the sum of per-chunk times — real speedup. Measured from the trace
    // events, not total wall time, so the VAD pass (which now scans long silence)
    // doesn't mask the overlap.
    const decodeSpan =
      Math.max(...events.map((e) => e.wallEndMs)) -
      Math.min(...events.map((e) => e.wallStartMs));
    const sumPerChunk = events.reduce(
      (s, e) => s + (e.wallEndMs - e.wallStartMs),
      0,
    );
    expect(decodeSpan).toBeLessThan(sumPerChunk);
  });
});
