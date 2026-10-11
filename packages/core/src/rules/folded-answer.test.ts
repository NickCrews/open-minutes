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
});
