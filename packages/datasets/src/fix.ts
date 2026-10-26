// Fixing checked-in fixtures: applies the fixes of the rules in
// @open-minutes/core/rules to a meeting's files: meeting.json, the transcript
// and chapters.json. Goldens must look like cleaned pipeline output, or every
// disfluency the pipeline strips would count against it as a deletion; the
// cleaning rules' fixes (see core/rules/clean.ts) do that here too.
// `pnpm datasets:fix` rewrites the files; check.ts reports what is left, so
// `pnpm datasets:check`, the fixture tests and the post-edit hook all catch
// what it can't fix.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { formatClock } from "@open-minutes/core/clock";
import {
  BODY_RULE_SPECS,
  fixMeeting,
  type MeetingIssue,
  RULE_SPECS,
  TRANSCRIPT_RULE_SPECS,
} from "@open-minutes/core/rules";
import { ruleMeeting } from "./check";
import type { Segment } from "@open-minutes/core/transcript";
import { parsePsv, serializePsv } from "./psv";
import {
  bodyRuleCodes,
  getMeetingData,
  type GoldenChapters,
  transcriptPath,
} from "./datums";

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

/**
 * Apply the fix of every rule the meeting follows, its bodies' own included,
 * to a meeting directory, rewriting meeting.json, the transcript and
 * chapters.json where something changed. Returns what it rewrote. Throws if
 * the meeting doesn't load.
 */
export async function fixMeetingDir(dir: string): Promise<FileFix[]> {
  const root = resolve(dir, "../..");
  const golden = getMeetingData(basename(dir), root);
  const given = {
    ...ruleMeeting(golden),
    segments: golden.segments,
    chapters: golden.chapters?.chapters ?? null,
  };
  const codes = bodyRuleCodes(golden.body_slugs, root);
  const { meeting, fixed } = await fixMeeting(given, [
    ...RULE_SPECS,
    ...BODY_RULE_SPECS.filter((spec) => codes.includes(spec.code)),
  ]);
  const rewritten: FileFix[] = [];
  if (meeting.title !== given.title) {
    // In place, so the rest of the file keeps its formatting.
    const file = join(dir, "meeting.json");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        JSON.stringify(given.title),
        JSON.stringify(meeting.title),
      ),
    );
    rewritten.push({ file, fixed: fixed.filter((v) => "field" in v) });
  }
  if (meeting.segments !== given.segments) {
    const file = transcriptPath(dir)!;
    writeFileSync(file, serializePsv(meeting.segments));
    rewritten.push({
      file,
      fixed: fixed.filter((v) => "segmentIndex" in v),
    });
  }
  if (golden.chapters && meeting.chapters !== given.chapters) {
    const file = join(dir, "chapters.json");
    writeFileSync(
      file,
      serializeChapters({ ...golden.chapters, chapters: meeting.chapters! }),
    );
    rewritten.push({
      file,
      fixed: fixed.filter((v) => "chapterIndex" in v),
    });
  }
  return rewritten;
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
