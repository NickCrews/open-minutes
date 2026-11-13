import { describe, expect, it } from "vite-plus/test";
import { alignHypotheses } from "./combine";
import type { Word } from "../transcript";

/** Words from "text@start" strings. */
const ws = (...specs: string[]): Word[] =>
  specs.map((s) => {
    const [text, start] = s.split("@");
    return { text: text!, start: Number(start) };
  });

/** Each slot as its words' texts, "-" for none. */
const texts = (slots: (Word | null)[][]) =>
  slots.map((slot) => slot.map((w) => w?.text ?? "-").join(" "));

describe("alignHypotheses", () => {
  it("puts words that agree in one slot, ignoring case and punctuation", () => {
    const slots = alignHypotheses([
      ws("the@0", "fox.@1"),
      ws("The@0", "fox@1"),
    ]);
    expect(texts(slots)).toEqual(["the The", "fox. fox"]);
  });

  it("puts a substitution in the slot of the word it replaces", () => {
    const slots = alignHypotheses([
      ws("brown@0", "fox@1"),
      ws("clown@0", "lox@1"),
      ws("brown@0", "fox@1"),
    ]);
    expect(texts(slots)).toEqual(["brown clown brown", "fox lox fox"]);
  });

  it("lines up words two hypotheses heard and the first skipped", () => {
    const slots = alignHypotheses([
      ws("yes@0", "then@5"),
      ws("yes@0", "one@2", "ninety@3", "then@5"),
      ws("yes@0", "one@2", "ninety@3", "then@5"),
    ]);
    expect(texts(slots)).toEqual([
      "yes yes yes",
      "- one one",
      "- ninety ninety",
      "then then then",
    ]);
  });

  it("pairs a repeated word with the copy heard at the same time", () => {
    const slots = alignHypotheses([ws("yes@0", "yes@1"), ws("yes@1")]);
    expect(texts(slots)).toEqual(["yes -", "yes yes"]);
  });

  it("returns no slots for no words", () => {
    expect(alignHypotheses([[], []])).toEqual([]);
  });
});
