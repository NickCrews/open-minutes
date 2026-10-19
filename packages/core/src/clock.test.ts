import { describe, expect, it } from "vitest";
import { formatClock, parseClock } from "./clock";

describe("clock", () => {
  it("formats seconds as H:MM:SS.ss", () => {
    expect(formatClock(0.08)).toBe("0:00:00.08");
    expect(formatClock(2)).toBe("0:00:02.00");
    expect(formatClock(2.56)).toBe("0:00:02.56");
    expect(formatClock(2 * 3600 + 45 * 60 + 21.28)).toBe("2:45:21.28");
  });

  it("round-trips psvtool's format", () => {
    expect(formatClock(3723.4)).toBe("1:02:03.40");
    expect(parseClock("1:02:03.40")).toBeCloseTo(3723.4);
    expect(parseClock("2:03")).toBe(123);
    expect(parseClock("42.5")).toBe(42.5);
    expect(parseClock("1:2:3:4")).toBeNull();
  });
});
