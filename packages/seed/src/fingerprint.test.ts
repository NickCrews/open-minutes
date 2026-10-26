import { describe, expect, test } from "vite-plus/test";
import { datasetNames } from "@open-minutes/datasets/spec";
import { dataset } from "./index";

describe("fingerprints", () => {
  test("are stable, and differ per dataset", () => {
    const names = datasetNames();
    const prints = names.map((n) => dataset(n).fingerprint);
    for (const p of prints) expect(p).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set(prints).size).toBe(names.length);
    expect(dataset("bodies").fingerprint).toBe(prints[names.indexOf("bodies")]);
  });
});
