import { describe, expect, it } from "vitest";
import { alignWords, type AlignedWordPair, type AlignmentOp } from "./wer";
import type { TranscriptWord } from "@open-minutes/core/transcription";

// Deterministic PRNG so the generated transcripts are stable across runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function w(text: string, start = 0, end = 0): TranscriptWord {
  return { text, start, end };
}

// Build a sequence of `n` already-normalized words from a small vocabulary so
// normalizeToken() is a no-op and we can reason about alignment directly.
function makeWords(n: number, rng: () => number): TranscriptWord[] {
  const vocab = [
    "the",
    "quick",
    "brown",
    "fox",
    "jumps",
    "over",
    "lazy",
    "dog",
    "and",
    "then",
    "runs",
    "away",
    "into",
    "forest",
    "where",
    "trees",
    "grow",
    "tall",
    "near",
    "river",
    "that",
    "flows",
    "down",
    "hill",
  ];
  const words: TranscriptWord[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const text = vocab[Math.floor(rng() * vocab.length)]!;
    words[i] = w(text, i, i + 1);
  }
  return words;
}

// Oracle: the original full-matrix Needleman–Wunsch this module used to ship.
// Kept here (and only here) so we can assert Hirschberg produces a *byte-identical*
// alignment — same ops, same indices, same tie-breaks — on inputs small enough
// that the O(m·n) matrices fit in memory.
function referenceAlign(
  ref: readonly string[],
  hyp: readonly string[],
): AlignedWordPair[] {
  const m = ref.length;
  const n = hyp.length;
  const cost: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  const back: AlignmentOp[][] = Array.from({ length: m + 1 }, () =>
    new Array<AlignmentOp>(n + 1).fill("match"),
  );
  for (let i = 1; i <= m; i++) {
    cost[i]![0] = i;
    back[i]![0] = "del";
  }
  for (let j = 1; j <= n; j++) {
    cost[0]![j] = j;
    back[0]![j] = "ins";
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const isMatch = ref[i - 1] === hyp[j - 1];
      const subCost = cost[i - 1]![j - 1]! + (isMatch ? 0 : 1);
      const delCost = cost[i - 1]![j]! + 1;
      const insCost = cost[i]![j - 1]! + 1;
      const min = Math.min(subCost, delCost, insCost);
      cost[i]![j] = min;
      if (min === subCost) back[i]![j] = isMatch ? "match" : "sub";
      else if (min === delCost) back[i]![j] = "del";
      else back[i]![j] = "ins";
    }
  }
  const ops: AlignedWordPair[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const op = back[i]![j]!;
    if (op === "match" || op === "sub") {
      ops.push({ op, refIdx: i - 1, hypIdx: j - 1 });
      i--;
      j--;
    } else if (op === "del") {
      ops.push({ op, refIdx: i - 1, hypIdx: -1 });
      i--;
    } else {
      ops.push({ op, refIdx: -1, hypIdx: j - 1 });
      j--;
    }
  }
  ops.reverse();
  return ops;
}

function toTokens(words: readonly TranscriptWord[]): string[] {
  return words.map((x) => x.text);
}

describe("alignWords cross-validation against full-matrix oracle", () => {
  it("matches the oracle on many random small/medium inputs (incl. sub/del/ins ties)", () => {
    const rng = mulberry32(1234);
    for (let trial = 0; trial < 200; trial++) {
      const refLen = Math.floor(rng() * 60);
      const hypLen = Math.floor(rng() * 60);
      const ref = makeWords(refLen, rng);
      const hyp = makeWords(hypLen, rng);
      const got = alignWords(ref, hyp);
      const want = referenceAlign(toTokens(ref), toTokens(hyp));
      expect(got).toEqual(want);
    }
  });

  it("matches the oracle on lopsided lengths (forces long del/ins runs)", () => {
    const rng = mulberry32(99);
    const ref = makeWords(300, rng);
    const hyp = makeWords(5, rng);
    expect(alignWords(ref, hyp)).toEqual(
      referenceAlign(toTokens(ref), toTokens(hyp)),
    );
    expect(alignWords(hyp, ref)).toEqual(
      referenceAlign(toTokens(hyp), toTokens(ref)),
    );
  });
});

describe("alignWords on full-meeting-sized transcripts", () => {
  // The golden fixtures are ~21k–27k words. The old full-matrix DP allocates two
  // (m+1)×(n+1) matrices (~600M cells, multiple GB) and OOMs V8 here.
  it("aligns ~25k-word sequences without OOM, with a controlled diff", () => {
    const N = 25_000;
    const rng = mulberry32(7);
    const ref = makeWords(N, rng);

    // Build hyp = ref with a substitution at every 100th position. Sparse,
    // non-adjacent single-word swaps, so the optimal alignment is exactly those
    // substitutions and the rest matches (no cheaper del+ins path exists).
    const hyp = ref.map((x) => w(x.text, x.start, x.end));
    let expectedSubs = 0;
    for (let i = 0; i < N; i += 100) {
      const cur = hyp[i]!;
      // Pick a different token deterministically.
      hyp[i] = w(cur.text === "the" ? "zzz" : "the", cur.start, cur.end);
      if (hyp[i]!.text !== ref[i]!.text) expectedSubs++;
    }

    const t0 = Date.now();
    const ops = alignWords(ref, hyp);
    const elapsed = Date.now() - t0;

    const counts = { match: 0, sub: 0, del: 0, ins: 0 };
    for (const o of ops) counts[o.op]++;

    expect(counts.sub).toBe(expectedSubs);
    expect(counts.del).toBe(0);
    expect(counts.ins).toBe(0);
    expect(counts.match).toBe(N - expectedSubs);
    expect(ops).toHaveLength(N);
    // Generous ceiling: the point is it finishes at all (no OOM). Catches a gross
    // perf regression without being flaky on a loaded CI box.
    expect(elapsed).toBeLessThan(60_000);
  });
});
