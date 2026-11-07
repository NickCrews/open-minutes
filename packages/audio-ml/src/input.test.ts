import { describe, expect, it } from "vite-plus/test";
import { parseMask, parseTime, prepareInput } from "./input";

const second = (secs: number, sampleRate = 16000) => ({
  samples: new Float32Array(secs * sampleRate),
  sampleRate,
});

describe("parseTime", () => {
  it("takes seconds or a clock string", () => {
    expect(parseTime(42.5)).toBe(42.5);
    expect(parseTime("42.5")).toBe(42.5);
    expect(parseTime("2:03")).toBe(123);
    expect(parseTime("1:02:03.40")).toBeCloseTo(3723.4);
  });

  it("rejects what isn't a time", () => {
    expect(() => parseTime("noon")).toThrow(RangeError);
    expect(() => parseTime(Number.NaN)).toThrow(RangeError);
    expect(() => parseTime(Infinity)).toThrow(RangeError);
  });
});

describe("parseMask", () => {
  it("is the whole file when omitted", () => {
    expect(parseMask(undefined, 60)).toEqual([{ start: 0, end: 60 }]);
  });

  it("reads a missing or null end as that end of the file", () => {
    expect(parseMask({}, 60)).toEqual([{ start: 0, end: 60 }]);
    expect(parseMask({ start: null, end: "0:10" }, 60)).toEqual([
      { start: 0, end: 10 },
    ]);
    expect(parseMask({ start: "0:50", end: null }, 60)).toEqual([
      { start: 50, end: 60 },
    ]);
  });

  it("sorts the spans and joins those that overlap or touch", () => {
    expect(
      parseMask(
        [
          { start: 30, end: 40 },
          { start: 5, end: 10 },
          { start: 8, end: 12 },
          { start: 40, end: 45 },
          { start: 50, end: 55 },
        ],
        60,
      ),
    ).toEqual([
      { start: 5, end: 12 },
      { start: 30, end: 45 },
      { start: 50, end: 55 },
    ]);
  });

  it("clamps the spans to the file and drops those outside it", () => {
    expect(
      parseMask(
        [
          { start: -5, end: 3 },
          { start: 55, end: 90 },
          { start: 70, end: 80 },
        ],
        60,
      ),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 55, end: 60 },
    ]);
  });

  it("drops empty spans, and an empty list is an empty mask", () => {
    expect(parseMask({ start: 5, end: 5 }, 60)).toEqual([]);
    expect(parseMask([], 60)).toEqual([]);
  });

  it("rejects a span that ends before it starts", () => {
    expect(() => parseMask({ start: 10, end: 5 }, 60)).toThrow(RangeError);
  });
});

describe("prepareInput", () => {
  it("returns the wave, its duration and the mask", async () => {
    const wave = second(2);
    expect(await prepareInput(wave, { span: { start: "0:01" } })).toEqual({
      wave,
      duration: 2,
      mask: [{ start: 1, end: 2 }],
    });
  });

  it("rejects audio that isn't 16 kHz", async () => {
    await expect(prepareInput(second(1, 44100))).rejects.toThrow(
      "Expected 16000 Hz mono audio, got 44100 Hz.",
    );
  });

  it("throws the signal's reason if it is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      prepareInput(second(1), { signal: controller.signal }),
    ).rejects.toThrow("stop");
  });
});
