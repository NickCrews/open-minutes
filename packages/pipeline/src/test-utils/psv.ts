// Pipe-separated golden transcript format ("PSV"). A git-diffable, line-oriented
// way to store golden transcripts: one event per line, so a re-transcription
// produces a clean word-level diff instead of a single mangled JSON blob.
//
// Grammar (see test-fixtures/*/golden.psv for a worked example):
//   - Lines starting with `#` are comments; blank lines are ignored.
//   - The column header `start_sec|end_sec|event_type|event_data` is optional.
//   - Each remaining line is `start_sec|end_sec|event_type|event_data`.
//       * event_type "text": a transcribed word. start/end are timestamps and
//         event_data is the raw word text.
//       * event_type "meta": a marker with an empty end. event_data is JSON,
//         e.g. {"begin_speaker": "identified:alice-jones"}.
//   - Timestamps are `H:MM:SS.ss` (hours:minutes:seconds.hundredths).
//   - event_data is the final field, so it may itself contain `|`.

import type { TranscriptWord } from "../types.ts";

export type PsvEvent =
  | { type: "text"; start: number; end: number; text: string }
  | { type: "meta"; start: number; data: Record<string, unknown> };

const COLUMN_HEADER = "start_sec|end_sec|event_type|event_data";

const FILE_HEADER = [
  "# Pipe-separated golden transcript. Lines starting with '#' are comments.",
  "# Columns: " + COLUMN_HEADER,
  "# event_type 'text' = a transcribed word (event_data is the word text).",
  "# event_type 'meta' = a marker (event_data is JSON), e.g. {\"begin_speaker\": \"...\"}.",
];

/** Format seconds as `H:MM:SS.ss` (rounded to the nearest hundredth). */
export function formatTimestamp(sec: number): string {
  const totalCs = Math.round(sec * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

/** Parse a `H:MM:SS.ss` timestamp into seconds. */
export function parseTimestamp(str: string): number {
  const parts = str.split(":");
  if (parts.length !== 3) {
    throw new Error(`Invalid timestamp (expected H:MM:SS.ss): ${JSON.stringify(str)}`);
  }
  const [h, m, s] = parts;
  const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
  if (!Number.isFinite(seconds)) {
    throw new Error(`Invalid timestamp (non-numeric): ${JSON.stringify(str)}`);
  }
  // The format stores centisecond precision; round away float-summation noise
  // (e.g. 60 + 14.96 -> 74.96000000000001) so round-trips compare exactly.
  return Math.round(seconds * 100) / 100;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function parsePsv(content: string): PsvEvent[] {
  const events: PsvEvent[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    // Split into at most 4 fields; event_data keeps any embedded `|`.
    const sep1 = line.indexOf("|");
    const sep2 = line.indexOf("|", sep1 + 1);
    const sep3 = line.indexOf("|", sep2 + 1);
    if (sep1 < 0 || sep2 < 0 || sep3 < 0) {
      throw new Error(`Malformed PSV line ${i + 1} (expected 4 fields): ${JSON.stringify(raw)}`);
    }
    const startField = line.slice(0, sep1);
    const endField = line.slice(sep1 + 1, sep2);
    const eventType = line.slice(sep2 + 1, sep3);
    const eventData = line.slice(sep3 + 1);

    if (startField === "start_sec") continue; // optional column header

    if (eventType === "text") {
      events.push({
        type: "text",
        start: parseTimestamp(startField),
        end: parseTimestamp(endField),
        text: eventData,
      });
    } else if (eventType === "meta") {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(eventData) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Invalid meta JSON on PSV line ${i + 1}: ${JSON.stringify(eventData)}`, { cause: err });
      }
      events.push({ type: "meta", start: parseTimestamp(startField), data });
    } else {
      throw new Error(`Unknown event_type on PSV line ${i + 1}: ${JSON.stringify(eventType)}`);
    }
  }
  return events;
}

export function serializePsv(events: readonly PsvEvent[]): string {
  const rows = events.map((e) =>
    e.type === "text"
      ? `${formatTimestamp(e.start)}|${formatTimestamp(e.end)}|text|${e.text}`
      : `${formatTimestamp(e.start)}||meta|${JSON.stringify(e.data)}`,
  );
  return [...FILE_HEADER, COLUMN_HEADER, ...rows].join("\n") + "\n";
}

/** Extract the transcribed words (text events) from a parsed PSV. */
export function psvWords(events: readonly PsvEvent[]): TranscriptWord[] {
  return events
    .filter((e): e is Extract<PsvEvent, { type: "text" }> => e.type === "text")
    .map((e) => ({ text: e.text, start: e.start, end: e.end }));
}

/** Build text events from a flat word list (no speaker meta). */
export function wordsToPsvEvents(words: readonly TranscriptWord[]): PsvEvent[] {
  return words.map((w) => ({ type: "text", start: w.start, end: w.end, text: w.text }));
}
