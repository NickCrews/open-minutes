import { describe, expect, it } from "vite-plus/test";
import * as repeatedWord from "./repeated-word";
import { foundTexts, seg } from "./testing";

const found = (sentence: string) => foundTexts(repeatedWord.rule, sentence);

describe("repeated-word", () => {
  it("finds a word said twice in a row", () => {
    expect(found("maybe elaborate elaborate a little")).toEqual([
      "elaborate elaborate",
    ]);
    expect(found("what What impacts")).toEqual(["what What"]);
    expect(found("That's that's helpful")).toEqual(["That's that's"]);
  });

  it("reports a run of copies once", () => {
    expect(found("in how how how easily")).toEqual(["how how how"]);
  });

  it("finds a repeat across segments", () => {
    expect(
      repeatedWord.rule({
        segments: [
          seg("a", [1, "about"], [1.3, "the"]),
          seg("b", [2, "the"], [2.3, "budget."]),
        ],
      }),
    ).toEqual([
      {
        code: "repeated-word",
        message:
          '"the the": a word said twice in a row is usually a stutter; drop the extra copy unless it was meant',
        segmentIndex: 0,
        wordIndex: 1,
        atSecs: 1.3,
        text: "the the",
      },
    ]);
  });

  it("leaves what the stutter rule finds to it", () => {
    expect(found("I I think the the budget")).toEqual([]);
  });

  it("keeps repeats that can be grammatical or deliberate", () => {
    for (const s of [
      "I think that that is",
      "what it is is fine",
      "logged in in time",
      "my great great grandfather",
      "in twenty twenty six",
      "for many many years",
      "yes yes chair",
      "very, very good",
      "no, no, no",
      "about it. It is",
      "spelled G I N N E T T E",
    ])
      expect(found(s), s).toEqual([]);
  });
});
