/**
 * Generates (or regenerates) segments.jsonl for a fixture by running the full
 * transcribe → diarize → align pipeline on the cached audio. The output
 * replaces the existing segments.jsonl completely; use `git diff` afterwards to
 * review changes and make manual corrections.
 *
 * Usage:
 *   tsx scripts/bootstrap-golden.ts <municipality>/<meeting_dir>
 *   # e.g.:
 *   tsx scripts/bootstrap-golden.ts girdwood/1
 */

import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { loadAllFixtures, type GoldenSegment } from "../src/test-utils/fixtures";
import { getCachedAudioForFixture } from "../src/test-utils/audio-cache";
import { transcribeAudio } from "../src/transcribe";
import { diarizeAudio } from "../src/diarize";
import { alignTranscriptWithSpeakers } from "../src/align";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: tsx scripts/bootstrap-golden.ts <municipality>/<meeting_dir>");
    console.error("  e.g.: tsx scripts/bootstrap-golden.ts girdwood/1");
    process.exit(1);
  }

  const [muniSlug, meetingDir] = target.split("/");
  const fixtures = loadAllFixtures();
  const fixture = fixtures.find(
    (f) => f.municipality_slug === muniSlug && f.meeting_dir === meetingDir,
  );
  if (!fixture) {
    console.error(`No fixture found for ${target}. Available fixtures:`);
    for (const f of fixtures) console.error(`  ${f.municipality_slug}/${f.meeting_dir}`);
    process.exit(1);
  }

  console.log(`Bootstrapping golden segments for ${target} (youtube: ${fixture.meeting.youtube_id})`);

  console.log("  Ensuring audio is cached...");
  const cached = await getCachedAudioForFixture(fixture);
  console.log(`  Audio: ${cached.path}`);

  console.log("  Transcribing (full meeting — this may take a while)...");
  const transcriptSegments = await transcribeAudio(cached.path);
  console.log(`  Got ${transcriptSegments.length} transcript segment(s) with ${transcriptSegments.reduce((n, s) => n + s.words.length, 0)} words.`);

  console.log("  Diarizing...");
  const { turns: diarizationTurns } = await diarizeAudio(cached.path);
  console.log(`  Got ${diarizationTurns.length} speaker turns.`);

  console.log("  Aligning...");
  const aligned = alignTranscriptWithSpeakers(transcriptSegments, diarizationTurns);
  console.log(`  Got ${aligned.length} aligned segments.`);

  const segmentRows: GoldenSegment[] = aligned.map((seg) => ({
    person_slug: null,
    text: seg.text,
    start_secs: seg.start,
    end_secs: seg.end,
    words: seg.words,
  }));

  const outputPath = join(fixture.fixtureDir, "segments.jsonl");
  const content = segmentRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(outputPath, content);
  console.log(`\nWrote ${segmentRows.length} segments to ${outputPath}`);
  console.log("Review with: git diff -- " + outputPath);
  console.log("Then set person_slug on segments and _curated: true on reference segments.");
}

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
