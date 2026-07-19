import { describe, expect, it } from "vitest";

import { alignSpeakers, segmentsToTurns } from "./align";
import { tokensToWords } from "./transcribe";
import type {
  DiarizationTurn,
  TranscriptSegment,
} from "@open-minutes/core/transcription";

/** The text of each segment, in order — the shape a reader actually sees. */
function texts(segments: TranscriptSegment[]): string[] {
  return segments.map((s) => s.words.map((w) => w.text).join(" "));
}

function speakers(segments: TranscriptSegment[]): number[] {
  return segments.map((s) =>
    s.speaker.type === "segmented" ? s.speaker.speakerNumber : -1,
  );
}

describe("alignSpeakers", () => {
  it("groups consecutive same-speaker words into one segment", () => {
    const words = [
      { text: "a", start: 0.0, end: 0.2 },
      { text: "b", start: 0.3, end: 0.5 },
      { text: "c", start: 2.0, end: 2.2 },
    ];
    const turns: DiarizationTurn[] = [
      { start: 0.0, end: 1.0, speaker: 0 },
      { start: 1.8, end: 3.0, speaker: 1 },
    ];
    expect(texts(alignSpeakers(words, turns))).toEqual(["a b", "c"]);
    expect(speakers(alignSpeakers(words, turns))).toEqual([0, 1]);
  });

  it("returns a single unlabeled segment when there are no turns", () => {
    const words = [{ text: "a", start: 0, end: 0.2 }];
    const segments = alignSpeakers(words, []);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.speaker).toEqual({ type: "unlabeled" });
  });

  // The bug this file was written for. In production transcripts ~30% of
  // segments began mid-sentence, always the same way: the *final* word of a
  // speaker's utterance was credited to whoever spoke next, e.g.
  //
  //   Jennifer Wingard: ...let's move on to the 3rd quarterly
  //   Bob Jones:        report. Thanks Jennifer...
  //
  // The mechanism lives in the seam between transcription and alignment, so
  // this test drives the real chain: recognizer tokens -> tokensToWords ->
  // alignSpeakers. Parakeet emits one timestamp per token (the token's onset,
  // on a 0.08s frame grid) and no durations, so tokensToWords has to decide
  // where a word ends. If it ends a word at the *next* word's start, the last
  // word before a pause is stretched across the whole silence and overlaps the
  // next speaker's turn more than its own — flipping it to the wrong speaker.
  it("keeps a speaker's last word before a long pause with that speaker", () => {
    // Speaker 0 trails off at ~10.3s; speaker 1 starts talking at 12.0s.
    // The gap is silence, and diarization opens speaker 1's turn at 11.5
    // (pyannote catches the breath before the first word).
    const tokens = [
      " quarter",
      "ly",
      " report",
      ".",
      // --- 1.7s of silence, then a different person ---
      " Thanks",
      " Jennifer",
      ".",
    ];
    const timestamps = [9.6, 9.84, 10.08, 10.32, 12.0, 12.32, 12.56];

    const words = tokensToWords(tokens, timestamps);
    const turns: DiarizationTurn[] = [
      { start: 6.0, end: 10.5, speaker: 0 },
      { start: 11.5, end: 14.0, speaker: 1 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "quarterly report.",
      "Thanks Jennifer.",
    ]);
  });

  it("does not stretch a word across a pause into the next turn", () => {
    // Same seam, stated as a property: no word may outlast the silence that
    // follows it. "report." is the last word before a 1.7s gap.
    const words = tokensToWords(
      [" quarter", "ly", " report", ".", " Thanks"],
      [9.6, 9.84, 10.08, 10.32, 12.0],
    );
    const report = words.find((w) => w.text === "report.")!;
    expect(report.end).toBeLessThan(11.0);
  });
});

describe("segmentsToTurns", () => {
  it("round-trips speaker boundaries through alignSpeakers", () => {
    const words = [
      { text: "a", start: 0.0, end: 0.2 },
      { text: "b", start: 2.0, end: 2.2 },
    ];
    const turns: DiarizationTurn[] = [
      { start: 0.0, end: 1.0, speaker: 0 },
      { start: 1.8, end: 3.0, speaker: 1 },
    ];
    const aligned = alignSpeakers(words, turns);
    expect(speakers(alignSpeakers(words, segmentsToTurns(aligned)))).toEqual([
      0, 1,
    ]);
  });
});
