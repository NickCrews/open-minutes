import { describe, expect, test } from "vitest";
import { goldenMeetingsData } from "./golden-meetings-data";

describe("goldenMeetingsData fingerprint", () => {
  test("differs per meeting set, and is stable", () => {
    const a = goldenMeetingsData(["gbos-2026-03-23"]).fingerprint;
    expect(goldenMeetingsData(["gbos-2026-03-23"]).fingerprint).toBe(a);
    expect(goldenMeetingsData(["gbos-2026-06-15"]).fingerprint).not.toBe(a);
  });
});
