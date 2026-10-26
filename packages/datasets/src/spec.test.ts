import { describe, expect, test } from "vite-plus/test";
import { allMeetingSlugs, datasetNames, loadSpec, parseSpec } from "./spec";

describe("specs/", () => {
  test.for(datasetNames())("%s.json is a valid spec", (name) => {
    expect(() => loadSpec(name)).not.toThrow();
  });

  test('resolves "meetings": "all" to every golden meeting', () => {
    expect(loadSpec("all").meetings).toEqual(allMeetingSlugs());
  });

  test("names the datasets when one is unknown", () => {
    expect(() => loadSpec("nope")).toThrow(/No dataset "nope".*bodies/);
  });
});

describe("parseSpec", () => {
  const voiced = {
    description: "d",
    meetings: ["pzc-2026-06-08"],
    people: "speakers",
    voiceprints: "audio",
  };

  test("accepts a spec with no meetings and nothing else", () => {
    expect(parseSpec({ description: "d", meetings: [] }, "x").meetings).toEqual(
      [],
    );
  });

  test.for([
    [{ ...voiced, extra: 1 }, /unknown key "extra"/],
    [{ ...voiced, description: "" }, /description/],
    [{ ...voiced, meetings: ["nope-2026-01-01"] }, /no golden meeting/],
    [
      { ...voiced, meetings: ["pzc-2026-06-08", "pzc-2026-06-08"] },
      /duplicate/,
    ],
    [{ ...voiced, people: "some" }, /people must be/],
    [{ ...voiced, voiceprints: undefined }, /voiceprints must be/],
    [{ description: "d", meetings: [], people: "all" }, /need meetings/],
  ] as const)("refuses %j", ([spec, error]) => {
    expect(() => parseSpec(spec, "x")).toThrow(error);
  });
});
