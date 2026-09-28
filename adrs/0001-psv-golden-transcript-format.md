# ADR 0001: Store golden transcripts as PSV

Date: 2026-07-19
Status: Accepted

## Context

Golden transcripts are the fixtures we diff a re-transcription against. They are
large (~27k words, ~230 speaker segments per meeting), they get regenerated
whenever the pipeline changes, and a human has to review the result in a PR. The
format therefore has to serve three goals, in priority order:

1. **Git-diffability.** A small semantic change must produce a small, legible
   diff. This is the whole reason the fixtures are checked in as text.
2. **Readability and editability.** A reviewer should be able to read the
   transcript, and hand-correct a misheard word, without tooling.
3. **File size.** These are committed, so repo weight and clone time matter —
   but only as a tiebreaker, never at the cost of (1) or (2).

We use PSV (`packages/fixtures/src/psv.ts`): one event per line,
`start_sec|event_type|event_data`, absolute `H:MM:SS.ss` timestamps, one line per
word, speaker changes as `meta` marker lines.

## Comparison

Measured on a real fixture (`gbos_9HoIM5INxpI/golden.psv`, 26,993 words, 228
segments) by re-encoding it into each candidate format and applying four
representative edits. Diff cost is `git diff --numstat` (added/deleted lines).

| Format         | Bytes    | Gzip   | Delete word | Add word | Fix spelling | Shift 5 words |
| -------------- | -------- | ------ | ----------- | -------- | ------------ | ------------- |
| **psv**        | 585 KB   | 154 KB | +0/−1       | +1/−0    | +1/−1        | +5/−5         |
| json (compact) | 874 KB   | 157 KB | +1/−1       | +1/−1    | +1/−1        | +1/−1         |
| json (pretty)  | 1,797 KB | 182 KB | +0/−4       | +4/−0    | +1/−1        | +5/−5         |
| jsonl          | 872 KB   | 157 KB | +0/−1       | +1/−0    | +1/−1        | +5/−5         |
| csv            | 873 KB   | 171 KB | +0/−1       | +1/−0    | +1/−1        | +5/−5         |
| bin            | 362 KB   | 146 KB | binary      | binary   | binary       | binary        |

Reading the table:

- **Compact JSON's `+1/−1` is the worst result, not the best.** The file is one
  line, so every edit rewrites the whole file. The diff is unreviewable.
- **Pretty JSON** is diffable but pays 4 lines per word (`{`, `text`, `start`,
  `}`), so it is 3× the bytes of PSV and multiplies every structural edit by four.
- **jsonl and csv** match PSV's diff behaviour exactly — the line-per-word shape
  is what produces good diffs, not the delimiter. They cost ~50% more bytes
  (repeated keys, or a speaker column repeated on every row) and read worse:
  `{"text":"Alaska","start":10.17}` and `0:00:10.17,unlabeled,Alaska` are both
  noisier than `0:00:10.17|text|Alaska`. CSV additionally has no place to put a
  speaker-change marker, so it must denormalize the speaker onto every row, and
  needs quoting rules for words containing commas or quotes.
- **Binary** wins on size (38% smaller raw; only 5% smaller gzipped, which is
  what actually hits the repo) and loses everything else. It fails goals 1 and 2
  outright: no diff, no reading, no hand-editing.

PSV wins because it is the smallest format that keeps one word per line, and
because `event_data` is the last field — so it may contain `|` without quoting
rules, which is why it stays smaller and cleaner than CSV.

## Timing shifts

The one weak case, shared by every line-oriented format: shifting N words in time
costs 2N diff lines, and looks identical to N words being rewritten.

Mitigate with a git word-diff driver, which collapses those diffs to the
timestamp field alone:

```gitattributes
# .gitattributes
*.psv diff=psv
```

```ini
# .git/config
[diff "psv"]
	wordRegex = [^|]+
```

Then review with `git diff --word-diff`. Local only — GitHub's PR view ignores
diff drivers.

**Delta timestamps** (each word's offset from the previous) were considered as a
structural fix: they make a contiguous shift a 2-line diff. Rejected because they
make add/delete cost 2 lines instead of 1, destroy readability (you cannot seek
audio without summing the file), and let a bad merge resolution silently shift
every subsequent absolute time.

If the real-world noise turns out to be recognizer jitter (many words moving
±0.01–0.05s) rather than genuine shifts, the higher-leverage fix is coarser
timestamp quantization in golden files — tenths rather than hundredths — not a
format change.

## Decision

Keep PSV. Add the `wordRegex` diff driver for reviewing timing-heavy diffs.
Revisit only if fixture size becomes a real problem, in which case gzip-on-commit
beats changing the format — the binary encoding buys only 5% once compressed.
