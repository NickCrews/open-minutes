// The difference between two transcripts of a meeting, word by word: which
// words were deleted and inserted, and where a segment now starts, ends or
// changes speaker, gathered into hunks with a little of the transcript around
// each change.

import type { Change, Hunk, SegmentView, Transcript, WordView } from "./types";

/** One step of a diff of sequences `a` and `b`. */
export type Op =
  | { kind: "equal"; a: number; b: number }
  | { kind: "del"; a: number }
  | { kind: "ins"; b: number };

/**
 * A shortest edit script turning `a` into `b`, by Myers' O(ND) algorithm,
 * after setting aside what they start and end with in common.
 */
export function diffSequences<T>(a: readonly T[], b: readonly T[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  const eq = (x: number, y: number) => a[pre + x] === b[pre + y];

  // trace[d][k + d] is the furthest x reached on diagonal k with d edits.
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= n + m; d++) {
    const v = new Int32Array(2 * d + 1);
    const prev = trace[d - 1];
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (!prev) x = 0;
      else if (
        k === -d ||
        (k !== d && prev[k - 1 + d - 1]! < prev[k + 1 + d - 1]!)
      )
        x = prev[k + 1 + d - 1]!;
      else x = prev[k - 1 + d - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && eq(x, y)) {
        x++;
        y++;
      }
      v[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(v);
        break outer;
      }
    }
    trace.push(v);
  }

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!;
    const k = x - y;
    const down =
      k === -d || (k !== d && prev[k - 1 + d - 1]! < prev[k + 1 + d - 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "equal", a: pre + x, b: pre + y });
    }
    if (down) ops.push({ kind: "ins", b: pre + prevY });
    else ops.push({ kind: "del", a: pre + prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: "equal", a: pre + x, b: pre + y });
  }
  ops.reverse();
  const head: Op[] = [];
  for (let i = 0; i < pre; i++) head.push({ kind: "equal", a: i, b: i });
  const tail: Op[] = [];
  for (let i = 0; i < suf; i++)
    tail.push({ kind: "equal", a: a.length - suf + i, b: b.length - suf + i });
  return [...head, ...ops, ...tail];
}

interface Token {
  seg: number;
  /** Its index in its segment. */
  pos: number;
  text: string;
  start: number;
}

function tokens(t: Transcript): Token[] {
  return t.segments.flatMap((s, seg) =>
    s.words.map((w, pos) => ({ seg, pos, text: w.text, start: w.start })),
  );
}

/** A word, matched by its text and its onset to the hundredth. */
const key = (t: Token) => `${t.text} ${Math.round(t.start * 100)}`;

interface Row {
  a?: number;
  b?: number;
  /** Deleted, inserted, or a segment starts here on only one side or with another speaker. */
  changed: boolean;
}

/** A word whose speaker changed: its onset, text, and old and new labels. */
export type Relabel = [start: number, text: string, old: string, new: string];

/**
 * What changed between two transcripts of a meeting: each change, and hunks
 * showing the segments around them, with up to `context` words on either
 * side of each change.
 */
export function diffTranscripts(
  before: Transcript,
  after: Transcript,
  { context = 8 }: { context?: number } = {},
): { changes: Change[]; hunks: Hunk[]; relabelled: Relabel[] } {
  const ta = tokens(before);
  const tb = tokens(after);
  const label = (t: Transcript, tok: Token) =>
    t.segments[tok.seg]!.speaker.label;
  const ops = diffSequences(ta.map(key), tb.map(key));

  const rows: Row[] = [];
  const changes: Change[] = [];
  const relabelled: Relabel[] = [];
  let run: { old: string[]; new: string[]; start: number } | null = null;
  const endRun = () => {
    if (run)
      changes.push({
        kind: "words",
        start: run.start,
        old: run.old.join(" "),
        new: run.new.join(" "),
      });
    run = null;
  };
  for (const op of ops) {
    if (op.kind === "equal") {
      endRun();
      const a = ta[op.a]!;
      const b = tb[op.b]!;
      const startsA = a.pos === 0;
      const startsB = b.pos === 0;
      const la = label(before, a);
      const lb = label(after, b);
      if (la !== lb) relabelled.push([a.start, a.text, la, lb]);
      const changed =
        (startsA || startsB) && (startsA !== startsB || la !== lb);
      if (changed) {
        if (la !== lb)
          changes.push({ kind: "speaker", start: b.start, old: la, new: lb });
        else changes.push({ kind: "boundary", start: b.start, split: startsB });
      }
      rows.push({ a: op.a, b: op.b, changed });
    } else {
      const tok = op.kind === "del" ? ta[op.a]! : tb[op.b]!;
      run ??= { old: [], new: [], start: tok.start };
      if (op.kind === "del") {
        run.old.push(tok.text);
        rows.push({ a: op.a, changed: true });
      } else {
        run.new.push(tok.text);
        rows.push({ b: op.b, changed: true });
      }
    }
  }
  endRun();

  // Ranges of rows to show: each change with `context` rows either side,
  // merged where they touch.
  const ranges: [number, number][] = [];
  rows.forEach((row, r) => {
    if (!row.changed) return;
    const lo = Math.max(0, r - context);
    const hi = Math.min(rows.length - 1, r + context);
    const last = ranges.at(-1);
    if (last && lo <= last[1] + 1) last[1] = hi;
    else ranges.push([lo, hi]);
  });

  // Which segments start differently on each side.
  const changedA = new Set<number>();
  const changedB = new Set<number>();
  for (const row of rows) {
    if (!row.changed || row.a === undefined || row.b === undefined) continue;
    if (ta[row.a]!.pos === 0) changedA.add(ta[row.a]!.seg);
    if (tb[row.b]!.pos === 0) changedB.add(tb[row.b]!.seg);
  }

  const side = (
    t: Transcript,
    toks: Token[],
    shown: { i: number; mark: WordView["mark"] }[],
    changedSegs: Set<number>,
  ): SegmentView[] => {
    const views: SegmentView[] = [];
    for (const { i, mark } of shown) {
      const tok = toks[i]!;
      let view = views.at(-1);
      if (!view || view.index !== tok.seg) {
        const seg = t.segments[tok.seg]!;
        view = {
          index: tok.seg,
          speaker: seg.speaker,
          start: seg.words[0]!.start,
          changed: changedSegs.has(tok.seg),
          items: tok.pos ? [{ gap: tok.pos }] : [],
        };
        views.push(view);
      }
      view.items.push({ text: tok.text, start: tok.start, mark });
    }
    for (const view of views) {
      const shownWords = view.items.filter((it) => !("gap" in it)).length;
      const first = view.items[0];
      const lead = first && "gap" in first ? first.gap : 0;
      const rest = t.segments[view.index]!.words.length - lead - shownWords;
      if (rest > 0) view.items.push({ gap: rest });
    }
    return views;
  };

  const hunks = ranges.map(([lo, hi]): Hunk => {
    const slice = rows.slice(lo, hi + 1);
    return {
      before: side(
        before,
        ta,
        slice
          .filter((r) => r.a !== undefined)
          .map((r) => ({ i: r.a!, mark: r.b === undefined ? "del" : null })),
        changedA,
      ),
      after: side(
        after,
        tb,
        slice
          .filter((r) => r.b !== undefined)
          .map((r) => ({ i: r.b!, mark: r.a === undefined ? "ins" : null })),
        changedB,
      ),
    };
  });
  return { changes, hunks, relabelled };
}
