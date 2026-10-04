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
import { getMeetingAudio } from "./test-utils/audio-cache";
import {
  cleanSpeechSegments,
  compareTranscripts,
} from "@open-minutes/core/transcription";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "..", "test-runs");

describe("transcribe", () => {
  const meetingSlugs = ["gbos_9HoIM5INxpI", "gbos_xTDznaSElgY"];
  for (const slug of meetingSlugs) {
    it(
      `can transcribe meeting ${slug}, passing our accuracy limits`,
      { tags: ["slow"] },
      async () => {
        const meeting = getMeetingData(slug);
        const runDir = join(RUNS_DIR, slug);
        cpDirSymlinked(meeting.meetingDir, runDir);
        // Goldens hold cleaned text (see `pnpm fixtures check`), so compare
        // against the same transcribe → clean output ingestion uses.
        const speechSegments = cleanSpeechSegments(
          await transcribeAudio(
            await getMeetingAudio(meeting).then((a) => a.path),
          ),
        );
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
            `p95 start=${cmp.p95StartError.toFixed(3)}s; ${speechSegments.length} segments`,
        );
        // First: confirm the check actually has teeth. With strict thresholds the
        // current transcribe output should never pass, so the assertion below MUST
        // throw. If it doesn't, our metric is broken (or the model is suspiciously
        // perfect — also worth knowing).
        expect(() =>
          assertWithinThresholds(cmp, { maxWER: 0, maxTimestampError: 0 }),
        ).toThrow();

        // Then the real check: lax-but-meaningful thresholds we expect to pass.
        // WER < 15% and matched-word p95 timestamp error < 0.5s are realistic for
        // this model on noisy multi-speaker audio.
        assertWithinThresholds(cmp, { maxWER: 0.15, maxTimestampError: 0.5 });
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
