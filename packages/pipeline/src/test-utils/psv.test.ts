import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  parseTimestamp,
  parsePsv,
  serializePsv,
  psvWords,
  wordsToPsvEvents,
  type PsvEvent,
} from "./psv";

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
  it("parses text and meta events, ignoring comments and the column header", () => {
    const content = [
      "# a comment",
      "start_sec|end_sec|event_type|event_data",
      '0:00:00.00||meta|{"begin_speaker": "identified:alice-jones"}',
      "0:00:00.08|0:00:00.64|text|Uh",
      "",
      "0:00:00.64|0:00:01.04|text|certainly",
    ].join("\n");
    const events = parsePsv(content);
    expect(events).toEqual<PsvEvent[]>([
      { type: "meta", start: 0, data: { begin_speaker: "identified:alice-jones" } },
      { type: "text", start: 0.08, end: 0.64, text: "Uh" },
      { type: "text", start: 0.64, end: 1.04, text: "certainly" },
    ]);
  });

  it("preserves '|' inside event_data", () => {
    const events = parsePsv("0:00:01.00|0:00:02.00|text|a|b");
    expect(events).toEqual<PsvEvent[]>([{ type: "text", start: 1, end: 2, text: "a|b" }]);
  });

  it("round-trips events through serialize/parse", () => {
    const events: PsvEvent[] = [
      { type: "meta", start: 0, data: { begin_speaker: "unlabeled" } },
      { type: "text", start: 0.08, end: 0.64, text: "Uh" },
      { type: "text", start: 0.64, end: 1.28, text: "$10" },
    ];
    expect(parsePsv(serializePsv(events))).toEqual(events);
  });

  it("extracts words and rebuilds events", () => {
    const words = [
      { text: "hello", start: 0, end: 0.5 },
      { text: "world", start: 0.5, end: 1 },
    ];
    expect(psvWords(parsePsv(serializePsv(wordsToPsvEvents(words))))).toEqual(words);
  });
});
