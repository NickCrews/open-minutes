import { describe, expect, it } from "vite-plus/test";
import * as emptySegment from "./empty-segment";
import { seg } from "./testing";

describe("empty-segment", () => {
  it("reports each segment with no words", () => {
    expect(
      emptySegment.rule({
        segments: [seg("a"), seg("b", [1, "Hi."]), seg("c")],
      }),
    ).toEqual([
      {
        code: "empty-segment",
        message: "a segment with no words",
        segmentIndex: 0,
      },
      {
        code: "empty-segment",
        message: "a segment with no words",
        segmentIndex: 2,
      },
    ]);
  });

  it("drops them, keeping the rest as they are", () => {
    const hi = { ...seg("b", [1, "Hi."]), id: 7 };
    const meeting = { segments: [seg("a"), hi] };
    const { meeting: fixed, fixed: violations } = emptySegment.fix(
      meeting,
      emptySegment.rule(meeting),
    );
    expect(fixed.segments).toEqual([hi]);
    expect(fixed.segments[0]).toBe(hi);
    expect(violations).toHaveLength(1);
  });

  it("returns the meeting given when there is nothing to fix", () => {
    const meeting = { segments: [seg("a", [1, "Hi."])] };
    expect(emptySegment.fix(meeting, [])).toEqual({ meeting, fixed: [] });
    expect(emptySegment.fix(meeting, []).meeting).toBe(meeting);
  });
});
