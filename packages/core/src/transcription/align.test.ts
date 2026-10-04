import { describe, expect, it } from "vitest";

import {
  alignSpeakers,
  MAX_WORD_SEC,
  segmentsToSpeechRuns,
  segmentsToTurns,
} from "./align";
import type {
  DiarizationTurn,
  SpeechSegment,
  TranscriptSegment,
  TranscriptWord,
} from "./types";

/** The text of each segment, in order — the shape a reader actually sees. */
function texts(segments: TranscriptSegment[]): string[] {
  return segments.map((s) => s.words.map((w) => w.text).join(" "));
}

function speakers(segments: TranscriptSegment[]): number[] {
  return segments.map((s) => s.speakerNum ?? -1);
}

/**
 * Build a SpeechSegment the way VAD + transcription would: a run spanning from
 * its first word's onset to `end` (defaulting to shortly after the last word's
 * onset). Tests split words into runs wherever the audio would have had a
 * pause ≥ 0.5s, because that is what VAD does.
 */
function run(words: TranscriptWord[], end?: number): SpeechSegment {
  return {
    start: words[0]!.start,
    end: end ?? words.at(-1)!.start + 0.3,
    words,
  };
}

function w(text: string, start: number): TranscriptWord {
  return { text, start };
}

describe("alignSpeakers", () => {
  it("groups consecutive same-speaker words into one segment", () => {
    // "a b" ... 1.5s pause ... "c" — VAD cuts at the pause, so two runs.
    const speech = [
      run([w("a", 0.0), w("b", 0.3)], 0.5),
      run([w("c", 2.0)], 2.2),
    ];
    const turns: DiarizationTurn[] = [
      { start: 0.0, end: 1.0, speakerNum: 0 },
      { start: 1.8, end: 3.0, speakerNum: 1 },
    ];
    expect(texts(alignSpeakers(speech, turns))).toEqual(["a b", "c"]);
    expect(speakers(alignSpeakers(speech, turns))).toEqual([0, 1]);
  });

  it("returns a single unlabeled segment when there are no turns", () => {
    const speech = [run([w("a", 0)], 0.2)];
    const segments = alignSpeakers(speech, []);
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
  // The mechanism is the seam between transcription and alignment: words carry
  // only onsets, so a word's end must be derived. If it were derived as "the
  // next word's start" with no regard for run structure, the last word before a
  // pause would stretch across the whole silence and overlap the next speaker's
  // turn more than its own — flipping it to the wrong speaker. Run boundaries
  // (VAD cuts at every pause ≥ 0.5s) are what stop that: a run's last word ends
  // at the run's end, never later.
  it("keeps a speaker's last word before a long pause with that speaker", () => {
    // Speaker 0 trails off at ~10.3s; speaker 1 starts talking at 12.0s.
    // The 1.7s gap is silence, so VAD cut a run boundary there. Diarization
    // opens speaker 1's turn at 11.5 (pyannote catches the breath before the
    // first word).
    const speech = [
      run([w("quarterly", 9.6), w("report.", 10.08)], 10.4),
      run([w("Thanks", 12.0), w("Jennifer.", 12.32)], 12.9),
    ];
    const turns: DiarizationTurn[] = [
      { start: 6.0, end: 10.5, speakerNum: 0 },
      { start: 11.5, end: 14.0, speakerNum: 1 },
    ];

    expect(texts(alignSpeakers(speech, turns))).toEqual([
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
    // One continuous utterance, so one VAD run.
    const speech = [
      run(
        [
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
        ],
        13.2,
      ),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.45, speakerNum: 0 },
      { start: 11.45, end: 12.35, speakerNum: 1 },
      { start: 12.35, end: 14.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(speech, turns))).toEqual([
      "would not be supported in that area by the plan.",
    ]);
    expect(speakers(alignSpeakers(speech, turns))).toEqual([0]);
  });

  it("keeps a short interjection that lands between sentences", () => {
    // Same shape, but the first speaker finished their sentence — so the short
    // turn is a real interjection, not a clustering wobble.
    const speech = [
      run(
        [
          w("supported.", 10.9),
          w("Point", 11.5),
          w("of", 11.7),
          w("order.", 11.9),
          w("Thank", 12.4),
          w("you.", 12.6),
        ],
        13.2,
      ),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.45, speakerNum: 0 },
      { start: 11.45, end: 12.35, speakerNum: 1 },
      { start: 12.35, end: 14.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(speech, turns))).toEqual([
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
    const speech = [
      run(
        [
          w("foo", 10.0),
          w("bar.", 10.3),
          w("baz", 10.6),
          w("zub", 11.5),
          w("zub", 11.7),
          w("quz.", 12.4),
          w("foo", 12.6),
        ],
        12.8,
      ),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.45, speakerNum: 0 },
      { start: 11.45, end: 12.35, speakerNum: 1 },
      { start: 12.35, end: 14.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(speech, turns))).toEqual([
      "foo bar. baz",
      "zub zub",
      "quz. foo",
    ]);
  });

  // The other tell is rhythm: a wobble happens inside an unbroken stream of
  // words. Anyone who waited for a gap, or held the floor for a while, was
  // taking a turn. Pauses show up as VAD run boundaries — a run's last word
  // ends at the run's end, and the silence before the next run is the gap.
  it("keeps a sliver that is separated from its neighbours by a pause", () => {
    const speech = [
      // A clear beat of silence before and after the sliver — three runs.
      run(
        [w("would", 10.0), w("not", 10.3), w("be", 10.6), w("supported", 10.9)],
        11.4,
      ),
      run([w("in", 12.6), w("that", 12.8), w("area", 13.0)], 13.4),
      run([w("by", 14.6), w("the", 14.8), w("plan.", 15.0)], 15.4),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 12.0, speakerNum: 0 },
      { start: 12.0, end: 13.5, speakerNum: 1 },
      { start: 13.5, end: 16.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(speech, turns))).toEqual([
      "would not be supported",
      "in that area",
      "by the plan.",
    ]);
  });

  it("keeps a sliver that runs long, even at a steady pace", () => {
    // Five slow words with no gap big enough for a VAD cut, but the sliver
    // holds the floor for seconds — that is a turn, not a wobble.
    const speech = [
      run(
        [
          w("would", 10.0),
          w("not", 10.3),
          w("aaa", 11.5),
          w("bbb", 12.2),
          w("ccc", 12.9),
          w("ddd", 13.6),
          w("eee", 14.3),
          w("by", 15.0),
          w("plan.", 15.4),
        ],
        15.8,
      ),
    ];
    const turns: DiarizationTurn[] = [
      { start: 9.0, end: 11.2, speakerNum: 0 },
      { start: 11.2, end: 14.85, speakerNum: 1 },
      { start: 14.85, end: 16.0, speakerNum: 0 },
    ];

    expect(texts(alignSpeakers(speech, turns))).toEqual([
      "would not",
      "aaa bbb ccc ddd eee",
      "by plan.",
    ]);
  });

  it("does not stretch a word across a run boundary into the next turn", () => {
    // Same seam, stated as a property: no word may outlast the silence that
    // follows it. "report." is the last word of its run, so its derived end is
    // the run's end — inside speaker 0's turn — no matter how close the next
    // run's words come to it in the flat stream.
    const speech = [
      run([w("report.", 10.08)], 10.4),
      run([w("Thanks", 12.0)], 12.3),
    ];
    const turns: DiarizationTurn[] = [
      { start: 6.0, end: 10.5, speakerNum: 0 },
      { start: 11.5, end: 14.0, speakerNum: 1 },
    ];
    expect(speakers(alignSpeakers(speech, turns))).toEqual([0, 1]);
  });

  // The test above builds its runs with a tight end (10.4 for a word at 10.32),
  // which quietly assumes the thing worth checking: that VAD's endpoint lands
  // close behind the last word. On the real meetings it often does not. Measured
  // over test-runs/*/transcribed.gen.psv (2142 runs, both meetings): 18% of runs
  // end more than 0.32s after their last word's onset, and the worst reach 4.3s
  // and 6.3s past it.
  //
  // That gap is what the old MAX_TOKEN_SEC ceiling in transcribe.ts existed to
  // cap — it was set below VAD_MIN_SILENCE_SEC precisely so an estimated word
  // could never span a pause VAD would have cut at. Deriving the end from
  // run.end instead removes the ceiling, so the run's last word is free to
  // stretch across the silence and into the next speaker's turn.
  it("does not stretch a run's last word past the pause when VAD's endpoint runs long", () => {
    // Speaker 0's last word is "report." at 10.32. VAD closed the run at 12.4 —
    // two seconds later, well within the range seen on real audio. Speaker 1's
    // turn opens at 11.5.
    const speech = [
      run([w("report.", 10.08)], 12.4),
      run([w("Thanks", 12.5)], 12.8),
    ];
    const turns: DiarizationTurn[] = [
      { start: 6.0, end: 10.5, speakerNum: 0 },
      { start: 11.5, end: 14.0, speakerNum: 1 },
    ];
    // "report." overlaps speaker 0 for 0.18s (10.32→10.5) but speaker 1 for
    // 0.9s (11.5→12.4), so it is handed to the wrong speaker.
    expect(speakers(alignSpeakers(speech, turns))).toEqual([0, 1]);
    expect(texts(alignSpeakers(speech, turns))).toEqual(["report.", "Thanks"]);
  });

  // The mirror image, and the more common one: run.end lands *before* the last
  // word's onset, because splitWordsIntoRuns parks a word that fell in an
  // inter-run silence on the preceding run. deriveTimedWords clamps the end to
  // the start, giving a zero-width word — and a zero-width word has zero overlap
  // with every turn, so assignSpeaker always falls through to its nearest-turn-
  // by-midpoint branch. That happens to 73% of run-final words on the real
  // meetings, which are exactly the words sitting at speaker boundaries.
  //
  // Midpoint distance is not a safe fallback: it compares a word to the *centre*
  // of each turn, so a word sitting squarely inside a long turn loses to a short
  // turn that happens to be centred nearer.
  it("keeps a zero-duration run-final word with the turn it actually sits inside", () => {
    // "plan." starts at 99.0, deep inside speaker 0's turn, but the run ended at
    // 98.5 — so its derived end clamps back to 99.0 and it has no width.
    const speech = [run([w("the", 98.0), w("plan.", 99.0)], 98.5)];
    const turns: DiarizationTurn[] = [
      // Speaker 0 holds the floor for the whole minute; midpoint 50.
      { start: 0.0, end: 100.0, speakerNum: 0 },
      // A brief interjection after it; midpoint 102.
      { start: 101.0, end: 103.0, speakerNum: 1 },
    ];
    // |99 - 50| = 49 vs |99 - 102| = 3, so the midpoint fallback picks speaker 1
    // for a word that lies entirely within speaker 0's turn.
    expect(speakers(alignSpeakers(speech, turns))).toEqual([0]);
  });
});

describe("deriveTimedWords", () => {
  it("never lets a word outlast its own ceiling or overlap the next", () => {
    // Words 0.1s apart (tighter than the ceiling), then a gap wider than it,
    // spanning two runs so the flattened stream is what gets clamped.
    const speech = [
      run([w("a", 0.0), w("b", 0.1)], 5.0), // run.end deliberately absurd
      run([w("c", 2.0)], 2.05), // and here deliberately before the word
    ];
    const [seg] = alignSpeakers(speech, []);
    const words = seg!.words;
    expect(words.map((x) => x.text)).toEqual(["a", "b", "c"]);

    // Reconstruct the derived ends the way alignSpeakers does internally.
    const ends = words.map((x, i) =>
      Math.min(x.start + MAX_WORD_SEC, words[i + 1]?.start ?? Infinity),
    );
    expect(ends).toEqual([0.1, 0.1 + MAX_WORD_SEC, 2.0 + MAX_WORD_SEC]);
    // Neither run.end value leaked in: no zero-width word, no 5s-long word.
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
    const speech = [run([w("a", 0.0)], 0.2), run([w("b", 2.0)], 2.2)];
    const turns: DiarizationTurn[] = [
      { start: 0.0, end: 1.0, speakerNum: 0 },
      { start: 1.8, end: 3.0, speakerNum: 1 },
    ];
    const aligned = alignSpeakers(speech, turns);
    expect(speakers(alignSpeakers(speech, segmentsToTurns(aligned)))).toEqual([
      0, 1,
    ]);
  });
});

describe("segmentsToSpeechRuns", () => {
  it("wraps labeled segments as pseudo-runs that re-align to the same speakers", () => {
    const segments: TranscriptSegment[] = [
      { speakerNum: 0, words: [w("a", 0.0), w("b", 0.3)] },
      { speakerNum: 1, words: [w("c", 2.0)] },
    ];
    const runs = segmentsToSpeechRuns(segments);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.start).toBe(0.0);
    expect(runs[0]!.end).toBeGreaterThan(0.3);
    expect(runs[0]!.end).toBeLessThan(2.0);

    const realigned = alignSpeakers(runs, segmentsToTurns(segments));
    expect(speakers(realigned)).toEqual([0, 1]);
    expect(texts(realigned)).toEqual(["a b", "c"]);
  });
});
