import { describe, expect, it } from "vitest";
import {
  cleanGroups,
  cleanWords,
  dashRule,
  falseStartRule,
  fillerRule,
  findUncleanWords,
  isFillerWord,
  stutterRule,
} from "./clean";
import type { TranscriptWord } from "./types";

/** Words from a sentence, `step` seconds apart. */
function words(sentence: string, step = 0.3): TranscriptWord[] {
  return sentence.split(" ").map((text, i) => ({ text, start: i * step }));
}

function text(ws: readonly TranscriptWord[]): string {
  return ws.map((w) => w.text).join(" ");
}

function clean(sentence: string, step?: number): string {
  return text(cleanWords(words(sentence, step)).words);
}

describe("isFillerWord", () => {
  it("matches hesitations regardless of case and punctuation", () => {
    for (const w of ["um", "Um,", "uh", "Uh.", "umm", "uhh", "uhm", "erm"]) {
      expect(isFillerWord(w), w).toBe(true);
    }
  });

  it("leaves interjections and real words alone", () => {
    for (const w of ["Oh,", "ah", "hmm", "Mm-hmm", "uh-huh", "uh-oh", "m"]) {
      expect(isFillerWord(w), w).toBe(false);
    }
    for (const w of ["umbrella", "huh", "her", "us", "Uhura", "err"]) {
      expect(isFillerWord(w), w).toBe(false);
    }
  });
});

describe("dash rule", () => {
  const run = (s: string) => text(dashRule.apply(words(s)).words);

  it("turns en and em dashes into plain hyphens", () => {
    expect(run("from 2019–2022 we")).toBe("from 2019-2022 we");
    expect(run("the board— and staff")).toBe("the board- and staff");
    expect(run("AO 2026-23 passed")).toBe("AO 2026-23 passed");
  });

  it("runs before the false-start rule", () => {
    expect(clean("six– sixteen items")).toBe("sixteen items");
  });
});

describe("filler rule", () => {
  const run = (s: string) => text(fillerRule.apply(words(s)).words);

  it("drops fillers mid-sentence", () => {
    expect(run("we have uh three items")).toBe("we have three items");
    expect(run("the, um, budget")).toBe("the, budget");
  });

  it("hands a sentence-initial filler's capital to the next word", () => {
    expect(run("Um, so we begin.")).toBe("So we begin.");
    expect(run("Done. Uh the next item")).toBe("Done. The next item");
    expect(run("Uh, um, okay.")).toBe("Okay.");
  });

  it("does not capitalize after a filler mid-sentence", () => {
    expect(run("and Uh the next")).toBe("and the next");
  });

  it("moves a sentence-ending mark onto the previous word", () => {
    expect(run("about making um. Flaws")).toBe("about making. Flaws");
    expect(run("is that, uh? Yes")).toBe("is that? Yes");
    expect(run("All done. um.")).toBe("All done.");
  });

  it("can empty a run entirely", () => {
    expect(fillerRule.apply(words("Uh, um.")).words).toEqual([]);
  });

  it("keeps kept words' onsets and extra properties", () => {
    const input = [
      { text: "Um,", start: 1, tag: "a" },
      { text: "yes", start: 2, tag: "b" },
    ];
    expect(fillerRule.apply(input).words).toEqual([
      { text: "Yes", start: 2, tag: "b" },
    ]);
    expect(input[1]!.text).toBe("yes"); // not mutated
  });
});

describe("false-start rule", () => {
  const run = (s: string) => text(falseStartRule.apply(words(s)).words);

  it("drops a broken-off fragment", () => {
    expect(run("about six- sixteen units")).toBe("about sixteen units");
    expect(run("Re- reconsider it")).toBe("Reconsider it");
  });

  it("keeps hyphens that are not an abandoned word", () => {
    expect(run("pre- and post-war")).toBe("pre- and post-war");
    expect(run("two- to three-year")).toBe("two- to three-year");
    expect(run("AO twenty twenty six- twenty-three")).toBe(
      "AO twenty twenty six- twenty-three",
    );
    expect(run("we just re- We just")).toBe("we just re- We just");
    expect(run("we were about to-")).toBe("we were about to-");
    expect(run("a well-known plan")).toBe("a well-known plan");
  });
});

describe("stutter rule", () => {
  const run = (s: string, step?: number) =>
    text(stutterRule.apply(words(s, step)).words);

  it("collapses doubled function words", () => {
    expect(run("I I think the the budget")).toBe("I think the budget");
    expect(run("I I I think")).toBe("I think");
    expect(run("And and then")).toBe("And then");
    expect(run("and And then")).toBe("And then");
    expect(run("it's it's fine")).toBe("it's fine");
    expect(run("So so we")).toBe("So we");
    expect(run("the, the budget")).toBe("the budget");
    expect(run("I, I think")).toBe("I think");
  });

  it("keeps the second copy's punctuation", () => {
    expect(run("for the the.")).toBe("for the.");
  });

  it("keeps repetitions that can be grammatical or deliberate", () => {
    expect(run("I think that that is")).toBe("I think that that is");
    expect(run("in twenty twenty six")).toBe("in twenty twenty six");
    expect(run("what it is is fine")).toBe("what it is is fine");
    expect(run("Yes. Yes.")).toBe("Yes. Yes.");
    expect(run("no, no, no")).toBe("no, no, no");
    expect(run("very, very good")).toBe("very, very good");
    expect(run("approved it, it passed")).toBe("approved it, it passed");
    expect(run("about the. The next")).toBe("about the. The next");
  });

  it("keeps a repeat after a long pause", () => {
    expect(run("the the", 2)).toBe("the the");
  });
});

describe("cleanWords", () => {
  it("runs every rule, fillers first", () => {
    expect(clean("Um, the, uh, the the six- sixteen items.")).toBe(
      "The sixteen items.",
    );
  });

  it("reports each change against the original word", () => {
    const { changes } = cleanWords(words("Um, so I I agree"));
    expect(changes).toEqual([
      { rule: "filler", start: 0, before: "Um,", after: null },
      { rule: "filler", start: 0.3, before: "so", after: "So" },
      { rule: "stutter", start: 0.6, before: "I", after: null },
    ]);
  });

  it("is idempotent", () => {
    const once = cleanWords(words("Um, the the, uh, re- report. Uh.")).words;
    expect(findUncleanWords(once)).toEqual([]);
    expect(cleanWords(once).words).toEqual(once);
  });

  it("finds nothing in clean text", () => {
    expect(findUncleanWords(words("We approved the budget."))).toEqual([]);
  });
});

describe("cleanGroups", () => {
  it("never reaches across a group boundary", () => {
    const { groups } = cleanGroups([
      { speaker: "a", words: words("I") },
      { speaker: "b", words: words("I agree") },
    ]);
    expect(groups.map((g) => text(g.words))).toEqual(["I", "I agree"]);
  });

  it("keeps group properties and may leave a group empty", () => {
    const { groups, changes } = cleanGroups([
      { speaker: "a", words: words("Um.") },
      { speaker: "b", words: words("uh, yes") },
    ]);
    expect(groups).toEqual([
      { speaker: "a", words: [] },
      { speaker: "b", words: [{ text: "yes", start: 0.3 }] },
    ]);
    expect(changes).toHaveLength(2);
  });
});
