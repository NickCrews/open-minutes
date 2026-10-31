import { describe, expect, it } from "vite-plus/test";
import * as fillerWord from "./filler-word";
import { isFillerWord } from "./filler-word";
import { fixWith, words } from "./testing";

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
    expect(fixWith(fillerWord, "Uh, um.")).toBe("");
  });

  it("keeps kept words' onsets and extra properties", () => {
    const input = [
      { text: "Um,", start: 1, tag: "a" },
      { text: "yes", start: 2, tag: "b" },
    ];
    const meeting = { segments: [{ speaker: null, words: input }] };
    const { meeting: fixed } = fillerWord.fix(
      meeting,
      fillerWord.rule(meeting),
    );
    expect(fixed.segments[0]!.words).toEqual([
      { text: "Yes", start: 2, tag: "b" },
    ]);
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
