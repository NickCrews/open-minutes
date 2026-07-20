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
  return segments.map((s) => s.speakerNum ?? -1);
}

describe("alignSpeakers", () => {
  it("groups consecutive same-speaker words into one segment", () => {
    const words = [
      { text: "a", start: 0.0, end: 0.2 },
      { text: "b", start: 0.3, end: 0.5 },
      { text: "c", start: 2.0, end: 2.2 },
    ];
    const turns: DiarizationTurn[] = [
      { start: 0.0, end: 1.0, speakerNum: 0 },
      { start: 1.8, end: 3.0, speakerNum: 1 },
    ];
    expect(texts(alignSpeakers(words, turns))).toEqual(["a b", "c"]);
    expect(speakers(alignSpeakers(words, turns))).toEqual([0, 1]);
  });

  it("returns a single unlabeled segment when there are no turns", () => {
    const words = [{ text: "a", start: 0, end: 0.2 }];
    const segments = alignSpeakers(words, []);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.speakerNum).toBeNull();
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
      { start: 6.0, end: 10.5, speakerNum: 0 },
      { start: 11.5, end: 14.0, speakerNum: 1 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "quarterly report.",
      "Thanks Jennifer.",
    ]);
  });

  // Diarization sometimes flips to a different cluster for a word or two in the
  // middle of an uninterrupted utterance, splitting one turn into three and
  // crediting the middle sliver to whoever the clustering drifted to:
  //
  //   Mélisa Babb:      ...a rezone to a residential district would not necessarily be supported
  //   Radhika Krishna:  in that area
  //   Mélisa Babb:      by the plan because that area is envisioned as...
  //
  // Two things give it away: the sliver is tiny, and the surrounding text runs
  // on as one sentence — the speaker before it never reached a full stop. A
  // real interjection lands *between* sentences.
  it("absorbs a short mid-sentence sliver back into the surrounding speaker", () => {
    const words = [
      { text: "would", start: 10.0, end: 10.3 },
      { text: "not", start: 10.3, end: 10.6 },
      { text: "be", start: 10.6, end: 10.9 },
      { text: "supported", start: 10.9, end: 11.4 },
      { text: "in", start: 11.5, end: 11.7 },
      { text: "that", start: 11.7, end: 11.9 },
      { text: "area", start: 11.9, end: 12.3 },
      { text: "by", start: 12.4, end: 12.6 },
      { text: "the", start: 12.6, end: 12.8 },
      { text: "plan.", start: 12.8, end: 13.2 },
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.45, speakerNum: 0 },
      { start: 11.45, end: 12.35, speakerNum: 1 },
      { start: 12.35, end: 14.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "would not be supported in that area by the plan.",
    ]);
    expect(speakers(alignSpeakers(words, turns))).toEqual([0]);
  });

  it("keeps a short interjection that lands between sentences", () => {
    // Same shape, but the first speaker finished their sentence — so the short
    // turn is a real interjection, not a clustering wobble.
    const words = [
      { text: "supported.", start: 10.9, end: 11.4 },
      { text: "Point", start: 11.5, end: 11.7 },
      { text: "of", start: 11.7, end: 11.9 },
      { text: "order.", start: 11.9, end: 12.3 },
      { text: "Thank", start: 12.4, end: 12.6 },
      { text: "you.", start: 12.6, end: 13.2 },
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.45, speakerNum: 0 },
      { start: 11.45, end: 12.35, speakerNum: 1 },
      { start: 12.35, end: 14.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "supported.",
      "Point of order.",
      "Thank you.",
    ]);
  });

  // A sliver only reads as a clustering wobble if the *whole* neighbourhood is
  // one run-on sentence. "...foo bar. baz | zub zub | quz. foo..." looks
  // mid-clause at each boundary word, but "baz zub zub quz." is a complete
  // sentence of its own — a real interjection the surrounding speaker talked
  // over. Sentence punctuation anywhere near either boundary rules it out.
  it("keeps a sliver when a sentence ends within two words of a boundary", () => {
    const words = [
      { text: "foo", start: 10.0, end: 10.3 },
      { text: "bar.", start: 10.3, end: 10.6 },
      { text: "baz", start: 10.6, end: 10.9 },
      { text: "zub", start: 11.5, end: 11.7 },
      { text: "zub", start: 11.7, end: 11.9 },
      { text: "quz.", start: 12.4, end: 12.6 },
      { text: "foo", start: 12.6, end: 12.8 },
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.45, speakerNum: 0 },
      { start: 11.45, end: 12.35, speakerNum: 1 },
      { start: 12.35, end: 14.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "foo bar. baz",
      "zub zub",
      "quz. foo",
    ]);
  });

  // The other tell is rhythm: a wobble happens inside an unbroken stream of
  // words. Anyone who waited for a gap, or held the floor for a while, was
  // taking a turn.
  it("keeps a sliver that is separated from its neighbours by a pause", () => {
    const words = [
      { text: "would", start: 10.0, end: 10.3 },
      { text: "not", start: 10.3, end: 10.6 },
      { text: "be", start: 10.6, end: 10.9 },
      { text: "supported", start: 10.9, end: 11.4 },
      // A clear beat of silence before and after the sliver.
      { text: "in", start: 12.6, end: 12.8 },
      { text: "that", start: 12.8, end: 13.0 },
      { text: "area", start: 13.0, end: 13.4 },
      { text: "by", start: 14.6, end: 14.8 },
      { text: "the", start: 14.8, end: 15.0 },
      { text: "plan.", start: 15.0, end: 15.4 },
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 12.0, speakerNum: 0 },
      { start: 12.0, end: 13.5, speakerNum: 1 },
      { start: 13.5, end: 16.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "would not be supported",
      "in that area",
      "by the plan.",
    ]);
  });

  it("keeps a sliver that runs long, even at a steady pace", () => {
    // Five slow words with no gap big enough to trip the pause check, but the
    // sliver holds the floor for seconds — that is a turn, not a wobble.
    const words = [
      { text: "would", start: 10.0, end: 10.3 },
      { text: "not", start: 10.3, end: 10.9 },
      { text: "aaa", start: 11.5, end: 11.9 },
      { text: "bbb", start: 12.2, end: 12.6 },
      { text: "ccc", start: 12.9, end: 13.3 },
      { text: "ddd", start: 13.6, end: 14.0 },
      { text: "eee", start: 14.3, end: 14.7 },
      { text: "by", start: 15.0, end: 15.4 },
      { text: "plan.", start: 15.4, end: 15.8 },
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.2, speakerNum: 0 },
      { start: 11.2, end: 14.85, speakerNum: 1 },
      { start: 14.85, end: 16.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "would not",
      "aaa bbb ccc ddd eee",
      "by plan.",
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
      { start: 0.0, end: 1.0, speakerNum: 0 },
      { start: 1.8, end: 3.0, speakerNum: 1 },
    ];
    const aligned = alignSpeakers(words, turns);
    expect(speakers(alignSpeakers(words, segmentsToTurns(aligned)))).toEqual([
      0, 1,
    ]);
  });
});
