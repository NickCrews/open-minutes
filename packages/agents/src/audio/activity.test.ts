import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "@open-minutes/core/transcription";
import {
  mergeSpans,
  pauses,
  subtract,
  untranscribedSpeech,
  wordCoverage,
} from "./activity";
import type { LabeledSegment } from "./meeting";

function segment(label: string, words: [number, string][]): LabeledSegment {
  const ws: TranscriptWord[] = words.map(([start, text]) => ({ start, text }));
  return {
    id: 0,
    label,
    start: ws[0]!.start,
    end: ws.at(-1)!.start + 0.5,
    words: ws,
  };
}

/** One word every 0.3 s from `start` to `end`. */
function talk(start: number, end: number): [number, string][] {
  const words: [number, string][] = [];
  for (let t = start; t < end; t += 0.3) words.push([t, "word"]);
  return words;
}

describe("span arithmetic", () => {
  it("merges spans closer than the gap", () => {
    expect(
      mergeSpans(
        [
          { start: 5, end: 6 },
          { start: 0, end: 1 },
          { start: 1.2, end: 2 },
        ],
        0.5,
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 6 },
    ]);
  });

  it("subtracts one span list from another", () => {
    expect(
      subtract(
        [
          { start: 0, end: 10 },
          { start: 20, end: 30 },
        ],
        [
          { start: 2, end: 3 },
          { start: 8, end: 22 },
          { start: 25, end: 26 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 8 },
      { start: 22, end: 25 },
      { start: 26, end: 30 },
    ]);
  });

  it("finds pauses, including at the range edges", () => {
    const runs = [
      { start: 1, end: 3 },
      { start: 3.2, end: 5 },
      { start: 7, end: 8 },
    ];
    expect(pauses(runs, 0, 10, 0.5)).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 7 },
      { start: 8, end: 10 },
    ]);
  });
});

describe("wordCoverage", () => {
  it("lets a word run until the next one, up to a cap", () => {
    const covered = wordCoverage([
      segment("a", [
        [10, "one"],
        [10.4, "two"],
        [20, "three"],
      ]),
    ]);
    expect(covered).toHaveLength(2);
    expect(covered[0]!.end).toBeCloseTo(11.6);
    expect(covered[1]!.start).toBeCloseTo(19.85);
  });
});

describe("untranscribedSpeech", () => {
  it("reports speech between two segments that has no words", () => {
    const segments = [
      segment("identified:chair", talk(0, 10)),
      segment("identified:clerk", talk(20, 30)),
    ];
    // The clerk's roll call at 12-17 s was never transcribed.
    const runs = [
      { start: 0, end: 10 },
      { start: 12, end: 14 },
      { start: 14.5, end: 17 },
      { start: 20, end: 30 },
    ];
    expect(untranscribedSpeech(runs, segments)).toEqual([
      { start: 12, end: 17, speechSecs: 4.5 },
    ]);
  });

  it("ignores short blips and speech the words cover", () => {
    const segments = [segment("a", talk(0, 10))];
    const runs = [
      { start: 0, end: 10.5 },
      { start: 12, end: 13 },
    ];
    expect(untranscribedSpeech(runs, segments)).toEqual([]);
  });
});
