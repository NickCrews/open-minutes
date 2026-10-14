// Transcript cleaning for checked-in fixtures. Goldens must look like cleaned
// pipeline output (see @open-minutes/core/transcription's clean.ts), or every
// disfluency the pipeline strips would count against it as a deletion. This
// module applies the fixes of the transcript rules in @open-minutes/core/rules
// to PSV files. `pnpm fixtures:clean` rewrites them; check.ts reports what is
// left, so `pnpm fixtures:check`, the fixture tests and the post-edit hook all
// catch an unclean golden.

import { readFileSync, writeFileSync } from "node:fs";
import {
  fixMeeting,
  type MeetingIssue,
  TRANSCRIPT_RULE_SPECS,
} from "@open-minutes/core/rules";
import { ruleSegment } from "./check";
import { type GoldenSegment, parsePsv, serializePsv } from "./psv";

/** What fixing a transcript fixed. */
export type TranscriptFix = MeetingIssue<
  (typeof TRANSCRIPT_RULE_SPECS)[number]["code"]
>;

/**
 * Apply the transcript rules' fixes to golden segments: clean each speaker's
 * words, and drop a segment left with none. Returns the segments given if
 * nothing changed.
 */
export async function cleanGoldenSegments(
  segments: readonly GoldenSegment[],
): Promise<{ segments: readonly GoldenSegment[]; fixed: TranscriptFix[] }> {
  const given = {
    segments: segments.map((s) => ({ ...ruleSegment(s), label: s.speaker })),
  };
  const { meeting, fixed } = await fixMeeting(given, TRANSCRIPT_RULE_SPECS);
  if (meeting === given) return { segments, fixed };
  return {
    segments: meeting.segments.map((s) => ({
      speaker: s.label,
      words: [...s.words],
    })),
    fixed,
  };
}

/**
 * Clean one PSV file in place, rewriting it only if something changed.
 * Returns whether it did, and what it fixed.
 */
export async function cleanTranscriptFile(
  path: string,
): Promise<{ changed: boolean; fixed: TranscriptFix[] }> {
  const before = parsePsv(readFileSync(path, "utf8"));
  const { segments, fixed } = await cleanGoldenSegments(before);
  const changed = segments !== before;
  if (changed) writeFileSync(path, serializePsv(segments));
  return { changed, fixed };
}
