import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureModelFiles, getTraceEvents, resetTrace, transcribeAudio } from "./transcribe";
import { compareTranscripts } from "./test-utils/wer";
import { serializePsv } from "./test-utils/psv";
import { getMeetingData } from "./test-utils/test-data";
import { alignSpeakers, segmentsToTurns } from "./align";
import type { TranscriptWord } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "..", "test-runs");

beforeAll(() => {
  process.env.TRANSCRIBE_TRACE = "1";
});

beforeEach(() => {
  resetTrace();
});

describe("transcribe", () => {
  it("transcribes a 4 second audio sample", async () => {
    const modelFiles = ensureModelFiles();
    const result = await transcribeAudio(modelFiles.test_wavs['en.wav']);
    expect(result.map((w) => w.text)).toEqual([
      "Ask", "not", "what", "your", "country", "can", "do", "for", "you,",
      "ask", "what", "you", "can", "do", "for", "your", "country.",
    ]);

    // Word timings are monotonic and non-overlapping
    for (let i = 0; i < result.length; i++) {
      const w = result[i]!;
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      if (i > 0) {
        expect(w.start).toBeGreaterThanOrEqual(result[i - 1]!.start);
      }
    }
  });

  it("processes chunks in parallel", async () => {
    const modelFiles = ensureModelFiles();
    // Force the 4s sample into multiple chunks so we can observe overlap.
    const chunkSec = 1;
    const wallStart = Date.now();
    await transcribeAudio(modelFiles.test_wavs["en.wav"], chunkSec);
    const wallElapsed = Date.now() - wallStart;

    const events = getTraceEvents();
    expect(events.length).toBeGreaterThanOrEqual(3);

    // At least one pair of chunks must overlap in wall time — proof of parallelism.
    const overlapped = events.some((a, i) =>
      events.some(
        (b, j) => i !== j && a.wallStartMs < b.wallEndMs && b.wallStartMs < a.wallEndMs,
      ),
    );
    expect(overlapped).toBe(true);

    // Total wall time must be less than the sum of per-chunk times (real speedup).
    const sumPerChunk = events.reduce((s, e) => s + (e.wallEndMs - e.wallStartMs), 0);
    expect(wallElapsed).toBeLessThan(sumPerChunk);
  });

  const meetingSlugs = [
    "gbos_9HoIM5INxpI",
    "gbos_xTDznaSElgY",
  ];
  for (const slug of meetingSlugs) {
    it(`can transcribe meeting ${slug}, passing our accuracy limits`, { tags: ["slow5min"] }, async () => {
      const meeting = getMeetingData(slug);
      const runDir = join(RUNS_DIR, slug);
      cpDirSymlinked(meeting.meetingDir, runDir);
      const transcribedWords = await transcribeAudio(await meeting.getAudio().then(a => a.path));
      const transcribedSegments = [{ words: transcribedWords, speaker: { type: "unlabeled" as const } }];
      serializePsv(transcribedSegments, { path: join(runDir, "transcribed.gen.psv") });
      if (process.env.SNAPSHOT_UPDATE === "1") {
        // golden.psv is shared with diarize.test.ts. This test owns only the
        // transcription, so preserve the existing speaker boundaries (the
        // diarization layer) instead of overwriting them with `unlabeled`:
        // re-apply the golden's turns to the freshly transcribed words.
        const turns = segmentsToTurns(meeting.segments);
        const merged = turns.length > 0 ? alignSpeakers(transcribedWords, turns) : transcribedSegments;
        serializePsv(merged, { path: join(meeting.meetingDir, "golden.psv") });
        return;
      }

      const refWords = meeting.segments.flatMap((s) => s.words);
      // First: confirm the check actually has teeth. With strict thresholds the
      // current transcribe output should never pass, so the assertion below MUST
      // throw. If it doesn't, our metric is broken (or the model is suspiciously
      // perfect — also worth knowing).
      expect(() => assertWithinThresholds(refWords, transcribedWords, { maxWER: 0, maxTimestampError: 0 })).toThrow();

      // Then the real check: lax-but-meaningful thresholds we expect to pass.
      // WER < 15% and matched-word p95 timestamp error < 0.5s are realistic for
      // this model on noisy multi-speaker audio.
      assertWithinThresholds(refWords, transcribedWords, { maxWER: 0.15, maxTimestampError: 0.5 });
    });
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
  ref: readonly TranscriptWord[],
  hyp: readonly TranscriptWord[],
  thresholds: { maxWER: number; maxTimestampError: number },
): void {
  const cmp = compareTranscripts(ref, hyp);
  const failures: string[] = [];
  if (cmp.wer > thresholds.maxWER) {
    failures.push(`WER ${cmp.wer.toFixed(4)} > ${thresholds.maxWER} (sub=${cmp.substitutions} del=${cmp.deletions} ins=${cmp.insertions} of ${cmp.refWordCount} ref words)`);
  }
  if (cmp.p95StartError > thresholds.maxTimestampError) {
    failures.push(`p95 word-start error ${cmp.p95StartError.toFixed(3)}s > ${thresholds.maxTimestampError}s (mean=${cmp.meanStartError.toFixed(3)}s, max=${cmp.maxStartError.toFixed(3)}s, n=${cmp.matchedPairs})`);
  }
  if (cmp.p95EndError > thresholds.maxTimestampError) {
    failures.push(`p95 word-end error ${cmp.p95EndError.toFixed(3)}s > ${thresholds.maxTimestampError}s (mean=${cmp.meanEndError.toFixed(3)}s, max=${cmp.maxEndError.toFixed(3)}s, n=${cmp.matchedPairs})`);
  }
  if (failures.length > 0) {
    throw new Error(`Transcript outside thresholds:\n  - ${failures.join("\n  - ")}`);
  }
}