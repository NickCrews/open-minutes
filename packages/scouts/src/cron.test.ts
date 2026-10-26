import { describe, expect, it } from "vite-plus/test";
import { firedInPastHour, parseCron } from "./cron";

const at = (iso: string) => new Date(iso);

describe("firedInPastHour", () => {
  it("is true from the minute a cron fires until an hour later", () => {
    const cron = "0 17 * * *";
    expect(firedInPastHour(cron, at("2026-10-26T16:59:59Z"))).toBe(false);
    expect(firedInPastHour(cron, at("2026-10-26T17:00:00Z"))).toBe(true);
    expect(firedInPastHour(cron, at("2026-10-26T17:59:59Z"))).toBe(true);
    expect(firedInPastHour(cron, at("2026-10-26T18:00:00Z"))).toBe(false);
  });

  it("reads ranges, lists and steps", () => {
    // 2026-10-26 is a Monday; 2026-10-25 a Sunday.
    expect(firedInPastHour("0 17 * * 1-5", at("2026-10-26T17:30:00Z"))).toBe(
      true,
    );
    expect(firedInPastHour("0 17 * * 1-5", at("2026-10-25T17:30:00Z"))).toBe(
      false,
    );
    expect(firedInPastHour("0 */6 * * *", at("2026-10-26T12:10:00Z"))).toBe(
      true,
    );
    expect(firedInPastHour("0 */6 * * *", at("2026-10-26T13:10:00Z"))).toBe(
      false,
    );
    expect(firedInPastHour("30 1,7 * * *", at("2026-10-26T07:45:00Z"))).toBe(
      true,
    );
    expect(firedInPastHour("0 0 * * 7", at("2026-10-25T00:00:00Z"))).toBe(true);
  });

  it("matches either day field when both are restricted", () => {
    // The 1st of the month, or a Monday.
    expect(firedInPastHour("0 9 1 * 1", at("2026-10-26T09:00:00Z"))).toBe(true);
    expect(firedInPastHour("0 9 1 * 1", at("2026-10-01T09:00:00Z"))).toBe(true);
    expect(firedInPastHour("0 9 1 * 1", at("2026-10-27T09:00:00Z"))).toBe(
      false,
    );
  });
});

describe("parseCron", () => {
  it.each([
    "* * * *",
    "60 * * * *",
    "* 24 * * *",
    "5-1 * * * *",
    "*/0 * * * *",
    "a * * * *",
  ])("rejects %j", (expr) => {
    expect(() => parseCron(expr)).toThrow();
  });
});
