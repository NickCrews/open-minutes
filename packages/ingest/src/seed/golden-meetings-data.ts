import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataState } from "@open-minutes/db/ensure";
import { EMBEDDING_MODEL_SPEC } from "@open-minutes/audio/embed";
import {
  TEST_DATA_ROOT,
  getMeetingData,
  loadPeople,
  transcriptPath,
} from "@open-minutes/fixtures/test-data";
import { goldenData } from "@open-minutes/fixtures/golden-data";
import {
  GOLDEN_MEETINGS_SEED_VERSION,
  seedGoldenMeetings,
} from "@open-minutes/fixtures/golden-meetings";
import { audioVoiceprints } from "./audio-voiceprints";

// The golden dataset plus some golden meetings seeded as established history:
// transcripts, speaker-attributed segments, chapters, and a *real* voiceprint
// per identified person, computed from the meeting audio. That's expensive, so the
// test harness caches the result as a template until the inputs change.

// Bump when audioVoiceprints' behavior changes in a way the inputs hashed
// below don't capture.
const VERSION = 3;

/** Golden rows + the given golden meetings, with real voiceprints. */
export function goldenMeetingsData(meetingSlugs: readonly string[]): DataState {
  let fingerprint: string | undefined;
  return {
    name: `golden+meetings:${meetingSlugs.join(",")}`,
    get fingerprint() {
      fingerprint ??= computeFingerprint(meetingSlugs);
      return fingerprint;
    },
    apply: async (db) => {
      await goldenData.apply(db);
      await seedGoldenMeetings(
        db,
        meetingSlugs.map((s) => getMeetingData(s)),
        {
          registry: loadPeople(),
          people: "speakers",
          voiceprints: audioVoiceprints,
        },
      );
    },
  };
}

/**
 * Everything the seeded rows depend on: the golden rows, each meeting's
 * metadata (including its audio's sha256), transcript and chapters, the
 * people registry, and the embedding model that turns audio into voiceprints.
 */
function computeFingerprint(meetingSlugs: readonly string[]): string {
  const hash = createHash("sha256")
    .update(`v${VERSION}.${GOLDEN_MEETINGS_SEED_VERSION}\n`)
    .update(`${goldenData.fingerprint}\n`)
    .update(`${EMBEDDING_MODEL_SPEC.url}\n`)
    .update(readFileSync(join(TEST_DATA_ROOT, "people.jsonl")));
  for (const slug of meetingSlugs) {
    const dir = join(TEST_DATA_ROOT, "meetings", slug);
    const chapters = join(dir, "chapters.json");
    hash
      .update(`${slug}\0`)
      .update(readFileSync(join(dir, "meeting.json")))
      .update(readFileSync(transcriptPath(dir)!))
      .update(existsSync(chapters) ? readFileSync(chapters) : "");
  }
  return hash.digest("hex").slice(0, 12);
}
