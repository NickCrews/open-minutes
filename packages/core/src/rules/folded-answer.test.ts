import { describe, expect, it } from "vitest";
import * as foldedAnswer from "./folded-answer";
import { seg } from "./testing";

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
