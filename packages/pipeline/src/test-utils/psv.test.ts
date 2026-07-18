import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  parseTimestamp,
  parsePsv,
  serializePsv,
  serializeVadRunsPsv,
} from "./psv";
import type { SpeechSegment, TranscriptSegment } from "../types";

describe("psv timestamps", () => {
  it("formats seconds as H:MM:SS.ss", () => {
    expect(formatTimestamp(0.08)).toBe("0:00:00.08");
    expect(formatTimestamp(2)).toBe("0:00:02.00");
    expect(formatTimestamp(2.56)).toBe("0:00:02.56");
    expect(formatTimestamp(2 * 3600 + 45 * 60 + 21.28)).toBe("2:45:21.28");
  });

  it("round-trips through parse/format", () => {
    for (const sec of [0, 0.08, 2.56, 65.4, 9921.28]) {
      expect(parseTimestamp(formatTimestamp(sec))).toBeCloseTo(sec, 2);
    }
  });
});

describe("psv parse/serialize", () => {
  it("groups text events under the preceding begin_speaker into segments", () => {
    const content = [
      "# a comment",
      "start_sec|end_sec|event_type|event_data",
      '0:00:00.00||meta|{"begin_speaker": "identified:alice-jones"}',
      "0:00:00.08|0:00:00.64|text|Uh",
      "",
      "0:00:00.64|0:00:01.04|text|certainly",
      '2:45:21.28||meta|{"begin_speaker": "segmented:spk-4"}',
      "2:45:21.28|2:45:22.24|text|What",
      '2:45:25.60||meta|{"begin_speaker": "unlabeled"}',
      "2:45:25.60|2:45:25.68|text|Nice!",
    ].join("\n");
    expect(parsePsv(content)).toEqual<TranscriptSegment[]>([
      {
        speaker: { type: "identified", personId: "alice-jones" },
        words: [
          { text: "Uh", start: 0.08, end: 0.64 },
          { text: "certainly", start: 0.64, end: 1.04 },
        ],
      },
      {
        speaker: { type: "segmented", speakerNumber: 4 },
        words: [{ text: "What", start: 9921.28, end: 9922.24 }],
      },
      {
        speaker: { type: "unlabeled" },
        words: [{ text: "Nice!", start: 9925.6, end: 9925.68 }],
      },
    ]);
  });

  it("preserves '|' inside a word", () => {
    const content = [
      '0:00:00.00||meta|{"begin_speaker": "unlabeled"}',
      "0:00:01.00|0:00:02.00|text|a|b",
    ].join("\n");
    expect(parsePsv(content)[0]!.words).toEqual([
      { text: "a|b", start: 1, end: 2 },
    ]);
  });

  it("rejects text before any begin_speaker", () => {
    expect(() => parsePsv("0:00:01.00|0:00:02.00|text|orphan")).toThrow(
      /begin_speaker/,
    );
  });

  it("emits vad span markers interleaved with each run's words", () => {
    const runs: SpeechSegment[] = [
      {
        start: 0.08,
        end: 1.0,
        words: [{ text: "Hello", start: 0.08, end: 1.0 }],
      },
      {
        start: 1.1,
        end: 301.1,
        words: [{ text: "there", start: 1.1, end: 1.5 }],
      },
    ];
    const content = serializeVadRunsPsv(runs);
    const lines = content.trim().split("\n");
    expect(lines).toEqual([
      "start_sec|end_sec|event_type|event_data",
      '0:00:00.08||meta|{"begin_speaker":"unlabeled"}',
      '0:00:00.08|0:00:01.00|vad|{"index":0,"dur":0.92}',
      "0:00:00.08|0:00:01.00|text|Hello",
      '0:00:01.10|0:05:01.10|vad|{"index":1,"dur":300}',
      "0:00:01.10|0:00:01.50|text|there",
    ]);
  });

  it("skips vad markers when parsing, recovering the flat word list", () => {
    const runs: SpeechSegment[] = [
      {
        start: 0.08,
        end: 1.0,
        words: [{ text: "Hello", start: 0.08, end: 1.0 }],
      },
      {
        start: 1.1,
        end: 1.5,
        words: [{ text: "there", start: 1.1, end: 1.5 }],
      },
    ];
    expect(parsePsv(serializeVadRunsPsv(runs))).toEqual<TranscriptSegment[]>([
      {
        speaker: { type: "unlabeled" },
        words: [
          { text: "Hello", start: 0.08, end: 1.0 },
          { text: "there", start: 1.1, end: 1.5 },
        ],
      },
    ]);
  });

  it("round-trips segments through serialize/parse", () => {
    const segments: TranscriptSegment[] = [
      {
        speaker: { type: "unlabeled" },
        words: [
          { text: "Uh", start: 0.08, end: 0.64 },
          { text: "$10", start: 0.64, end: 1.28 },
        ],
      },
      {
        speaker: { type: "segmented", speakerNumber: 2 },
        words: [{ text: "Thanks!", start: 1.28, end: 1.6 }],
      },
    ];
    expect(parsePsv(serializePsv(segments))).toEqual(segments);
  });
});
