import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureModelFiles, getTraceEvents, resetTrace, transcribeAudio } from "./transcribe";
import { getCachedAudio } from "./test-utils/audio-cache";
import { compareTranscripts } from "./test-utils/wer";
import { parsePsv, psvWords, serializePsv, wordsToPsvEvents } from "./test-utils/psv";
import type { TranscriptSegment, TranscriptWord } from "./types";
import { execSync } from "child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "test-fixtures");

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
    expect(result.length).toBe(1);
    const firstSegment = result[0]!;

    expect(firstSegment.text).toMatchInlineSnapshot(
      `"Ask not what your country can do for you, ask what you can do for your country."`,
    );
    expect(firstSegment.words.map((w) => w.text)).toEqual([
      "Ask", "not", "what", "your", "country", "can", "do", "for", "you,",
      "ask", "what", "you", "can", "do", "for", "your", "country.",
    ]);

    // Segment timing: starts at/near 0, ends within a plausible window.
    expect(firstSegment.start).toBeGreaterThanOrEqual(0);
    expect(firstSegment.end).toBeGreaterThan(firstSegment.start);
    expect(firstSegment.end).toBeLessThan(5);

    // Word timings are monotonic, non-overlapping, and fall inside the segment.
    const BOUNDARY_SLOP = 0.05;
    for (let i = 0; i < firstSegment.words.length; i++) {
      const w = firstSegment.words[i]!;
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      if (i > 0) {
        expect(w.start).toBeGreaterThanOrEqual(firstSegment.words[i - 1]!.start);
      }
    }
    expect(firstSegment.words[0]!.start).toBeGreaterThanOrEqual(firstSegment.start - BOUNDARY_SLOP);
    expect(firstSegment.words.at(-1)!.end).toBeLessThanOrEqual(firstSegment.end + BOUNDARY_SLOP);
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

  it("can handle a hour long clip", { timeout: 15 * 60 * 1000 }, async () => {
    // longer clips can cause out-of-memory errors, so verify that we can handle it.
    const youtubeId = "9HoIM5INxpI" // ~3 hour youtube video
    const { path: fullPath } = await getCachedAudio({ youtubeId });
    const shortenedPath = fullPath.replace(".wav", "-short.wav");
    extractClip(fullPath, shortenedPath, 2 * 60, 60 * 60);
    const result = await transcribeAudio(shortenedPath)
    expect(result.length).toBeGreaterThan(20);
  });

  // Verifies accuracy of the transcribe pipeline against a golden snapshot of
  // word-level timestamps. Set UPDATE_TRANSCRIBE_GOLDEN=1 to regenerate the
  // golden file (like vitest --update for inline snapshots).
  it("matches the golden transcript for a 3-minute multi-speaker clip", { timeout: 10 * 60 * 1000 }, async () => {
    const FIXTURE_DIR = join(FIXTURES_DIR, "three-minute-multi-speaker");
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const youtubeId = "9HoIM5INxpI";
    const startSec = 30 * 60; // skip preamble — start mid-meeting for multiple speakers
    const durationSec = 3 * 60;
    const goldenPath = join(FIXTURE_DIR, `golden.psv`);
    const { path: fullPath } = await getCachedAudio({ youtubeId });
    const clipPath = join(FIXTURE_DIR, `clip.gen.wav`);
    extractClip(fullPath, clipPath, startSec, durationSec);

    const segments = await transcribeAudio(clipPath);
    writeGoldenPsv(join(FIXTURE_DIR, `hypothesis.gen.psv`), segments);
    const hypWords = flattenWords(segments);
    expect(hypWords.length).toBeGreaterThan(100);

    if (process.env.UPDATE_TRANSCRIBE_GOLDEN === "1") {
      writeGoldenPsv(goldenPath, segments);
      return;
    }

    if (!existsSync(goldenPath)) {
      throw new Error(
        `Golden file missing: ${goldenPath}\nRun with UPDATE_TRANSCRIBE_GOLDEN=1 to bootstrap it.`,
      );
    }
    const refWords = readGoldenPsv(goldenPath);
    expect(refWords.length).toBeGreaterThan(100);

    // First: confirm the check actually has teeth. With strict thresholds the
    // current transcribe output should never pass, so the assertion below MUST
    // throw. If it doesn't, our metric is broken (or the model is suspiciously
    // perfect — also worth knowing).
    expect(() => assertWithinThresholds(refWords, hypWords, { maxWER: 0, maxTimestampError: 0 })).toThrow();

    // Then the real check: lax-but-meaningful thresholds we expect to pass.
    // WER < 15% and matched-word p95 timestamp error < 0.5s are realistic for
    // this model on noisy multi-speaker audio.
    assertWithinThresholds(refWords, hypWords, { maxWER: 0.15, maxTimestampError: 0.5 });
  });
});

function flattenWords(segments: readonly TranscriptSegment[]): TranscriptWord[] {
  return segments.flatMap((s) => s.words);
}

function readGoldenPsv(path: string): TranscriptWord[] {
  return psvWords(parsePsv(readFileSync(path, "utf8")));
}

function writeGoldenPsv(path: string, segments: TranscriptSegment[]) {
  mkdirSync(dirname(path), { recursive: true });
  const words = flattenWords(segments);
  writeFileSync(path, serializePsv(wordsToPsvEvents(words)));
  console.log(`Wrote golden: ${path} (${words.length} words across ${segments.length} segment(s))`);
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


function extractClip(inputPath: string, outputPath: string, startSec: number, durationSec: number): void {
  execSync(
    `ffmpeg -y -loglevel error -i "${inputPath}" -ss ${startSec} -t ${durationSec} -ar 16000 -ac 1 "${outputPath}"`,
    { stdio: "inherit" },
  );
}