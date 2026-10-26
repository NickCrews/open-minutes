import { describe, expect, test } from "vite-plus/test";
import {
  allMeetingSlugs,
  datasetHash,
  datasetNames,
  loadDataset,
  parseDataset,
} from "./datasets";

describe("datasets/", () => {
  test.for(datasetNames())("%s.json is a valid dataset", (name) => {
    expect(() => loadDataset(name)).not.toThrow();
  });

  test('resolves "meetings": "all" to every golden meeting', () => {
    expect(loadDataset("all").meetings).toEqual(allMeetingSlugs());
  });

  test("names the datasets when one is unknown", () => {
    expect(() => loadDataset("nope")).toThrow(/No dataset "nope".*bodies/);
  });
});

describe("parseDataset", () => {
  const voiced = {
    description: "d",
    meetings: ["pzc-2026-06-08"],
    people: "speakers",
    voiceprints: "audio",
  };

  test("accepts a dataset with no meetings and nothing else", () => {
    expect(
      parseDataset({ description: "d", meetings: [] }, "x").meetings,
    ).toEqual([]);
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
  ] as const)("refuses %j", ([json, error]) => {
    expect(() => parseDataset(json, "x")).toThrow(error);
  });
});

describe("datasetHash", () => {
  test("is stable, and differs per dataset", () => {
    const names = datasetNames();
    const hashes = names.map((n) => datasetHash(loadDataset(n)));
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(hashes).size).toBe(names.length);
    expect(datasetHash(loadDataset("bodies"))).toBe(
      hashes[names.indexOf("bodies")],
    );
  });

  test("ignores the description", () => {
    const bodies = loadDataset("bodies");
    expect(datasetHash({ ...bodies, description: "other" })).toBe(
      datasetHash(bodies),
    );
  });
});
