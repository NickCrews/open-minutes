// Word Error Rate via Levenshtein distance over normalized word tokens.
// WER = (substitutions + deletions + insertions) / reference_word_count.

import type { TranscriptWord } from "../types.ts";

export interface WERResult {
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  ref_word_count: number;
}

export function normalizeForWER(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, "");
}

export function computeWER(reference: string, hypothesis: string): WERResult {
  const ref = normalizeForWER(reference);
  const hyp = normalizeForWER(hypothesis);
  const ops = alignTokens(ref, hyp);
  const { substitutions, deletions, insertions } = tallyOps(ops);
  const ref_word_count = ref.length;
  const wer = ref_word_count === 0 ? (hyp.length === 0 ? 0 : 1) : (substitutions + deletions + insertions) / ref_word_count;
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
  ref: readonly TranscriptWord[],
  hyp: readonly TranscriptWord[],
): AlignedWordPair[] {
  const refTokens = ref.map((w) => normalizeToken(w.text));
  const hypTokens = hyp.map((w) => normalizeToken(w.text));
  return alignTokens(refTokens, hypTokens);
}

// Needleman–Wunsch alignment with a memory-conscious layout.
//
// The naive version of this DP allocates two full (m+1)×(n+1) matrices: a
// `number[][]` cost grid and a `string[][]` back-pointer grid. On full-meeting
// transcripts (~21k–27k words) those are ~470M–720M cells of *boxed* values —
// each a heap pointer to a double or an interned string — which totals well over
// 7 GB and OOMs V8's old-space (~4 GB). `compareTranscripts(golden, golden)`
// alone OOMs in ~3s with no ASR involved.
//
// Two changes keep the exact same algorithm and output but slash peak memory:
//   1. Cost only ever reads the previous and current row, so it lives in two
//      Int32Array rows (O(n)) instead of a full matrix.
//   2. Back-pointers are packed one byte per cell in a single flat Uint8Array
//      (off-heap backing store), not a (m+1)×(n+1) array-of-arrays of strings.
// That brings a 27k×27k alignment from ~7+ GB down to ~700 MB — comfortably
// under the heap limit — so full meetings align without OOM.
//
// Tie-break priority is preserved exactly: sub/match > del > ins. The byte codes
// below are compared with strict `<` against the running minimum (del checked
// before ins), which is equivalent to the original `min === subCost ? ... :
// min === delCost ? ...` cascade. wer.perf.test.ts cross-validates this against
// the original full-matrix implementation on hundreds of random inputs.
//
// Memory is still O(m·n) for the back-pointer buffer. If transcripts ever grow
// well beyond meeting scale, Hirschberg's algorithm would drop this to
// O(min(m,n)) at the cost of ~2× the time and a much trickier tie-break.
const OP_MATCH = 0;
const OP_SUB = 1;
const OP_DEL = 2;
const OP_INS = 3;

function alignTokens(ref: readonly string[], hyp: readonly string[]): AlignedWordPair[] {
  const m = ref.length;
  const n = hyp.length;
  const width = n + 1;
  const back = new Uint8Array(width * (m + 1));

  let prev = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  for (let j = 1; j <= n; j++) {
    prev[j] = j;
    back[j] = OP_INS; // row 0: only insertions reach these cells
  }
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const rowBase = i * width;
    back[rowBase] = OP_DEL; // column 0: only deletions reach these cells
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

  const ops: AlignedWordPair[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const op = back[i * width + j]!;
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
  // Timestamp error stats over matched-only pairs (substitutions excluded —
  // they may be different words and timestamps aren't meaningful to compare).
  // Errors are absolute differences in seconds, separately for start and end.
  matchedPairs: number;
  meanStartError: number;
  meanEndError: number;
  maxStartError: number;
  maxEndError: number;
  // 95th-percentile absolute errors — robust to a handful of outliers.
  p95StartError: number;
  p95EndError: number;
}

export function compareTranscripts(
  ref: readonly TranscriptWord[],
  hyp: readonly TranscriptWord[],
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
  const endErrs: number[] = [];
  for (const op of ops) {
    if (op.op !== "match") continue;
    const r = ref[op.refIdx]!;
    const h = hyp[op.hypIdx]!;
    startErrs.push(Math.abs(r.start - h.start));
    endErrs.push(Math.abs(r.end - h.end));
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
    meanEndError: mean(endErrs),
    maxStartError: max(startErrs),
    maxEndError: max(endErrs),
    p95StartError: percentile(startErrs, 0.95),
    p95EndError: percentile(endErrs, 0.95),
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
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}
