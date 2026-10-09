import { describe, expect, it } from "vitest";
import { parseMeetingRef } from "./sites";
import { workDirName } from "./work-dir";

describe("parseMeetingRef", () => {
  it("reads akleg.gov meeting IDs and URLs", () => {
    const meeting = { siteKind: "akleg", siteId: "SL&C 2017-03-07 13:30:00" };
    expect(parseMeetingRef("SL&C 2017-03-07 13:30:00")).toEqual(meeting);
    expect(
      parseMeetingRef(
        "https://www.akleg.gov/basis/Meeting/Detail?Meeting=SL%26C%202017-03-07%2013:30:00",
      ),
    ).toEqual(meeting);
  });

  it("takes anything else for a YouTube video", () => {
    const meeting = { siteKind: "youtube", siteId: "hTKVG_L61ec" };
    expect(parseMeetingRef("hTKVG_L61ec")).toEqual(meeting);
    expect(
      parseMeetingRef("https://www.youtube.com/watch?v=hTKVG_L61ec"),
    ).toEqual(meeting);
    expect(parseMeetingRef("https://youtu.be/hTKVG_L61ec")).toEqual(meeting);
  });
});

describe("workDirName", () => {
  it("keeps YouTube IDs as they are", () => {
    expect(workDirName({ siteKind: "youtube", siteId: "i_f44L7QpLs" })).toBe(
      "youtube_i_f44L7QpLs",
    );
  });

  it("makes akleg.gov IDs safe for a path", () => {
    expect(
      workDirName({ siteKind: "akleg", siteId: "SL&C 2017-03-07 13:30:00" }),
    ).toBe("akleg_SL-C-2017-03-07-13-30-00");
  });
});
