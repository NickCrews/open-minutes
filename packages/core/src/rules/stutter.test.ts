import { describe, expect, it } from "vitest";
import * as stutter from "./stutter";
import { fixWith, words } from "./testing";

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

  it("reports each word it would drop", () => {
    expect(
      stutter.rule({
        segments: [{ speaker: null, words: words("I I think") }],
      }),
    ).toEqual([
      {
        code: "stutter",
        message: 'stutter "I" should not be in a transcript',
        segmentIndex: 0,
        wordIndex: 0,
        atSecs: 0.0,
        text: "I",
      },
    ]);
  });
});
