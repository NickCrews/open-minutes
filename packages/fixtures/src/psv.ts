// Pipe-separated golden transcript format ("PSV"). A git-diffable, line-oriented
// way to store golden transcripts: one event per line, so a re-transcription
// produces a clean word-level diff instead of a single mangled JSON blob.
//
// A TranscriptSegment is serialized as a `meta` begin_speaker line followed by
// one `text` line per word; parsing inverts that grouping.
//
// Grammar (see test-data/meetings/*/golden.psv for a worked example):
//   - Lines starting with `#` are comments; blank lines are ignored.
//   - The column header `start_sec|event_type|event_data` is optional.
//   - Each remaining line is `start_sec|event_type|event_data`.
//       * event_type "text": a transcribed word. start_sec is the word's onset
//         and event_data is the raw word text. Words carry no end timestamps —
//         see TranscriptWord in @open-minutes/core.
//       * event_type "meta": a marker. event_data is JSON.
//         {"begin_speaker": "<label>"} opens a new segment for that speaker.
//       * event_type "vad": a debug marker (written only to *.gen.psv) at the
//         start of a VAD speech run — the chunk of audio fed to the recognizer.
//         event_data is JSON ({"index","dur"}, dur being the run's length in
//         seconds). Purely informational: parsePsv skips these, so they never
//         affect parsed output.
//   - Speaker labels name who is speaking, in one of three forms:
//       * "unlabeled"          — no speaker info.
//       * "segmented:spk-<n>"  — a distinct voice the diarizer separated but that
//                                is not tied to a known person. The number is a
//                                per-meeting cluster id: spk-3 in one meeting has
//                                nothing to do with spk-3 in another.
//       * "identified:<slug>"  — a known, recurring person, keyed by a stable
//                                slug (eg "margaret-tyler"). The SAME slug is the SAME
//                                person in every golden — that global identity is
//                                what lets cross-meeting speaker recognition be
//                                tested end to end (seed people + voiceprints from
//                                two goldens, then recognize them in a third).
//   - A stretch of music is an "unlabeled" segment holding the one word
//     `[music]` (MUSIC_MARKER in @open-minutes/core), at the music's onset.
//   - Timestamps are `H:MM:SS.ss` (hours:minutes:seconds.hundredths).
//   - event_data is the final field, so it may itself contain `|`.

import { readFileSync, writeFileSync } from "node:fs";

import type {
  SpeechSegment,
  TranscriptSegment,
  TranscriptWord,
} from "@open-minutes/core/transcription";

/**
 * Who a golden segment is attributed to. Two tiers of identity:
 *   - `segmented` is a per-meeting diarization cluster — a voice we separated but
 *     have not tied to a known person. `cluster` is local to one meeting.
 *   - `identified` is a global person, keyed by a stable `person` slug that means
 *     the same individual across every meeting.
 *
 * The live diarization/alignment pipeline only ever produces `unlabeled` or
 * `segmented` (it cannot know who a voice belongs to — that is identify.ts's job,
 * later, against stored voiceprints). `identified` exists only in goldens, where
 * a human has supplied the ground-truth answer.
 */
export type SpeakerLabel =
  | { kind: "unlabeled" }
  | { kind: "segmented"; cluster: number }
  | { kind: "identified"; person: string };

/**
 * A speaker-grouped run of words in a golden transcript. The golden counterpart
 * of the pipeline's {@link TranscriptSegment}: same word grouping, but its
 * speaker is a rich {@link SpeakerLabel} rather than a bare cluster number, so it
 * can carry the identified-person ground truth the pipeline has to work out.
 */
export interface GoldenSegment {
  speaker: SpeakerLabel;
  words: TranscriptWord[];
}

/** Lift a pipeline segment (bare cluster number) into a golden segment. */
export function toGoldenSegment(seg: TranscriptSegment): GoldenSegment {
  return {
    speaker:
      seg.speakerNum === null
        ? { kind: "unlabeled" }
        : { kind: "segmented", cluster: seg.speakerNum },
    words: seg.words,
  };
}

/** Structural equality of two speaker labels. */
export function sameSpeakerLabel(a: SpeakerLabel, b: SpeakerLabel): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "segmented" && b.kind === "segmented")
    return a.cluster === b.cluster;
  if (a.kind === "identified" && b.kind === "identified")
    return a.person === b.person;
  return true; // both "unlabeled"
}

// Internal line-level representation. Not part of the public API.
type PsvEvent =
  | { type: "text"; start: number; text: string }
  | { type: "meta"; start: number; data: Record<string, unknown> }
  | { type: "vad"; start: number; data: Record<string, unknown> };

const COLUMN_HEADER = "start_sec|event_type|event_data";

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

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function parseSpeaker(label: string): SpeakerLabel {
  if (label === "unlabeled") return { kind: "unlabeled" };
  if (label.startsWith("segmented:")) {
    const m = label.slice("segmented:".length).match(/^spk-(\d+)$/);
    if (!m)
      throw new Error(
        `Invalid segmented speaker label (expected "segmented:spk-<n>"): ${JSON.stringify(label)}`,
      );
    return { kind: "segmented", cluster: Number(m[1]) };
  }
  if (label.startsWith("identified:")) {
    const person = label.slice("identified:".length);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(person)) {
      throw new Error(
        `Invalid identified speaker slug (expected kebab-case, eg "identified:margaret-tyler"): ${JSON.stringify(label)}`,
      );
    }
    return { kind: "identified", person };
  }
  throw new Error(`Unknown speaker label: ${JSON.stringify(label)}`);
}

function formatSpeaker(speaker: SpeakerLabel): string {
  switch (speaker.kind) {
    case "unlabeled":
      return "unlabeled";
    case "segmented":
      return `segmented:spk-${speaker.cluster}`;
    case "identified":
      return `identified:${speaker.person}`;
  }
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
export function parsePsv(source: string | { path: string }): GoldenSegment[] {
  const content =
    typeof source === "string" ? source : readFileSync(source.path, "utf8");
  const segments: GoldenSegment[] = [];
  let current: GoldenSegment | null = null;

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
      current = { speaker: parseSpeaker(label), words: [] };
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
  segments: readonly GoldenSegment[],
  options?: { path?: string },
): string {
  const rows: string[] = [];
  for (const segment of segments) {
    const start = segment.words[0]?.start ?? 0;
    rows.push(
      `${formatTimestamp(start)}|meta|${JSON.stringify({ begin_speaker: formatSpeaker(segment.speaker) })}`,
    );
    for (const w of segment.words) {
      rows.push(`${formatTimestamp(w.start)}|text|${w.text}`);
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
  runs: readonly SpeechSegment[],
  options?: { path?: string },
): string {
  const rows: string[] = [];
  rows.push(
    `${formatTimestamp(runs[0]?.start ?? 0)}|meta|${JSON.stringify({ begin_speaker: "unlabeled" })}`,
  );
  runs.forEach((run, i) => {
    const data = {
      index: i,
      dur: Math.round((run.end - run.start) * 100) / 100,
    };
    rows.push(`${formatTimestamp(run.start)}|vad|${JSON.stringify(data)}`);
    for (const w of run.words) {
      rows.push(`${formatTimestamp(w.start)}|text|${w.text}`);
    }
  });
  const content = [COLUMN_HEADER, ...rows].join("\n") + "\n";
  if (options?.path !== undefined) {
    writeFileSync(options.path, content);
  }
  return content;
}
