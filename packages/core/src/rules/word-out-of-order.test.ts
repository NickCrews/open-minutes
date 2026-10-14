import { describe, expect, it } from "vitest";
import { seg } from "./testing";
import * as wordOutOfOrder from "./word-out-of-order";

describe("word-out-of-order", () => {
  it("reports a word that starts before the word before it", () => {
    expect(
      wordOutOfOrder.rule({
        segments: [seg("a", [1, "one"], [3, "three"], [2, "two."])],
      }),
    ).toEqual([
      {
        code: "word-out-of-order",
        message:
          "word onset 0:00:02.00 is before the previous word's (0:00:03.00); words must be in time order",
        segmentIndex: 0,
        wordIndex: 2,
        atSecs: 2,
        previousStartSecs: 3,
      },
    ]);
  });

  it("allows words at the same onset, and looks within a segment only", () => {
    expect(
      wordOutOfOrder.rule({
        segments: [
          seg("a", [1, "a"], [1, "b"], [5, "c."]),
          seg("b", [2, "d."]),
        ],
      }),
    ).toEqual([]);
  });
});
