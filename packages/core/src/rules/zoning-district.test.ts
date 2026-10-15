import { describe, expect, it } from "vitest";
import * as zoningDistrict from "./zoning-district";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(zoningDistrict.rule, sentence);

describe("zoning-district", () => {
  it("finds zoning districts not written as R-4 or gR-1", () => {
    expect(found("from R4 to R2M and GC8 or GC-5 but not R19.")).toEqual([
      "R4",
      "R2M",
      "GC8",
      "GC-5",
    ]);
    expect(found("to CER three and GC eight, not item B one.")).toEqual([
      "CER three",
      "GC eight,",
    ]);
  });

  it("accepts districts written the house way", () => {
    expect(
      found("Rezone from R-4 SL to R-4, near B-3 and gR-1 and CE-R-10."),
    ).toEqual([]);
  });
  it("writes the district as R-4 or gR-1", () => {
    expect(
      fixWith(
        zoningDistrict,
        "from R4 to R2M and CER three and GC eight, or GC-5",
      ),
    ).toBe("from R-4 to R-2M and CE-R-3 and gC-8, or gC-5");
  });
});
