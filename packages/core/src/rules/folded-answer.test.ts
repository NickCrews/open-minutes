import { describe, expect, it } from "vitest";
import * as foldedAnswer from "./folded-answer";
import { seg, words } from "./testing";

describe("folded-answer", () => {
  it("reports an answer left in the asker's segment", () => {
    const segments = [
      seg("clerk", [1, "Member"], [1.3, "Johnson."], [2, "Yes."]),
    ];
    expect(foldedAnswer.rule({ segments })).toEqual([
      expect.objectContaining({
        code: "folded-answer",
        segmentIndex: 0,
        answer: "Yes.",
      }),
    ]);
  });

  it("moves an answer to a roll call or motion into a segment of its own", () => {
    const segments = [
      seg(
        "clerk",
        [1, "Member"],
        [1.3, "Johnson."],
        [2, "Yes."],
        [3, "Member"],
        [3.3, "Rivera."],
      ),
      seg("chair", [4, "Anyone"], [4.3, "else?"], [5, "No."]),
      seg(
        "chair",
        [6, "Second."],
        [7, "Moved"],
        [7.3, "by"],
        [7.6, "Ms."],
        [8, "Brawley."],
      ),
    ];
    const { meeting, fixed } = foldedAnswer.fix(
      { segments },
      foldedAnswer.rule({ segments }),
    );
    expect(fixed.map((v) => v.answer)).toEqual(["Yes.", "Second."]);
    expect(meeting.segments).toEqual([
      seg("clerk", [1, "Member"], [1.3, "Johnson."]),
      seg(null, [2, "Yes."]),
      seg("clerk", [3, "Member"], [3.3, "Rivera."]),
      segments[1],
      seg(null, [6, "Second."]),
      seg("chair", [7, "Moved"], [7.3, "by"], [7.6, "Ms."], [8, "Brawley."]),
    ]);
  });
});

const found = (sentence: string) =>
  foldedAnswer
    .foldedAnswers(words(sentence))
    .map((f) => `${f.asked} | ${f.answer}`);

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
