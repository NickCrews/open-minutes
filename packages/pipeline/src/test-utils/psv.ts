// Pipe-separated golden transcript format ("PSV"). A git-diffable, line-oriented
// way to store golden transcripts: one event per line, so a re-transcription
// produces a clean word-level diff instead of a single mangled JSON blob.
//
// A TranscriptSegment is serialized as a `meta` begin_speaker line followed by
// one `text` line per word; parsing inverts that grouping.
//
// Grammar (see test-fixtures/*/golden.psv for a worked example):
//   - Lines starting with `#` are comments; blank lines are ignored.
//   - The column header `start_sec|end_sec|event_type|event_data` is optional.
//   - Each remaining line is `start_sec|end_sec|event_type|event_data`.
//       * event_type "text": a transcribed word. start/end are timestamps and
//         event_data is the raw word text.
//       * event_type "meta": a marker with an empty end. event_data is JSON.
//         {"begin_speaker": "<label>"} opens a new segment for that speaker.
//   - Speaker labels: "unlabeled", "segmented:spk-<n>", "identified:<personId>".
//   - Timestamps are `H:MM:SS.ss` (hours:minutes:seconds.hundredths).
//   - event_data is the final field, so it may itself contain `|`.

import { readFileSync, writeFileSync } from "node:fs";

import type { Speaker, TranscriptSegment } from "../types.ts";

// Internal line-level representation. Not part of the public API.
type PsvEvent =
  | { type: "text"; start: number; end: number; text: string }
  | { type: "meta"; start: number; data: Record<string, unknown> };

const COLUMN_HEADER = "start_sec|end_sec|event_type|event_data";

const FILE_HEADER = [
  "# Pipe-separated golden transcript. Lines starting with '#' are comments.",
  "# Columns: " + COLUMN_HEADER,
  "# 'text' rows are transcribed words; event_data is the word text.",
  "# 'meta' rows open a segment for a speaker; event_data is JSON, e.g.",
  '#   {"begin_speaker": "unlabeled"}              (cannot be segmented)',
  '#   {"begin_speaker": "segmented:spk-3"}        (distinct but unknown speaker)',
  '#   {"begin_speaker": "identified:alice-jones"} (known person in the DB)',
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

function parseSpeaker(label: string): Speaker {
  if (label === "unlabeled") return { type: "unlabeled" };
  if (label.startsWith("segmented:")) {
    const m = label.slice("segmented:".length).match(/^spk-(\d+)$/);
    if (!m) throw new Error(`Invalid segmented speaker label: ${JSON.stringify(label)}`);
    return { type: "segmented", speakerNumber: Number(m[1]) };
  }
  if (label.startsWith("identified:")) {
    const personId = label.slice("identified:".length);
    if (!personId) throw new Error(`Invalid identified speaker label (no id): ${JSON.stringify(label)}`);
    return { type: "identified", personId };
  }
  throw new Error(`Unknown speaker label: ${JSON.stringify(label)}`);
}

function formatSpeaker(speaker: Speaker): string {
  const type = speaker.type;
  switch (type) {
    case "unlabeled":
      return "unlabeled";
    case "segmented":
      return `segmented:spk-${speaker.speakerNumber}`;
    case "identified":
      return `identified:${speaker.personId}`;
    default:
      throw new Error(`Unknown speaker type: ${type satisfies never} `);
  }
}

function parseEvents(content: string): PsvEvent[] {
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

/**
 * Parse a PSV golden transcript into speaker-grouped segments.
 *
 * Pass a content string to parse it directly, or `{ path }` to read and parse
 * the file at that path.
 */
export function parsePsv(source: string | { path: string }): TranscriptSegment[] {
  const content = typeof source === "string" ? source : readFileSync(source.path, "utf8");
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;

  for (const event of parseEvents(content)) {
    if (event.type === "meta") {
      const label = event.data["begin_speaker"];
      if (typeof label !== "string") {
        throw new Error(`Unsupported meta event (expected begin_speaker): ${JSON.stringify(event.data)}`);
      }
      current = { speaker: parseSpeaker(label), words: [] };
      segments.push(current);
    } else {
      if (!current) {
        throw new Error(`text event before any begin_speaker meta (word: ${JSON.stringify(event.text)})`);
      }
      current.words.push({ text: event.text, start: event.start, end: event.end });
    }
  }
  return segments;
}

/**
 * Serialize speaker-grouped segments to the PSV golden transcript format.
 *
 * Always returns the serialized string. If `options.path` is given, the string
 * is also written to that file.
 */
export function serializePsv(
  segments: readonly TranscriptSegment[],
  options?: { path?: string },
): string {
  const rows: string[] = [];
  for (const segment of segments) {
    const start = segment.words[0]?.start ?? 0;
    rows.push(`${formatTimestamp(start)}||meta|${JSON.stringify({ begin_speaker: formatSpeaker(segment.speaker) })}`);
    for (const w of segment.words) {
      rows.push(`${formatTimestamp(w.start)}|${formatTimestamp(w.end)}|text|${w.text}`);
    }
  }
  const content = [...FILE_HEADER, COLUMN_HEADER, ...rows].join("\n") + "\n";
  if (options?.path !== undefined) {
    writeFileSync(options.path, content);
  }
  return content;
}
