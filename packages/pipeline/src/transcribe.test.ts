import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureModelFiles, getTraceEvents, resetTrace, transcribeAudio } from "./transcribe";
import { getCachedAudio } from "./test-utils/audio-cache";
import { execSync } from "child_process";

beforeAll(() => {
  process.env.TRANSCRIBE_TRACE = "1";
});

beforeEach(() => {
  resetTrace();
});

describe("transcribe", () => {
  it("transcribes a 4 second audio sample", async () => {
    const modelFiles = ensureModelFiles();
    const result = await transcribeAudio(modelFiles.testWav);
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
    await transcribeAudio(modelFiles.testWav, chunkSec);
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
});


function extractClip(inputPath: string, outputPath: string, startSec: number, durationSec: number): void {
  execSync(
    `ffmpeg -y -loglevel error -i "${inputPath}" -ss ${startSec} -t ${durationSec} -ar 16000 -ac 1 "${outputPath}"`,
    { stdio: "inherit" },
  );
}