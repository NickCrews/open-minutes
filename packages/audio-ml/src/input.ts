import {
  type AudioInput,
  ensureWaveForm,
  type WaveForm,
} from "@open-minutes/codecs";
import { parseClock } from "@open-minutes/core/clock";
import { mergeSpans, type Span } from "@open-minutes/core/span";

// The input every audio function takes, and the one wrapper that reads it.

export type { AudioInput, WaveForm };

/** The sample rate every model here expects, in Hz, of mono audio. */
export const EXPECTED_SAMPLE_RATE = 16000;

/** Seconds from the start of the file, or a clock string such as "1:02:03.40". */
export type Time = number | string;

/** A span to compute results in. A missing or null end is that end of the file. */
export interface SpanInput {
  start?: Time | null;
  end?: Time | null;
}

/** Options every audio function takes. */
export interface BaseOptions {
  /**
   * Where results are needed: one span, or a list of them, which is a mask.
   * Omitted, the whole file.
   */
  span?: SpanInput | SpanInput[];
  signal?: AbortSignal;
}

/** An audio function's input, read and checked. */
export interface PreparedInput {
  wave: WaveForm;
  /** Length of the audio, in seconds. */
  duration: number;
  /** Where results are needed: sorted, disjoint, non-empty spans inside the file. */
  mask: Span[];
}

/**
 * Reads `audio`, checks it is 16 kHz, and turns `span` into a mask clamped
 * to the file. Throws the signal's reason if it is aborted.
 */
export async function prepareInput(
  audio: AudioInput,
  { span, signal }: BaseOptions = {},
): Promise<PreparedInput> {
  signal?.throwIfAborted();
  const wave = await ensureWaveForm(audio);
  signal?.throwIfAborted();
  assertSampleRate(wave.sampleRate);
  const duration = wave.samples.length / wave.sampleRate;
  return { wave, duration, mask: parseMask(span, duration) };
}

/**
 * `span` as sorted, disjoint spans clamped to [0, duration]. Overlapping and
 * touching spans are joined, and spans empty after clamping are dropped.
 * Omitted, the whole file.
 */
export function parseMask(
  span: SpanInput | SpanInput[] | undefined,
  duration: number,
): Span[] {
  if (span === undefined)
    return duration > 0 ? [{ start: 0, end: duration }] : [];
  const spans = (Array.isArray(span) ? span : [span]).map((s) => {
    const start = s.start == null ? 0 : parseTime(s.start);
    const end = s.end == null ? duration : parseTime(s.end);
    if (end < start) {
      throw new RangeError(
        `Span ends (${end} s) before it starts (${start} s).`,
      );
    }
    return { start: Math.max(0, start), end: Math.min(duration, end) };
  });
  return mergeSpans(
    spans.filter((s) => s.end > s.start),
    0,
  );
}

/** `time` in seconds. Throws on a malformed clock string or a non-finite number. */
export function parseTime(time: Time): number {
  const secs = typeof time === "number" ? time : parseClock(time);
  if (secs === null || !Number.isFinite(secs)) {
    throw new RangeError(`Not a time: ${JSON.stringify(time)}.`);
  }
  return secs;
}

export function assertSampleRate(
  actual: number,
  expected = EXPECTED_SAMPLE_RATE,
): void {
  if (actual !== expected) {
    throw new Error(
      `Expected ${expected} Hz mono audio, got ${actual} Hz. ` +
        `Resample first (e.g. ffmpeg -ar 16000 -ac 1).`,
    );
  }
}
