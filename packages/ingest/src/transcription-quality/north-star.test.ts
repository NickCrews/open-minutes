import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transcribeAudio } from "@open-minutes/audio/transcribe";
import {
  reapplySpeakerLayer,
  serializePsv,
  serializeVadRunsPsv,
} from "@open-minutes/fixtures/psv";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import { getMeetingAudio } from "../test-utils/audio-cache";
import {
  cleanSpeechSegments,
  compareTranscripts,
} from "@open-minutes/core/transcription";

// THE NORTH STAR for transcription (see README.md in this directory).
//
// What we actually care about is how many words of a meeting we get right and
// how long it takes: word error rate against the hand-corrected goldens, and
// runtime as a fraction of the audio's length. Every other transcription test
// (parakeet.characterization.test.ts, @open-minutes/audio's unit tests) is
// scaffolding in support of these two numbers. When a change to transcribeAudio
// is in question, this is the test that decides it: run it before and after
// (`pnpm test:slow north-star`) and compare the logged WER and RTF.

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "..", "..", "test-runs");

// Lax-but-meaningful limits that every golden meeting should pass. They catch
// a regression, not a small drift: read the logged numbers to compare changes.
const MAX_WER = 0.15;
// Matched-word p95 onset error.
const MAX_TIMESTAMP_ERROR_SEC = 0.5;
// Wall-clock seconds per second of audio. ~0.04 on a 4-core machine.
const MAX_REAL_TIME_FACTOR = 0.2;

describe("transcribe", () => {
  const meetingSlugs = [
    "assembly-2026-02-17",
    "assembly-2026-03-03",
    "ced-2026-03-05",
    "gbos-2026-03-23",
    "gbos-2026-05-18",
    "gbos-2026-06-15",
    "pzc-2026-06-08",
  ];
  for (const slug of meetingSlugs) {
    it(
      `can transcribe meeting ${slug}, within our WER and runtime limits`,
      { tags: ["slow"] },
      async () => {
        const meeting = getMeetingData(slug);
        const runDir = join(RUNS_DIR, slug);
        cpDirSymlinked(meeting.meetingDir, runDir);
        // Goldens hold cleaned text (see `pnpm fixtures check`), so compare
        // against the same transcribe → clean output ingestion uses.
        const audio = await getMeetingAudio(meeting);
        const wallStart = Date.now();
        const speechSegments = cleanSpeechSegments(
          await transcribeAudio(audio.path),
        );
        const rtf =
          (Date.now() - wallStart) / 1000 / audio.manifest.duration_sec;
        const transcribedWords = speechSegments.flatMap((s) => s.words);
        // Debug artifact: interleave VAD run markers so a diff shows where the audio
        // was chunked (each run's span + duration) and fed to the recognizer.
        serializeVadRunsPsv(speechSegments, {
          path: join(runDir, "transcribed.gen.psv"),
        });
        if (process.env.SNAPSHOT_UPDATE === "1") {
          // golden.psv is shared with diarize.test.ts. This test owns only the
          // transcription, so preserve the existing speaker layer (the diarization
          // clusters AND any hand-assigned identified people) instead of
          // overwriting it: redistribute the freshly transcribed words back into
          // the golden's existing speaker segments by time.
          const merged = reapplySpeakerLayer(
            transcribedWords,
            meeting.segments,
          );
          serializePsv(merged, {
            path: join(meeting.meetingDir, "golden.psv"),
          });
          return;
        }

        const refWords = meeting.segments.flatMap((s) => s.words);
        const cmp = compareTranscripts(refWords, transcribedWords);
        console.log(
          `[${slug}] WER=${cmp.wer.toFixed(4)} (sub=${cmp.substitutions} del=${cmp.deletions} ins=${cmp.insertions} of ${cmp.refWordCount}); ` +
            `p95 start=${cmp.p95StartError.toFixed(3)}s; RTF=${rtf.toFixed(3)}; ${speechSegments.length} segments`,
        );
        // First: confirm the check actually has teeth. With strict thresholds the
        // current transcribe output should never pass, so the assertion below MUST
        // throw. If it doesn't, our metric is broken (or the model is suspiciously
        // perfect — also worth knowing).
        expect(() =>
          assertWithinThresholds(cmp, { maxWER: 0, maxTimestampError: 0 }),
        ).toThrow();

        // Then the real check.
        assertWithinThresholds(cmp, {
          maxWER: MAX_WER,
          maxTimestampError: MAX_TIMESTAMP_ERROR_SEC,
        });
        expect(rtf).toBeLessThan(MAX_REAL_TIME_FACTOR);
      },
    );
  }
});

function cpDirSymlinked(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    if (!existsSync(destPath)) {
      symlinkSync(srcPath, destPath);
    }
  }
}

function assertWithinThresholds(
  cmp: ReturnType<typeof compareTranscripts>,
  thresholds: { maxWER: number; maxTimestampError: number },
): void {
  const failures: string[] = [];
  if (cmp.wer > thresholds.maxWER) {
    failures.push(
      `WER ${cmp.wer.toFixed(4)} > ${thresholds.maxWER} (sub=${cmp.substitutions} del=${cmp.deletions} ins=${cmp.insertions} of ${cmp.refWordCount} ref words)`,
    );
  }
  if (cmp.p95StartError > thresholds.maxTimestampError) {
    failures.push(
      `p95 word-start error ${cmp.p95StartError.toFixed(3)}s > ${thresholds.maxTimestampError}s (mean=${cmp.meanStartError.toFixed(3)}s, max=${cmp.maxStartError.toFixed(3)}s, n=${cmp.matchedPairs})`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `Transcript outside thresholds:\n  - ${failures.join("\n  - ")}`,
    );
  }
}
