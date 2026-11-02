# Golden transcript file formats

Why golden transcripts are stored as PSV: how candidate formats compare on
diff size, readability and file size. Measured in July 2026.

Golden transcripts are large (~27k words, ~230 segments per meeting), get
regenerated whenever the pipeline changes, and are reviewed by a human in a
PR. A format has to serve three goals, in priority order:

1. **Git-diffability.** A small change to the transcript produces a small,
   legible diff.
2. **Readability and editability.** A reviewer can read the transcript, and
   hand-correct a misheard word, without tooling.
3. **File size.** Repo weight and clone time matter, but only as a tiebreaker.

## Comparison

Measured on `gbos-2026-03-23/golden.psv` (26,993 words, 228 segments),
re-encoded into each format, with four representative edits applied. Diff cost
is `git diff --numstat` (added/deleted lines).

| Format         | Bytes    | Gzip   | Delete word | Add word | Fix spelling | Shift 5 words |
| -------------- | -------- | ------ | ----------- | -------- | ------------ | ------------- |
| **psv**        | 585 KB   | 154 KB | +0/−1       | +1/−0    | +1/−1        | +5/−5         |
| json (compact) | 874 KB   | 157 KB | +1/−1       | +1/−1    | +1/−1        | +1/−1         |
| json (pretty)  | 1,797 KB | 182 KB | +0/−4       | +4/−0    | +1/−1        | +5/−5         |
| jsonl          | 872 KB   | 157 KB | +0/−1       | +1/−0    | +1/−1        | +5/−5         |
| csv            | 873 KB   | 171 KB | +0/−1       | +1/−0    | +1/−1        | +5/−5         |
| bin            | 362 KB   | 146 KB | binary      | binary   | binary       | binary        |

- **Compact JSON's `+1/−1` is the worst result.** The file is one line, so
  every edit rewrites the whole file and the diff is unreviewable.
- **Pretty JSON** is diffable but spends 4 lines per word (`{`, `text`,
  `start`, `}`): 3× the bytes of PSV, and every structural edit costs four
  times as many lines.
- **jsonl and csv** diff exactly like PSV, since the line-per-word shape is
  what produces good diffs, not the delimiter. They cost ~50% more bytes
  (repeated keys, or a speaker column on every row) and read worse:
  `{"text":"Alaska","start":10.17}` and `0:00:10.17,unlabeled,Alaska` are
  both noisier than `0:00:10.17|text|Alaska`. CSV has no place for a
  speaker-change line, so it repeats the speaker on every row, and needs
  quoting for words containing commas or quotes.
- **Binary** is 38% smaller raw but only 5% smaller gzipped, which is what
  the repo stores. It can't be diffed, read or hand-edited.

PSV is the smallest format that keeps one word per line. Because
`event_data` is the last field it may contain `|` without quoting, which
keeps it smaller and cleaner than CSV. If fixture size ever matters,
compressing on commit saves more than switching to the binary encoding.

## Timing shifts

Every line-oriented format shares one weak case: shifting N words in time
costs 2N diff lines, and looks the same as rewriting N words.

**Delta timestamps** (each word's offset from the previous word) would make a
contiguous shift a 2-line diff. They make adding or deleting a word cost 2
lines instead of 1, make the file unreadable (finding a word's place in the
audio means summing the file), and let a bad merge silently shift every later
time.

If timing noise in practice is recognizer jitter (many words moving
±0.01–0.05 s) rather than real shifts, coarser timestamps in goldens (tenths
rather than hundredths) would remove more of it than a format change.
