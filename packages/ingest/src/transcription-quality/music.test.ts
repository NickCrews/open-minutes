// Music detection against the golden meetings. A golden marks each stretch of
// music with a MUSIC_MARKER segment at its start, and has no words inside it.

import { describe, expect, it } from "vitest";
import { detectMusic } from "@open-minutes/audio/music";
import { transcribeAudio } from "@open-minutes/audio/transcribe";
import { readWave } from "@open-minutes/audio/wav";
import { isMusicMarker, MUSIC_MARKER } from "@open-minutes/core/transcription";
import { getMeetingData } from "@open-minutes/fixtures/test-data";
import { getMeetingAudio } from "../test-utils/audio-cache";

// detectMusic works in 10 s clips, so a stretch starts within a clip of
// where the golden marks it.
const CLIP_SEC = 10;

describe("detectMusic", () => {
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
      `finds the music in ${slug}, and no speech`,
      { tags: ["slow"], timeout: 10 * 60 * 1000 },
      async () => {
        const meeting = getMeetingData(slug);
        const wave = readWave((await getMeetingAudio(meeting)).path);
        const spans = detectMusic(wave);
        const words = meeting.segments.flatMap((s) => s.words);
        const markers = words.filter(isMusicMarker).map((w) => w.start);
        console.log(
          `[${slug}] music at ${spans.map((s) => `${s.start}-${s.end}`).join(", ") || "nothing"}; golden marks ${markers.join(", ") || "nothing"}`,
        );

        const near = (a: number, b: number) => Math.abs(a - b) <= CLIP_SEC;
        expect(spans).toHaveLength(markers.length);
        for (const marker of markers)
          expect(spans.some((s) => near(s.start, marker))).toBe(true);

        const swallowed = words.filter(
          (w) =>
            !isMusicMarker(w) &&
            spans.some((s) => w.start >= s.start && w.start < s.end),
        );
        expect(swallowed).toEqual([]);
      },
    );
  }
});

describe("transcribeAudio", () => {
  it(
    "transcribes the music before assembly-2026-03-03 as music, not lyrics",
    { tags: ["slow"], timeout: 10 * 60 * 1000 },
    async () => {
      // 18 minutes of songs, then the chair's first words at 20:12.
      const meeting = getMeetingData("assembly-2026-03-03");
      const wave = readWave((await getMeetingAudio(meeting)).path);
      const firstSpeech = meeting.segments
        .flatMap((s) => s.words)
        .find((w) => !isMusicMarker(w))!;
      const opening = await transcribeAudio({
        sampleRate: wave.sampleRate,
        samples: wave.samples.subarray(
          0,
          (firstSpeech.start + 30) * wave.sampleRate,
        ),
      });
      const words = opening.flatMap((s) => s.words);
      const before = words.filter((w) => w.start < firstSpeech.start - 1);
      expect(before.map((w) => w.text)).toEqual([MUSIC_MARKER]);
      expect(words.length).toBeGreaterThan(before.length);
    },
  );
});
