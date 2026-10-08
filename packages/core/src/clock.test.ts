import { describe, expect, it } from "vitest";
import { formatClock, parseClock } from "./clock";

describe("clock", () => {
  it("round-trips psvtool's format", () => {
    expect(formatClock(3723.4)).toBe("1:02:03.40");
    expect(parseClock("1:02:03.40")).toBeCloseTo(3723.4);
    expect(parseClock("2:03")).toBe(123);
    expect(parseClock("42.5")).toBe(42.5);
    expect(parseClock("1:2:3:4")).toBeNull();
  });
});
