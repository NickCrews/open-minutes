import { describe, expect, it } from "vite-plus/test";
import { meetingBodyIds } from "./map";

describe("meetingBodyIds", () => {
  const ids = new Map([
    ["gbos", 1],
    ["luc", 2],
  ]);

  it("resolves the bodies to database ids", () => {
    expect(
      meetingBodyIds({ slug: "m", body_slugs: ["gbos", "luc"] }, ids),
    ).toEqual([1, 2]);
  });

  it("refuses a body bodies.jsonl doesn't have", () => {
    expect(() =>
      meetingBodyIds({ slug: "m", body_slugs: ["gbos", "nope"] }, ids),
    ).toThrow(/unknown body "nope"/);
  });
});
