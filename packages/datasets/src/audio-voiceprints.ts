import {
  LAST_WORD_DURATION_SEC,
  type DiarizationTurn,
} from "@open-minutes/core/transcription";
import { computeSpeakerEmbeddings } from "@open-minutes/audio/embed";
import { getMeetingAudio } from "@open-minutes/fixtures/audio";
import type { GoldenMeeting } from "@open-minutes/fixtures/test-data";
import type { Voiceprints } from "./voiceprints";

// Real voiceprints for golden meetings, computed from their audio: the "known
// past" an end-to-end test recognizes a later, unseen meeting against. The
// same person (by slug) learned here must be re-identified there purely from
// their voice. seed.ts imports this module only for a dataset that asks for
// it, since @open-minutes/audio/embed loads sherpa-onnx's native module.

/**
 * One voiceprint per person, from the audio spans they speak in the first
 * meeting where they have enough speech to embed reliably. A meeting's audio
 * (a ~600 MB wav) is only loaded when it has someone left to embed.
 */
export async function audioVoiceprints(
  slugs: readonly string[],
  meetings: readonly GoldenMeeting[],
): Promise<Voiceprints> {
  const wanted = new Set(slugs);
  const voiceprints = new Map<string, Float32Array>();
  for (const meeting of meetings) {
    // Give each identified person a synthetic speaker index, then reuse the
    // pipeline's per-speaker centroid builder (it expects DiarizationTurns
    // keyed by number). Each identified segment becomes one turn.
    const slugToIndex = new Map<string, number>();
    const turns: DiarizationTurn[] = [];
    for (const seg of meeting.segments) {
      if (seg.speaker.kind !== "identified" || seg.words.length === 0) continue;
      const slug = seg.speaker.person;
      if (!wanted.has(slug) || voiceprints.has(slug)) continue;
      let index = slugToIndex.get(slug);
      if (index === undefined) {
        index = slugToIndex.size;
        slugToIndex.set(slug, index);
      }
      turns.push({
        start: seg.words[0]!.start,
        end: seg.words.at(-1)!.start + LAST_WORD_DURATION_SEC,
        speakerNum: index,
      });
    }
    if (turns.length === 0) continue;

    const audio = await getMeetingAudio(meeting);
    const centroids = await computeSpeakerEmbeddings(audio.path, turns);
    for (const [slug, index] of slugToIndex) {
      const centroid = centroids.get(index);
      if (centroid) voiceprints.set(slug, centroid);
    }
  }
  return voiceprints;
}
