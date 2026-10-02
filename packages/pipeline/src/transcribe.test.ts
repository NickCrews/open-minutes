import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sherpa_onnx from "sherpa-onnx-node";
import {
  ensureModelFiles,
  loadTranscriptionModels,
  MERGE_WINDOW_SEC,
  tokensToWords,
  transcribeAudio,
  type TranscribeWindowEndEvent,
} from "./transcribe";
import { compareTranscripts } from "./test-utils/wer";
import {
  reapplySpeakerLayer,
  serializePsv,
  serializeVadRunsPsv,
} from "@open-minutes/fixtures/psv";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import { getMeetingAudio } from "./test-utils/audio-cache";
import { cleanSpeechSegments } from "@open-minutes/core/transcription";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "..", "test-runs");

// transcribeAudio requires 16 kHz mono, but the model's bundled en.wav is 24 kHz.
// Resample it once (memoized on disk) for the unit tests.
function sample16kHz(): string {
  const src = ensureModelFiles().test_wavs["en.wav"];
  const dest = join(RUNS_DIR, "en-16k.wav");
  if (!existsSync(dest)) {
    mkdirSync(RUNS_DIR, { recursive: true });
    execSync(
      `ffmpeg -y -loglevel error -i "${src}" -ar 16000 -ac 1 "${dest}"`,
      { stdio: "inherit" },
    );
  }
  return dest;
}

// Parakeet reports one timestamp per token — the token's onset — and no
// durations. A word keeps only its first token's onset; ends are derived from
// the run structure later (see align.ts).
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

  const meetingSlugs = ["gbos_9HoIM5INxpI", "gbos_xTDznaSElgY"];
  for (const slug of meetingSlugs) {
    it(
      `can transcribe meeting ${slug}, passing our accuracy limits`,
      { tags: ["slow"] },
      async () => {
        const meeting = getMeetingData(slug);
        const runDir = join(RUNS_DIR, slug);
        cpDirSymlinked(meeting.meetingDir, runDir);
        // Goldens hold cleaned text (see `pnpm fixtures check`), so compare
        // against the same transcribe → clean output ingestion uses.
        const speechSegments = cleanSpeechSegments(
          await transcribeAudio(
            await getMeetingAudio(meeting).then((a) => a.path),
          ),
        );
        const transcribedWords = speechSegments.flatMap((s) => s.words);
        // Debug artifact: interleave VAD run markers so a diff shows where the audio
        // was chunked (each run's span + duration) and fed to the recognizer.
        serializeVadRunsPsv(speechSegments, {
          path: join(runDir, "transcribed.gen.psv"),
        });
        if (process.env.SNAPSHOT_UPDATE === "1") {
          // golden.psv is shared with diarize.test.ts. This test owns only the
          // transcription, so preserve the existing speaker layer (the diarization
          // clusters AND any hand-assigned identified people) instead of
          // overwriting it: redistribute the freshly transcribed words back into
          // the golden's existing speaker segments by time.
          const merged = reapplySpeakerLayer(
            transcribedWords,
            meeting.segments,
          );
          serializePsv(merged, {
            path: join(meeting.meetingDir, "golden.psv"),
          });
          return;
        }

        const refWords = meeting.segments.flatMap((s) => s.words);
        const cmp = compareTranscripts(refWords, transcribedWords);
        console.log(
          `[${slug}] WER=${cmp.wer.toFixed(4)} (sub=${cmp.substitutions} del=${cmp.deletions} ins=${cmp.insertions} of ${cmp.refWordCount}); ` +
            `p95 start=${cmp.p95StartError.toFixed(3)}s; ${speechSegments.length} segments`,
        );
        // First: confirm the check actually has teeth. With strict thresholds the
        // current transcribe output should never pass, so the assertion below MUST
        // throw. If it doesn't, our metric is broken (or the model is suspiciously
        // perfect — also worth knowing).
        expect(() =>
          assertWithinThresholds(cmp, { maxWER: 0, maxTimestampError: 0 }),
        ).toThrow();

        // Then the real check: lax-but-meaningful thresholds we expect to pass.
        // WER < 15% and matched-word p95 timestamp error < 0.5s are realistic for
        // this model on noisy multi-speaker audio.
        assertWithinThresholds(cmp, { maxWER: 0.15, maxTimestampError: 0.5 });
      },
    );
  }
});

function cpDirSymlinked(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    if (!existsSync(destPath)) {
      symlinkSync(srcPath, destPath);
    }
  }
}

function assertWithinThresholds(
  cmp: ReturnType<typeof compareTranscripts>,
  thresholds: { maxWER: number; maxTimestampError: number },
): void {
  const failures: string[] = [];
  if (cmp.wer > thresholds.maxWER) {
    failures.push(
      `WER ${cmp.wer.toFixed(4)} > ${thresholds.maxWER} (sub=${cmp.substitutions} del=${cmp.deletions} ins=${cmp.insertions} of ${cmp.refWordCount} ref words)`,
    );
  }
  if (cmp.p95StartError > thresholds.maxTimestampError) {
    failures.push(
      `p95 word-start error ${cmp.p95StartError.toFixed(3)}s > ${thresholds.maxTimestampError}s (mean=${cmp.meanStartError.toFixed(3)}s, max=${cmp.maxStartError.toFixed(3)}s, n=${cmp.matchedPairs})`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `Transcript outside thresholds:\n  - ${failures.join("\n  - ")}`,
    );
  }
}
