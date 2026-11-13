import { describe, expect, test } from "vite-plus/test";
import type { Transcript } from "./types";
import { diffSequences, diffTranscripts } from "./words";

/** A transcript from "label: word word | label: word", one second a word. */
function transcript(text: string): Transcript {
  let t = 0;
  return {
    segments: text.split(" | ").map((seg) => {
      const [label, words] = seg.split(": ");
      return {
        speaker: { label: label!, name: null },
        words: words!.split(" ").map((w) => ({ text: w, start: t++ })),
      };
    }),
  };
}

/** A transcript's words with their onsets given, as "label: word@onset ...". */
function timed(text: string): Transcript {
  return {
    segments: text.split(" | ").map((seg) => {
      const [label, words] = seg.split(": ");
      return {
        speaker: { label: label!, name: null },
        words: words!.split(" ").map((w) => {
          const [word, at] = w.split("@");
          return { text: word!, start: Number(at) };
        }),
      };
    }),
  };
}

describe("diffSequences", () => {
  test("finds a shortest edit script", () => {
    const a = [..."ABCABBA"];
    const b = [..."CBABAC"];
    const ops = diffSequences(a, b);
    expect(ops.filter((o) => o.kind !== "equal")).toHaveLength(5);
    // Applying it to a gives b.
    const out: string[] = [];
    for (const op of ops) if (op.kind !== "del") out.push(b[op.b]!);
    expect(out).toEqual(b);
    expect(
      ops.filter((o) => o.kind !== "ins").map((o) => "a" in o && a[o.a]),
    ).toEqual(a);
  });

  test("handles empty and equal sequences", () => {
    expect(diffSequences([], [1])).toEqual([{ kind: "ins", b: 0 }]);
    expect(diffSequences([1], [])).toEqual([{ kind: "del", a: 0 }]);
    expect(diffSequences([1, 2], [1, 2])).toEqual([
      { kind: "equal", a: 0, b: 0 },
      { kind: "equal", a: 1, b: 1 },
    ]);
  });
});

describe("diffTranscripts", () => {
  test("marks replaced words, with context and gaps", () => {
    const before = timed(
      "spk-1: we@0 met@1 in@2 good@3 wood@4 on@5 the@6 tenth.@7",
    );
    const after = timed(
      "spk-1: we@0 met@1 in@2 Girdwood@3 on@5 the@6 tenth.@7",
    );
    const { changes, hunks } = diffTranscripts(before, after, { context: 1 });
    expect(changes).toEqual([
      { kind: "words", start: 3, old: "good wood", new: "Girdwood" },
    ]);
    expect(hunks).toHaveLength(1);
    const [hunk] = hunks;
    expect(hunk!.before[0]!.items).toEqual([
      { gap: 2 },
      { text: "in", start: 2, mark: null },
      { text: "good", start: 3, mark: "del" },
      { text: "wood", start: 4, mark: "del" },
      { text: "on", start: 5, mark: null },
      { gap: 2 },
    ]);
    expect(hunk!.after[0]!.items).toEqual([
      { gap: 2 },
      { text: "in", start: 2, mark: null },
      { text: "Girdwood", start: 3, mark: "ins" },
      { text: "on", start: 5, mark: null },
      { gap: 2 },
    ]);
  });

  test("shows a split as a new segment with another speaker", () => {
    const before = transcript("spk-1: Hello all. Thank you chair.");
    const after = transcript(
      "spk-1: Hello all. | identified:kyle: Thank you chair.",
    );
    const { changes, hunks } = diffTranscripts(before, after);
    expect(changes).toEqual([
      { kind: "speaker", start: 2, old: "spk-1", new: "identified:kyle" },
    ]);
    expect(hunks[0]!.before.map((s) => [s.speaker.label, s.changed])).toEqual([
      ["spk-1", false],
    ]);
    expect(hunks[0]!.after.map((s) => [s.speaker.label, s.changed])).toEqual([
      ["spk-1", false],
      ["identified:kyle", true],
    ]);
    expect(hunks[0]!.after[1]!.items.every((i) => "gap" in i || !i.mark)).toBe(
      true,
    );
  });

  test("shows a relabelled segment without marking its words", () => {
    const before = transcript("a: one two | b: three four five six | a: seven");
    const after = transcript("a: one two | c: three four five six | a: seven");
    const { changes, hunks } = diffTranscripts(before, after, { context: 1 });
    expect(changes).toEqual([
      { kind: "speaker", start: 2, old: "b", new: "c" },
    ]);
    expect(hunks[0]!.after[1]).toMatchObject({
      speaker: { label: "c" },
      changed: true,
      items: [
        { text: "three", mark: null },
        { text: "four", mark: null },
        { gap: 2 },
      ],
    });
  });

  test("reports a word moved into the segment before it", () => {
    const before = transcript("a: twenty | b: six. Thank you");
    const after = transcript("a: twenty six. | b: Thank you");
    expect(diffTranscripts(before, after).changes).toEqual([
      { kind: "speaker", start: 1, old: "b", new: "a" },
      { kind: "boundary", start: 2, split: true },
    ]);
  });

  test("keeps far-apart changes in separate hunks", () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const before = transcript(`a: ${words}`);
    const after = transcript(
      `a: ${words.replace("w2 ", "x2 ").replace("w30 ", "x30 ")}`,
    );
    const { changes, hunks } = diffTranscripts(before, after, { context: 3 });
    expect(changes.map((c) => c.kind === "words" && c.new)).toEqual([
      "x2",
      "x30",
    ]);
    expect(hunks).toHaveLength(2);
  });

  test("finds nothing in an unchanged transcript", () => {
    const t = transcript("a: one two | b: three");
    expect(diffTranscripts(t, t)).toEqual({ changes: [], hunks: [] });
  });
});
