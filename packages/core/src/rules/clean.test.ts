import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "../transcription";
import { cleanGroups, cleanSpeechSegments, cleanWords } from "./clean";
import type { RuleMeeting, Violation } from "./common";
import * as falseStart from "./false-start";
import { isFillerWord } from "./filler-word";
import * as fillerWord from "./filler-word";
import * as stutter from "./stutter";
import * as typographicDash from "./typographic-dash";

/** Words from a sentence, `step` seconds apart. */
function words(sentence: string, step = 0.3): TranscriptWord[] {
  return sentence.split(" ").map((text, i) => ({ text, start: i * step }));
}

function text(ws: readonly TranscriptWord[]): string {
  return ws.map((w) => w.text).join(" ");
}

function clean(sentence: string, step?: number): string {
  return text(cleanWords(words(sentence, step)));
}

/** One cleaning rule's fix, on its own, over a sentence. */
function fixWith(
  spec: {
    rule: (meeting: RuleMeeting) => Violation[];
    fix: <M extends RuleMeeting>(
      meeting: M,
      violations: never,
    ) => { meeting: M };
  },
  sentence: string,
  step?: number,
): string {
  const meeting = {
    segments: [{ speaker: null, words: words(sentence, step) }],
  };
  const fixed = spec.fix(meeting, spec.rule(meeting) as never);
  return text(fixed.meeting.segments[0]!.words);
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

describe("typographic-dash in words", () => {
  const run = (s: string) => fixWith(typographicDash, s);

  it("turns en and em dashes into plain hyphens", () => {
    expect(run("from 2019–2022 we")).toBe("from 2019-2022 we");
    expect(run("the board— and staff")).toBe("the board- and staff");
    expect(run("AO 2026-23 passed")).toBe("AO 2026-23 passed");
  });

  it("lets a dashed fragment be a false start", () => {
    expect(clean("six– sixteen items")).toBe("sixteen items");
  });
});

describe("filler-word", () => {
  const run = (s: string) => fixWith(fillerWord, s);

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
    expect(cleanWords(words("Uh, um."))).toEqual([]);
  });

  it("keeps kept words' onsets and extra properties", () => {
    const input = [
      { text: "Um,", start: 1, tag: "a" },
      { text: "yes", start: 2, tag: "b" },
    ];
    expect(cleanWords(input)).toEqual([{ text: "Yes", start: 2, tag: "b" }]);
    expect(input[1]!.text).toBe("yes"); // not mutated
  });

  it("reports each filler at its word", () => {
    expect(
      fillerWord.rule({
        segments: [{ speaker: null, words: words("so um, yes") }],
      }),
    ).toEqual([
      {
        code: "filler-word",
        message: 'filler "um," should not be in a transcript',
        segmentIndex: 0,
        wordIndex: 1,
        atSecs: 0.3,
        text: "um,",
      },
    ]);
  });
});

describe("false-start", () => {
  const run = (s: string) => fixWith(falseStart, s);

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

describe("stutter", () => {
  const run = (s: string, step?: number) => fixWith(stutter, s, step);

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

describe("cleanSpeechSegments", () => {
  it("cleans each VAD run and keeps it, even emptied", () => {
    expect(
      cleanSpeechSegments([
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
