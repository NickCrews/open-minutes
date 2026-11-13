// Unit tests: transcribeAudio's parts do what they say. Whether its design is
// any good is measured by the WER and runtime of
// transcription-quality/north-star.test.ts, which outranks these; see the
// README.md there.
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  readWav,
  resample,
  SAMPLE_RATE,
  type WaveForm,
} from "@open-minutes/codecs";
import {
  ensureModelFiles,
  loadTranscriptionModels,
  planWindows,
  type PassWord,
  tokensToWords,
  transcribeAudio,
  transcribeRange,
  TRANSCRIBE_VAD_OPTIONS,
  type TranscribeWindowEndEvent,
  vote,
  voteWords,
  WINDOW_SEC,
} from "./transcribe";
import { type Word } from "@open-minutes/core/transcript";
import { MAX_WORD_SEC } from "@open-minutes/core/transcription";
import { halfUntranscribedRollCall } from "@open-minutes/datasets/clips";

// transcribeAudio requires 16 kHz mono, but the model's bundled en.wav is 24 kHz.
async function sample16kHz(): Promise<WaveForm> {
  const wave = await readWav(ensureModelFiles().test_wavs["en.wav"]);
  return resample(wave, SAMPLE_RATE);
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

describe("planWindows", () => {
  const spans = [
    { start: 1, end: 5 },
    { start: 8, end: 12 },
    { start: 14, end: 20 },
    { start: 31, end: 33 },
  ];

  it("groups the spans starting in each cell of the grid", () => {
    const windows = planWindows(spans, {
      windowSec: 10,
      gridOffsetSec: 0,
      leadSec: 0,
    });
    expect(windows).toEqual([
      { start: 1, end: 12, first: 0, last: 1 },
      { start: 14, end: 20, first: 2, last: 2 },
      { start: 31, end: 33, first: 3, last: 3 },
    ]);
  });

  it("cuts at other silences when the grid is offset", () => {
    const windows = planWindows(spans, {
      windowSec: 10,
      gridOffsetSec: 5,
      leadSec: 0,
    });
    expect(windows.map((w) => [w.first, w.last])).toEqual([
      [0, 0],
      [1, 2],
      [3, 3],
    ]);
  });

  it("starts each window early by the lead, but not before the audio", () => {
    const windows = planWindows(spans, {
      windowSec: 10,
      gridOffsetSec: 0,
      leadSec: 2,
    });
    expect(windows.map((w) => w.start)).toEqual([0, 12, 29]);
  });
});

describe("vote", () => {
  const pw = (text: string, start: number, edgeSecs = 10): PassWord => ({
    text,
    start,
    edgeSecs,
  });

  it("takes the word most passes heard", () => {
    const votes = vote([
      [pw("brown", 0), pw("fox", 1)],
      [pw("clown", 0), pw("lox", 1)],
      [pw("brown", 0.02), pw("fox", 1)],
    ]);
    expect(votes.map((v) => [v.word.text, v.agree, v.heard])).toEqual([
      ["brown", 2, 3],
      ["fox", 2, 3],
    ]);
    expect(votes[0]!.word.start).toBeCloseTo(0.01);
  });

  it("keeps words only one pass heard where the others heard nothing", () => {
    const votes = vote([
      [pw("yes", 0), pw("then", 5)],
      [pw("yes", 0), pw("one", 2), pw("ninety", 3), pw("then", 5)],
      [pw("yes", 0), pw("then", 5)],
    ]);
    expect(votes.map((v) => [v.word.text, v.agree, v.heard])).toEqual([
      ["yes", 3, 3],
      ["one", 1, 1],
      ["ninety", 1, 1],
      ["then", 3, 3],
    ]);
  });

  it("breaks a tie with the word heard farthest from a window edge", () => {
    const votes = vote([
      [pw("brown", 0, 0.1)],
      [pw("Brown.", 0, 5)],
      [pw("clown", 0, 2)],
    ]);
    expect(votes[0]!.word.text).toBe("Brown.");
    expect(votes[0]!.agree).toBe(2);
    const tie = vote([[pw("brown", 0, 0.1)], [pw("clown", 0, 5)]]);
    expect(tie[0]!.word.text).toBe("clown");
  });
});

describe("voteWords", () => {
  it("gives words their confidence, higher when more passes agree", () => {
    const words = voteWords([
      [pw2("all", 0), pw2("agree", 1)],
      [pw2("all", 0), pw2("argue", 1)],
      [pw2("all", 0), pw2("agree", 1)],
    ]);
    expect(words.map((w) => w.text)).toEqual(["all", "agree"]);
    expect(words[0]!.confidence).toBeGreaterThan(words[1]!.confidence!);
  });
});

function pw2(text: string, start: number): PassWord {
  return { text, start, edgeSecs: 10 };
}

describe("TRANSCRIBE_VAD_OPTIONS.minSilenceSecs", () => {
  // The whole safety argument for deriving word ends from onsets rests on this
  // one inequality: a derived word is shorter than the shortest silence VAD
  // will cut at, so no word can span a pause and be credited to whoever speaks
  // after it. The two constants live in different packages; this is what
  // stops them drifting apart.
  it("is longer than any derived word, so no word spans a VAD cut", () => {
    expect(MAX_WORD_SEC).toBeLessThan(TRANSCRIBE_VAD_OPTIONS.minSilenceSecs);
  });
});

describe("transcribe", () => {
  // Downloading the ~460MB model (on a cold cache) and loading it (always,
  // several seconds) take longer than a test's default 5s timeout, so neither
  // happens inside a test.
  let sample: WaveForm;
  beforeAll(async () => {
    loadTranscriptionModels();
    sample = await sample16kHz();
  }, 10 * 60_000);

  it("transcribes a 4 second audio sample", async () => {
    const segments = await transcribeAudio(sample);
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

  it("processes speech runs in parallel", async () => {
    // Build audio with several speech runs separated by long silence. The gap must
    // exceed WINDOW_SEC so each run lands in its own decode window (otherwise
    // they'd merge into one window and decode serially); the silence itself is never
    // decoded — each window slices only its own run — so this stays cheap.
    const sr = sample.sampleRate;
    const silence = new Float32Array(Math.round((WINDOW_SEC + 1) * sr));
    const parts = [
      sample.samples,
      silence,
      sample.samples,
      silence,
      sample.samples,
    ];
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

/** Words as lowercase text without punctuation, for loose matching. */
const plain = (words: readonly Word[]) =>
  words.map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ""));

/** Whether `phrase` occurs as consecutive words in `words`. */
function hears(words: readonly Word[], phrase: string): boolean {
  return ` ${plain(words).join(" ")} `.includes(` ${phrase} `);
}

// Decoding a stretch takes about a second on a laptop; leave CI headroom.
const DECODE_TIMEOUT = 60_000;

describe("transcribeRange on the GBOS roll call", () => {
  // Its transcript is missing the first half of the roll call, at 0:12–0:21.
  let wave: WaveForm;
  beforeAll(async () => {
    loadTranscriptionModels();
    wave = await readWav(halfUntranscribedRollCall().wavPath);
  }, 10 * 60_000);

  it(
    "recovers the roll call the full-meeting pass dropped",
    async () => {
      // Exact spellings shift with where the window starts ("Burnett" or
      // "Brunett", "connected" or "connecting"), so match loosely.
      const words = plain(await transcribeRange(wave, 11, 21.5));
      expect(words).toContain("brian");
      expect(words).toContain("sullivan");
      expect(words.filter((w) => w === "present")).toHaveLength(2);
    },
    DECODE_TIMEOUT,
  );

  it(
    "returns only words starting in the range",
    async () => {
      const words = await transcribeRange(wave, 15, 18);
      expect(words.length).toBeGreaterThan(0);
      for (const w of words) {
        expect(w.start).toBeGreaterThanOrEqual(15);
        expect(w.start).toBeLessThan(18);
      }
      // "Thanks." (0:20.5) is decoded as context but left out.
      expect(plain(words)).toContain("brian");
      expect(plain(words)).not.toContain("thanks");
    },
    DECODE_TIMEOUT,
  );

  it(
    "decodes words at the range's edge with the audio around it",
    async () => {
      // The chair: "...future peoples. Thank you very much, Brian. Staff,
      // would you like to do the roll call", cut off at 0:10 mid-request.
      // Given only [5, 10) the model drops the half-heard request (it ends
      // at "Thank you very much."); with the audio around it, it hears it.
      const words = await transcribeRange(wave, 5, 10);
      expect(words.filter((w) => w.start > 8).length).toBeGreaterThan(2);
      expect(words.at(-1)!.start).toBeLessThan(10);
    },
    DECODE_TIMEOUT,
  );

  it(
    "clamps context at the start and end of the audio",
    async () => {
      const words = await transcribeRange(wave, 0, 3);
      expect(hears(words, "wider community")).toBe(true);
      const end = await transcribeRange(wave, 58, 60);
      expect(hears(end, "thank you")).toBe(true);
    },
    DECODE_TIMEOUT,
  );
});
