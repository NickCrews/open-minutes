import { beforeAll, describe, expect, it } from "vite-plus/test";
import type { TranscriptWord } from "@open-minutes/core/transcription";
import { halfUntranscribedRollCall } from "@open-minutes/fixtures/clips";
import { untranscribedSpeech, wordCoverage } from "./coverage";
import type { Span } from "@open-minutes/core/span";
import { detectSpeech } from "./vad";
import { readWave } from "./waveform";

/** One word every 0.3 s from `start` to `end`. */
function talk(start: number, end: number): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (let t = start; t < end; t += 0.3) words.push({ start: t, text: "word" });
  return words;
}

describe("wordCoverage", () => {
  it("lets a word run until the next one, up to a cap", () => {
    const covered = wordCoverage([
      { start: 10, text: "one" },
      { start: 10.4, text: "two" },
      { start: 20, text: "three" },
    ]);
    expect(covered).toHaveLength(2);
    expect(covered[0]!.end).toBeCloseTo(11.6);
    expect(covered[1]!.start).toBeCloseTo(19.85);
  });
});

describe("untranscribedSpeech", () => {
  it("reports speech between two turns that has no words", () => {
    const words = [...talk(0, 10), ...talk(20, 30)];
    // The clerk's roll call at 12-17 s was never transcribed.
    const runs = [
      { start: 0, end: 10 },
      { start: 12, end: 14 },
      { start: 14.5, end: 17 },
      { start: 20, end: 30 },
    ];
    expect(untranscribedSpeech(runs, words)).toEqual([
      { start: 12, end: 17, speechSecs: 4.5 },
    ]);
  });

  it("ignores short blips and speech the words cover", () => {
    const words = talk(0, 10);
    const runs = [
      { start: 0, end: 10.5 },
      { start: 12, end: 13 },
    ];
    expect(untranscribedSpeech(runs, words)).toEqual([]);
  });
});

describe("untranscribedSpeech on the GBOS roll call", () => {
  const rollCall = halfUntranscribedRollCall();
  let runs: Span[];

  // Downloading the VAD model on a cold cache takes longer than a test's
  // default timeout.
  beforeAll(() => {
    runs = detectSpeech(readWave(rollCall.wavPath));
  }, 10 * 60_000);

  it("finds only the dropped half of the roll call", () => {
    const stretches = untranscribedSpeech(
      runs,
      rollCall.segments.flatMap((s) => s.words),
    );
    expect(stretches).toHaveLength(1);
    const [s] = stretches;
    expect(s!.start).toBeGreaterThan(10);
    expect(s!.start).toBeLessThan(12.5);
    expect(s!.end).toBeGreaterThan(20);
    expect(s!.end).toBeLessThan(21.8);
    expect(s!.speechSecs).toBeGreaterThan(4);
  });
});
