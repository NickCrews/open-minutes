import { describe, expect, it } from "vite-plus/test";
import * as billNumber from "./bill-number";
import { fixWith, foundTexts } from "./testing";

const found = (sentence: string) => foundTexts(billNumber.rule, sentence);

describe("bill-number", () => {
  it("finds bill numbers the recognizer wrote its own way", () => {
    expect(found("AR 2026 48 and AO2026-23 and A02026-27.")).toEqual([
      "AR 2026 48",
      "AO2026-23",
      "A02026-27.",
    ]);
    expect(found("AO 2025-144S and AR 26-36 and AM 145.")).toEqual([
      "AO 2025-144S",
      "AR 26-36",
      "AM 145.",
    ]);
  });

  it("accepts bills written the house way", () => {
    expect(found("AO 2025-144(S) and AO 2025-74(S-2) and AR 2026-7.")).toEqual(
      [],
    );
    expect(
      found("AO 2026 unnumbered, an ordinance amending chapter 21.05."),
    ).toEqual([]);
    expect(found("Assembly memorandum AM 142-2026 has passed.")).toEqual([]);
  });
  it("writes the bill as AO 2026-23", () => {
    const fix = (s: string) => fixWith(billNumber, s);
    expect(fix("AR 2026 48 and AO2026-23 and A02026-27.")).toBe(
      "AR 2026-48 and AO 2026-23 and AO 2026-27.",
    );
    expect(fix("AO 2025-144S and AR 26-36 and AM 142 2026.")).toBe(
      "AO 2025-144(S) and AR 2026-36 and AM 142-2026.",
    );
    expect(fix("AO 2026 was and AM 145.")).toBe("AO 2026 was and AM 145.");
  });
});
