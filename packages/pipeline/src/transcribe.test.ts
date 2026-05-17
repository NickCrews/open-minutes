import { beforeAll, describe, expect, it } from "vitest";
import { type WaveForm } from "sherpa-onnx-node";
import { getRecognizer, transcribeSamples } from "./transcribe";
import { loadAllFixtures, type MeetingFixture } from "./test-utils/fixtures";
import { getCachedAudioForFixture, isCached } from "./test-utils/audio-cache";
import { computeWER } from "./test-utils/wer";
import { readWave, sliceWave } from "./test-utils/wav-window";
import { formatTimestamp } from "@gbos/core/timeline";

// word error rate threshold
const WER_HARD_FAIL = 0.15;

// Boundary tolerance: per-segment we expect the model to emit its first token
// timestamp within X seconds of the slice start, and its last token timestamp
// within X seconds of the slice end.
const BOUNDARY_TOLERANCE_SEC = 5;

const TRANSCRIBE_TIMEOUT_MS = 600_000;

const fixtures = loadAllFixtures();
// Only run WER checks when the audio is already cached locally — downloading
// a full meeting (~2.7 hr) during a test run is not practical.
const curatedFixtures = fixtures
  .filter((f) => f.segments.some((s) => s._curated))
  .filter((f) => isCached(f.meeting.youtube_id));

describe.runIf(curatedFixtures.length > 0)("transcribe — curated WER checks", () => {
  beforeAll(() => {
    getRecognizer();
  }, TRANSCRIBE_TIMEOUT_MS);

  for (const fixture of curatedFixtures) {
    describe(`${fixture.municipality_slug}/${fixture.meeting_dir} (${fixture.meeting.youtube_id})`, () => {
      let wave: WaveForm;
      const perSegmentResults: Array<{ wer: number; refWords: number; hypWords: number }> = [];

      beforeAll(async () => {
        const cached = await getCachedAudioForFixture(fixture);
        wave = readWave(cached.path);
      }, TRANSCRIBE_TIMEOUT_MS);

      const curated = fixture.segments.filter((s) => s._curated);

      for (const seg of curated) {
        it(
          `[${formatTimestamp(seg.start_secs)} -> ${formatTimestamp(seg.end_secs)}] ${seg.person_slug ?? "unknown"}: WER and boundary deltas`,
          { timeout: TRANSCRIBE_TIMEOUT_MS },
          () => {
            const bufferSec = 3;
            const slice = sliceWave(wave, seg.start_secs - bufferSec, seg.end_secs + bufferSec);
            const sliceDuration = slice.samples.length / slice.sampleRate;
            const result = transcribeSamples(slice.samples, slice.sampleRate);
            result.timestamps = result.timestamps?.map((t) => t - bufferSec);

            const wer = computeWER(seg.text, result.text);
            perSegmentResults.push({
              wer: wer.wer,
              refWords: wer.ref_word_count,
              hypWords: result.text.split(/\s+/).filter(Boolean).length,
            });

            expect(
              wer.wer,
              `per-clip WER ${(wer.wer * 100).toFixed(1)}% exceeds hard threshold for [${seg.start_secs}-${seg.end_secs}]\nref: ${seg.text}\nhyp: ${result.text}`,
            ).toBeLessThanOrEqual(WER_HARD_FAIL);

            const timestamps = result.timestamps;
            expect(timestamps, "model returned no per-token timestamps").toBeDefined();
            expect(timestamps!.length).toBeGreaterThan(0);
            const firstTs = timestamps![0]!;
            const lastTs = timestamps![timestamps!.length - 1]!;
            expect(
              firstTs,
              `first-token timestamp ${firstTs.toFixed(3)}s drifted >${BOUNDARY_TOLERANCE_SEC}s from slice start`,
            ).toBeLessThanOrEqual(BOUNDARY_TOLERANCE_SEC);
            expect(
              sliceDuration - lastTs,
              `last-token timestamp ${lastTs.toFixed(3)}s drifted >${BOUNDARY_TOLERANCE_SEC}s from slice end`,
            ).toBeLessThanOrEqual(BOUNDARY_TOLERANCE_SEC);
          },
        );
      }

      it("aggregate WER under hard threshold", () => {
        if (perSegmentResults.length === 0) return;
        const totalRefWords = perSegmentResults.reduce((s, r) => s + r.refWords, 0);
        const totalErrors = perSegmentResults.reduce((s, r) => s + r.wer * r.refWords, 0);
        const aggregate = totalRefWords === 0 ? 0 : totalErrors / totalRefWords;
        expect(
          aggregate,
          `aggregate WER ${(aggregate * 100).toFixed(1)}% exceeds hard threshold`,
        ).toBeLessThanOrEqual(WER_HARD_FAIL);
      });
    });
  }
});

describe.runIf(curatedFixtures.length === 0)("transcribe (no curated fixtures)", () => {
  it.skip("no segments with _curated: true found in any fixture", () => {});
});

// Full pipeline eval: run transcribe+diarize+align over the whole meeting, then
// compare aggregate WER against all golden segments. Gate behind GOLDEN_EVAL=1
// because this takes many minutes and requires the sherpa models to be present.
describe.runIf(process.env.GOLDEN_EVAL === "1")("transcribe — full pipeline golden eval", () => {
  for (const fixture of fixtures) {
    it(
      `${fixture.municipality_slug}/${fixture.meeting_dir}: full meeting WER`,
      { timeout: 3_600_000 },
      async () => {
        const { transcribeAudio } = await import("./transcribe");
        const { diarizeAudio } = await import("./diarize");
        const { alignTranscriptWithSpeakers } = await import("./align");

        const cached = await getCachedAudioForFixture(fixture);
        const transcriptSegments = await transcribeAudio(cached.path);
        const { turns } = await diarizeAudio(cached.path);
        const actual = alignTranscriptWithSpeakers(transcriptSegments, turns);

        // Build one long hypothesis and reference string for aggregate WER.
        // Golden segments are sorted by start time for a fair comparison.
        const goldenText = fixture.segments
          .slice()
          .sort((a, b) => a.start_secs - b.start_secs)
          .map((s) => s.text)
          .join(" ");
        const actualText = actual
          .slice()
          .sort((a, b) => a.start - b.start)
          .map((s) => s.text)
          .join(" ");

        const wer = computeWER(goldenText, actualText);
        expect(
          wer.wer,
          `full meeting WER ${(wer.wer * 100).toFixed(1)}% exceeds threshold`,
        ).toBeLessThanOrEqual(WER_HARD_FAIL);
      },
    );
  }
});

// Keep the fixture variable referenced so unused-import linting doesn't complain.
const _f: MeetingFixture | undefined = fixtures[0];
void _f;
