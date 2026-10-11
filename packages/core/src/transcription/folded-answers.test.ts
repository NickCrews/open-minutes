import { describe, expect, it } from "vitest";
import { foldedAnswers } from "./folded-answers";
import type { TranscriptWord } from "./types";

/** Words from a sentence, a third of a second apart. */
function words(sentence: string): TranscriptWord[] {
  return sentence.split(" ").map((text, i) => ({ text, start: i / 3 }));
}

const found = (sentence: string) =>
  foldedAnswers(words(sentence)).map((f) => `${f.asked} | ${f.answer}`);

describe("foldedAnswers", () => {
  it("finds answers to a roll call, a question or a vote put to a member", () => {
    expect(found("Member Johnson. Yes. Member Rivera. Yes.")).toEqual([
      "Member Johnson. | Yes.",
      "Member Rivera. | Yes.",
    ]);
    expect(found("Can I speak, Jen? Yes. Please.")).toEqual([
      "Can I speak, Jen? | Yes.",
    ]);
    expect(
      found("On a vote of 11 to 0 and the youth member votes. Yes. Yes."),
    ).toEqual(["On a vote of 11 to 0 and the youth member votes. | Yes."]);
  });

  it("finds a second after a motion or before the chair restates it", () => {
    expect(found("I move Brawley amendment one. Second.")).toEqual([
      "I move Brawley amendment one. | Second.",
    ]);
    expect(
      found("Second. Move by Ms. Brawley, second by Mr. Volland, Ms. Brawley."),
    ).toEqual([
      "Move by Ms. Brawley, second by Mr. Volland, Ms. Brawley. | Second.",
    ]);
  });

  it("leaves a speaker's own words alone", () => {
    for (const s of [
      "Thank you. Yes. The amendment has passed.",
      "So let me just punch the button, right? Yep.",
      "Okay. Second. I think so.",
      "Sorry. Yeah. I was just going to say.",
      "Yes. I agree.",
    ])
      expect(found(s), s).toEqual([]);
  });
});
