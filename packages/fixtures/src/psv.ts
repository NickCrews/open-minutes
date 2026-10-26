// Pipe-separated golden transcript format ("PSV"). A git-diffable, line-oriented
// way to store golden transcripts: one event per line, so a re-transcription
// produces a clean word-level diff instead of a single mangled JSON blob.
//
// A Segment is serialized as a `meta` begin_speaker line followed by
// one `text` line per word; parsing inverts that grouping.
//
// Grammar (see test-data/meetings/*/golden.psv for a worked example):
//   - Lines starting with `#` are comments; blank lines are ignored.
//   - The column header `start_sec|event_type|event_data` is optional.
//   - Each remaining line is `start_sec|event_type|event_data`.
//       * event_type "text": a transcribed word. start_sec is the word's onset
//         and event_data is the raw word text. Words carry no end timestamps —
//         see Word in @open-minutes/core.
//       * event_type "meta": a marker. event_data is JSON.
//         {"begin_speaker": "<label>"} opens a new segment for that speaker.
//       * event_type "vad": a debug marker (written only to *.gen.psv) at the
//         start of a VAD speech run — the chunk of audio fed to the recognizer.
//         event_data is JSON ({"index","dur"}, dur being the run's length in
//         seconds). Purely informational: parsePsv skips these, so they never
//         affect parsed output.
//   - Speaker labels name who is speaking, in one of three forms, each parsed
//     into a Segment<string>'s speakerNumber and person:
//       * "unlabeled"          — unattributed: neither.
//       * "segmented:spk-<n>"  — speakerNumber n: a distinct voice the diarizer
//                                separated but that is not tied to a known person.
//                                spk-3 in one meeting has nothing to do with spk-3
//                                in another.
//       * "identified:<slug>"  — person <slug>: a known, recurring person (eg
//                                "margaret-tyler"). The SAME slug is the SAME
//                                person in every golden — that global identity is
//                                what lets cross-meeting speaker recognition be
//                                tested (seed people + voiceprints from some
//                                goldens, then recognize them in another).
//   - Timestamps are `H:MM:SS.ss` (hours:minutes:seconds.hundredths).
//   - event_data is the final field, so it may itself contain `|`.

import { readFileSync, writeFileSync } from "node:fs";

import { formatClock } from "@open-minutes/core/clock";
import type { Segment } from "@open-minutes/core/transcript";
import type { SpeechRun } from "@open-minutes/core/transcription";

// Internal line-level representation. Not part of the public API.
type PsvEvent =
  | { type: "text"; start: number; text: string }
  | { type: "meta"; start: number; data: Record<string, unknown> }
  | { type: "vad"; start: number; data: Record<string, unknown> };

const COLUMN_HEADER = "start_sec|event_type|event_data";

/** Parse a `H:MM:SS.ss` timestamp into seconds. */
export function parseTimestamp(str: string): number {
  const parts = str.split(":");
  if (parts.length !== 3) {
    throw new Error(
      `Invalid timestamp (expected H:MM:SS.ss): ${JSON.stringify(str)}`,
    );
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

/** Who a `begin_speaker` label says is speaking. */
type Speaker = Pick<Segment<string>, "speakerNumber" | "person">;

function parseSpeaker(label: string): Speaker {
  if (label === "unlabeled") return { speakerNumber: null, person: null };
  if (label.startsWith("segmented:")) {
    const m = label.slice("segmented:".length).match(/^spk-(\d+)$/);
    if (!m)
      throw new Error(
        `Invalid segmented speaker label (expected "segmented:spk-<n>"): ${JSON.stringify(label)}`,
      );
    return { speakerNumber: Number(m[1]), person: null };
  }
  if (label.startsWith("identified:")) {
    const person = label.slice("identified:".length);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(person)) {
      throw new Error(
        `Invalid identified speaker slug (expected kebab-case, eg "identified:margaret-tyler"): ${JSON.stringify(label)}`,
      );
    }
    return { speakerNumber: null, person };
  }
  throw new Error(`Unknown speaker label: ${JSON.stringify(label)}`);
}

/**
 * The `begin_speaker` label for a segment's speaker. A label holds a person or
 * a speaker number, not both, so a segment with both throws rather than lose
 * one.
 */
function formatSpeaker({ speakerNumber, person }: Speaker): string {
  if (person !== null) {
    if (speakerNumber !== null)
      throw new Error(
        `A PSV speaker label can't hold both person ${JSON.stringify(person)} and speaker number ${speakerNumber}`,
      );
    return `identified:${person}`;
  }
  if (speakerNumber !== null) return `segmented:spk-${speakerNumber}`;
  return "unlabeled";
}

function parseEvents(content: string): PsvEvent[] {
  const events: PsvEvent[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    // Split into at most 3 fields; event_data keeps any embedded `|`.
    const sep1 = line.indexOf("|");
    const sep2 = line.indexOf("|", sep1 + 1);
    if (sep1 < 0 || sep2 < 0) {
      throw new Error(
        `Malformed PSV line ${i + 1} (expected 3 fields): ${JSON.stringify(raw)}`,
      );
    }
    const startField = line.slice(0, sep1);
    const eventType = line.slice(sep1 + 1, sep2);
    const eventData = line.slice(sep2 + 1);

    if (startField === "start_sec") continue; // optional column header

    if (eventType === "text") {
      events.push({
        type: "text",
        start: parseTimestamp(startField),
        text: eventData,
      });
    } else if (eventType === "meta") {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(eventData) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `Invalid meta JSON on PSV line ${i + 1}: ${JSON.stringify(eventData)}`,
          { cause: err },
        );
      }
      events.push({ type: "meta", start: parseTimestamp(startField), data });
    } else if (eventType === "vad") {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(eventData) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `Invalid vad JSON on PSV line ${i + 1}: ${JSON.stringify(eventData)}`,
          { cause: err },
        );
      }
      events.push({
        type: "vad",
        start: parseTimestamp(startField),
        data,
      });
    } else {
      throw new Error(
        `Unknown event_type on PSV line ${i + 1}: ${JSON.stringify(eventType)}`,
      );
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
export function parsePsv(source: string | { path: string }): Segment<string>[] {
  const content =
    typeof source === "string" ? source : readFileSync(source.path, "utf8");
  const segments: Segment<string>[] = [];
  let current: Segment<string> | null = null;

  for (const event of parseEvents(content)) {
    if (event.type === "vad") {
      continue; // debug-only span marker; carries no transcript content
    } else if (event.type === "meta") {
      const label = event.data["begin_speaker"];
      if (typeof label !== "string") {
        throw new Error(
          `Unsupported meta event (expected begin_speaker): ${JSON.stringify(event.data)}`,
        );
      }
      current = { ...parseSpeaker(label), words: [] };
      segments.push(current);
    } else {
      if (!current) {
        throw new Error(
          `text event before any begin_speaker meta (word: ${JSON.stringify(event.text)})`,
        );
      }
      current.words.push({
        text: event.text,
        start: event.start,
      });
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
  segments: readonly Segment<string>[],
  options?: { path?: string },
): string {
  const rows: string[] = [];
  for (const segment of segments) {
    const start = segment.words[0]?.start ?? 0;
    rows.push(
      `${formatClock(start)}|meta|${JSON.stringify({ begin_speaker: formatSpeaker(segment) })}`,
    );
    for (const w of segment.words) {
      rows.push(`${formatClock(w.start)}|text|${w.text}`);
    }
  }
  const content = [COLUMN_HEADER, ...rows].join("\n") + "\n";
  if (options?.path !== undefined) {
    writeFileSync(options.path, content);
  }
  return content;
}

/**
 * Serialize VAD speech runs for the debug `transcribed.gen.psv` artifact: one
 * unlabeled speaker segment whose words are interleaved with `vad` marker lines
 * showing where each run was cut and fed to the recognizer. Each marker sits at
 * the run's start and carries its `index` and `dur` in seconds — so a diff makes
 * a changed chunk boundary visible. Round-trips through parsePsv, which skips
 * the markers and recovers the flat word list.
 */
export function serializeVadRunsPsv(
  runs: readonly SpeechRun[],
  options?: { path?: string },
): string {
  const rows: string[] = [];
  rows.push(
    `${formatClock(runs[0]?.start ?? 0)}|meta|${JSON.stringify({ begin_speaker: "unlabeled" })}`,
  );
  runs.forEach((run, i) => {
    const data = {
      index: i,
      dur: Math.round((run.end - run.start) * 100) / 100,
    };
    rows.push(`${formatClock(run.start)}|vad|${JSON.stringify(data)}`);
    for (const w of run.words) {
      rows.push(`${formatClock(w.start)}|text|${w.text}`);
    }
  });
  const content = [COLUMN_HEADER, ...rows].join("\n") + "\n";
  if (options?.path !== undefined) {
    writeFileSync(options.path, content);
  }
  return content;
}
