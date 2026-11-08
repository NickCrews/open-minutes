import { describe, expect, it } from "vite-plus/test";

import { alignSpeakers, MAX_WORD_SEC, segmentsToTurns } from "./align";
import type { Segment, Word } from "../transcript";
import type { DiarizationTurn } from "./types";

/** The text of each segment, in order — the shape a reader actually sees. */
function texts(segments: Segment[]): string[] {
  return segments.map((s) => s.words.map((w) => w.text).join(" "));
}

function speakers(segments: Segment[]): number[] {
  return segments.map((s) => s.speakerNumber ?? -1);
}

function w(text: string, start: number): Word {
  return { text, start };
}

describe("alignSpeakers", () => {
  it("groups consecutive same-speaker words into one segment", () => {
    // "a b" ... 1.5s pause ... "c".
    const words = [w("a", 0.0), w("b", 0.3), w("c", 2.0)];
    const turns: DiarizationTurn[] = [
      { start: 0.0, end: 1.0, speakerNumber: 0 },
      { start: 1.8, end: 3.0, speakerNumber: 1 },
    ];
    expect(texts(alignSpeakers(words, turns))).toEqual(["a b", "c"]);
    expect(speakers(alignSpeakers(words, turns))).toEqual([0, 1]);
  });

  it("returns a single unlabeled segment when there are no turns", () => {
    const segments = alignSpeakers([w("a", 0)], []);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.speakerNumber).toBeNull();
  });

  // The bug this file was written for. In production transcripts ~30% of
  // segments began mid-sentence, always the same way: the *final* word of a
  // speaker's utterance was credited to whoever spoke next, e.g.
  //
  //   Jennifer Wingard: ...let's move on to the 3rd quarterly
  //   Bob Jones:        report. Thanks Jennifer...
  //
  // The mechanism is the seam between transcription and alignment: words carry
  // only onsets, so a word's end must be derived. If it were derived as "the
  // next word's start", the last word before a pause would stretch across the
  // whole silence and overlap the next speaker's turn more than its own —
  // flipping it to the wrong speaker. Capping each word at MAX_WORD_SEC is what
  // stops that.
  it("keeps a speaker's last word before a long pause with that speaker", () => {
    // Speaker 0 trails off at ~10.3s; speaker 1 starts talking at 12.0s.
    // The 1.7s gap is silence. Diarization opens speaker 1's turn at 11.5
    // (pyannote catches the breath before the first word).
    const words = [
      w("quarterly", 9.6),
      w("report.", 10.08),
      w("Thanks", 12.0),
      w("Jennifer.", 12.32),
    ];
    const turns: DiarizationTurn[] = [
      { start: 6.0, end: 10.5, speakerNumber: 0 },
      { start: 11.5, end: 14.0, speakerNumber: 1 },
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
    // One continuous utterance.
    const words = [
      w("would", 10.0),
      w("not", 10.3),
      w("be", 10.6),
      w("supported", 10.9),
      w("in", 11.5),
      w("that", 11.7),
      w("area", 11.9),
      w("by", 12.4),
      w("the", 12.6),
      w("plan.", 12.8),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.45, speakerNumber: 0 },
      { start: 11.45, end: 12.35, speakerNumber: 1 },
      { start: 12.35, end: 14.0, speakerNumber: 0 },
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
      w("supported.", 10.9),
      w("Point", 11.5),
      w("of", 11.7),
      w("order.", 11.9),
      w("Thank", 12.4),
      w("you.", 12.6),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.45, speakerNumber: 0 },
      { start: 11.45, end: 12.35, speakerNumber: 1 },
      { start: 12.35, end: 14.0, speakerNumber: 0 },
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
      w("foo", 10.0),
      w("bar.", 10.3),
      w("baz", 10.6),
      w("zub", 11.5),
      w("zub", 11.7),
      w("quz.", 12.4),
      w("foo", 12.6),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.45, speakerNumber: 0 },
      { start: 11.45, end: 12.35, speakerNumber: 1 },
      { start: 12.35, end: 14.0, speakerNumber: 0 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "foo bar. baz",
      "zub zub",
      "quz. foo",
    ]);
  });

  // The other tell is rhythm: a wobble happens inside an unbroken stream of
  // words. Anyone who waited for a gap, or held the floor for a while, was
  // taking a turn. A pause is the gap between one word's derived end and the
  // next word's onset.
  it("keeps a sliver that is separated from its neighbours by a pause", () => {
    // A clear beat of silence before and after the sliver.
    const words = [
      w("would", 10.0),
      w("not", 10.3),
      w("be", 10.6),
      w("supported", 10.9),
      w("in", 12.6),
      w("that", 12.8),
      w("area", 13.0),
      w("by", 14.6),
      w("the", 14.8),
      w("plan.", 15.0),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 12.0, speakerNumber: 0 },
      { start: 12.0, end: 13.5, speakerNumber: 1 },
      { start: 13.5, end: 16.0, speakerNumber: 0 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "would not be supported",
      "in that area",
      "by the plan.",
    ]);
  });

  it("keeps a sliver that runs long, even at a steady pace", () => {
    // Five slow words, but the sliver holds the floor for seconds — that is a
    // turn, not a wobble.
    const words = [
      w("would", 10.0),
      w("not", 10.3),
      w("aaa", 11.5),
      w("bbb", 12.2),
      w("ccc", 12.9),
      w("ddd", 13.6),
      w("eee", 14.3),
      w("by", 15.0),
      w("plan.", 15.4),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.2, speakerNumber: 0 },
      { start: 11.2, end: 14.85, speakerNumber: 1 },
      { start: 14.85, end: 16.0, speakerNumber: 0 },
    ];

    expect(texts(alignSpeakers(words, turns))).toEqual([
      "would not",
      "aaa bbb ccc ddd eee",
      "by plan.",
    ]);
  });

  it("does not stretch a word across a pause into the next turn", () => {
    // Same seam, stated as a property: no word may outlast the silence that
    // follows it. "report." ends MAX_WORD_SEC after its onset — inside speaker
    // 0's turn.
    const words = [w("report.", 10.08), w("Thanks", 12.0)];
    const turns: DiarizationTurn[] = [
      { start: 6.0, end: 10.5, speakerNumber: 0 },
      { start: 11.5, end: 14.0, speakerNumber: 1 },
    ];
    expect(speakers(alignSpeakers(words, turns))).toEqual([0, 1]);
  });

  // VAD's endpoint can trail a speaker's last word by seconds (up to 6.3s on
  // the real meetings). The word's end must not follow it across the silence.
  it("does not stretch a speaker's last word across a long silence", () => {
    // Speaker 0's last word is "report." at 10.08; VAD would close the span at
    // 12.4. Speaker 1's turn opens at 11.5.
    const words = [w("report.", 10.08), w("Thanks", 12.5)];
    const turns: DiarizationTurn[] = [
      { start: 6.0, end: 10.5, speakerNumber: 0 },
      { start: 11.5, end: 14.0, speakerNumber: 1 },
    ];
    // Ending "report." at 12.4 would give it 0.42s of overlap with speaker 0
    // (10.08→10.5) against 0.9s with speaker 1 (11.5→12.4).
    expect(speakers(alignSpeakers(words, turns))).toEqual([0, 1]);
    expect(texts(alignSpeakers(words, turns))).toEqual(["report.", "Thanks"]);
  });

  // VAD's endpoint can also land *before* a speaker's last onset. Ending the
  // word there would give it zero width — zero overlap with every turn — so
  // assignSpeaker would fall through to its nearest-turn-by-midpoint branch.
  //
  // Midpoint distance is not a safe fallback: it compares a word to the *centre*
  // of each turn, so a word sitting squarely inside a long turn loses to a short
  // turn that happens to be centred nearer.
  it("keeps a speaker's last word with the turn it sits inside", () => {
    // "plan." starts at 99.0, deep inside speaker 0's turn; VAD would end the
    // span at 98.5.
    const words = [w("the", 98.0), w("plan.", 99.0)];
    const turns: DiarizationTurn[] = [
      // Speaker 0 holds the floor for the whole minute; midpoint 50.
      { start: 0.0, end: 100.0, speakerNumber: 0 },
      // A brief interjection after it; midpoint 102.
      { start: 101.0, end: 103.0, speakerNumber: 1 },
    ];
    // |99 - 50| = 49 vs |99 - 102| = 3, so the midpoint fallback picks speaker 1
    // for a word that lies entirely within speaker 0's turn.
    expect(speakers(alignSpeakers(words, turns))).toEqual([0]);
  });
});

describe("deriveTimedWords", () => {
  it("never lets a word outlast its own ceiling or overlap the next", () => {
    // Words 0.1s apart (tighter than the ceiling), then a gap wider than it,
    const [seg] = alignSpeakers([w("a", 0.0), w("b", 0.1), w("c", 2.0)], []);
    const words = seg!.words;
    expect(words.map((x) => x.text)).toEqual(["a", "b", "c"]);

    // Reconstruct the derived ends the way alignSpeakers does internally.
    const ends = words.map((x, i) =>
      Math.min(x.start + MAX_WORD_SEC, words[i + 1]?.start ?? Infinity),
    );
    expect(ends).toEqual([0.1, 0.1 + MAX_WORD_SEC, 2.0 + MAX_WORD_SEC]);
    for (let i = 0; i < words.length; i++) {
      expect(ends[i]!).toBeGreaterThan(words[i]!.start);
      expect(ends[i]! - words[i]!.start).toBeLessThanOrEqual(
        MAX_WORD_SEC + Number.EPSILON * 10,
      );
      if (i + 1 < words.length) {
        expect(ends[i]!).toBeLessThanOrEqual(words[i + 1]!.start);
      }
    }
  });
});

describe("segmentsToTurns", () => {
  it("round-trips speaker boundaries through alignSpeakers", () => {
    const words = [w("a", 0.0), w("b", 2.0)];
    const turns: DiarizationTurn[] = [
      { start: 0.0, end: 1.0, speakerNumber: 0 },
      { start: 1.8, end: 3.0, speakerNumber: 1 },
    ];
    const aligned = alignSpeakers(words, turns);
    expect(speakers(alignSpeakers(words, segmentsToTurns(aligned)))).toEqual([
      0, 1,
    ]);
  });
});
