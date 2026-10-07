import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readWave, type WaveForm } from "@open-minutes/audio/wav";
import { parsePsv } from "@open-minutes/fixtures/psv";
import { TEST_DATA_ROOT } from "@open-minutes/fixtures/test-data";
import {
  getCachedAudio,
  meetingCacheDir,
} from "@open-minutes/ingest/audio-cache";
import { formatClock } from "../clock";
import { NOT_A_SPEAKER, toLabeled, type AudioMeeting } from "../meeting";
import { labelVoices, SAME_PERSON } from "../speakers";
import { centroid, similarity } from "../vectors";
import { HOP_SEC, voiceGrid, WINDOW_SEC } from "../voiceprints";
import { SAMPLES_PATH, type VoiceSamples } from "./voices";

// Writes voice-samples.json: real CAM++ window voiceprints of a few people in
// a golden meeting, which testdata/voices.ts replays over made-up turns so
// the voice analyses are tested against real voices without the model.
//
// From packages/agents (the audio comes from the object store, once):
//   OBJECT_STORE_PUBLIC_URL=https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev \
//     pnpm tsx src/audio/testdata/sample-voices-cli.ts

const MEETING = "gbos-2026-03-23";
/** The people sampled, in the order voices.ts hands them out. */
const PEOPLE = [
  "mike-edgington",
  "jennifer-wingard",
  "kyle-kelley",
  "kellie-okonek",
  "bray-keefer",
  "brianna-sullivan",
];
/** Windows sampled per person, at least: a minute of window starts. */
const WINDOWS_PER_PERSON = 120;
/**
 * Fewest windows in a stretch: 12 s of unbroken speech, so a made-up turn
 * mostly plays one stretch, as a real turn would.
 */
const MIN_STRETCH_WINDOWS = 24;
/** Most windows in a stretch, so one long speech isn't all of a person. */
const MAX_STRETCH_WINDOWS = 60;
/** Windows start at least this far inside a segment, clear of the turn change. */
const MARGIN_SEC = 1;

const dir = join(TEST_DATA_ROOT, "meetings", MEETING);
const info = JSON.parse(readFileSync(join(dir, "meeting.json"), "utf8")) as {
  youtube_id: string;
  _audio_sha256: string;
};
const audio = await getCachedAudio({
  youtubeId: info.youtube_id,
  sha256: info._audio_sha256,
});
const segments = parsePsv({ path: join(dir, "golden.psv") })
  .map((seg, id) => ({ seg, id }))
  .filter(({ seg }) => seg.words.length > 0)
  .map(({ seg, id }) =>
    toLabeled(
      id,
      seg.speaker.kind === "identified" ? seg.speaker.person : NOT_A_SPEAKER,
      seg.words,
    ),
  );
let wave: WaveForm | null = null;
const meeting: AudioMeeting = {
  ref: MEETING,
  youtubeId: info.youtube_id,
  audioPath: audio.path,
  cacheDir: meetingCacheDir(info.youtube_id),
  segments,
  wave: () => (wave ??= readWave(audio.path)),
};
const grid = voiceGrid(meeting);
// Golden labels can be wrong, so a stretch is kept only if it sounds like
// the rest of its person's speech.
const voices = labelVoices(grid, segments);

const samples: VoiceSamples = {
  source: MEETING,
  people: PEOPLE.map((person) => {
    // The person's longest segments first: the most speech in one stretch.
    const own = segments
      .filter((s) => s.label === person)
      .sort((a, b) => b.end - b.start - (a.end - a.start));
    const voice = voices.find((v) => v.label === person)!.voiceprint;
    const stretches: VoiceSamples["people"][number]["stretches"] = [];
    let count = 0;
    for (const seg of own) {
      if (count >= WINDOWS_PER_PERSON) break;
      const from = seg.start + MARGIN_SEC;
      const to = seg.end - MARGIN_SEC - WINDOW_SEC + 1e-9;
      // Runs of consecutive voiced windows: a pause ends a stretch.
      let run: { start: number; windows: Float32Array[] } | null = null;
      const close = () => {
        if (run && run.windows.length >= MIN_STRETCH_WINDOWS) {
          const alike = similarity(centroid(run.windows)!, voice);
          if (alike >= SAME_PERSON) {
            stretches.push({ start: run.start, windows: encode(run.windows) });
            count += run.windows.length;
          } else {
            console.warn(
              `Skipped ${formatClock(run.start)}, under ${person} but only ${alike.toFixed(2)} like the rest of their speech`,
            );
          }
        }
        run = null;
      };
      for (const w of grid.windows(from, to)) {
        if (count >= WINDOWS_PER_PERSON) break;
        if (!w.voiceprint) {
          close();
          continue;
        }
        run ??= { start: w.start, windows: [] };
        run.windows.push(w.voiceprint);
        if (run.windows.length === MAX_STRETCH_WINDOWS) close();
      }
      close();
    }
    if (count < WINDOWS_PER_PERSON)
      throw new Error(`Only ${count} windows of ${person} in ${MEETING}`);
    return { person, stretches };
  }),
};
writeFileSync(SAMPLES_PATH, `${JSON.stringify(samples, null, 2)}\n`);
console.log(
  `Wrote ${PEOPLE.length} people, ${WINDOWS_PER_PERSON}+ windows (${HOP_SEC} s apart) each, to ${SAMPLES_PATH}`,
);

/**
 * Voiceprints as base64 of one signed byte per dimension, each scaled by its
 * largest component: similarities only need their directions.
 */
function encode(windows: readonly Float32Array[]): string {
  const dims = windows[0]!.length;
  const bytes = new Int8Array(windows.length * dims);
  windows.forEach((v, i) => {
    const max = Math.max(...v.map(Math.abs));
    for (let d = 0; d < dims; d++)
      bytes[i * dims + d] = Math.round((v[d]! / max) * 127);
  });
  return Buffer.from(bytes.buffer).toString("base64");
}
