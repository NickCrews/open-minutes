import {
  alignWords,
  type TranscriptWord,
} from "@open-minutes/core/transcription";

// Combining several decodes of the same audio into one transcript. Each decode
// of a stretch, framed a little differently, gets a different ~5% of words
// wrong (see parakeet.characterization.test.ts in @open-minutes/ingest), so
// where they disagree the majority is more often right than any one of them.

/** A stretch where the decodes heard different words. */
export interface Disagreement {
  /** Onset of the first word any decode heard in the stretch. */
  start: number;
  /** Onset of the last word any decode heard in the stretch. */
  end: number;
  /** What the vote chose ("" if it chose no words). */
  chosen: string;
  /** Every distinct reading, most votes first; "" is a decode that heard nothing. */
  readings: string[];
}

export interface Vote {
  words: TranscriptWord[];
  disagreements: Disagreement[];
}

const norm = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const key = (words: readonly TranscriptWord[]) =>
  words.map((w) => norm(w.text)).join(" ");
const text = (words: readonly TranscriptWord[]) =>
  words.map((w) => w.text).join(" ");

/**
 * The words most decodes agree on (ROVER, with the medoid as the pivot). Every
 * decode is aligned to the pivot, the decode closest to all the others; then
 * each of the pivot's words, and each gap between them, is a column, and in
 * each column the reading most decodes have wins, the pivot's on a tie. A
 * column a decode has nothing in reads as "" and can win, dropping the word.
 */
export function voteWords(hyps: readonly (readonly TranscriptWord[])[]): Vote {
  if (hyps.length === 0) return { words: [], disagreements: [] };
  if (hyps.length === 1) return { words: [...hyps[0]!], disagreements: [] };

  const pivotIdx = medoid(hyps);
  const pivot = hyps[pivotIdx]!;
  // columns[2i] is the gap before pivot word i, columns[2i+1] is pivot word i;
  // each holds one reading per decode.
  const columns: TranscriptWord[][][] = Array.from(
    { length: 2 * pivot.length + 1 },
    () => [],
  );
  hyps.forEach((hyp, h) => {
    const cells: TranscriptWord[][] = columns.map(() => []);
    if (h === pivotIdx) pivot.forEach((w, i) => cells[2 * i + 1]!.push(w));
    else {
      let lastRef = -1;
      for (const op of alignWords(pivot, hyp)) {
        if (op.op === "ins") cells[2 * (lastRef + 1)]!.push(hyp[op.hypIdx]!);
        else {
          lastRef = op.refIdx;
          if (op.op !== "del") cells[2 * op.refIdx + 1]!.push(hyp[op.hypIdx]!);
        }
      }
    }
    cells.forEach((c, i) => columns[i]!.push(c));
  });

  const words: TranscriptWord[] = [];
  const disagreements: Disagreement[] = [];
  let open: { cols: number[] } | null = null;
  const close = () => {
    if (!open) return;
    const cols = open.cols;
    const perHyp = hyps.map((_, h) => cols.flatMap((c) => columns[c]![h]!));
    const chosen = cols.flatMap((c) => winner(columns[c]!, pivotIdx));
    const onsets = perHyp.flat().map((w) => w.start);
    disagreements.push({
      start: Math.min(...onsets),
      end: Math.max(...onsets),
      chosen: text(chosen),
      readings: ranked(perHyp).map(text),
    });
    open = null;
  };
  columns.forEach((col, c) => {
    if (col.every((cell) => cell.length === 0)) return;
    words.push(...winner(col, pivotIdx));
    const unanimous = col.every((cell) => key(cell) === key(col[0]!));
    if (unanimous) close();
    else (open ??= { cols: [] }).cols.push(c);
  });
  close();
  return { words, disagreements };
}

/** The reading most cells have, `prefer`'s on a tie. */
function winner(cells: readonly TranscriptWord[][], prefer: number) {
  const votes = new Map<string, number>();
  for (const cell of cells)
    votes.set(key(cell), (votes.get(key(cell)) ?? 0) + 1);
  const preferred = key(cells[prefer]!);
  let best = preferred;
  for (const [k, n] of votes) if (n > votes.get(best)!) best = k;
  return cells.find((cell) => key(cell) === best)!;
}

/** Distinct readings, most common first. */
function ranked(readings: readonly TranscriptWord[][]) {
  const groups = new Map<string, { words: TranscriptWord[]; n: number }>();
  for (const r of readings) {
    const g = groups.get(key(r));
    if (g) g.n++;
    else groups.set(key(r), { words: r, n: 1 });
  }
  return [...groups.values()].sort((a, b) => b.n - a.n).map((g) => g.words);
}

/** Index of the decode with the fewest edits to all the others. */
function medoid(hyps: readonly (readonly TranscriptWord[])[]): number {
  const edits = hyps.map(() => 0);
  for (let i = 0; i < hyps.length; i++)
    for (let j = i + 1; j < hyps.length; j++) {
      const d = alignWords(hyps[i]!, hyps[j]!).filter(
        (op) => op.op !== "match",
      ).length;
      edits[i]! += d;
      edits[j]! += d;
    }
  return edits.indexOf(Math.min(...edits));
}
