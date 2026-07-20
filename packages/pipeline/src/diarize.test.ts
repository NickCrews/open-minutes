import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sherpa_onnx from "sherpa-onnx-node";

import { computeSpeakerEmbeddings, diarizeAudio } from "./diarize";
import { alignSpeakers } from "./align";
import { parsePsv, serializePsv } from "./test-utils/psv";
import { getMeetingData } from "./test-utils/test-data";
import { N_DIMENSIONS } from "@open-minutes/core/voice_embeddings";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "..", "test-runs");

// golden.psv is shared with transcribe.test.ts: that test owns the transcription
// (words + timings), this one owns the diarization (speaker labels). Under
// SNAPSHOT_UPDATE we keep the golden's existing words and only rewrite the
// speaker grouping, so neither test clobbers the other's slice — or your manual
// tweaks. Generate the first pass with SNAPSHOT_UPDATE=1, then refine by hand.
describe("diarize", () => {
  const meetingSlugs = ["gbos_9HoIM5INxpI", "gbos_xTDznaSElgY"];
  for (const slug of meetingSlugs) {
    // It took 18 minutes on my M1 pro, probably slower on others.
    it(`diarizes meeting ${slug}`, { tags: ["slow"] }, async () => {
      const meeting = getMeetingData(slug);
      const runDir = join(RUNS_DIR, slug);
      cpDirSymlinked(meeting.meetingDir, runDir);

      const audioPath = await meeting.getAudio().then((a) => a.path);
      const wave = sherpa_onnx.readWave(audioPath);
      const turns = diarizeAudio(wave);

      // Keep the transcription slice from the existing golden; relabel speakers.
      const words = meeting.segments.flatMap((s) => s.words);
      const aligned = alignSpeakers(words, turns);
      serializePsv(aligned, { path: join(runDir, "diarized.gen.psv") });

      if (process.env.SNAPSHOT_UPDATE === "1") {
        serializePsv(aligned, { path: join(meeting.meetingDir, "golden.psv") });
        return;
      }

      // A board meeting has multiple speakers, in order, within the recording.
      const duration = wave.samples.length / wave.sampleRate;
      expect(turns.length).toBeGreaterThan(0);
      expect(new Set(turns.map((t) => t.speakerNum)).size).toBeGreaterThan(1);
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i]!;
        expect(t.end).toBeGreaterThanOrEqual(t.start);
        expect(t.start).toBeGreaterThanOrEqual(0);
        expect(t.end).toBeLessThanOrEqual(duration + 1);
        if (i > 0) expect(t.start).toBeGreaterThanOrEqual(turns[i - 1]!.start);
      }

      // Every speaker that talks long enough gets an N_DIMENSIONS-dim centroid.
      const embeddings = computeSpeakerEmbeddings(wave, turns);
      expect(embeddings.size).toBeGreaterThan(0);
      for (const [, embedding] of embeddings) {
        expect(embedding.length).toBe(N_DIMENSIONS);
      }

      // Aligned segments cover the transcript with no word lost.
      expect(aligned.flatMap((s) => s.words).length).toBe(words.length);

      // The golden re-parses cleanly and carries speaker labels.
      const reparsed = parsePsv(serializePsv(aligned));
      expect(reparsed.every((s) => s.speakerNum !== null)).toBe(true);
    });
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
