// Word Error Rate via Levenshtein distance over normalized word tokens.
// WER = (substitutions + deletions + insertions) / reference_word_count.

import type { Word } from "../transcript";

export interface WERResult {
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  ref_word_count: number;
}

function normalizeForWER(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

export function computeWER(reference: string, hypothesis: string): WERResult {
  const ref = normalizeForWER(reference);
  const hyp = normalizeForWER(hypothesis);
  const ops = alignTokens(ref, hyp);
  const { substitutions, deletions, insertions } = tallyOps(ops);
  const ref_word_count = ref.length;
  const wer =
    ref_word_count === 0
      ? hyp.length === 0
        ? 0
        : 1
      : (substitutions + deletions + insertions) / ref_word_count;
  return { wer, substitutions, deletions, insertions, ref_word_count };
}

const ALIGNMENT_OPS = ["match", "sub", "del", "ins"] as const;
export type AlignmentOp = (typeof ALIGNMENT_OPS)[number];

export interface AlignedWordPair {
  op: AlignmentOp;
  // refIdx/hypIdx index into the original input arrays. -1 means "no word on this side".
  refIdx: number;
  hypIdx: number;
}

// Align two word sequences (Levenshtein) and return the alignment path. Tokens
// are compared after normalizeToken() so punctuation/case differences don't
// register as substitutions.
export function alignWords(
  ref: readonly Word[],
  hyp: readonly Word[],
): AlignedWordPair[] {
  const refTokens = ref.map((w) => normalizeToken(w.text));
  const hypTokens = hyp.map((w) => normalizeToken(w.text));
  return alignTokens(refTokens, hypTokens);
}

// Needleman–Wunsch alignment, computed only within a diagonal band.
//
// Every cell (i, j) on an optimal alignment path has cost >= |i - j|, so when
// the edit distance is d, the path stays within the band |i - j| <= d. We fill
// only a band of half-width k (cells outside count as infinite cost). If the
// band's final cost is <= k, it is the true distance. Otherwise it is still an
// upper bound on the distance, so the next band uses the smaller of that bound
// and 2k.
// That is O((m+n)·d) time and memory rather than O(m·n): a 25k-word transcript
// with a few hundred edits fills ~12M cells, not ~625M.
//
// The alignment is identical to the full-matrix DP, tie-breaks included. Within
// the band, every cell on an optimal path gets its exact cost. A neighbor whose
// cost the band inflates is not on an optimal path, so its true cost already
// loses the comparison. wer.perf.test.ts cross-validates against the full
// matrix on hundreds of random inputs.
//
// Tie-break priority: sub/match > del > ins. The comparisons below use strict
// `<` against the running minimum, with del checked before ins.
//
// Back-pointers are one byte per band cell in a flat Uint8Array. Once the band
// would be as wide as a full row, the full matrix is filled instead, so memory
// never exceeds (m+1)·(n+1) bytes.
const OP_MATCH = 0;
const OP_SUB = 1;
const OP_DEL = 2;
const OP_INS = 3;

const INF = 1 << 29;
const INITIAL_BAND = 64;

function alignTokens(
  refTokens: readonly string[],
  hypTokens: readonly string[],
): AlignedWordPair[] {
  // Integer ids make the inner loop's equality test a number compare.
  const ids = new Map<string, number>();
  const toIds = (tokens: readonly string[]): Int32Array => {
    const out = new Int32Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      let id = ids.get(t);
      if (id === undefined) {
        id = ids.size;
        ids.set(t, id);
      }
      out[i] = id;
    }
    return out;
  };
  const ref = toIds(refTokens);
  const hyp = toIds(hypTokens);
  const m = ref.length;
  const n = hyp.length;

  let k = Math.max(Math.abs(m - n), INITIAL_BAND);
  for (;;) {
    if (2 * k >= n) {
      const width = n + 1;
      return backtrace(fillFull(ref, hyp), m, n, (i, j) => i * width + j);
    }
    const { back, cost } = fillBand(ref, hyp, k);
    if (cost <= k) {
      const width = 2 * k + 1;
      return backtrace(back, m, n, (i, j) => i * width + j - i + k);
    }
    k = Math.min(cost, 2 * k);
  }
}

// Fills the band |i - j| <= k. Cell (i, j) lives at row i, column j - i + k.
// Returns the back-pointers and the band's cost for (m, n), which equals the
// edit distance if it is <= k and is an upper bound on it otherwise.
function fillBand(
  ref: Int32Array,
  hyp: Int32Array,
  k: number,
): { back: Uint8Array; cost: number } {
  const m = ref.length;
  const n = hyp.length;
  const width = 2 * k + 1;
  const back = new Uint8Array(width * (m + 1));
  // Cost rows are indexed by band column + 1, so columns -1 and `width` are
  // INF sentinels for the neighbors just outside the band.
  let prev = new Int32Array(width + 2).fill(INF);
  let cur = new Int32Array(width + 2).fill(INF);

  for (let j = 0; j <= Math.min(n, k); j++) {
    prev[j + k + 1] = j;
    back[j + k] = OP_INS; // row 0: only insertions reach these cells
  }
  for (let i = 1; i <= m; i++) {
    cur.fill(INF);
    const rowBase = i * width;
    const jlo = Math.max(0, i - k);
    const jhi = Math.min(n, i + k);
    const refTok = ref[i - 1];
    let j = jlo;
    if (j === 0) {
      cur[k - i + 1] = i;
      back[rowBase + k - i] = OP_DEL; // column 0: only deletions reach here
      j = 1;
    }
    for (; j <= jhi; j++) {
      const c = j - i + k + 1;
      const isMatch = refTok === hyp[j - 1];
      const subCost = prev[c]! + (isMatch ? 0 : 1);
      const delCost = prev[c + 1]! + 1;
      const insCost = cur[c - 1]! + 1;
      let min = subCost;
      let op = isMatch ? OP_MATCH : OP_SUB;
      if (delCost < min) {
        min = delCost;
        op = OP_DEL;
      }
      if (insCost < min) {
        min = insCost;
        op = OP_INS;
      }
      cur[c] = min;
      back[rowBase + c - 1] = op;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return { back, cost: prev[n - m + k + 1]! };
}

function fillFull(ref: Int32Array, hyp: Int32Array): Uint8Array {
  const m = ref.length;
  const n = hyp.length;
  const width = n + 1;
  const back = new Uint8Array(width * (m + 1));
  let prev = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  for (let j = 1; j <= n; j++) {
    prev[j] = j;
    back[j] = OP_INS;
  }
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const rowBase = i * width;
    back[rowBase] = OP_DEL;
    const refTok = ref[i - 1];
    for (let j = 1; j <= n; j++) {
      const isMatch = refTok === hyp[j - 1];
      const subCost = prev[j - 1]! + (isMatch ? 0 : 1);
      const delCost = prev[j]! + 1;
      const insCost = cur[j - 1]! + 1;
      let min = subCost;
      let op = isMatch ? OP_MATCH : OP_SUB;
      if (delCost < min) {
        min = delCost;
        op = OP_DEL;
      }
      if (insCost < min) {
        min = insCost;
        op = OP_INS;
      }
      cur[j] = min;
      back[rowBase + j] = op;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return back;
}

// Walks back-pointers from (m, n). `index` maps cell (i, j) into `back`.
function backtrace(
  back: Uint8Array,
  m: number,
  n: number,
  index: (i: number, j: number) => number,
): AlignedWordPair[] {
  const ops: AlignedWordPair[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const op = back[index(i, j)]!;
    if (op === OP_MATCH || op === OP_SUB) {
      ops.push({ op: ALIGNMENT_OPS[op]!, refIdx: i - 1, hypIdx: j - 1 });
      i--;
      j--;
    } else if (op === OP_DEL) {
      ops.push({ op: "del", refIdx: i - 1, hypIdx: -1 });
      i--;
    } else {
      ops.push({ op: "ins", refIdx: -1, hypIdx: j - 1 });
      j--;
    }
  }
  ops.reverse();
  return ops;
}

function tallyOps(ops: readonly AlignedWordPair[]): {
  matches: number;
  substitutions: number;
  deletions: number;
  insertions: number;
} {
  let matches = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  for (const o of ops) {
    if (o.op === "match") matches++;
    else if (o.op === "sub") substitutions++;
    else if (o.op === "del") deletions++;
    else insertions++;
  }
  return { matches, substitutions, deletions, insertions };
}

export interface TranscriptComparison {
  wer: number;
  matches: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  refWordCount: number;
  hypWordCount: number;
  // Onset error stats over matched-only pairs (substitutions excluded —
  // they may be different words and timestamps aren't meaningful to compare).
  // Errors are absolute differences in seconds. Only starts are compared:
  // words carry no end timestamps.
  matchedPairs: number;
  meanStartError: number;
  maxStartError: number;
  // 95th-percentile absolute error — robust to a handful of outliers.
  p95StartError: number;
}

export function compareTranscripts(
  ref: readonly Word[],
  hyp: readonly Word[],
): TranscriptComparison {
  const ops = alignWords(ref, hyp);
  const { matches, substitutions, deletions, insertions } = tallyOps(ops);
  const refWordCount = ref.length;
  const hypWordCount = hyp.length;
  const wer =
    refWordCount === 0
      ? hypWordCount === 0
        ? 0
        : 1
      : (substitutions + deletions + insertions) / refWordCount;

  const startErrs: number[] = [];
  for (const op of ops) {
    if (op.op !== "match") continue;
    const r = ref[op.refIdx]!;
    const h = hyp[op.hypIdx]!;
    startErrs.push(Math.abs(r.start - h.start));
  }

  return {
    wer,
    matches,
    substitutions,
    deletions,
    insertions,
    refWordCount,
    hypWordCount,
    matchedPairs: startErrs.length,
    meanStartError: mean(startErrs),
    maxStartError: max(startErrs),
    p95StartError: percentile(startErrs, 0.95),
  };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function max(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let m = xs[0]!;
  for (const x of xs) if (x > m) m = x;
  return m;
}

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx]!;
}
