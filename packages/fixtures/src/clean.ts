// Transcript cleaning for checked-in fixtures. Goldens must look like cleaned
// pipeline output (see @open-minutes/core/transcription's clean.ts), or every
// disfluency the pipeline strips would count against it as a deletion. This
// module applies the same rules to PSV files. `pnpm fixtures:clean` rewrites
// them; check.ts reports what is left as errors, so `pnpm fixtures:check`, the
// fixture tests and the post-edit hook all catch an unclean golden.

import { readFileSync, writeFileSync } from "node:fs";
import {
  type CleanChange,
  cleanGroups,
} from "@open-minutes/core/transcription";
import { type GoldenSegment, parsePsv, serializePsv } from "./psv";

/**
 * Clean golden segments speaker by speaker. A segment left with no words is
 * dropped: it would serialize as a speaker turn with nothing said.
 */
export function cleanGoldenSegments(segments: readonly GoldenSegment[]): {
  segments: GoldenSegment[];
  changes: CleanChange[];
} {
  const { groups, changes } = cleanGroups(segments);
  return { segments: groups.filter((s) => s.words.length > 0), changes };
}

/**
 * Clean one PSV file in place, rewriting it only if something changed.
 * Returns what changed.
 */
export function cleanTranscriptFile(path: string): CleanChange[] {
  const { segments, changes } = cleanGoldenSegments(
    parsePsv(readFileSync(path, "utf8")),
  );
  if (changes.length > 0) writeFileSync(path, serializePsv(segments));
  return changes;
}
