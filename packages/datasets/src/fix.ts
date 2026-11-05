// Applies the transcript rules' fixes in @open-minutes/core/rules to a PSV
// file that isn't a golden, such as a pipeline run's output. Goldens are
// exported from the database, so they are fixed there, with
// `pnpm transcript fix` (see @open-minutes/edit). Also writes chapters.json.

import { readFileSync, writeFileSync } from "node:fs";
import { formatClock } from "@open-minutes/core/clock";
import {
  fixMeeting,
  type MeetingIssue,
  TRANSCRIPT_RULE_SPECS,
} from "@open-minutes/core/rules";
import type { Segment } from "@open-minutes/core/transcript";
import { parsePsv, serializePsv } from "./psv";
import type { GoldenChapters } from "./datums";

/** A file the fixes rewrote, and the violations they fixed in it. */
export interface FileFix {
  file: string;
  fixed: MeetingIssue[];
}

/**
 * Apply the transcript rules' fixes to golden segments, eg clean each
 * speaker's words and drop a segment left with none. Returns the segments
 * given if nothing changed.
 */
export async function fixGoldenSegments(
  segments: readonly Segment<string>[],
): Promise<{ segments: readonly Segment<string>[]; fixed: MeetingIssue[] }> {
  const given = { segments };
  const { meeting, fixed } = await fixMeeting(given, TRANSCRIPT_RULE_SPECS);
  return { segments: meeting.segments, fixed };
}

/**
 * Apply the transcript rules' fixes to a PSV file on its own, rewriting it
 * only if something changed. Returns what it rewrote.
 */
export async function fixTranscriptFile(path: string): Promise<FileFix[]> {
  const before = parsePsv(readFileSync(path, "utf8"));
  const { segments, fixed } = await fixGoldenSegments(before);
  if (segments === before) return [];
  writeFileSync(path, serializePsv(segments));
  return [{ file: path, fixed }];
}

/** A meeting's chapters as chapters.json, times as "H:MM:SS.ss". */
export function serializeChapters({
  generation,
  chapters,
}: GoldenChapters): string {
  const raw = {
    generation,
    chapters: chapters.map((c) => ({
      start: formatClock(c.start),
      end: formatClock(c.end),
      title: c.title,
      summary: c.summary,
      bullets: c.bullets,
    })),
  };
  return JSON.stringify(raw, null, 2) + "\n";
}
