import { createHash } from "node:crypto";

/**
 * A short hash of a transcript's words and their onsets, recorded with each
 * chapter generation so a later re-transcription shows the chapters are stale.
 * Speakers are left out: relabelling a speaker doesn't stale chapters, whose
 * speakers are derived.
 */
export function transcriptFingerprint(
  segments: readonly { words: readonly { text: string; start: number }[] }[],
): string {
  const hash = createHash("sha256");
  for (const seg of segments) {
    for (const w of seg.words) hash.update(`${w.start}\t${w.text}\n`);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}
