import { describe, expect, it } from "vite-plus/test";
import { cleanGroups, cleanSpeechRuns, cleanWords } from "./clean";
import { text, words } from "./testing";

function clean(sentence: string, step?: number): string {
  return text(cleanWords(words(sentence, step)));
}

describe("cleanWords", () => {
  it("lets a dashed fragment be a false start", () => {
    expect(clean("six– sixteen items")).toBe("sixteen items");
  });

  it("runs every rule's fix until they settle", () => {
    expect(clean("Um, the, uh, the the six- sixteen items.")).toBe(
      "The sixteen items.",
    );
  });

  it("is idempotent", () => {
    const once = cleanWords(words("Um, the the, uh, re- report. Uh."));
    expect(cleanWords(once)).toEqual(once);
  });

  it("leaves clean text alone", () => {
    const clean = words("We approved the budget.");
    expect(cleanWords(clean)).toEqual(clean);
  });
});

describe("cleanGroups", () => {
  it("never reaches across a group boundary", () => {
    const groups = cleanGroups([
      { speaker: "a", words: words("I") },
      { speaker: "b", words: words("I agree") },
    ]);
    expect(groups.map((g) => text(g.words))).toEqual(["I", "I agree"]);
  });

  it("keeps group properties and may leave a group empty", () => {
    expect(
      cleanGroups([
        { speaker: "a", words: words("Um.") },
        { speaker: "b", words: words("uh, yes") },
      ]),
    ).toEqual([
      { speaker: "a", words: [] },
      { speaker: "b", words: [{ text: "yes", start: 0.3 }] },
    ]);
  });
});

describe("cleanSpeechRuns", () => {
  it("cleans each VAD run and keeps it, even emptied", () => {
    expect(
      cleanSpeechRuns([
        { start: 0, end: 1, words: words("Um.") },
        { start: 1, end: 2, words: words("the the vote") },
      ]),
    ).toEqual([
      { start: 0, end: 1, words: [] },
      {
        start: 1,
        end: 2,
        words: words("the vote").map((w) => ({ ...w, start: w.start + 0.3 })),
      },
    ]);
  });
});
