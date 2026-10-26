import { describe, expect, it } from "vite-plus/test";
import { text, words } from "./testing";
import {
  droppedWords,
  dropWords,
  type FindDrops,
  trailingPunctuation,
  wordCore,
} from "./words";

/** Drops every word whose letters are "x", whatever its case or punctuation. */
const findXs: FindDrops = (ws) =>
  ws.map((w) => wordCore(w.text).toLowerCase() === "x");

/** A meeting of one segment per sentence. */
const meeting = (...sentences: string[]) => ({
  segments: sentences.map((s) => ({ speaker: null, words: words(s) })),
});

/** `dropWords` with `findXs` over one sentence. */
function drop(sentence: string): string {
  const m = meeting(sentence);
  const violations = droppedWords(m, "x", findXs, (t) => t);
  return text(dropWords(m, violations, findXs).meeting.segments[0]!.words);
}

describe("wordCore and trailingPunctuation", () => {
  it("split a word from the punctuation around it", () => {
    expect(wordCore('"Hello,"')).toBe("Hello");
    expect(trailingPunctuation('"Hello,"')).toBe(',"');
    expect(wordCore("well-known.")).toBe("well-known");
    expect(trailingPunctuation("six-")).toBe("-");
    expect(wordCore("...")).toBe("");
  });
});

describe("droppedWords", () => {
  it("reports each word to drop, in each segment, at its onset", () => {
    expect(
      droppedWords(
        meeting("a x b", "x."),
        "x",
        findXs,
        (t) => `drop ${JSON.stringify(t)}`,
      ),
    ).toEqual([
      {
        code: "x",
        message: 'drop "x" should not be in a transcript',
        segmentIndex: 0,
        wordIndex: 1,
        atSecs: 0.3,
        text: "x",
      },
      {
        code: "x",
        message: 'drop "x." should not be in a transcript',
        segmentIndex: 1,
        wordIndex: 0,
        atSecs: 0,
        text: "x.",
      },
    ]);
  });
});

describe("dropWords", () => {
  it("drops the words, with their commas", () => {
    expect(drop("a, x, b")).toBe("a, b");
  });

  it("hands a sentence-initial word's capital to the next word", () => {
    expect(drop("X, so we")).toBe("So we");
    expect(drop("Done. X the next")).toBe("Done. The next");
    expect(drop("and X the next")).toBe("and the next");
  });

  it("moves a sentence end onto the previous word", () => {
    expect(drop("about it x. Next")).toBe("about it. Next");
    expect(drop("is that, x? Yes")).toBe("is that? Yes");
    expect(drop("All done. x.")).toBe("All done.");
  });

  it("returns the meeting given, and fixes nothing, when given nothing to fix", () => {
    const m = meeting("a b");
    expect(dropWords(m, [], findXs)).toEqual({ meeting: m, fixed: [] });
    expect(dropWords(m, [], findXs).meeting).toBe(m);
  });

  it("keeps untouched segments, and kept words' onsets and properties", () => {
    const m = {
      segments: [
        { speaker: "a", words: words("a b") },
        {
          speaker: "b",
          words: [
            { text: "x", start: 1, tag: 1 },
            { text: "yes", start: 2, tag: 2 },
          ],
        },
      ],
    };
    const fixed = dropWords(
      m,
      droppedWords(m, "x", findXs, (t) => t),
      findXs,
    ).meeting;
    expect(fixed.segments[0]).toBe(m.segments[0]);
    expect(fixed.segments[1]).toEqual({
      speaker: "b",
      words: [{ text: "yes", start: 2, tag: 2 }],
    });
  });
});
