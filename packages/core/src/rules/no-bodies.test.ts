import { describe, expect, it } from "vitest";
import * as noBodies from "./no-bodies";

describe("no-bodies", () => {
  it("reports a meeting held by no body", () => {
    expect(noBodies.rule({ bodyCount: 0, segments: [] })).toEqual([
      { code: "no-bodies", message: "the meeting has no bodies" },
    ]);
  });

  it("says nothing when there is a body, or the count is unknown", () => {
    expect(noBodies.rule({ bodyCount: 2, segments: [] })).toEqual([]);
    expect(noBodies.rule({ segments: [] })).toEqual([]);
  });
});
