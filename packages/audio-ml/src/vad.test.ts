import { beforeAll, describe, expect, it } from "vite-plus/test";
import { halfUntranscribedRollCall } from "@open-minutes/datasets/clips";
import { clip, gaps, type Span, totalSecs } from "@open-minutes/core/span";
import { detectSpeech } from "./vad";
import { readWav, type WaveForm } from "@open-minutes/codecs";

// Silero VAD on a checked-in minute of a real meeting: what it hears, not
// just that it spans.

describe("detectSpeech on the GBOS roll call", () => {
  let wave: WaveForm;
  let spans: Span[];

  // Downloading the VAD model on a cold cache takes longer than a test's
  // default timeout.
  beforeAll(async () => {
    wave = await readWav(halfUntranscribedRollCall().wavPath);
    spans = await detectSpeech(wave);
  }, 10 * 60_000);

  it("finds voice activity spans in order, inside the clip", () => {
    expect(spans.length).toBeGreaterThan(10);
    for (const [i, span] of spans.entries()) {
      expect(span.end).toBeGreaterThan(span.start);
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeLessThanOrEqual(60);
      if (i > 0) expect(span.start).toBeGreaterThan(spans[i - 1]!.end);
    }
    // A council meeting is mostly talk.
    expect(totalSecs(spans) / 60).toBeGreaterThan(0.6);
  });

  it("hears the roll call the transcript is missing", () => {
    expect(totalSecs(clip(spans, 12, 21))).toBeGreaterThan(4);
  });

  it("shows the pause between a name and its answer", () => {
    // "Brianna Sullivan?" at 0:17.3–0:18.4, "Present." from 0:19.3.
    expect(gaps(spans, 17, 20, 0.3)).toContainEqual(
      expect.objectContaining({
        start: expect.closeTo(18.6, 0) as number,
        end: expect.closeTo(19.5, 0) as number,
      }),
    );
  });

  it("hears the quiet while the chair reads silently", () => {
    // Nobody talks from 0:53.4 to 0:55.4.
    expect(clip(spans, 53.6, 55.2)).toEqual([]);
  });
});

describe("detectSpeech with a mask", () => {
  let wave: WaveForm;
  let all: Span[];

  beforeAll(async () => {
    wave = await readWav(halfUntranscribedRollCall().wavPath);
    all = await detectSpeech(wave);
  }, 10 * 60_000);

  /** The span of `spans` that contains `t`. */
  const at = (spans: Span[], t: number) =>
    spans.find((s) => s.start <= t && t < s.end);

  it("is complete inside the mask, read from clock strings", async () => {
    const masked = await detectSpeech(wave, {
      span: { start: "0:15", end: "0:21" },
    });
    // Each span the whole-file pass finds there, the masked pass covers.
    for (const span of clip(all, 15, 21)) {
      const mid = (span.start + span.end) / 2;
      expect(at(masked, mid)).toBeDefined();
    }
    expect(totalSecs(clip(masked, 15, 21))).toBeCloseTo(
      totalSecs(clip(all, 15, 21)),
      0,
    );
  });

  it("returns a span that crosses the mask's edge whole", async () => {
    // Someone talks from 0:28.7 to 0:32.9; the mask is half a second of it.
    const whole = at(all, 30.5)!;
    expect(whole.end - whole.start).toBeGreaterThan(3);
    const masked = await detectSpeech(wave, { span: { start: 30.5, end: 31 } });
    expect(masked).toHaveLength(1);
    expect(masked[0]!.start).toBeCloseTo(whole.start, 1);
    expect(masked[0]!.end).toBeCloseTo(whole.end, 1);
  });

  it("returns a span that starts before a pass's padding whole", async () => {
    // Talk from 0:00.2 to 0:06.4, so the first pass, from 0:03, starts in it.
    const whole = at(all, 5)!;
    const masked = await detectSpeech(wave, { span: { start: 5, end: 6 } });
    expect(masked).toHaveLength(1);
    expect(masked[0]!.start).toBeCloseTo(whole.start, 1);
    expect(masked[0]!.end).toBeCloseTo(whole.end, 1);
  });

  it("covers every span of a mask", async () => {
    const masked = await detectSpeech(wave, {
      span: [
        { start: 40, end: 42 },
        { start: 5, end: 6 },
      ],
    });
    expect(at(masked, 5)).toBeDefined();
    expect(at(masked, 41)).toBeDefined();
    for (const [i, span] of masked.entries()) {
      if (i > 0) expect(span.start).toBeGreaterThan(masked[i - 1]!.end);
    }
  });

  it("finds nothing in an empty mask", async () => {
    expect(await detectSpeech(wave, { span: [] })).toEqual([]);
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      detectSpeech(wave, { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
