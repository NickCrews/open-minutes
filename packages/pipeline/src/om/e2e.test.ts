import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { eq, isNotNull } from "drizzle-orm";
import { peopleTable, segmentsTable } from "@open-minutes/db";
import { dbTest } from "@open-minutes/db/testing/vitest";
import type { TranscriptWord } from "@open-minutes/core/transcription";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import type { GoldenSegment } from "@open-minutes/fixtures/psv";
import { compareTranscripts } from "../test-utils/wer";
import { goldenMeetingsData } from "../seed/golden-meetings-data";
import { GOLDEN_GBOS, fakeYouTube } from "./testing";
import { ingestVideo } from "./ingest";
import { getMeetingAudio } from "../test-utils/audio-cache";

// End-to-end cross-meeting speaker recognition.
//
// The premise the whole architecture exists to support: a person's identity
// (their slug, eg "margaret-tyler") is the SAME across meetings, tied to their voice.
// So we can learn people from some meetings and recognize them, by voice alone,
// in a meeting we never trained on.
//
// The test:
//   1. Start from a database already holding two goldens (transcripts + a
//      voiceprint per identified person): the goldenMeetingsData dataset.
//   2. Ingest a THIRD golden's audio through the real pipeline (transcribe →
//      diarize → align → identify). Ingestion sees only audio, never the third
//      golden's labels; its diarizer invents anonymous clusters, and identify.ts
//      matches those clusters' voiceprints back to the people seeded in step 1.
//   3. Compare the ingested result against the third golden: word error rate, and
//      — once the third golden is hand-labeled with identified people — how often
//      the right person was recognized.
//
// Thresholds are deliberately very lax: the third golden is a rough first-pass
// transcript, to be hand-cleaned (and hand-labeled with identified people) later.
// This exercises the full machinery end to end today; tighten as the data firms.

const SEED_SLUGS = ["gbos_9HoIM5INxpI", "gbos_xTDznaSElgY"];
const HELD_OUT_SLUG = "gbos_hTKVG_L61ec";

// Ingesting the held-out meeting re-runs transcription + diarization, which take
// the better part of an hour on a ~2.7h recording. Persist the pipeline's
// per-stage artifact cache across runs (gitignored under test-runs/) so only the
// first, cold run pays that cost; later runs — while iterating on the assertions
// — hit the cache and finish in seconds.
const E2E_WORK_ROOT = fileURLToPath(
  new URL("../../test-runs/e2e-work/", import.meta.url),
);

// Step 1 as a declared dataset. Seeding computes real voiceprints from the two
// meetings' audio, which is slow, so the harness does it once per change to
// the fixtures (or the embedding model) and caches the result as a template;
// every later run clones it in milliseconds.
const test = dbTest({
  data: goldenMeetingsData(SEED_SLUGS),
  setupTimeoutMs: 60 * 60_000,
});

describe("e2e cross-meeting speaker recognition", () => {
  test(
    "recognizes seeded people in an unseen meeting",
    { tags: ["slow"], timeout: 120 * 60_000 },
    async ({ db }) => {
      // 1. The two known meetings are already seeded (see `test` above); the
      //    people they taught us are everyone with a slug.
      const seeded = await db
        .select({ slug: peopleTable.slug })
        .from(peopleTable)
        .where(isNotNull(peopleTable.slug));
      const seededSlugs = new Set(seeded.map((p) => p.slug!));
      console.log(
        `[e2e] seeded ${seededSlugs.size} people with voiceprints: ` +
          `${[...seededSlugs].sort().join(", ")}`,
      );
      expect(seededSlugs.size).toBeGreaterThan(0);

      // 2. Ingest the third meeting through the real pipeline. The mock YouTube
      //    boundary hands the pipeline the cached golden audio and GBOS metadata,
      //    but never the golden's labels.
      const held = getMeetingData(HELD_OUT_SLUG);
      const heldAudio = await getMeetingAudio(held);
      const yt = fakeYouTube({
        fetchVideoMetadata: async (id: string) => ({
          id,
          channelId: GOLDEN_GBOS.channelId,
          title: held.title,
          description: "",
          durationSecs: null,
        }),
        downloadVideoAudio: async (_id: string, dest: string) => {
          await copyFile(heldAudio.path, dest);
          return { downloaded: true };
        },
      });
      const result = await ingestVideo(db, held.youtube_id, {
        yt,
        workRoot: E2E_WORK_ROOT,
      });
      if (result.status !== "ingested") {
        throw new Error(`expected ingestion, got ${result.status}`);
      }

      // 3a. Word error rate vs the held-out golden.
      const ingested = await db
        .select({
          words: segmentsTable.words,
          slug: peopleTable.slug,
        })
        .from(segmentsTable)
        .leftJoin(peopleTable, eq(peopleTable.id, segmentsTable.person_id))
        .where(eq(segmentsTable.meeting_id, result.meetingId))
        // Segments are inserted in time order; id order recovers it. Without this
        // the words come back unordered and the WER alignment is meaningless.
        .orderBy(segmentsTable.id);

      const ingestedWords = ingested.flatMap((s) => s.words);
      const refWords = held.segments.flatMap((s) => s.words);
      const cmp = compareTranscripts(refWords, ingestedWords);
      console.log(
        `[e2e] WER=${cmp.wer.toFixed(4)} ` +
          `(sub=${cmp.substitutions} del=${cmp.deletions} ins=${cmp.insertions} ` +
          `of ${cmp.refWordCount})`,
      );
      // The golden is (for now) itself derived from this pipeline's transcription
      // of this audio, so WER is ~0 until the golden's words are hand-cleaned; this
      // mainly guards against the pipeline emitting materially different words than
      // it did at golden-generation time (a model change, dropped words). Lax on
      // purpose — tighten once the golden transcript is corrected by hand.
      expect(ingestedWords.length).toBeGreaterThan(0);
      expect(cmp.wer).toBeLessThan(0.5);

      // 3b. Cross-meeting recognition signal: how many ingested segments were tied
      //     to a person we seeded from the other meetings.
      const recognized = new Map<string, number>();
      for (const seg of ingested) {
        if (seg.slug && seededSlugs.has(seg.slug)) {
          recognized.set(seg.slug, (recognized.get(seg.slug) ?? 0) + 1);
        }
      }
      console.log(
        `[e2e] segments matched to a seeded person: ` +
          `${JSON.stringify(Object.fromEntries(recognized))}`,
      );

      // 3c. Identification accuracy — only meaningful once the held-out golden has
      //     identified people. Skip the assertion while it is still spk-N only.
      const identityScore = scoreIdentifications(held.segments, ingested);
      if (identityScore.total > 0) {
        console.log(
          `[e2e] identification accuracy: ` +
            `${identityScore.correct}/${identityScore.total} ` +
            `(${((identityScore.correct / identityScore.total) * 100).toFixed(0)}%)`,
        );
        // Lax first-pass floor; raise once labels + transcript are cleaned up.
        expect(identityScore.correct / identityScore.total).toBeGreaterThan(0);
      } else {
        console.log(
          `[e2e] held-out golden has no identified people yet — ` +
            `label ${HELD_OUT_SLUG} to score identification accuracy.`,
        );
      }
    },
  );
});

/**
 * Fraction of the held-out golden's identified segments whose speaker the
 * pipeline recognized correctly. A golden segment is scored by taking its
 * midpoint in time and finding the ingested segment spanning it; a hit is when
 * that segment resolved to the same person slug.
 */
function scoreIdentifications(
  reference: readonly GoldenSegment[],
  ingested: readonly { words: TranscriptWord[]; slug: string | null }[],
): { correct: number; total: number } {
  const spans = ingested
    .filter((s) => s.words.length > 0)
    .map((s) => ({
      start: s.words[0]!.start,
      end: s.words.at(-1)!.start,
      slug: s.slug,
    }));

  let correct = 0;
  let total = 0;
  for (const seg of reference) {
    if (seg.speaker.kind !== "identified" || seg.words.length === 0) continue;
    total++;
    const expected = seg.speaker.person;
    const mid = (seg.words[0]!.start + seg.words.at(-1)!.start) / 2;
    const hit = spans.find((s) => mid >= s.start && mid <= s.end);
    if (hit && hit.slug === expected) correct++;
  }
  return { correct, total };
}
