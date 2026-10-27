import { beforeAll, describe, expect, it } from "vite-plus/test";
import { halfUntranscribedRollCall } from "@open-minutes/fixtures/clips";
import { clip, gaps, type Span, totalSecs } from "@open-minutes/core/span";
import { detectSpeech } from "./vad";
import { readWave } from "./waveform";

// Silero VAD on a checked-in minute of a real meeting: what it hears, not
// just that it runs.

describe("detectSpeech on the GBOS roll call", () => {
  let runs: Span[];

  // Downloading the VAD model on a cold cache takes longer than a test's
  // default timeout.
  beforeAll(() => {
    runs = detectSpeech(readWave(halfUntranscribedRollCall().wavPath));
  }, 10 * 60_000);

  it("finds speech runs in order, inside the clip", () => {
    expect(runs.length).toBeGreaterThan(10);
    for (const [i, r] of runs.entries()) {
      expect(r.end).toBeGreaterThan(r.start);
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(60);
      if (i > 0) expect(r.start).toBeGreaterThan(runs[i - 1]!.end);
    }
    // A council meeting is mostly talk.
    expect(totalSecs(runs) / 60).toBeGreaterThan(0.6);
  });

  it("hears the roll call the transcript is missing", () => {
    expect(totalSecs(clip(runs, 12, 21))).toBeGreaterThan(4);
  });

  it("shows the pause between a name and its answer", () => {
    // "Brianna Sullivan?" at 0:17.3–0:18.4, "Present." from 0:19.3.
    expect(gaps(runs, 17, 20, 0.3)).toContainEqual(
      expect.objectContaining({
        start: expect.closeTo(18.6, 0) as number,
        end: expect.closeTo(19.5, 0) as number,
      }),
    );
  });

  it("hears the quiet while the chair reads silently", () => {
    // Nobody talks from 0:53.4 to 0:55.4.
    expect(clip(runs, 53.6, 55.2)).toEqual([]);
  });
});
