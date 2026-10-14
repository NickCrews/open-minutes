import { describe, expect, it } from "vitest";
import * as segmentOutOfOrder from "./segment-out-of-order";
import { seg } from "./testing";

describe("segment-out-of-order", () => {
  it("reports a segment that starts before an earlier one's last word", () => {
    expect(
      segmentOutOfOrder.rule({
        segments: [seg("a", [5, "Later."]), seg("b", [1, "First."])],
      }),
    ).toEqual([
      {
        code: "segment-out-of-order",
        message:
          "starts at 0:00:01.00, before the previous segment's last word (0:00:05.00); segments must be in order of their first word",
        segmentIndex: 1,
        wordIndex: 0,
        atSecs: 1,
        previousLastWordSecs: 5,
        interleaves: [],
      },
    ]);
  });

  it("reports where a segment's words mix with an earlier one's", () => {
    expect(
      segmentOutOfOrder.rule({
        segments: [
          seg("a", [1, "One"], [3, "three"], [5, "five."]),
          seg("b", [2, "Two"], [4, "four."]),
        ],
      }),
    ).toEqual([
      {
        code: "segment-out-of-order",
        message:
          "starts at 0:00:02.00, before the previous segment's last word (0:00:05.00), and its words mix with an earlier segment's from 0:00:02.00 to 0:00:04.00; segments must not interleave",
        segmentIndex: 1,
        wordIndex: 0,
        atSecs: 2,
        previousLastWordSecs: 5,
        interleaves: [{ segmentIndex: 0, fromSecs: 2, toSecs: 4 }],
      },
    ]);
  });

  it("counts an earlier segment that starts inside a later one's words", () => {
    const [v] = segmentOutOfOrder.rule({
      segments: [
        seg("a", [1, "Ok."]),
        seg("b", [3, "Three"], [6, "six."]),
        seg("c", [2, "Two"], [4, "four."]),
      ],
    });
    expect(v!.interleaves).toEqual([
      { segmentIndex: 1, fromSecs: 3, toSecs: 4 },
    ]);
  });

  it("skips segments with no words", () => {
    expect(
      segmentOutOfOrder.rule({
        segments: [seg("a", [1, "One."]), seg("b"), seg("c", [2, "Two."])],
      }),
    ).toEqual([]);
  });

  it("puts misordered segments in order of their first word", () => {
    const late = seg("a", [5, "Later."]);
    const empty = seg("b");
    const early = seg("c", [1, "First."]);
    const meeting = { segments: [late, empty, early] };
    const { meeting: fixed, fixed: violations } = segmentOutOfOrder.fix(
      meeting,
      segmentOutOfOrder.rule(meeting),
    );
    // A segment with no words stays where it is.
    expect(fixed.segments).toEqual([early, empty, late]);
    expect(violations.map((v) => v.segmentIndex)).toEqual([2]);
  });

  it("leaves interleaved segments, which sorting doesn't fix", () => {
    const meeting = {
      segments: [seg("a", [1, "One"], [3, "three."]), seg("b", [2, "Two."])],
    };
    expect(
      segmentOutOfOrder.fix(meeting, segmentOutOfOrder.rule(meeting)),
    ).toEqual({ meeting, fixed: [] });
  });
});
