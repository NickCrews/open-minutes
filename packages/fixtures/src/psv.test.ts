import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  parseTimestamp,
  parsePsv,
  serializePsv,
  serializeVadRunsPsv,
  type GoldenSegment,
} from "./psv";
import type { SpeechSegment } from "@open-minutes/core/transcription";

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
      "start_sec|event_type|event_data",
      '0:00:00.00|meta|{"begin_speaker": "segmented:spk-2"}',
      "0:00:00.08|text|Uh",
      "",
      "0:00:00.64|text|certainly",
      '2:45:21.28|meta|{"begin_speaker": "segmented:spk-4"}',
      "2:45:21.28|text|What",
      '2:45:25.60|meta|{"begin_speaker": "unlabeled"}',
      "2:45:25.60|text|Nice!",
    ].join("\n");
    expect(parsePsv(content)).toEqual<GoldenSegment[]>([
      {
        speaker: { kind: "segmented", cluster: 2 },
        words: [
          { text: "Uh", start: 0.08 },
          { text: "certainly", start: 0.64 },
        ],
      },
      {
        speaker: { kind: "segmented", cluster: 4 },
        words: [{ text: "What", start: 9921.28 }],
      },
      {
        speaker: { kind: "unlabeled" },
        words: [{ text: "Nice!", start: 9925.6 }],
      },
    ]);
  });

  it("parses identified-person labels", () => {
    const content = [
      '0:00:00.00|meta|{"begin_speaker": "identified:margaret-tyler"}',
      "0:00:00.08|text|Hello",
    ].join("\n");
    expect(parsePsv(content)).toEqual<GoldenSegment[]>([
      {
        speaker: { kind: "identified", person: "margaret-tyler" },
        words: [{ text: "Hello", start: 0.08 }],
      },
    ]);
  });

  it("rejects a malformed segmented label", () => {
    expect(() =>
      parsePsv('0:00:00.00|meta|{"begin_speaker": "segmented:bob"}'),
    ).toThrow(/segmented/);
  });

  it("rejects a non-kebab identified slug", () => {
    expect(() =>
      parsePsv(
        '0:00:00.00|meta|{"begin_speaker": "identified:Margaret Smith"}',
      ),
    ).toThrow(/identified/);
  });

  it("preserves '|' inside a word", () => {
    const content = [
      '0:00:00.00|meta|{"begin_speaker": "unlabeled"}',
      "0:00:01.00|text|a|b",
    ].join("\n");
    expect(parsePsv(content)[0]!.words).toEqual([{ text: "a|b", start: 1 }]);
  });

  it("rejects text before any begin_speaker", () => {
    expect(() => parsePsv("0:00:01.00|text|orphan")).toThrow(/begin_speaker/);
  });

  it("emits vad span markers interleaved with each run's words", () => {
    const runs: SpeechSegment[] = [
      {
        start: 0.08,
        end: 1.0,
        words: [{ text: "Hello", start: 0.08 }],
      },
      {
        start: 1.1,
        end: 301.1,
        words: [{ text: "there", start: 1.1 }],
      },
    ];
    const content = serializeVadRunsPsv(runs);
    const lines = content.trim().split("\n");
    expect(lines).toEqual([
      "start_sec|event_type|event_data",
      '0:00:00.08|meta|{"begin_speaker":"unlabeled"}',
      '0:00:00.08|vad|{"index":0,"dur":0.92}',
      "0:00:00.08|text|Hello",
      '0:00:01.10|vad|{"index":1,"dur":300}',
      "0:00:01.10|text|there",
    ]);
  });

  it("skips vad markers when parsing, recovering the flat word list", () => {
    const runs: SpeechSegment[] = [
      {
        start: 0.08,
        end: 1.0,
        words: [{ text: "Hello", start: 0.08 }],
      },
      {
        start: 1.1,
        end: 1.5,
        words: [{ text: "there", start: 1.1 }],
      },
    ];
    expect(parsePsv(serializeVadRunsPsv(runs))).toEqual<GoldenSegment[]>([
      {
        speaker: { kind: "unlabeled" },
        words: [
          { text: "Hello", start: 0.08 },
          { text: "there", start: 1.1 },
        ],
      },
    ]);
  });

  it("round-trips segments through serialize/parse", () => {
    const segments: GoldenSegment[] = [
      {
        speaker: { kind: "unlabeled" },
        words: [
          { text: "Uh", start: 0.08 },
          { text: "$10", start: 0.64 },
        ],
      },
      {
        speaker: { kind: "segmented", cluster: 2 },
        words: [{ text: "Thanks!", start: 1.28 }],
      },
      {
        speaker: { kind: "identified", person: "margaret-tyler" },
        words: [{ text: "Hi", start: 2.0 }],
      },
    ];
    expect(parsePsv(serializePsv(segments))).toEqual(segments);
  });
});
