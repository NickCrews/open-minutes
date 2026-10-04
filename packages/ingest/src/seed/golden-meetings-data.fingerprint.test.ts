import { describe, expect, test } from "vitest";
import { goldenMeetingsData } from "./golden-meetings-data";

describe("goldenMeetingsData fingerprint", () => {
  test("differs per meeting set, and is stable", () => {
    const a = goldenMeetingsData(["gbos_9HoIM5INxpI"]).fingerprint;
    expect(goldenMeetingsData(["gbos_9HoIM5INxpI"]).fingerprint).toBe(a);
    expect(goldenMeetingsData(["gbos_hTKVG_L61ec"]).fingerprint).not.toBe(a);
  });
});
