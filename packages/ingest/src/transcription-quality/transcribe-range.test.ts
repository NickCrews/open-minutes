import { describe, expect, it } from "vitest";
import {
  recognizeOnce,
  RANGE_FRAMINGS,
  transcribeRange,
} from "@open-minutes/audio/transcribe";
import { readWave, type WaveForm } from "@open-minutes/audio/wav";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import {
  cleanWords,
  compareTranscripts,
  type TranscriptWord,
} from "@open-minutes/core/transcription";
import { getMeetingAudio } from "../test-utils/audio-cache";
import clips from "./range-clips.json";

// What transcribeRange, the agents' transcribe_range tool, gets right: word
// error rate against the goldens on 219 clips of 20-45 s, each cut at a pause
// of 1 s or more in the golden. Half ("hard") are the stretches of each golden
// meeting where transcribeAudio did worst; half ("random") are picked at
// random from the rest. Run it before and after a change to transcribeRange
// (`pnpm test:slow transcribe-range`) and compare the logged WER.
//
// Clips where the golden itself is wrong (music transcribed as speech, a
// presentation left out) are not in range-clips.json.
//
// Measured 2026-10 on these clips and five since dropped for a wrong golden,
// WER all / hard / random, and audio decoded per second of clip:
//   one pass, 2 s either side                  0.142 / 0.207 / 0.090  1.1
//   + holes repaired                           0.127 / 0.202 / 0.067  1.2
//   three framings voted                       0.128 / 0.183 / 0.085  3.4
//   three framings voted, holes repaired       0.116 / 0.181 / 0.064  3.5
//   five framings voted, holes repaired        0.118 / 0.184 / 0.065  5.8
//   five, weighted by token confidence         0.117 / 0.184 / 0.064  5.8
//   three, kept if any decode heard it         0.126 / 0.201 / 0.067  3.5
//   one pass, 20 s either side                 0.171 / 0.246 / 0.111  2.1
// Which three framings made no difference. On these 219 clips, one decode
// gets 0.132 (0.187 / 0.090) and transcribeRange 0.109 (0.167 / 0.064). Of the golden words the vote
// misses, about 60% were heard by some decode of the clip.

const CONCURRENCY = 2;

interface Clip {
  slug: string;
  start: number;
  end: number;
  kind: string;
}

describe("transcribeRange on hard and random clips of the golden meetings", () => {
  it(
    "gets more words right than one decode",
    { tags: ["slow"], timeout: 40 * 60 * 1000 },
    async () => {
      const waves = new Map<string, WaveForm>();
      const refs = new Map<string, TranscriptWord[]>();
      for (const slug of new Set(clips.map((c) => c.slug))) {
        const meeting = getMeetingData(slug);
        waves.set(slug, readWave((await getMeetingAudio(meeting)).path));
        refs.set(
          slug,
          meeting.segments.flatMap((s) => s.words),
        );
      }
      const { before, after } = RANGE_FRAMINGS[0];
      const oneDecode = await score(clips, waves, refs, async (w, c) =>
        (await recognizeOnce(w, c.start - before, c.end + after)).filter(
          (x) => x.start >= c.start && x.start < c.end,
        ),
      );
      const range = await score(
        clips,
        waves,
        refs,
        async (w, c) => (await transcribeRange(w, c.start, c.end)).words,
      );
      console.log(`[transcribe-range] one decode: ${oneDecode}`);
      console.log(`[transcribe-range] transcribeRange: ${range}`);
      expect(range.all).toBeLessThan(oneDecode.all);
      expect(range.all).toBeLessThan(0.12);
    },
  );
});

async function score(
  clips: readonly Clip[],
  waves: Map<string, WaveForm>,
  refs: Map<string, TranscriptWord[]>,
  transcribe: (wave: WaveForm, clip: Clip) => Promise<TranscriptWord[]>,
) {
  const errors = { hard: 0, random: 0 };
  const words = { hard: 0, random: 0 };
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < clips.length; i = next++) {
      const clip = clips[i]!;
      const hyp = cleanWords(await transcribe(waves.get(clip.slug)!, clip));
      const ref = refs
        .get(clip.slug)!
        .filter((w) => w.start >= clip.start && w.start < clip.end);
      const cmp = compareTranscripts(ref, hyp.words);
      const kind = clip.kind as keyof typeof errors;
      errors[kind] += cmp.substitutions + cmp.deletions + cmp.insertions;
      words[kind] += cmp.refWordCount;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const all = (errors.hard + errors.random) / (words.hard + words.random);
  const hard = errors.hard / words.hard;
  const random = errors.random / words.random;
  return {
    all,
    toString: () =>
      `WER=${all.toFixed(4)} (hard ${hard.toFixed(4)}, random ${random.toFixed(4)})`,
  };
}
