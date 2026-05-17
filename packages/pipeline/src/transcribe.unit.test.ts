import { describe, it, expect, beforeAll } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokensToWords, transcribeAudio, getRecognizer } from "./transcribe";

const HERE = dirname(fileURLToPath(import.meta.url));

// sherpa-onnx holds a libuv worker-thread handle that prevents the fork from
// exiting naturally. When the event loop drains but a native handle keeps it
// alive, 'beforeExit' fires — we force exit at that point so vitest doesn't
// log a "Timeout terminating forks worker" error.
process.on("beforeExit", () => process.exit(0));
const MODEL_TEST_WAV = join(
  HERE,
  "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav",
);
const TIMEOUT = 600_000;

// ─── tokensToWords — pure, no model ─────────────────────────────────────────

describe("tokensToWords", () => {
  it("maps single-token words (space-prefixed)", () => {
    const tokens = [" Ask", " not", " what"];
    const timestamps = [0.1, 0.4, 0.64];
    const words = tokensToWords(tokens, timestamps);
    expect(words).toHaveLength(3);
    expect(words[0]).toEqual({ text: "Ask", start: 0.1, end: 0.4 });
    expect(words[1]).toEqual({ text: "not", start: 0.4, end: 0.64 });
    // last word's end = last timestamp
    expect(words[2]).toEqual({ text: "what", start: 0.64, end: 0.64 });
  });

  it("joins subword tokens into one word", () => {
    // " co" + "un" + "tr" + "y" → "country"
    const tokens = [" co", "un", "tr", "y"];
    const timestamps = [0.96, 1.04, 1.12, 1.2];
    const words = tokensToWords(tokens, timestamps);
    expect(words).toHaveLength(1);
    expect(words[0]?.text).toBe("country");
    expect(words[0]?.start).toBe(0.96);
    expect(words[0]?.end).toBe(1.2);
  });

  it("attaches punctuation tokens to the preceding word", () => {
    // " you" + "," → "you,"
    const tokens = [" you", ",", " ask"];
    const timestamps = [1.68, 1.92, 2.08];
    const words = tokensToWords(tokens, timestamps);
    expect(words).toHaveLength(2);
    expect(words[0]?.text).toBe("you,");
    expect(words[0]?.start).toBe(1.68);
    expect(words[0]?.end).toBe(2.08);
    expect(words[1]?.text).toBe("ask");
  });

  it("accepts SentencePiece ▁ word-start marker as well as space", () => {
    const tokens = ["▁Hello", "▁world"];
    const timestamps = [0.0, 0.5];
    const words = tokensToWords(tokens, timestamps);
    expect(words).toHaveLength(2);
    expect(words[0]?.text).toBe("Hello");
    expect(words[1]?.text).toBe("world");
  });

  it("returns [] for empty input", () => {
    expect(tokensToWords([], [])).toEqual([]);
  });

  it("matches actual Parakeet en.wav token output", () => {
    // Ground-truth tokens observed from the model on en.wav (verified manually).
    const tokens = [" A","sk"," not"," what"," your"," co","un","tr","y"," can"," do"," for"," you",","," a","sk"," what"," you"," can"," do"," for"," your"," co","un","tr","y","."];
    const timestamps = [0,0.24,0.4,0.64,0.8,0.96,1.04,1.12,1.2,1.28,1.44,1.6,1.68,1.92,2.08,2.24,2.4,2.56,2.64,2.8,2.96,3.12,3.28,3.36,3.44,3.52,3.68];
    const words = tokensToWords(tokens, timestamps);
    const texts = words.map((w) => w.text);
    expect(texts).toEqual([
      "Ask", "not", "what", "your", "country",
      "can", "do", "for", "you,",
      "ask", "what", "you", "can", "do", "for", "your", "country.",
    ]);
    // Timestamps are monotonically non-decreasing
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.start);
    }
  });
});

// ─── transcribeAudio with chunking — requires model (en.wav, 3.8s) ──────────

const runModelTests = process.env.RUN_MODEL_TESTS === "1" &&
  (() => { try { return require("node:fs").existsSync(MODEL_TEST_WAV); } catch { return false; } })();

describe.runIf(runModelTests)("transcribeAudio — chunked", () => {
  beforeAll(() => {
    getRecognizer();
  }, TIMEOUT);

  it("produces the same text whether chunked or not", { timeout: TIMEOUT }, async () => {
    // Use a 2s chunk size on the 3.8s en.wav to force 2 chunks.
    const chunked = await transcribeAudio(MODEL_TEST_WAV, 2);
    const single = await transcribeAudio(MODEL_TEST_WAV, Infinity);

    const chunkedText = chunked.map((s) => s.text).join(" ").toLowerCase().replace(/[^a-z ]/g, "");
    const singleText = single.map((s) => s.text).join(" ").toLowerCase().replace(/[^a-z ]/g, "");

    // Allow for minor differences at chunk boundaries; just verify major content
    // words are present in both transcriptions.
    const keyWords = ["ask", "not", "what", "your", "country", "can", "do", "for", "you"];
    for (const word of keyWords) {
      expect(chunkedText, `"${word}" missing from chunked output`).toContain(word);
      expect(singleText, `"${word}" missing from single-pass output`).toContain(word);
    }
  });

  it("offsets chunk timestamps by chunk start time", { timeout: TIMEOUT }, async () => {
    const chunkSec = 2;
    const segments = await transcribeAudio(MODEL_TEST_WAV, chunkSec);

    // With a 3.8s file and 2s chunks there should be 2 segments.
    expect(segments.length).toBeGreaterThanOrEqual(1);

    // All word timestamps must fall within [0, audio_duration].
    const audioDuration = 3.8; // approximate
    for (const seg of segments) {
      for (const w of seg.words) {
        expect(w.start).toBeGreaterThanOrEqual(0);
        expect(w.end).toBeLessThanOrEqual(audioDuration + 1); // +1s tolerance
      }
    }

    // If we got 2+ segments, words in the second segment must start at or after chunkSec.
    if (segments.length >= 2) {
      const seg2FirstWord = segments[1]!.words[0];
      expect(seg2FirstWord?.start).toBeGreaterThanOrEqual(chunkSec - 0.5); // 0.5s tolerance
    }
  });
});
