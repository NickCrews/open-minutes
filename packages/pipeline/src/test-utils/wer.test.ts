import { describe, expect, it } from "vitest";
import { alignWords, computeWER } from "./wer";
import type { TranscriptWord } from "@open-minutes/core/transcription";

function w(text: string, start = 0, end = 0): TranscriptWord {
  return { text, start, end };
}

describe("computeWER", () => {
  it("returns zero WER when reference and hypothesis match exactly", () => {
    const result = computeWER("the quick brown fox", "the quick brown fox");
    expect(result).toEqual({
      wer: 0,
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      ref_word_count: 4,
    });
  });

  it("ignores case and punctuation when normalizing", () => {
    const result = computeWER("Hello, world!", "hello world");
    expect(result.wer).toBe(0);
    expect(result.ref_word_count).toBe(2);
  });

  it("counts a single substitution", () => {
    const result = computeWER("the quick brown fox", "the quick red fox");
    expect(result.substitutions).toBe(1);
    expect(result.deletions).toBe(0);
    expect(result.insertions).toBe(0);
    expect(result.wer).toBe(1 / 4);
  });

  it("counts deletions when hypothesis is missing words", () => {
    const result = computeWER("the quick brown fox", "the brown fox");
    expect(result.deletions).toBe(1);
    expect(result.substitutions).toBe(0);
    expect(result.insertions).toBe(0);
    expect(result.wer).toBe(1 / 4);
  });

  it("counts insertions when hypothesis has extra words", () => {
    const result = computeWER("the quick fox", "the very quick fox");
    expect(result.insertions).toBe(1);
    expect(result.substitutions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.wer).toBe(1 / 3);
  });

  it("handles a mix of substitutions, insertions, and deletions", () => {
    const result = computeWER("the quick brown fox jumps", "a quick red fox");
    expect(result.substitutions).toBe(2);
    expect(result.deletions).toBe(1);
    expect(result.insertions).toBe(0);
    expect(result.wer).toBe(3 / 5);
  });

  it("returns WER 1 when reference is empty but hypothesis is not", () => {
    const result = computeWER("", "extra words here");
    expect(result.wer).toBe(1);
    expect(result.ref_word_count).toBe(0);
    expect(result.insertions).toBe(3);
  });

  it("returns WER 0 when both reference and hypothesis are empty", () => {
    const result = computeWER("", "");
    expect(result.wer).toBe(0);
    expect(result.ref_word_count).toBe(0);
  });
});

describe("alignWords", () => {
  it("aligns identical word sequences as all matches", () => {
    const ref = [w("the"), w("quick"), w("fox")];
    const hyp = [w("the"), w("quick"), w("fox")];
    const ops = alignWords(ref, hyp);
    expect(ops).toEqual([
      { op: "match", refIdx: 0, hypIdx: 0 },
      { op: "match", refIdx: 1, hypIdx: 1 },
      { op: "match", refIdx: 2, hypIdx: 2 },
    ]);
  });

  it("treats case and punctuation differences as matches", () => {
    const ref = [w("Hello,"), w("World!")];
    const hyp = [w("hello"), w("world")];
    const ops = alignWords(ref, hyp);
    expect(ops.map((o) => o.op)).toEqual(["match", "match"]);
  });

  it("marks a differing word as a substitution", () => {
    const ref = [w("the"), w("quick"), w("fox")];
    const hyp = [w("the"), w("slow"), w("fox")];
    const ops = alignWords(ref, hyp);
    expect(ops).toEqual([
      { op: "match", refIdx: 0, hypIdx: 0 },
      { op: "sub", refIdx: 1, hypIdx: 1 },
      { op: "match", refIdx: 2, hypIdx: 2 },
    ]);
  });

  it("emits a deletion when the hypothesis drops a word", () => {
    const ref = [w("the"), w("quick"), w("fox")];
    const hyp = [w("THE"), w("FOX")];
    const ops = alignWords(ref, hyp);
    expect(ops).toEqual([
      { op: "match", refIdx: 0, hypIdx: 0 },
      { op: "del", refIdx: 1, hypIdx: -1 },
      { op: "match", refIdx: 2, hypIdx: 1 },
    ]);
  });

  it("emits an insertion when the hypothesis adds a word", () => {
    const ref = [w("the"), w("fox")];
    const hyp = [w("the"), w("quick"), w("fox")];
    const ops = alignWords(ref, hyp);
    expect(ops).toEqual([
      { op: "match", refIdx: 0, hypIdx: 0 },
      { op: "ins", refIdx: -1, hypIdx: 1 },
      { op: "match", refIdx: 1, hypIdx: 2 },
    ]);
  });

  it("returns only insertions when the reference is empty", () => {
    const ops = alignWords([], [w("a"), w("b")]);
    expect(ops).toEqual([
      { op: "ins", refIdx: -1, hypIdx: 0 },
      { op: "ins", refIdx: -1, hypIdx: 1 },
    ]);
  });

  it("returns only deletions when the hypothesis is empty", () => {
    const ops = alignWords([w("a"), w("b")], []);
    expect(ops).toEqual([
      { op: "del", refIdx: 0, hypIdx: -1 },
      { op: "del", refIdx: 1, hypIdx: -1 },
    ]);
  });

  it("returns an empty alignment for two empty inputs", () => {
    expect(alignWords([], [])).toEqual([]);
  });
});
