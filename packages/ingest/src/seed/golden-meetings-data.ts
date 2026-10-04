import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataState } from "@open-minutes/db/ensure";
import { EMBEDDING_MODEL_SPEC } from "@open-minutes/audio/embed";
import {
  TEST_DATA_ROOT,
  getMeetingData,
  loadAllTestData,
  loadPeople,
} from "@open-minutes/fixtures/test-data";
import { goldenData } from "@open-minutes/fixtures/golden-data";
import { seedGoldenMeeting } from "./golden-meeting";
import { mapSnapshot } from "@open-minutes/fixtures/map";

// The golden dataset plus some golden meetings seeded as established history:
// transcripts, speaker-attributed segments, and a *real* voiceprint per
// identified person, computed from the meeting audio. That's expensive, so the
// test harness caches the result as a template until the inputs change.

// Bump when seedGoldenMeeting's behavior changes in a way the inputs hashed
// below don't capture.
const VERSION = 1;

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
      const { bodyIdByKey } = mapSnapshot(loadAllTestData());
      const peopleBySlug = new Map(loadPeople().map((p) => [p.slug, p]));
      for (const slug of meetingSlugs) {
        const meeting = getMeetingData(slug);
        const bodyId = bodyIdByKey.get(meeting.body_id);
        if (bodyId === undefined) {
          throw new Error(
            `Meeting ${slug} has unknown body ${meeting.body_id}`,
          );
        }
        await seedGoldenMeeting(db, bodyId, meeting, peopleBySlug);
      }
    },
  };
}

/**
 * Everything the seeded rows depend on: the golden rows, each meeting's
 * metadata (including its audio's sha256) and transcript, the people
 * registry, and the embedding model that turns audio into voiceprints.
 */
function computeFingerprint(meetingSlugs: readonly string[]): string {
  const hash = createHash("sha256")
    .update(`v${VERSION}\n${goldenData.fingerprint}\n`)
    .update(`${EMBEDDING_MODEL_SPEC.url}\n`)
    .update(readFileSync(join(TEST_DATA_ROOT, "people.jsonl")));
  for (const slug of meetingSlugs) {
    const dir = join(TEST_DATA_ROOT, "meetings", slug);
    hash
      .update(`${slug}\0`)
      .update(readFileSync(join(dir, "meeting.json")))
      .update(readFileSync(join(dir, "golden.psv")));
  }
  return hash.digest("hex").slice(0, 12);
}
